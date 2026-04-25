import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Paperclip } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { claudeDetect, getConfig, getScreenshotsByIds } from "@/lib/api";
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

export function AskView({ onSelectScreenshot }: AskViewProps) {
  const { messages, isStreaming, error, sendMessage, cancelStream } = useAskChat();
  const [input, setInput] = useState("");
  const [attachedIds, setAttachedIds] = useState<number[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

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
      <ChatSidebar />

      <div className="flex-1 flex flex-col min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-2.5 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "w-1.5 h-1.5 transition-colors",
                chatReady ? "bg-signal-success animate-pulse-glow" : "bg-signal-error",
              )}
            />
            <span className="font-mono text-xs text-text-primary uppercase tracking-[0.2em]">
              ask
            </span>
            <span className="text-border">·</span>
            <AskModelPicker />
          </div>
        </div>

        {/* Messages or empty state */}
        {messages.length === 0 ? (
          <AskEmptyState onSuggest={submit} />
        ) : (
          <AskMessages
            rows={messages}
            onSelectScreenshot={onSelectScreenshot}
            onSelectSuggestion={submit}
          />
        )}

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="px-6 py-1.5 shrink-0 flex items-center gap-2 text-semantic border-t border-border/30">
            <Loader2 className="size-3 animate-spin" />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em]">
              thinking
            </span>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mx-6 mb-2 px-3 py-2 border border-signal-error/30 bg-signal-error/5 shrink-0">
            <div className="flex items-start gap-2">
              <span className="font-mono text-[10px] text-signal-error uppercase tracking-wider mt-0.5 shrink-0">
                err
              </span>
              <span className="text-xs text-signal-error/90">{error}</span>
            </div>
          </div>
        )}

        {/* Prompt */}
        <div className="border-t border-border/50 px-6 py-4 shrink-0 bg-surface-raised/20">
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
              className="border border-border/50 bg-surface-raised/40 focus-within:border-semantic/40 transition-colors rounded-none"
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
              <PromptInputFooter className="px-3 pb-2 pt-1 rounded-none">
                <div className="flex items-center gap-3 text-text-muted">
                  <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    disabled={isStreaming || !chatReady}
                    className="text-text-muted hover:text-semantic disabled:opacity-40 disabled:hover:text-text-muted transition-colors"
                    title="attach screenshot"
                    aria-label="attach screenshot"
                  >
                    <Paperclip className="size-4" />
                  </button>
                  <span className="font-mono text-[10px] uppercase tracking-wider">
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
