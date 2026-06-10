import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Paperclip, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { queryKeys } from "@/lib/query-keys";
import { claudeDetect, getConfig, getScreenshotsByIds, listChats } from "@/lib/api";
import { ollamaHealth } from "@/lib/ollama-chat";
import { useAskChat } from "@/context/AskContext";
import { AskMessages } from "./AskMessages";
import { AskEmptyState } from "./AskEmptyState";
import { AskModelPicker } from "./AskModelPicker";
import { AttachmentPicker } from "./AttachmentPicker";
import { ChatSidebar } from "./ChatSidebar";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentInfo,
  AttachmentRemove,
  type AttachmentData,
} from "@/components/ai-elements/attachments";

interface AskViewProps {
  onSelectScreenshot: (id: number) => void;
}

const CHATS_OPEN_KEY = "rewindos-ask-chats-open";

export function AskView({ onSelectScreenshot }: AskViewProps) {
  const { messages, isStreaming, error, sendMessage, cancelStream, startNewChat } = useAskChat();
  const [input, setInput] = useState("");
  const [attachedIds, setAttachedIds] = useState<number[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  // The chat list is navigation history, not always-on content — one sidebar
  // at rest, two only on request.
  const [chatsOpen, setChatsOpen] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(CHATS_OPEN_KEY) === "1",
  );
  const toggleChats = () => {
    setChatsOpen((c) => {
      localStorage.setItem(CHATS_OPEN_KEY, c ? "0" : "1");
      return !c;
    });
  };

  const { data: chats = [] } = useQuery({
    queryKey: queryKeys.chats(),
    queryFn: () => listChats(200),
    staleTime: 5_000,
  });

  const { data: attachedShots = [] } = useQuery({
    queryKey: queryKeys.screenshotsByIds(attachedIds),
    queryFn: () => getScreenshotsByIds(attachedIds),
    enabled: attachedIds.length > 0,
    staleTime: 60_000,
  });

  const attachmentData: AttachmentData[] = attachedShots.map((s) => ({
    type: "file",
    id: String(s.id),
    url: convertFileSrc(s.thumbnail_path ?? s.file_path),
    filename: `#${s.id} · ${s.app_name ?? "unknown"}`,
    mediaType: "image/webp",
  })) as AttachmentData[];

  const { data: config } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: getConfig,
  });

  const { data: ollamaOnline = false } = useQuery({
    queryKey: queryKeys.ollamaHealth(),
    queryFn: () =>
      config
        ? ollamaHealth(config.chat.ollama_url)
        : false,
    enabled: !!config,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: claudeStatus } = useQuery({
    queryKey: queryKeys.claudeStatus(),
    queryFn: claudeDetect,
    refetchInterval: 60_000,
  });

  const usingClaude = !!(claudeStatus?.available && claudeStatus.mcp_registered);
  const chatReady = usingClaude || ollamaOnline;

  const submit = useCallback(
    async (textOverride?: string) => {
      const msg = (textOverride ?? input).trim();
      if (!msg || isStreaming || !chatReady) return;
      const idsAtSend = attachedIds;
      try {
        await sendMessage(msg, idsAtSend);
        setInput("");
        setAttachedIds([]);
      } catch {
        // leave input + attachments in place so user can retry
      }
    },
    [input, isStreaming, chatReady, sendMessage, attachedIds],
  );

  const onPromptSubmit = useCallback(
    (msg: { text: string }) => {
      submit(msg.text);
    },
    [submit],
  );

  return (
    <div className="flex-1 flex min-h-0">
      {chatsOpen && <ChatSidebar />}

      <div className="flex-1 flex flex-col min-h-0">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 h-12 border-b border-line shrink-0">
          <button
            onClick={toggleChats}
            title={chatsOpen ? "Hide chat history" : "Show chat history"}
            className="flex items-center gap-2 h-8 px-2.5 rounded-[7px] text-text-muted hover:text-text-primary hover:bg-panel transition-colors"
          >
            {chatsOpen ? (
              <PanelLeftClose className="size-4" strokeWidth={1.7} />
            ) : (
              <PanelLeftOpen className="size-4" strokeWidth={1.7} />
            )}
            <span className="text-[12.5px] font-[450]">Chats</span>
            {chats.length > 0 && (
              <span className="font-mono text-[10px] text-text-faint">{chats.length}</span>
            )}
          </button>
          <span className="w-px h-4 bg-line-2" />
          <AskModelPicker />
          <button
            onClick={startNewChat}
            title="New chat"
            className="ml-auto flex items-center gap-1.5 h-8 px-2.5 rounded-[7px] text-text-muted hover:text-text-primary hover:bg-panel transition-colors"
          >
            <Plus className="size-4" strokeWidth={1.7} />
            <span className="text-[12.5px] font-[450]">New chat</span>
          </button>
        </div>

        {/* Messages or empty state */}
        {messages.length === 0 ? (
          <AskEmptyState onSuggest={submit} />
        ) : (
          <AskMessages
            rows={messages}
            onSelectScreenshot={onSelectScreenshot}
          />
        )}

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="px-7 py-1.5 shrink-0 flex items-center gap-2 text-accent-hi border-t border-line">
            <Loader2 className="size-3 animate-spin" />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em]">
              thinking
            </span>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mx-7 mb-2 px-3.5 py-2.5 rounded-lg border border-signal-error/30 bg-signal-error/5 shrink-0">
            <div className="flex items-start gap-2">
              <span className="font-mono text-[10px] text-signal-error uppercase tracking-wider mt-0.5 shrink-0">
                err
              </span>
              <span className="text-xs text-signal-error/90">{error}</span>
            </div>
          </div>
        )}

        {/* Prompt */}
        <div className="border-t border-line px-7 py-4 shrink-0">
          <div className="max-w-3xl mx-auto">
            {attachedIds.length > 0 && (
              <div className="mb-2">
                <Attachments variant="inline">
                  {attachmentData.map((data) => (
                    <Attachment
                      key={data.id}
                      data={data}
                      onRemove={() =>
                        setAttachedIds((prev) =>
                          prev.filter((x) => String(x) !== data.id),
                        )
                      }
                    >
                      <AttachmentPreview />
                      <AttachmentInfo />
                      <AttachmentRemove />
                    </Attachment>
                  ))}
                </Attachments>
              </div>
            )}
            <PromptInput
              onSubmit={onPromptSubmit}
              className="border border-line-2 bg-surface-raised focus-within:border-line-hi transition-colors rounded-xl"
            >
              <PromptInputTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  !chatReady
                    ? "connect claude or start ollama to chat"
                    : isStreaming
                      ? "claude is thinking…"
                      : usingClaude
                        ? "ask about your screen history — uses MCP tools"
                        : "ask about your screen history"
                }
                disabled={isStreaming || !chatReady}
                className="font-sans text-sm"
              />
              <PromptInputFooter className="px-3 pb-2 pt-1">
                <div className="flex items-center gap-3 text-text-muted">
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    disabled={isStreaming || !chatReady}
                    className="text-text-muted hover:text-accent-hi disabled:opacity-40 disabled:hover:text-text-muted transition-colors"
                    title="attach screenshot"
                    aria-label="attach screenshot"
                  >
                    <Paperclip className="size-4" strokeWidth={1.7} />
                  </button>
                  <span className="font-mono text-[10px] text-text-faint">
                    {usingClaude ? "⇧⏎ newline · ⏎ send" : "⏎ send"}
                  </span>
                </div>
                <PromptInputSubmit
                  disabled={!chatReady || (!isStreaming && !input.trim())}
                  status={isStreaming ? "streaming" : "ready"}
                  onStop={cancelStream}
                />
              </PromptInputFooter>
            </PromptInput>
            <p className="font-mono text-[9.5px] text-text-faint mt-2.5 text-center">
              {usingClaude
                ? "Claude answers through MCP tools over your local index."
                : "Answers are generated locally from your captures. Nothing is sent off-device."}
            </p>
          </div>
        </div>
      </div>

      <AttachmentPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onAttach={(ids) =>
          setAttachedIds((prev) => Array.from(new Set([...prev, ...ids])))
        }
      />
    </div>
  );
}
