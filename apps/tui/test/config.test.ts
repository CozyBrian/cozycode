import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-cfg-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveConfig", () => {
  test("reads from environment variables", () => {
    const r = resolveConfig([root], {
      COZY_BASE_URL: "https://x/v1",
      COZY_MODEL: "m1",
      COZY_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    expect(r.session?.provider.baseURL).toBe("https://x/v1");
    expect(r.session?.model).toBe("m1");
    expect(r.session?.provider.apiKey).toBe("k");
    expect(r.initialModel).toEqual({ providerID: "openai-compatible", modelID: "m1" });
    expect(r.workspaceRoot).toBe(root);
  });

  test("falls back to a cozycode.json in the workspace", async () => {
    await writeFile(
      join(root, "cozycode.json"),
      JSON.stringify({ baseURL: "https://file/v1", model: "file-model" }),
    );
    const r = resolveConfig([root], {} as NodeJS.ProcessEnv);
    expect(r.session?.provider.baseURL).toBe("https://file/v1");
    expect(r.initialModel?.modelID).toBe("file-model");
    expect(r.configSource).toContain("cozycode.json");
  });

  test("environment overrides the config file", async () => {
    await writeFile(
      join(root, "cozycode.json"),
      JSON.stringify({ baseURL: "https://file/v1", model: "file-model" }),
    );
    const r = resolveConfig([root], { COZY_MODEL: "env-model" } as NodeJS.ProcessEnv);
    expect(r.initialModel?.modelID).toBe("env-model");
    expect(r.session?.provider.baseURL).toBe("https://file/v1");
  });

  test("allows onboarding when provider and model are missing", () => {
    const r = resolveConfig([root], {} as NodeJS.ProcessEnv);
    expect(r.session).toBeNull();
    expect(r.initialModel).toBeNull();
  });

  test("defaults to the core ruleset when no permissions are configured", () => {
    const r = resolveConfig([root], {
      COZY_BASE_URL: "https://x/v1",
      COZY_MODEL: "m1",
    } as NodeJS.ProcessEnv);
    // edit asks by default in the core ruleset.
    expect(r.session?.permissions?.some((rule) => rule.permission === "edit")).toBe(true);
  });

  test("merges permission overrides from the config file over the default ruleset", async () => {
    await writeFile(
      join(root, "cozycode.json"),
      JSON.stringify({
        baseURL: "https://file/v1",
        model: "file-model",
        permissions: { edit: "allow" },
      }),
    );
    const r = resolveConfig([root], {} as NodeJS.ProcessEnv);
    // The override is merged last, so it wins (last-match-wins).
    const last = r.session!.permissions!.filter((rule) => rule.permission === "edit").at(-1);
    expect(last?.action).toBe("allow");
  });
});
