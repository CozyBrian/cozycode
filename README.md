# cozycode

A coding-agent harness with two surfaces — a desktop app (first) and a CLI/TUI
(later) — sharing one headless TypeScript core. The agent reads/edits files,
searches the codebase, and runs shell commands, with a permission gate on risky
actions. It is provider-agnostic and speaks any **OpenAI-compatible** API.

## Layout

```
packages/
  protocol/   @cozycode/protocol — shared event/message/config types
  core/       @cozycode/core     — the engine: agent loop, tools, permissions, sessions
apps/
  desktop/    @cozycode/desktop  — Electron app (core in main process, React renderer)
                                    macOS: unified title bar + window vibrancy;
                                    UI on Vite 7 + Tailwind v4 + shadcn/ui
  tui/        @cozycode/tui      — terminal UI (Ink), embeds the core directly
```

The core is UI-agnostic: a `Session` emits a typed event stream and answers
approval requests through a callback, so any frontend (Electron today, a TUI
later) is a thin consumer.

- **Agent loop:** [Vercel AI SDK v7](https://ai-sdk.dev) `ToolLoopAgent`.
- **Models:** `@ai-sdk/openai-compatible` — configure `baseURL` / `apiKey` / `model`.
- **Tools:** `read_file`, `write_file`, `edit_file`, `run_shell`, `search`.
- **Permissions:** per-tool `allow | ask | deny`; `ask` prompts the frontend and
  can be remembered for the session.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (package manager, test runner, TUI runtime)
- `ripgrep` (optional — `search` falls back to a built-in scan without it)

## Setup

```sh
bun install
# Electron ships a binary via a postinstall script that Bun blocks by default:
node apps/desktop/node_modules/electron/install.js
```

## Develop

```sh
bun run dev         # launch the Electron desktop app (electron-vite dev)
bun run build       # build the desktop app bundles
bun run pack:mac    # build the signed local arm64 .app
bun run dist:mac    # build the signed local arm64 app, DMG, and ZIP
bun test            # run the core unit + integration tests
bun run typecheck   # typecheck all packages and the app
```

Configure the provider (base URL, API key, model) and pick a workspace folder in
the app's **Settings** panel on first launch.

## Headless harness (CLI)

Drive one agent turn from the terminal against a real endpoint — the manual
counterpart to the mock-model integration test:

```sh
COZY_BASE_URL=https://api.openai.com/v1 \
COZY_API_KEY=sk-... \
COZY_MODEL=gpt-4o \
bun run agent . "list the TypeScript files and summarize the core module"
```

Approvals are answered interactively (`y` / `a` / `n`).

## TUI

An OpenCode-inspired full-screen terminal UI (Ink) that embeds the core directly
— a scrollable transcript, tool cards, an inline approval prompt, and a status
bar. Configure it the same way as the CLI harness (env vars or a `cozycode.json`
in the workspace):

```sh
COZY_BASE_URL=https://api.openai.com/v1 \
COZY_API_KEY=sk-... \
COZY_MODEL=gpt-4o \
bun run tui                 # run in the current directory
bun run tui path/to/repo    # or point at a workspace
```

Keys: **Enter** to send · **Esc** to interrupt a running turn · **Ctrl+C** to
quit. When a tool needs approval, choose **Allow once / Always allow / Deny**.

## Testing

```sh
bun test            # 33 tests: core unit + core & TUI mock-model integration
bun run typecheck   # all packages + both apps
```

The TUI's behavior is covered offline with `ink-testing-library` driving a mock
model — the transcript render, an allowed tool call, and the interactive
approval flow all run without a network endpoint.
