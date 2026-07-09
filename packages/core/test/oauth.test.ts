import { afterEach, describe, expect, test } from "bun:test";
import { get } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOpenAICredential, OAuthService } from "../src/oauth.ts";
import { AuthStore } from "../src/providers.ts";

const originalFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("OAuthService", () => {
  test("browser flow validates callback state and stores tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cozy-oauth-"));
    dirs.push(dir);
    const auth = new AuthStore(join(dir, "auth.json"));
    const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: "acct_test" })).toString("base64url");
    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      return Response.json({
        id_token: `x.${payload}.x`,
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      });
    }) as typeof fetch;

    const flow = await new OAuthService(auth).authorize("openai", 0);
    const state = new URL(flow.start.url).searchParams.get("state");
    await new Promise<void>((resolve, reject) => {
      get(`http://localhost:1455/auth/callback?code=code&state=${state}`, (response) => {
        response.resume();
        response.on("end", resolve);
      }).on("error", reject);
    });

    expect(await flow.promise).toEqual({ status: "complete" });
    expect(await auth.getOAuth("openai")).toMatchObject({
      access: "access",
      refresh: "refresh",
      accountID: "acct_test",
    });
  });

  test("refresh cannot overwrite a concurrent API-key change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cozy-oauth-"));
    dirs.push(dir);
    const auth = new AuthStore(join(dir, "auth.json"));
    await auth.setOAuth("openai", {
      access: "old-access",
      refresh: "old-refresh",
      expires: 0,
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    globalThis.fetch = (async () => {
      started();
      await waiting;
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
    }) as typeof fetch;

    const refresh = ensureOpenAICredential(auth);
    await didStart;
    await auth.setKey("openai", "api-key");
    release();

    await expect(refresh).rejects.toThrow("credentials changed");
    expect(await auth.getKey("openai")).toBe("api-key");
    expect(await auth.getOAuth("openai")).toBeUndefined();
  });
});
