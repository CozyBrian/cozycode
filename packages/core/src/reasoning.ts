import type { JSONValue } from "ai";
import type { ProviderConfig } from "@cozycode/protocol";

/**
 * Reasoning-effort ladders and provider-option mapping — the single home for
 * all reasoning-related provider divergence in the core.
 *
 * cozycode is entirely OpenAI-family (no Anthropic transport), so the mapping
 * is small: the OpenAI Responses transport takes `reasoningEffort` (plus a
 * reasoning summary + encrypted-content include, mirroring opencode), and every
 * other (openai-compatible) transport takes `reasoningEffort` which serializes
 * to the chat-completions `reasoning_effort` field.
 *
 * Ladders are computed once at catalog-normalize time and shipped on
 * `ModelInfo.reasoningEfforts`; frontends never recompute them.
 */

/**
 * Model-id substrings for reasoning models whose thinking is always-on with no
 * external effort knob. Mirrors opencode's specific exclusions — note these are
 * *specific* ids (e.g. `deepseek-v3`), NOT a blanket `deepseek`, so newer
 * effort-capable models like `deepseek-v4-pro` still get a ladder.
 */
const NO_EFFORT_KNOB = [
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-r1",
  "deepseek-v3",
  "minimax",
  "kimi",
  "k2p",
  "qwen",
  "big-pickle",
];

const WIDELY_SUPPORTED = ["low", "medium", "high"];

/** Bare model id (strip any leading `provider/`) lowercased. */
function bareId(modelID: string): string {
  const slash = modelID.lastIndexOf("/");
  return (slash === -1 ? modelID : modelID.slice(slash + 1)).toLowerCase();
}

/** Major version from a `gpt-5.2` / `gpt-5-...` id, or undefined for bare `gpt-5`. */
function gpt5Version(id: string): number | undefined {
  const match = id.match(/gpt-5[.-](\d+)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Ordered effort ladder (weakest → strongest) for a catalog model. Returns `[]`
 * when the model exposes no controllable effort (non-reasoning models, or
 * reasoning models like DeepSeek that have no effort parameter).
 */
export function reasoningEfforts(
  modelID: string,
  opts: { reasoning?: boolean; npm?: string },
): string[] {
  if (!opts.reasoning) return [];
  const id = bareId(modelID);

  if (/^gpt-5(?:[.-]|$)/.test(id)) {
    if (id.includes("-chat")) return [];
    if (id.includes("-pro")) {
      return gpt5Version(id) !== undefined ? ["medium", "high", "xhigh"] : ["high"];
    }
    if (id.includes("codex")) {
      const version = gpt5Version(id);
      const ladder = [...WIDELY_SUPPORTED];
      if (id.includes("codex-max") || (version !== undefined && version >= 2)) {
        ladder.push("xhigh");
      }
      if (version !== undefined && version >= 3) ladder.unshift("none");
      return ladder;
    }
    const version = gpt5Version(id);
    if (version === undefined) return ["minimal", "low", "medium", "high"];
    if (version === 1) return ["none", "low", "medium", "high"];
    return ["none", "low", "medium", "high", "xhigh"];
  }

  // GLM 5.2 exposes high/max; older GLM has no external knob.
  if (id.includes("glm-5.2") || id.includes("glm-5-2")) return ["high", "max"];
  if (id.includes("glm")) return [];

  // Grok: only grok-3-mini exposes an effort control.
  if (id.includes("grok")) return id.includes("grok-3-mini") ? ["low", "high"] : [];

  if (NO_EFFORT_KNOB.some((needle) => id.includes(needle))) return [];

  return WIDELY_SUPPORTED;
}

/**
 * The `providerOptions` bag for a session's transport, or `undefined` when no
 * effort is selected (the request is then identical to the pre-reasoning path).
 */
export function reasoningProviderOptions(
  provider: ProviderConfig,
  effort: string | undefined,
): Record<string, Record<string, JSONValue>> | undefined {
  if (!effort) return undefined;
  if (provider.kind === "openai" || provider.kind === "openai-oauth") {
    return {
      openai: {
        reasoningEffort: effort,
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    };
  }
  return { openaiCompatible: { reasoningEffort: effort } };
}
