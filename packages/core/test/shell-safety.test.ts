import { test, expect, describe } from "bun:test";
import { classifyCommand } from "../src/tools/shell-safety.ts";

describe("classifyCommand", () => {
  test("safe: common read-only commands", () => {
    expect(classifyCommand("pwd")).toBe("safe");
    expect(classifyCommand("ls")).toBe("safe");
    expect(classifyCommand("ls -la")).toBe("safe");
    expect(classifyCommand("rg class")).toBe("safe");
    expect(classifyCommand("rg class Foo")).toBe("safe");
    expect(classifyCommand("cat file.txt")).toBe("safe");
  });

  test("unknown: commands with shell metacharacters", () => {
    expect(classifyCommand("rg 'class Foo'")).toBe("unknown");
    expect(classifyCommand("git status && rm -rf .")).toBe("unknown");
    expect(classifyCommand("echo $(rm -rf .)")).toBe("unknown");
  });

  test("safe: read-only git subcommands", () => {
    expect(classifyCommand("git status")).toBe("safe");
    expect(classifyCommand("git diff")).toBe("safe");
    expect(classifyCommand("git log --oneline")).toBe("safe");
    expect(classifyCommand("git branch --show-current")).toBe("safe");
    expect(classifyCommand("git remote -v")).toBe("safe");
    expect(classifyCommand("git config --get user.name")).toBe("safe");
  });

  test("destructive: mutating git subcommands", () => {
    expect(classifyCommand("git reset --hard")).toBe("destructive");
    expect(classifyCommand("git clean -fd")).toBe("destructive");
    expect(classifyCommand("git checkout main")).toBe("destructive");
    expect(classifyCommand("git commit -m hi")).toBe("destructive");
    expect(classifyCommand("git push")).toBe("destructive");
    expect(classifyCommand("git pull")).toBe("destructive");
  });

  test("destructive: git config without read flags", () => {
    expect(classifyCommand("git config user.name NewName")).toBe("destructive");
  });

  test("destructive: dangerous executables", () => {
    expect(classifyCommand("rm -rf node_modules")).toBe("destructive");
    expect(classifyCommand("mv a b")).toBe("destructive");
    expect(classifyCommand("cp a b")).toBe("destructive");
    expect(classifyCommand("chmod +x script")).toBe("destructive");
  });

  test("safe: test and typecheck runners", () => {
    expect(classifyCommand("bun test")).toBe("safe");
    expect(classifyCommand("bun run test")).toBe("safe");
    expect(classifyCommand("bun run typecheck")).toBe("safe");
    expect(classifyCommand("npm test")).toBe("safe");
    expect(classifyCommand("npm run test")).toBe("safe");
    expect(classifyCommand("npm run typecheck")).toBe("safe");
    expect(classifyCommand("pnpm test")).toBe("safe");
    expect(classifyCommand("pnpm run typecheck")).toBe("safe");
  });

  test("destructive: package install commands", () => {
    expect(classifyCommand("npm install")).toBe("destructive");
    expect(classifyCommand("npm add lodash")).toBe("destructive");
    expect(classifyCommand("bun install")).toBe("destructive");
    expect(classifyCommand("pnpm add react")).toBe("destructive");
  });

  test("unknown: unrecognized package runner scripts", () => {
    expect(classifyCommand("bun run build")).toBe("unknown");
    expect(classifyCommand("npm run build")).toBe("unknown");
  });

  test("unknown: unrecognized programs", () => {
    expect(classifyCommand("some-random-binary --flag")).toBe("unknown");
  });

  test("safe: empty command (no-op)", () => {
    expect(classifyCommand("")).toBe("safe");
    expect(classifyCommand("   ")).toBe("safe");
  });
});