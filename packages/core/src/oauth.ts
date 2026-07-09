import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthResult, OAuthStart } from "@cozycode/protocol";
import type { AuthStore, OAuthCredential } from "./providers.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const CALLBACK = "http://localhost:1455/auth/callback";
const DEVICE_CALLBACK = `${ISSUER}/deviceauth/callback`;
const ATTEMPT_TIMEOUT = 10 * 60 * 1000;

interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export interface OAuthFlow {
  start: OAuthStart;
  browser: boolean;
  promise: Promise<OAuthResult>;
  cancel(): void;
}

export class OAuthService {
  constructor(private readonly auth: AuthStore) {}

  async authorize(providerID: string, method: number, signal?: AbortSignal): Promise<OAuthFlow> {
    if (providerID !== "openai") throw new Error("This provider does not offer OAuth sign-in.");
    if (method === 0) return this.browser(signal);
    if (method === 1) return this.device(signal);
    throw new Error("The selected authentication method is not OAuth.");
  }

  private async browser(signal?: AbortSignal): Promise<OAuthFlow> {
    const controller = new AbortController();
    forwardAbort(signal, controller);
    const verifier = pkceVerifier();
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(32));
    const url = new URL(`${ISSUER}/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK,
      scope: "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: "cozycode",
    }).toString();

    const pending = callbackServer(state, controller.signal);
    try {
      await pending.ready;
    } catch (error) {
      pending.close();
      throw error;
    }
    const promise = (async (): Promise<OAuthResult> => {
      try {
        const code = await pending.code;
        const credential = await exchangeCode(code, verifier, CALLBACK, controller.signal);
        await this.auth.setOAuth("openai", credential);
        return { status: "complete" };
      } catch (error) {
        if (controller.signal.aborted) return { status: "cancelled" };
        return { status: "failed", message: message(error) };
      } finally {
        pending.close();
      }
    })();
    return {
      start: {
        attemptID: randomUUID(),
        url: url.toString(),
        instructions: "Complete authorization in your browser. This window will close automatically.",
      },
      browser: true,
      promise,
      cancel: () => controller.abort(),
    };
  }

  private async device(signal?: AbortSignal): Promise<OAuthFlow> {
    const controller = new AbortController();
    forwardAbort(signal, controller);
    const response = await fetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "cozycode" },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Failed to initiate device authorization (${response.status}).`);
    const start = await response.json() as {
      device_auth_id: string;
      user_code: string;
      interval?: string;
    };
    const interval = Math.max(Number.parseInt(start.interval || "5", 10) || 5, 1) * 1000 + 3000;
    const promise = (async (): Promise<OAuthResult> => {
      try {
        const expires = Date.now() + ATTEMPT_TIMEOUT;
        while (Date.now() < expires) {
          await sleep(interval, controller.signal);
          const poll = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": "cozycode" },
            body: JSON.stringify({
              device_auth_id: start.device_auth_id,
              user_code: start.user_code,
            }),
            signal: controller.signal,
          });
          if (poll.status === 403 || poll.status === 404) continue;
          if (!poll.ok) throw new Error(`Device authorization failed (${poll.status}).`);
          const result = await poll.json() as { authorization_code: string; code_verifier: string };
          const credential = await exchangeCode(
            result.authorization_code,
            result.code_verifier,
            DEVICE_CALLBACK,
            controller.signal,
          );
          await this.auth.setOAuth("openai", credential);
          return { status: "complete" };
        }
        return { status: "failed", message: "Device authorization expired." };
      } catch (error) {
        if (controller.signal.aborted) return { status: "cancelled" };
        return { status: "failed", message: message(error) };
      }
    })();
    return {
      start: {
        attemptID: randomUUID(),
        url: `${ISSUER}/codex/device`,
        deviceCode: start.user_code,
        instructions: `Enter code: ${start.user_code}`,
      },
      browser: false,
      promise,
      cancel: () => controller.abort(),
    };
  }
}

export async function refreshOpenAICredential(
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: CLIENT_ID,
    }),
  });
  if (!response.ok) throw new Error(`OAuth token refresh failed (${response.status}).`);
  return credentialFromToken(await response.json() as TokenResponse, credential.accountID);
}

const refreshes = new WeakMap<AuthStore, Promise<OAuthCredential>>();

export async function ensureOpenAICredential(auth: AuthStore): Promise<OAuthCredential> {
  const credential = await auth.getOAuth("openai");
  if (!credential) throw new Error("OpenAI OAuth credentials are missing.");
  if (credential.expires > Date.now() + 5 * 60 * 1000) return credential;
  const active = refreshes.get(auth);
  if (active) return active;
  const refresh = refreshOpenAICredential(credential)
    .then(async (next) => {
      if (!await auth.replaceOAuth("openai", credential, next)) {
        throw new Error("OpenAI credentials changed while the token was refreshing.");
      }
      return next;
    })
    .finally(() => refreshes.delete(auth));
  refreshes.set(auth, refresh);
  return refresh;
}

async function exchangeCode(
  code: string,
  verifier: string,
  redirectURI: string,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectURI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`OAuth token exchange failed (${response.status}).`);
  return credentialFromToken(await response.json() as TokenResponse);
}

function credentialFromToken(token: TokenResponse, fallbackAccountID?: string): OAuthCredential {
  if (!token.access_token || !token.refresh_token) throw new Error("OAuth response did not include tokens.");
  return {
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
    accountID: accountID(token.id_token) || accountID(token.access_token) || fallbackAccountID,
  };
}

function accountID(token?: string): string | undefined {
  if (!token) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as {
      chatgpt_account_id?: string;
      organizations?: Array<{ id?: string }>;
      "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
    };
    return claims.chatgpt_account_id
      || claims["https://api.openai.com/auth"]?.chatgpt_account_id
      || claims.organizations?.[0]?.id;
  } catch {
    return undefined;
  }
}

function callbackServer(expectedState: string, signal: AbortSignal): {
  ready: Promise<void>;
  code: Promise<string>;
  close(): void;
} {
  let server: Server;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  server = createServer((request, response) => {
    const url = new URL(request.url || "/", CALLBACK);
    if (url.pathname !== "/auth/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const error = url.searchParams.get("error_description") || url.searchParams.get("error");
    const callbackCode = url.searchParams.get("code");
    if (error || !callbackCode || url.searchParams.get("state") !== expectedState) {
      response.writeHead(400, { "Content-Type": "text/html" }).end(page(false, error || "Invalid OAuth callback."));
      rejectCode(new Error(error || "Invalid OAuth callback."));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" }).end(page(true));
    resolveCode(callbackCode);
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(1455, "localhost", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo | null;
      if (!address) reject(new Error("OAuth callback server did not start."));
      else resolve();
    });
  });
  const timer = setTimeout(() => rejectCode(new Error("OAuth authorization timed out.")), ATTEMPT_TIMEOUT);
  signal.addEventListener("abort", () => rejectCode(new Error("OAuth authorization cancelled.")), { once: true });
  return {
    ready,
    code,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

function page(success: boolean, detail = ""): string {
  const title = success ? "Authorization successful" : "Authorization failed";
  const body = success ? "You can return to cozycode." : escapeHtml(detail);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:16px system-ui;padding:40px;background:#111;color:#eee"><h1>${title}</h1><p>${body}</p>${success ? "<script>setTimeout(()=>window.close(),2500)</script>" : ""}</body></html>`;
}

function pkceVerifier(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  return [...randomBytes(43)].map((byte) => chars[byte % chars.length]).join("");
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Cancelled."));
    }, { once: true });
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): void {
  if (!signal) return;
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
}
