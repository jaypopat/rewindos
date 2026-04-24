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
  askClaudeStreamWithAttachments,
  buildChatContext,
  claudeDetect,
  createChat,
  deleteMessagesAfter,
  getChatMessages,
  getConfig,
  getScreenshotsByIds,
  listChats,
  setModel,
  type AskStreamEvent,
  type Chat,
  type ChatMessageRow,
} from "@/lib/api";
import { ollamaChat, type OllamaMessage } from "@/lib/ollama-chat";
import { queryKeys } from "@/lib/query-keys";
import { decodeAttachments, encodeAttachments } from "@/lib/attachments";
import { extractLastTurns, generateFollowups } from "@/lib/followups";

export interface RootConfigShape {
  chat: {
    ollama_url: string;
    model: string;
    temperature: number;
    max_history_messages: number;
  };
}

interface AskContextValue {
  activeChatId: number | null;
  activeChat: Chat | null;
  messages: ChatMessageRow[];
  isStreaming: boolean;
  error: string | null;
  sendMessage: (text: string, attachedIds?: number[]) => Promise<void>;
  cancelStream: () => void;
  selectChat: (chatId: number | null) => void;
  startNewChat: () => void;
  pendingModel: string | null;
  setPendingModel: (model: string | null) => void;
  followups: string[];
  regenerate: () => Promise<void>;
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

  const { data: activeChat = null } = useQuery<Chat | null>({
    queryKey: activeChatId
      ? (["chat", activeChatId] as const)
      : (["chat", "none"] as const),
    queryFn: async () => {
      if (!activeChatId) return null;
      const chats = await listChats(200);
      return chats.find((c) => c.id === activeChatId) ?? null;
    },
    enabled: !!activeChatId,
  });

