import { test, expect, describe } from "bun:test";
import { prefix } from "../src/permission/arity.ts";

describe("arity prefix", () => {
  test("git has arity 2 (subcommand counts)", () => {
    expect(prefix(["git", "checkout", "main"])).toEqual(["git", "checkout"]);
    expect(prefix(["git", "commit", "-m", "msg"])).toEqual(["git", "commit"]);
  });

  test("longer prefixes with distinct arity win", () => {
    expect(prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"]);
    expect(prefix(["npm", "install", "react"])).toEqual(["npm", "install"]);
  });

  test("explicitly listed arity-1 commands take only the program", () => {
    expect(prefix(["rm", "-rf", "node_modules"])).toEqual(["rm"]);
    expect(prefix(["ls", "-la"])).toEqual(["ls"]);
  });

  test("unknown commands default to the first token", () => {
    expect(prefix(["touch", "file.txt"])).toEqual(["touch"]);
    expect(prefix(["mycli", "do", "thing"])).toEqual(["mycli"]);
  });

  test("empty input yields empty prefix", () => {
    expect(prefix([])).toEqual([]);
  });
});
