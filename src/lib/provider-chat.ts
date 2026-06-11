export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderChatOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  messages: ProviderMessage[];
  signal: AbortSignal;
  onToken: (token: string) => void;
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Stream a chat completion from any OpenAI-compatible endpoint (SSE). */
export async function providerChat(opts: ProviderChatOptions): Promise<string> {
  const response = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(opts.apiKey) },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
      temperature: opts.temperature,
    }),
  });

  if (!response.ok) {
    throw new Error(`provider returned ${response.status}: ${await response.text()}`);
  }

  const body = response.body;
  if (!body) throw new Error("No response body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return full;

        try {
          const obj = JSON.parse(payload);
          if (obj?.error) {
            throw new Error(String(obj.error.message ?? "provider stream error"));
          }
          const token = obj?.choices?.[0]?.delta?.content ?? "";
          if (token) {
            full += token;
            opts.onToken(token);
          }
          if (obj?.choices?.[0]?.finish_reason != null) return full;
        } catch (e) {
          if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
          // Skip malformed lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return full;
}

/** Probe an OpenAI-compatible endpoint (GET /models). */
export async function providerHealth(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