  const { data: appConfig } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: getConfig,
  });

  const [pendingModel, setPendingModelState] = useState<string | null>(null);
  const setPendingModel = useCallback((m: string | null) => {
    setPendingModelState(m);
  }, []);

  const [followups, setFollowups] = useState<string[]>([]);

  // Keep a fresh ref so the finally-block IIFE can check whether the user
  // switched chats during follow-up generation without closure staleness.
  const activeChatIdRef = useRef<number | null>(activeChatId);
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  const selectChat = useCallback((id: number | null) => {
    setActiveChatId(id);
    setError(null);
    setFollowups([]);
    abortRef.current?.abort();
  }, []);

  const startNewChat = useCallback(() => {
    setActiveChatId(null);
    setError(null);
    setFollowups([]);
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(
    async (text: string, attachedIds: number[] = []) => {
      if (isStreaming || !text.trim()) return;
      setError(null);
      setFollowups([]);
      setIsStreaming(true);

      // Hoisted so the `finally` block can reference the id actually used for this send.
      // Reading `activeChatId` again in finally could be stale if the user navigated.
      let chatId: number | null = activeChatId;
      let useClaude = false;
      try {
        const claude = await claudeDetect();
        useClaude = claude.available && claude.mcp_registered;

        // Build attachment context FIRST — if daemon fails here, we haven't created a chat stub
        // and the user won't see an orphan "New chat" row in the sidebar.
        const expandedText = await buildAttachedContext(attachedIds, text);
        const storedText = encodeAttachments(attachedIds, text);

        // effectiveModel: what this SEND should use. For existing chats, use the persisted chat.model.
        // For new chats, use the user's pick (pendingModel) or the backend default. Lifted above the
        // new-chat block so it's available later for the Ollama/Claude dispatch — reading activeChat
        // at call-time would be stale (useCallback closure captures the old value).
        const backendDefault = useClaude
          ? "sonnet"
          : (appConfig as RootConfigShape | undefined)?.chat.model ?? "";
        const effectiveModel =
          activeChat?.model ?? pendingModel ?? backendDefault;

        if (chatId == null) {
          const title = text.slice(0, 60).trim() || "New chat";
          chatId = await createChat(title, useClaude ? "claude" : "ollama", null);
          setActiveChatId(chatId);
          if (effectiveModel) {
            await setModel(chatId, effectiveModel);
          }
          setPendingModelState(null);
          qc.invalidateQueries({ queryKey: queryKeys.chats() });
          qc.invalidateQueries({ queryKey: ["chat", chatId] as const });
        }

        if (useClaude) {
          if (attachedIds.length > 0) {
            await askClaudeStreamWithAttachments(
              chatId,
              storedText,
              expandedText,
              (ev) => handleEvent(ev, chatId!, qc, setError),
            );
          } else {
            await askClaudeStream(chatId, text, (ev) =>
              handleEvent(ev, chatId!, qc, setError),
            );
          }
        } else {
          const ctx = await buildChatContext(text);
          const config = (await getConfig()) as unknown as RootConfigShape;

          await persistUserMessage(chatId, storedText);
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
            { role: "user", content: expandedText },
          ];

          abortRef.current = new AbortController();
          let accumulated = "";
          await ollamaChat({
            baseUrl: config.chat.ollama_url,
            model: effectiveModel || config.chat.model,
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

        if (chatId != null) {
          void (async () => {
            const chatIdSnapshot = chatId!;
            const rows = await getChatMessages(chatIdSnapshot);
            const { lastUserText, lastAssistantText } = extractLastTurns(rows);
            if (!lastAssistantText) return;
            const backend = activeChat?.backend ?? (useClaude ? "claude" : "ollama");
            const suggestions = await generateFollowups({
              backend,
              ollamaUrl: (appConfig as RootConfigShape | undefined)?.chat.ollama_url,
              ollamaModel: activeChat?.model ?? (appConfig as RootConfigShape | undefined)?.chat.model,
              lastUserText,
              lastAssistantText,
            });
            // Prevent cross-chat bleed: if the user switched chats during
            // follow-up generation, drop these suggestions on the floor.
            if (activeChatIdRef.current === chatIdSnapshot) {
              setFollowups(suggestions);
            }
          })();
        }
      }
    },
    [activeChatId, activeChat, messages, isStreaming, pendingModel, appConfig, qc],
  );

  const cancelStream = useCallback(() => {
    abortRef.current?.abort();
    if (activeChatId != null) {
      askClaudeCancel(activeChatId).catch(() => {});
      qc.invalidateQueries({ queryKey: queryKeys.chatMessages(activeChatId) });
    }
    setIsStreaming(false);
  }, [activeChatId, qc]);

  const regenerate = useCallback(async () => {
    if (!activeChatId) return;
    const rows = await getChatMessages(activeChatId);
    let lastUserRow: ChatMessageRow | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.role === "user" && r.block_type === "text") {
        lastUserRow = r;
        break;
      }
    }
    if (!lastUserRow) return;

    let userText = "";
    let attachedIds: number[] = [];
    try {
      const v = JSON.parse(lastUserRow.content_json);
      const raw = typeof v.text === "string" ? v.text : "";
      const decoded = decodeAttachments(raw);
      userText = decoded.text;
      attachedIds = decoded.ids;
    } catch {
      return;
    }

    // Delete the last user row AND everything after. sendMessage will
    // re-persist the user message as part of its normal flow. Wrap in
    // try/catch so a db/IPC failure surfaces in the error banner instead
    // of silently propagating as an unhandled rejection.
    try {
      await deleteMessagesAfter(activeChatId, lastUserRow.id - 1);
      qc.invalidateQueries({ queryKey: queryKeys.chatMessages(activeChatId) });
    } catch (e) {
      setError(`regenerate failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await sendMessage(userText, attachedIds);
  }, [activeChatId, qc, sendMessage]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const value = useMemo<AskContextValue>(
    () => ({
      activeChatId,
      activeChat,
      messages,
      isStreaming,
      error,
      sendMessage,
      cancelStream,
      selectChat,
      startNewChat,
      pendingModel,
      setPendingModel,
      followups,
      regenerate,
    }),
    [
      activeChatId,
      activeChat,
      messages,
      isStreaming,
      error,
      sendMessage,
      cancelStream,
      selectChat,
      startNewChat,
      pendingModel,
      setPendingModel,
      followups,
      regenerate,
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

async function buildAttachedContext(ids: number[], userText: string): Promise<string> {
  if (ids.length === 0) return userText;
  const shots = await getScreenshotsByIds(ids);
  const lines = shots.map((s) => {
    const ts = new Date(s.timestamp * 1000).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const app = s.app_name ?? "unknown";
    const title = s.window_title ? ` — ${s.window_title}` : "";
    return `- #${s.id} (${ts}, ${app}${title})`;
  });
  return [
    "[Attached screenshots — the user pinned these as context]",
    ...lines,
    "[End attached screenshots]",
    "",
    userText,
  ].join("\n");
}
