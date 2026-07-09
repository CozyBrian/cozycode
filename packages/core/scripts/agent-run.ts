#!/usr/bin/env bun
/**
 * Headless integration harness: drive one agent turn against a real
 * OpenAI-compatible endpoint from the terminal. Approvals are answered
 * interactively. This is the manual counterpart to the mock-model integration
 * test and an early seed for the TUI.
 *
 * Usage:
 *   COZY_BASE_URL=https://api.openai.com/v1 \
 *   COZY_API_KEY=sk-... \
 *   COZY_MODEL=gpt-4o \
 *   bun packages/core/scripts/agent-run.ts [workspaceDir] "your instruction"
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { createSession, DEFAULT_RULESET } from "../src/index.ts";

const baseURL = process.env.COZY_BASE_URL;
const apiKey = process.env.COZY_API_KEY;
const model = process.env.COZY_MODEL;
if (!baseURL || !model) {
  console.error("Set COZY_BASE_URL and COZY_MODEL (and COZY_API_KEY if required).");
  process.exit(1);
}

const args = process.argv.slice(2);
// If the first arg is a directory-ish path, treat it as the workspace.
const first = args[0];
const workspaceRoot = first && (first.startsWith(".") || first.startsWith("/"))
  ? resolve(first)
  : process.cwd();
const prompt = (first === undefined || workspaceRoot === resolve(first) ? args.slice(1) : args)
  .join(" ")
  .trim();

if (!prompt) {
  console.error('Provide an instruction, e.g. bun agent-run.ts . "list the TS files"');
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });

const session = createSession({
  provider: { name: "cli", baseURL, apiKey },
  model,
  workspaceRoot,
  permissions: DEFAULT_RULESET,
});

console.log(`\ncozycode → ${model} @ ${baseURL}\nworkspace: ${workspaceRoot}\n`);

const consume = (async () => {
  for await (const event of session.events) {
    switch (event.type) {
      case "text-delta":
        stdout.write(event.text);
        break;
      case "tool-call-start":
        console.log(`\n🔧 ${event.toolName}(${JSON.stringify(event.args)})`);
        break;
      case "tool-result":
        console.log(
          `   ${event.isError ? "✗" : "✓"} ${event.toolName} → ${truncate(JSON.stringify(event.result))}`,
        );
        break;
      case "permission-asked": {
        const req = event.request;
        const summary = typeof req.metadata.summary === "string" ? req.metadata.summary : "";
        const alwaysLabel = req.always.length ? ` / [a]lways ("${req.always.join('", "')}")` : "";
        const answer = (
          await rl.question(
            `\n⚠️  Approve ${req.permission}? ${summary}\n   [y]es${alwaysLabel} / [n]o: `,
          )
        )
          .trim()
          .toLowerCase();
        if ((answer === "a" || answer === "always") && req.always.length) {
          session.replyPermission(req.id, "always");
        } else if (answer === "y" || answer === "yes") {
          session.replyPermission(req.id, "once");
        } else {
          session.replyPermission(req.id, "reject");
        }
        break;
      }
      case "error":
        console.error(`\n❌ ${event.message}`);
        break;
      case "finish":
        console.log(`\n\n[done: ${event.reason}]`);
        return;
    }
  }
})();

await session.send(prompt);
session.close();
await consume;
rl.close();

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
