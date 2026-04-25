import { describe, it, expect } from "vitest";
import { toUIMessages } from "./chat-messages";
import type { ChatMessageRow } from "./api";

function row(p: Partial<ChatMessageRow>): ChatMessageRow {
  return {
    id: 1,
    chat_id: 1,
    role: "user",
    block_type: "text",
    content_json: "{}",
    is_partial: false,
    created_at: 0,
    ...p,
  };
}

describe("toUIMessages", () => {
  it("returns empty array for no rows", () => {
    expect(toUIMessages([])).toEqual([]);
  });

  it("collapses consecutive same-role blocks into one message", () => {
    const msgs = toUIMessages([
      row({ id: 1, role: "assistant", block_type: "text", content_json: '{"text":"hi"}' }),
      row({ id: 2, role: "assistant", block_type: "text", content_json: '{"text":" there"}' }),
      row({ id: 3, role: "user", block_type: "text", content_json: '{"text":"ok"}' }),
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].parts).toHaveLength(2);
    expect(msgs[1].role).toBe("user");
  });

  it("maps thinking to reasoning", () => {
    const msgs = toUIMessages([
      row({
        id: 1,
        role: "assistant",
        block_type: "thinking",
        content_json: '{"text":"pondering"}',
      }),
    ]);
    const part = msgs[0].parts[0];
    expect(part.type).toBe("reasoning");
    if (part.type !== "reasoning") throw new Error("expected reasoning part");
    expect(part.text).toBe("pondering");
  });

  it("pairs tool_use with tool_result into a single tool-<name> part", () => {
    const msgs = toUIMessages([
      row({
        id: 1,
        role: "assistant",
        block_type: "tool_use",
        content_json:
          '{"id":"tu_1","name":"search_screenshots","input":{"query":"rust"}}',
      }),
      row({
        id: 2,
        role: "user",
        block_type: "tool_result",
        content_json: '{"tool_use_id":"tu_1","content":"3 hits"}',
      }),
      row({
        id: 3,
        role: "assistant",
        block_type: "text",
        content_json: '{"text":"Found rust."}',
      }),
    ]);
    // tool_result is absorbed into the adjacent assistant block via lookup
    expect(msgs).toHaveLength(1);
    const parts = msgs[0].parts;
    expect(parts).toHaveLength(2);
    const toolPart = parts[0];
    if (toolPart.type === "text" || toolPart.type === "reasoning") {
      throw new Error("expected tool part");
    }
    expect(toolPart.type).toBe("tool-search_screenshots");
    expect(toolPart.state).toBe("output-available");
    expect(toolPart.output).toBe("3 hits");
    expect(toolPart.input).toEqual({ query: "rust" });
    expect(parts[1].type).toBe("text");
  });

  it("emits tool part with input-available state when result has not arrived", () => {
    const msgs = toUIMessages([
      row({
        id: 1,
        role: "assistant",
        block_type: "tool_use",
        content_json:
          '{"id":"tu_1","name":"get_timeline","input":{"start_time":0,"end_time":1}}',
      }),
    ]);
    const part = msgs[0].parts[0];
    if (part.type === "text" || part.type === "reasoning") {
      throw new Error("expected tool part");
    }
    expect(part.state).toBe("input-available");
    expect(part.output).toBeUndefined();
  });

  it("surfaces tool errors via errorText", () => {
    const msgs = toUIMessages([
      row({
        id: 1,
        role: "assistant",
        block_type: "tool_use",
        content_json: '{"id":"tu_1","name":"x","input":{}}',
      }),
      row({
        id: 2,
        role: "user",
        block_type: "tool_result",
        content_json: '{"tool_use_id":"tu_1","content":"boom","is_error":true}',
      }),
    ]);
    const part = msgs[0].parts[0];
    if (part.type === "text" || part.type === "reasoning") {
      throw new Error("expected tool part");
    }
    expect(part.errorText).toBe("boom");
  });
});
