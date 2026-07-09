# Summary of Changes

## Overview
14 modified files + 3 new files. ~499 lines added, ~83 removed. The changes implement **OAuth-based provider authentication** for OpenAI (ChatGPT Pro/Plus) across the desktop (Electron) and TUI apps, refactor the provider registry to use a dynamic catalog, and improve the session lifecycle.

---

## New Files

1. **`packages/core/src/oauth.ts`** — Full OAuth 2.0 authorization service for OpenAI:
   - PKCE browser flow (local callback server on port 1455)
   - Device code flow (headless)
   - Token exchange, refresh, credential storage
   - `ensureOpenAICredential()` auto-refresh helper

2. **`packages/core/src/models-dev.ts`** — Dynamic provider/model catalog:
   - Fetches from `https://models.dev/api.json` with disk cache
   - Fallback built-in list for OpenAI & DeepSeek
   - 5-minute TTL with background refresh

3. **`packages/core/test/oauth.test.ts`** and **`packages/core/test/providers.test.ts`** — New test files.

---

## Modified Files

### Core (`packages/core/`)

| File | Key Changes |
|------|-------------|
| `package.json` | Added `@ai-sdk/openai` dependency |
| `src/index.ts` | Exports `ModelsDevCatalog`, `modelsDev`, `OAuthService`, `OAuthFlow`; creates singleton `oauth` |
| `src/model.ts` | Supports `"openai"` and `"openai-oauth"` provider kinds; adds `oauthFetch` that injects OAuth credentials |
| `src/providers.ts` | Major rewrite: reads from `ProviderCatalog` instead of static OpenAI model list; `AuthStore` supports OAuth credentials (read/write/refresh with CAS); `ProviderConfig` now includes `kind` field; serialized auth files use mode `0o600` |

### Desktop App (`apps/desktop/`)

| File | Key Changes |
|------|-------------|
| `src/main/index.ts` | New IPC handler `providersOpenExternal` with URL validation; `oauthStart`/`oauthWait`/`oauthCancel` now pass `attemptID` in payload objects |
| `src/main/providers.ts` | **ProviderBridge** rewritten with concurrent-request serialization; tracks pending/active/completed OAuth flows; opens browser automatically |
| `src/main/session-manager.ts` | Session key now includes `provider` config field to avoid stale sessions |
| `src/preload/index.ts` | Exposes `openExternal` to renderer; IPC calls updated with `attemptID` parameter |
| `src/shared/ipc.ts` | New `providersOpenExternal` IPC channel; `CozyApi` interface updated |
| `src/renderer/.../ProvidersSection.tsx` | New `ConnectCard` component for OAuth UX (device code display, copy, open again, cancel); added search/filter input; providers sorted by connection status then name |

### TUI App (`apps/tui/`)

| File | Key Changes |
|------|-------------|
| `src/app.tsx` | Handles session restoration with custom/legacy providers; when a new provider is connected, auto-selects its first model and starts a session |
| `src/components/ProviderDialog.tsx` | Full OAuth flow in TUI: `authorizing` and `oauth` states, spinner, device code display, keyboard shortcuts (`o` to open browser, `esc` to cancel) |

### Protocol (`packages/protocol/src/index.ts`)

| File | Key Changes |
|------|-------------|
| `src/index.ts` | `OAuthStart` now includes `attemptID`; `ProviderConfig` gained optional `kind` field (`"openai-compatible"`, `"openai"`, or `"openai-oauth"`) |

### Other

| File | Key Changes |
|------|-------------|
| `bun.lock` | Updated lockfile for new `@ai-sdk/openai` dependency |

---

## Architecture Summary

```
new Provider Dialog / Settings UI
       │
       ▼
  oauth.authorize(id, method)
       │
       ├── browser flow (method=0)
       │     ├── starts local HTTP server on :1455
       │     ├── opens browser → auth.openai.com
       │     ├── callback received → exchange code for tokens
       │     └── store to auth.json
       │
       └── device flow (method=1)
             ├── POST /api/accounts/deviceauth/usercode
             ├── show user_code, poll for completion
             └── exchange code for tokens → store
```

- **`ProviderRegistry`** now reads from `ModelsDevCatalog` (network-backed) instead of hardcoded OpenAI models, merging with custom providers.
- **`AuthStore`** uses a serialized write queue to avoid race conditions and stores both API keys and OAuth credentials in `~/.config/cozycode/auth.json`.
- **`createModel()`** dispatches on `provider.kind` — uses `@ai-sdk/openai` for OpenAI/OAuth, `@ai-sdk/openai-compatible` for everything else.
