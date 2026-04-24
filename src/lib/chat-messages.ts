import type { UIMessage } from "ai";
import type { ChatMessageRow } from "./api";

/**
 * Map `ChatMessageRow[]` (one row per Anthropic content block) into `UIMessage[]`
 * (one message per role turn, with a parts array). ai-elements primitives consume
 * UIMessage directly.
 *
 * Rules:
 *  - Consecutive rows with the same role collapse into one UIMessage.
 *  - `thinking` blocks become `reasoning` parts.
 *  - Each assistant `tool_use` block pairs with its matching user `tool_result`
 *    (by `tool_use_id`) and emits a single `tool-<name>` part carrying
 *    `input`, `output`, and `state` so the Tool component renders the full call.
 *  - Unmatched `tool_result` rows (can happen during streaming before pairing)
 *    are dropped from the message walk — they'll appear on the next rerender
 *    after the matching tool_use has landed.
 */
export function toUIMessages(rows: ChatMessageRow[]): UIMessage[] {
  const resultByUseId = new Map<string, { content: string; isError: boolean }>();
  for (const r of rows) {
    if (r.role === "user" && r.block_type === "tool_result") {
      const body = safeParse(r.content_json);
      if (typeof body.tool_use_id === "string") {
        resultByUseId.set(body.tool_use_id, {
          content: typeof body.content === "string" ? body.content : "",
          isError: !!body.is_error,
        });
      }
    }
  }

  const messages: UIMessage[] = [];
  let current: UIMessage | null = null;

  for (const r of rows) {
    if (r.role === "user" && r.block_type === "tool_result") continue;

    if (!current || current.role !== r.role) {
      if (current) messages.push(current);
      current = {
        id: String(r.id),
        role: r.role as "user" | "assistant",
        parts: [],
      };
    }

    const body = safeParse(r.content_json);
    switch (r.block_type) {
      case "text":
        current.parts.push({
          type: "text",
          text: typeof body.text === "string" ? body.text : "",
        } as UIMessage["parts"][number]);
        break;
      case "thinking":
        current.parts.push({
          type: "reasoning",
          text: typeof body.text === "string" ? body.text : "",
        } as UIMessage["parts"][number]);
        break;
      case "tool_use": {
        const toolName = typeof body.name === "string" ? body.name : "unknown";
        const toolId = typeof body.id === "string" ? body.id : "";
        const result = resultByUseId.get(toolId);
        current.parts.push({
          type: `tool-${toolName}`,
          toolCallId: toolId,
          input: body.input,
          state: result ? "output-available" : "input-available",
          output: result?.content,
          errorText: result?.isError ? result.content : undefined,
        } as UIMessage["parts"][number]);
        break;
      }
      case "tool_result":
        // handled in first pass; not reached here
        break;
    }
  }
  if (current) messages.push(current);
  return messages;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
