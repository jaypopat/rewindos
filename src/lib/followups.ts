import type { ChatMessageRow } from "./api";

/**
 * Generate 3 short follow-up questions from the last turn. Ollama-backed in
 * Phase A; Claude-backed (Haiku) is a stub that returns [] — can be filled
 * in later via a dedicated one-shot Tauri command. 3-second timeout.
 * Ephemeral (not persisted).
 */
export async function generateFollowups(params: {
  backend: "claude" | "ollama";
  ollamaUrl?: string;
  ollamaModel?: string;
  lastUserText: string;
  lastAssistantText: string;
}): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const prompt = buildPrompt(params.lastUserText, params.lastAssistantText);
    if (params.backend === "claude") {
      return []; // Phase A: stubbed; Claude Haiku oneshot is a follow-up.
    }
    if (params.ollamaUrl && params.ollamaModel) {
      return await ollamaFollowups(
        params.ollamaUrl,
        params.ollamaModel,
        prompt,
        controller.signal,
      );
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function buildPrompt(userText: string, assistantText: string): string {
  return [
    "Suggest exactly 3 short follow-up questions the user might ask next.",
    "Each question must be under 10 words. Be specific to the topic.",
    "Output ONLY a JSON array of 3 strings, nothing else.",
    "",
    `User asked: ${userText}`,
    "",
    `You answered: ${assistantText.slice(0, 1000)}`,
  ].join("\n");
}

async function ollamaFollowups(
  baseUrl: string,
  model: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    signal,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { temperature: 0.3 },
    }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { message?: { content?: string } };
  const content = data.message?.content ?? "";
  const parsed = tryParseJsonArray(content);
  if (!parsed) return [];
  return parsed
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .slice(0, 3);
}

function tryParseJsonArray(s: string): unknown[] | null {
  const match = s.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const v = JSON.parse(match[0]);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function extractLastTurns(rows: ChatMessageRow[]): {
  lastUserText: string;
  lastAssistantText: string;
} {
  let lastUserText = "";
  let lastAssistantText = "";
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.block_type !== "text") continue;
    try {
      const v = JSON.parse(r.content_json);
      const text = typeof v.text === "string" ? v.text : "";
      if (r.role === "assistant" && !lastAssistantText) lastAssistantText = text;
      else if (r.role === "user" && !lastUserText) lastUserText = text;
      if (lastUserText && lastAssistantText) break;
    } catch {
      // skip
    }
  }
  return { lastUserText, lastAssistantText };
}
