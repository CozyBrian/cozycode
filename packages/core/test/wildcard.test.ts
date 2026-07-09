import { test, expect, describe } from "bun:test";
import { wildcardMatch } from "../src/permission/wildcard.ts";

describe("wildcardMatch", () => {
  test("literal match", () => {
    expect(wildcardMatch("edit", "edit")).toBe(true);
    expect(wildcardMatch("edit", "bash")).toBe(false);
  });

  test("* matches any run of characters", () => {
    expect(wildcardMatch("anything", "*")).toBe(true);
    expect(wildcardMatch("git commit -m x", "git *")).toBe(true);
    expect(wildcardMatch("npm", "npm*")).toBe(true);
  });

  test("? matches a single character", () => {
    expect(wildcardMatch("cat", "ca?")).toBe(true);
    expect(wildcardMatch("cats", "ca?")).toBe(false);
  });

  test("regex metacharacters are escaped and matched literally", () => {
    expect(wildcardMatch("a.b.c", "a.b.c")).toBe(true);
    expect(wildcardMatch("axbxc", "a.b.c")).toBe(false);
    expect(wildcardMatch("a+b", "a+b")).toBe(true);
  });

  test("backslashes normalize to forward slashes", () => {
    expect(wildcardMatch("src\\a.ts", "src/*.ts")).toBe(true);
  });

  test('trailing " *" also matches the bare command', () => {
    expect(wildcardMatch("git status", "git status *")).toBe(true);
    expect(wildcardMatch("git status --short", "git status *")).toBe(true);
    expect(wildcardMatch("git statusx", "git status *")).toBe(false);
  });

  test("is anchored (no partial matches)", () => {
    expect(wildcardMatch("rm -rf /", "rm")).toBe(false);
    expect(wildcardMatch("prefixed", "fixed")).toBe(false);
  });
});
