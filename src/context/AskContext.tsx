import {
  createContext,
  use,
  useCallback,
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
  type ChatRole,
} from "@/lib/api";
import { invoke } from "@tauri-apps/api/core";
import { resolveChatRoute } from "@/lib/claude-models";
import { ollamaChat, type OllamaMessage } from "@/lib/ollama-chat";
import { queryKeys } from "@/lib/query-keys";
import { decodeAttachments, encodeAttachments } from "@/lib/attachments";

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

  const [pendingModel, setPendingModel] = useState<string | null>(null);

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
    async (text: string, attachedIds: number[] = []) => {
      if (isStreaming || !text.trim()) return;
      setError(null);
      setIsStreaming(true);

      let chatId: number | null = activeChatId;
      let useClaude = false;
      let accumulated = "";
      try {
        const claude = await claudeDetect();
        const claudeReady = claude.available && claude.mcp_registered;

        // Build attachment context FIRST — if daemon fails here, we haven't created a chat stub
        // and the user won't see an orphan "New chat" row in the sidebar.
        const expandedText = await buildAttachedContext(attachedIds, text);
        const storedText = encodeAttachments(attachedIds, text);

        // Route by the SELECTED model, not by whether Claude is installed. An explicit pick
        // (chat.model for existing chats, pendingModel for new ones) decides the backend; with
        // no pick we default to Claude when ready, else the local Ollama model. activeChat is
        // read here rather than threaded in because the useCallback closure captures it.
        const route = resolveChatRoute({
          selectedModel: activeChat?.model ?? pendingModel ?? null,
          claudeReady,
          ollamaDefaultModel: appConfig?.chat.model ?? "",
        });
        const effectiveModel = route.model;
        useClaude = route.provider === "claude";

        // A Claude model was picked but the CLI/MCP server isn't available — fail loudly
        // instead of silently routing a Claude alias to Ollama (which would 404 the model).
        if (useClaude && !claudeReady) {
          throw new Error(
            "Claude Code isn't available. Enable it in Settings → AI, or pick a local Ollama model.",
          );
        }

        if (chatId == null) {
          const title = text.slice(0, 60).trim() || "New chat";
          chatId = await createChat(title, useClaude ? "claude" : "ollama", null);
          setActiveChatId(chatId);
          if (effectiveModel) {
            await setModel(chatId, effectiveModel);
          }
          setPendingModel(null);
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
          const [ctx, config] = await Promise.all([
            buildChatContext(text),
            getConfig(),
          ]);

          await persistTextMessage(chatId, "user", storedText);
          qc.invalidateQueries({ queryKey: queryKeys.chatMessages(chatId) });

          // History must come from the DB, not the render-closure query
          // snapshot — `messages` can be a refetch cycle behind after the
          // awaits above. Drop the user row just persisted; it is appended
          // below as the live turn.
          const allRows = await getChatMessages(chatId);
          const prevMessages = allRows
            .slice(0, -1)
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-config.chat.max_history_messages)
            .map(
              (m) =>
                ({
                  role: m.role,
                  content: parseBlockText(m.content_json, m.block_type),
                }) satisfies OllamaMessage,
            );

          const systemContent = `You are RewindOS. Answer directly. Cite screenshots with [REF:ID]. Context may include meeting transcripts ("You" = the user, "Remote" = the other party) — use them when the question concerns conversations or meetings.\n\nCurrent time: ${new Date().toISOString()}\n\n${ctx.context}`;
          const ollamaMessages: OllamaMessage[] = [
            { role: "system", content: systemContent },
            ...prevMessages,
            { role: "user", content: expandedText },
          ];

          abortRef.current = new AbortController();
          await ollamaChat({
            baseUrl: config.chat.base_url,
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

          await persistTextMessage(chatId, "assistant", accumulated);
          qc.invalidateQueries({ queryKey: queryKeys.chatMessages(chatId) });
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // Keep what streamed: persist the partial text, then refetch so
          // the optimistic is_partial row is replaced by the real DB row
          // instead of leaking into the next turn's context.
          if (chatId != null) {
            if (accumulated) {
              await persistTextMessage(chatId, "assistant", accumulated).catch(() => {});
            }
            qc.invalidateQueries({ queryKey: queryKeys.chatMessages(chatId) });
          }
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [activeChatId, activeChat, isStreaming, pendingModel, appConfig, qc],
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
      regenerate,
    ],
  );

  return <AskContext value={value}>{children}</AskContext>;
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

async function persistTextMessage(
  chatId: number,
  role: ChatRole,
  text: string,
): Promise<void> {
  await invoke("append_chat_message", {
    chatId,
    role,
    blockType: "text",
    contentJson: JSON.stringify({ text }),
    isPartial: false,
  });
}

export function useAskChat() {
  const ctx = use(AskContext);
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
