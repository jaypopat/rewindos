export interface ClaudeModel {
  id: string; // alias passed to claude CLI --model
  label: string;
  description: string;
}

export const CLAUDE_MODELS: ClaudeModel[] = [
  { id: "opus",   label: "Claude Opus",   description: "most capable · slowest"  },
  { id: "sonnet", label: "Claude Sonnet", description: "balanced · default"      },
  { id: "haiku",  label: "Claude Haiku",  description: "fastest · cheapest"      },
];

export const DEFAULT_CLAUDE_MODEL = "sonnet";

/** True if `id` is one of the Claude Code aliases (`opus`/`sonnet`/`haiku`). */
export function isClaudeModel(id: string | null | undefined): boolean {
  return !!id && CLAUDE_MODELS.some((m) => m.id === id);
}

export type ChatProvider = "claude" | "ollama";

export interface ChatRouteInput {
  /** The model this send should use: chat.model ?? user pick, or null if neither. */
  selectedModel: string | null | undefined;
  /** Whether the Claude CLI is installed AND our MCP server is registered. */
  claudeReady: boolean;
  /** Configured local Ollama model, used only when nothing is explicitly selected. */
  ollamaDefaultModel: string;
}

export interface ChatRoute {
  provider: ChatProvider;
  model: string;
}

/**
 * Decide which backend a chat send goes to, based on the SELECTED model — not on
 * whether Claude happens to be installed. An explicit pick always wins (a Claude
 * alias → Claude, anything else → Ollama). With no pick, default to Claude when
 * it's ready, otherwise the local Ollama model.
 *
 * Note: when the selected model is a Claude alias but `claudeReady` is false, this
 * still returns `provider: "claude"` — the caller is expected to surface a clear
 * "Claude not available" error rather than silently misroute to Ollama.
 */
export function resolveChatRoute(input: ChatRouteInput): ChatRoute {
  if (input.selectedModel) {
    return {
      provider: isClaudeModel(input.selectedModel) ? "claude" : "ollama",
      model: input.selectedModel,
    };
  }
  return input.claudeReady
    ? { provider: "claude", model: DEFAULT_CLAUDE_MODEL }
    : { provider: "ollama", model: input.ollamaDefaultModel };
}
