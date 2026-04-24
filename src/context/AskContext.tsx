import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  askClaude,
  askClaudeCancel,
  buildChatContext,
  claudeDetect,
  getConfig,
  type ScreenshotRef,
} from "@/lib/api";
import { ollamaChat, type OllamaMessage } from "@/lib/ollama-chat";

let nextMsgId = 0;

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  references?: ScreenshotRef[];
}

interface ChatConfigShape {
  ollama_url: string;
  model: string;
  temperature: number;
  max_history_messages: number;
}

interface RootConfigShape {
  chat: ChatConfigShape;
}

const SYSTEM_PROMPT = `You are RewindOS, a local AI assistant with access to the user's screen capture history. You answer questions about what the user has seen, done, and worked on — based on OCR text extracted from periodic screenshots.

## Core Rules
- Answer directly. Start with the answer, not preamble.
- When referencing a specific screenshot, use [REF:ID] format (e.g. [REF:42]).
- Be specific: mention timestamps, window titles, app names.
- Use markdown formatting.
- Never fabricate information not present in the context.
- If context has no relevant data, say "I don't have enough screen history for that time period."

## Format
- Keep answers under 300 words.
- No filler phrases like "Based on the context" or "Let me analyze".
- NEVER just rephrase the user's question.`;

interface AskContextValue {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  cancelStream: () => void;
  newSession: () => void;
}

const AskContext = createContext<AskContextValue | null>(null);

export function AskProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionIdRef = useRef<string>(crypto.randomUUID());
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      if (isStreaming || !text.trim()) return;

      setError(null);
      setIsStreaming(true);

      setMessages((prev) => [
        ...prev,
        { id: nextMsgId++, role: "user", content: text },
        { id: nextMsgId++, role: "assistant", content: "" },
      ]);

      try {
        const ctx = await buildChatContext(text);

        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, references: ctx.references }];
          }
          return prev;
        });

        const claude = await claudeDetect();
        const useClaude = claude.available && claude.mcp_registered;

        if (useClaude) {
          const prompt = `${SYSTEM_PROMPT}\n\nCurrent time: ${new Date().toISOString()}\n\n${ctx.context}\n\nUser question: ${text}`;
          const response = await askClaude(sessionIdRef.current, prompt);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant") {
              return [...prev.slice(0, -1), { ...last, content: response }];
            }
            return prev;
          });
        } else {
          const config = (await getConfig()) as unknown as RootConfigShape;
          const historyMessages: OllamaMessage[] = messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-config.chat.max_history_messages)
            .map((m) => ({ role: m.role, content: m.content }));

          const ollamaMessages: OllamaMessage[] = [
            {
              role: "system",
              content: `${SYSTEM_PROMPT}\n\nCurrent time: ${new Date().toISOString()}\n\n${ctx.context}`,
            },
            ...historyMessages,
            { role: "user", content: text },
          ];

          abortRef.current = new AbortController();

          await ollamaChat({
            baseUrl: config.chat.ollama_url,
            model: config.chat.model,
            temperature: config.chat.temperature,
            messages: ollamaMessages,
            signal: abortRef.current.signal,
            onToken: (token) => {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.role === "assistant") {
                  return [...prev.slice(0, -1), { ...last, content: last.content + token }];
                }
                return prev;
              });
            },
          });
        }
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // Cancelled — leave partial response intact
        } else {
          setError(e instanceof Error ? e.message : String(e));
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === "assistant" && last.content === "") {
              return prev.slice(0, -1);
            }
            return prev;
          });
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [isStreaming, messages],
  );

  const cancelStream = useCallback(() => {
    if (!isStreaming) return;
    abortRef.current?.abort();
    askClaudeCancel(sessionIdRef.current).catch(() => {});
    setIsStreaming(false);
  }, [isStreaming]);

  const newSession = useCallback(() => {
    setMessages([]);
    setError(null);
    setIsStreaming(false);
    abortRef.current?.abort();
    sessionIdRef.current = crypto.randomUUID();
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return (
    <AskContext.Provider value={{ messages, isStreaming, error, sendMessage, cancelStream, newSession }}>
      {children}
    </AskContext.Provider>
  );
}

export function useAskChat() {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAskChat must be used within AskProvider");
  return ctx;
}
