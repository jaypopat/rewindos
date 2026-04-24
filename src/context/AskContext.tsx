import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  askClaudeCancel,
  askClaudeStream,
  buildChatContext,
  claudeDetect,
  createChat,
  getChatMessages,
  getConfig,
  type AskStreamEvent,
  type ChatMessageRow,
} from "@/lib/api";
import { ollamaChat, type OllamaMessage } from "@/lib/ollama-chat";
import { queryKeys } from "@/lib/query-keys";

interface RootConfigShape {
  chat: {
    ollama_url: string;
    model: string;
    temperature: number;
    max_history_messages: number;
  };
}

interface AskContextValue {
  activeChatId: number | null;
  messages: ChatMessageRow[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (text: string) => Promise<void>;
  cancelStream: () => void;
  selectChat: (chatId: number | null) => void;
  startNewChat: () => void;
}

const AskContext = createContext<AskContextValue | null>(null);

export function AskProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [activeChatId, setActiveChatId] = useState<number | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { data: messages = [] } = useQuery({
    queryKey: activeChatId
      ? queryKeys.chatMessages(activeChatId)
      : (["chat-messages", "none"] as const),
    queryFn: () => (activeChatId ? getChatMessages(activeChatId) : Promise.resolve([])),
    enabled: !!activeChatId,
  });

  const selectChat = useCallback((id: number | null) => {
    setActiveChatId(id);
    setError(null);
    abortRef.current?.abort();
  }, []);

  const startNewChat = useCallback(() => {
    setActiveChatId(null);
    setError(null);
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      if (isStreaming || !text.trim()) return;
      setError(null);
      setIsStreaming(true);

      try {
        const claude = await claudeDetect();
        const useClaude = claude.available && claude.mcp_registered;

        let chatId = activeChatId;
        if (chatId == null) {
          const title = text.slice(0, 60).trim() || "New chat";
          chatId = await createChat(title, useClaude ? "claude" : "ollama", null);
          setActiveChatId(chatId);
          qc.invalidateQueries({ queryKey: queryKeys.chats() });
        }

        if (useClaude) {
          await askClaudeStream(chatId, text, (ev) => {
            handleEvent(ev, chatId!, qc, setError);
          });
        } else {
          const ctx = await buildChatContext(text);
          const config = (await getConfig()) as unknown as RootConfigShape;

          await persistUserMessage(chatId, text);
          qc.invalidateQueries({ queryKey: queryKeys.chatMessages(chatId) });

          const prevMessages = messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-config.chat.max_history_messages)
            .map(
              (m) =>
                ({
                  role: m.role,
                  content: parseBlockText(m.content_json, m.block_type),
                }) satisfies OllamaMessage,
            );

          const systemContent = `You are RewindOS. Answer directly. Cite with [REF:ID].\n\nCurrent time: ${new Date().toISOString()}\n\n${ctx.context}`;
          const ollamaMessages: OllamaMessage[] = [
            { role: "system", content: systemContent },
            ...prevMessages,
            { role: "user", content: text },
          ];

          abortRef.current = new AbortController();
          let accumulated = "";
          await ollamaChat({
            baseUrl: config.chat.ollama_url,
            model: config.chat.model,
            temperature: config.chat.temperature,
            messages: ollamaMessages,
            signal: abortRef.current.signal,
            onToken: (token) => {
              accumulated += token;
              qc.setQueryData<ChatMessageRow[]>(
                queryKeys.chatMessages(chatId!),
                (old = []) => {
                  const last = old[old.length - 1];
                  if (last && last.role === "assistant" && last.block_type === "text") {
                    return [
                      ...old.slice(0, -1),
                      { ...last, content_json: JSON.stringify({ text: accumulated }) },
                    ];
                  }
                  return [
                    ...old,
                    {
                      id: -Date.now(),
                      chat_id: chatId!,
                      role: "assistant",
                      block_type: "text",
                      content_json: JSON.stringify({ text: accumulated }),
                      is_partial: true,
                      created_at: Math.floor(Date.now() / 1000),
                    },
                  ];
                },
              );
            },
          });

          await persistAssistantText(chatId, accumulated);
          qc.invalidateQueries({ queryKey: queryKeys.chatMessages(chatId) });
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // Leave partial
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [activeChatId, messages, isStreaming, qc],
  );

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    if (activeChatId != null) {
      askClaudeCancel(activeChatId).catch(() => {});
      qc.invalidateQueries({ queryKey: queryKeys.chatMessages(activeChatId) });
    }
    setIsStreaming(false);
  }, [activeChatId, qc]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const value = useMemo<AskContextValue>(
    () => ({
      activeChatId,
      messages,
      isStreaming,
      error,
      sendMessage,
      cancelStream,
      selectChat,
      startNewChat,
    }),
    [
      activeChatId,
      messages,
      isStreaming,
      error,
      sendMessage,
      cancelStream,
      selectChat,
      startNewChat,
    ],
  );

  return <AskContext.Provider value={value}>{children}</AskContext.Provider>;
}

function handleEvent(
  ev: AskStreamEvent,
  chatId: number,
  qc: ReturnType<typeof useQueryClient>,
  setError: (e: string | null) => void,
) {
  if (ev.type === "error") {
    setError(ev.message);
    return;
  }
  qc.invalidateQueries({ queryKey: queryKeys.chatMessages(chatId) });
}

function parseBlockText(content_json: string, kind: ChatMessageRow["block_type"]): string {
  try {
    const v = JSON.parse(content_json);
    if (kind === "text" || kind === "thinking") return v.text ?? "";
    return "";
  } catch {
    return "";
  }
}

async function persistUserMessage(chatId: number, text: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("append_chat_message", {
    chatId,
    role: "user",
    blockType: "text",
    contentJson: JSON.stringify({ text }),
    isPartial: false,
  });
}

async function persistAssistantText(chatId: number, text: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("append_chat_message", {
    chatId,
    role: "assistant",
    blockType: "text",
    contentJson: JSON.stringify({ text }),
    isPartial: false,
  });
}

export function useAskChat() {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAskChat must be used within AskProvider");
  return ctx;
}
