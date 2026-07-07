import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 128 * 1024;

export interface ShellResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export const runShellTool = defineTool({
  name: "run_shell",
  description:
    "Run a shell command from within the workspace and capture its output. " +
    "Use this for builds, tests, git, and other CLI tasks. Output is truncated " +
    "if very large.",
  inputSchema: z.object({
    command: z.string().describe("The shell command to run (via `bash -c`)."),
    cwd: z
      .string()
      .optional()
      .describe("Working directory relative to the workspace root."),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}).`),
  }),
  summarize: ({ command }) => `Run: ${command}`,
  run(args, ctx) {
    const cwd = args.cwd
      ? resolveInWorkspace(ctx.workspaceRoot, args.cwd)
      : ctx.workspaceRoot;
    return execShell(args.command, cwd, args.timeoutMs ?? DEFAULT_TIMEOUT_MS, ctx.abortSignal);
  },
});

export function execShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", ["-c", command], { cwd });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (buf: string, chunk: Buffer): string => {
      if (buf.length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return buf;
      }
      return buf + chunk.toString("utf8");
    };

    child.stdout.on("data", (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = append(stderr, c)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const onAbort = () => child.kill("SIGKILL");
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolvePromise({
        command,
        exitCode,
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
        timedOut,
        truncated,
      });
    };

    child.on("error", (err) => {
      stderr = append(stderr, Buffer.from(`\n[spawn error] ${err.message}`));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
