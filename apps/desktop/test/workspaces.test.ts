import { describe, expect, test } from "bun:test";
import { emptySessionForWorkspace, workspaceRoots } from "../src/shared/workspaces.ts";

describe("workspaceRoots", () => {
  test("keeps existing project order while adding the default root", () => {
    expect(workspaceRoots("/projects/cozycode", ["/projects/other", "/projects/cozycode", ""])).toEqual([
      "/projects/other",
      "/projects/cozycode",
    ]);
  });
});

describe("emptySessionForWorkspace", () => {
  test("does not reuse an empty session from another project", () => {
    const sessions = [
      { id: "one", messageCount: 0, workspaceRoot: "/projects/one" },
      { id: "two", messageCount: 0, workspaceRoot: "/projects/two" },
    ];
    expect(emptySessionForWorkspace(sessions, "/projects/two")?.id).toBe("two");
    expect(emptySessionForWorkspace(sessions, "/projects/three")).toBeUndefined();
  });
});
