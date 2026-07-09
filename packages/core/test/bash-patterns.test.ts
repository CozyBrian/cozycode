import { test, expect, describe } from "bun:test";
import { commandPatterns } from "../src/permission/bash-patterns.ts";

describe("commandPatterns", () => {
  test("simple command yields exact pattern and prefix-glob always", () => {
    const { patterns, always } = commandPatterns("git commit -m 'hello world'");
    expect(patterns).toEqual(["git commit -m 'hello world'"]);
    expect(always).toEqual(["git commit *"]);
  });

  test("compound commands split into segments", () => {
    const { patterns, always } = commandPatterns("git status && rm -rf build");
    expect(patterns).toEqual(["git status", "rm -rf build"]);
    expect(always).toEqual(["git status *", "rm *"]);
  });

  test("pipes split into segments", () => {
    const { patterns } = commandPatterns("cat file | grep foo");
    expect(patterns).toEqual(["cat file", "grep foo"]);
  });

  test("leading env assignments are stripped for the prefix", () => {
    const { patterns, always } = commandPatterns("FOO=bar npm run dev");
    expect(patterns).toEqual(["FOO=bar npm run dev"]);
    expect(always).toEqual(["npm run dev *"]);
  });

  test("command substitution is conservative: pattern only, no always", () => {
    const { patterns, always } = commandPatterns("echo $(whoami)");
    expect(patterns).toEqual(["echo $(whoami)"]);
    expect(always).toEqual([]);
  });

  test("redirection is conservative: pattern only, no always", () => {
    const { patterns, always } = commandPatterns("echo hi > out.txt");
    expect(patterns).toEqual(["echo hi > out.txt"]);
    expect(always).toEqual([]);
  });

  test("quoted separators are not split", () => {
    const { patterns } = commandPatterns('echo "a; b && c"');
    expect(patterns).toEqual(['echo "a; b && c"']);
  });

  test("empty command yields nothing", () => {
    expect(commandPatterns("")).toEqual({ patterns: [], always: [] });
    expect(commandPatterns("   ")).toEqual({ patterns: [], always: [] });
  });

  test("duplicate segments are de-duplicated", () => {
    const { patterns, always } = commandPatterns("ls && ls");
    expect(patterns).toEqual(["ls"]);
    expect(always).toEqual(["ls *"]);
  });
});
