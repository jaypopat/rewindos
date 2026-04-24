import { Streamdown } from "streamdown";
import { useQuery } from "@tanstack/react-query";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentInfo,
  type AttachmentData,
} from "@/components/ai-elements/attachments";
import { toUIMessages } from "@/lib/chat-messages";
import { getScreenshotsByIds, type ChatMessageRow } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { decodeAttachments, stripMarker } from "@/lib/attachments";
import type { ToolUIPart } from "ai";
import { cn } from "@/lib/utils";
import { parseTextWithRefs, collectRefs } from "@/lib/citations";
import { CitationChip } from "./CitationChip";
import { CitationSources } from "./CitationSources";
import { MessageActions } from "./MessageActions";
import { FollowupSuggestions } from "./FollowupSuggestions";
import { useAskChat } from "@/context/AskContext";

interface AskMessagesProps {
  rows: ChatMessageRow[];
  onSelectScreenshot?: (id: number) => void;
  onSelectSuggestion?: (text: string) => void;
}

function RoleHeader({ role }: { role: "user" | "assistant" }) {
  const isUser = role === "user";
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <div
        className={cn(
          "w-1.5 h-1.5",
          isUser ? "bg-accent" : "bg-semantic",
        )}
      />
      <span
        className={cn(
          "font-mono text-[10px] uppercase tracking-[0.2em]",
          isUser ? "text-accent" : "text-semantic",
        )}
      >
        {isUser ? "you" : "rewindos"}
      </span>
    </div>
  );
}

const ASSISTANT_PROSE =
  "text-sm text-text-secondary leading-relaxed " +
  "[&>p]:my-1.5 [&>ul]:my-1.5 [&>ol]:my-1.5 [&>pre]:my-2 " +
  "[&>h1]:text-base [&>h1]:font-semibold [&>h1]:text-text-primary [&>h1]:mt-3 [&>h1]:mb-1 " +
  "[&>h2]:text-sm [&>h2]:font-semibold [&>h2]:text-text-primary [&>h2]:mt-2 [&>h2]:mb-1 " +
  "[&>h3]:text-sm [&>h3]:font-medium [&>h3]:text-text-primary [&>h3]:mt-2 [&>h3]:mb-0.5 " +
  "[&>blockquote]:border-l-2 [&>blockquote]:border-semantic/30 [&>blockquote]:pl-3 [&>blockquote]:text-text-muted [&>blockquote]:italic " +
  "[&_code]:font-mono [&_code]:text-xs [&_code]:bg-surface-overlay [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-accent [&_code]:rounded-sm " +
  "[&_a]:text-accent [&_a]:hover:underline " +
  "[&_strong]:text-text-primary [&_strong]:font-semibold " +
  "[&_ul]:list-disc [&_ul]:list-inside [&_ol]:list-decimal [&_ol]:list-inside [&_li]:text-text-secondary";

export function AskMessages({ rows, onSelectScreenshot, onSelectSuggestion }: AskMessagesProps) {
  const messages = toUIMessages(rows);
  const { followups, regenerate } = useAskChat();

  return (
    <Conversation className="flex-1 min-h-0">
      <ConversationContent className="max-w-3xl mx-auto w-full px-6 py-5 space-y-5">
        {messages.map((m, idx) => {
          const isUser = m.role === "user";
          const isLast = idx === messages.length - 1;
          return (
            <div key={m.id} className="animate-fade-in">
              <RoleHeader role={m.role as "user" | "assistant"} />
              <div
                className={cn(
                  "pl-3.5 border-l space-y-2",
                  isUser ? "border-accent/30" : "border-semantic/20",
                )}
              >
                {m.parts.map((part, i) => {
                  const key = `${m.id}-${i}`;
                  const anyPart = part as Record<string, unknown>;
                  const type = anyPart.type;

                  if (type === "text") {
                    const text = (anyPart.text as string) ?? "";
                    if (isUser) {
                      return (
                        <UserTextWithAttachments
                          key={key}
                          text={text}
                          onSelectScreenshot={onSelectScreenshot}
                        />
                      );
                    }
                    return (
                      <AssistantTextWithCitations
                        key={key}
                        text={text}
                        onSelectScreenshot={onSelectScreenshot}
                      />
                    );
                  }

                  if (type === "reasoning") {
                    return (
                      <Reasoning
                        key={key}
                        className="border border-border/30 bg-surface-raised/10 rounded-none"
                      >
                        <ReasoningTrigger />
                        <ReasoningContent>
                          {(anyPart.text as string) ?? ""}
                        </ReasoningContent>
                      </Reasoning>
                    );
                  }

                  if (typeof type === "string" && type.startsWith("tool-")) {
                    const toolType = type as ToolUIPart["type"];
                    const state = anyPart.state as ToolUIPart["state"];
                    const output = anyPart.output;
                    const errorText = anyPart.errorText as string | undefined;
                    return (
                      <Tool
                        key={key}
                        defaultOpen={false}
                        className="border border-border/40 bg-surface-raised/20 rounded-none"
                      >
                        <ToolHeader type={toolType} state={state} />
                        <ToolContent>
                          <ToolInput input={anyPart.input} />
                          {output !== undefined && (
                            <ToolOutput output={output} errorText={errorText} />
                          )}
                        </ToolContent>
                      </Tool>
                    );
                  }

                  return null;
                })}
              </div>
              {!isUser && isLast && (
                <div className="pl-3.5 mt-2">
                  <MessageActions
                    onCopy={() => {
                      const allText = m.parts
                        .map((p) => {
                          const a = p as Record<string, unknown>;
                          if (a.type === "text") return a.text as string;
                          return "";
                        })
                        .filter(Boolean)
                        .join("\n\n");
                      navigator.clipboard.writeText(stripMarker(allText));
                    }}
                    onRegenerate={() => void regenerate()}
                  />
                  <FollowupSuggestions
                    suggestions={followups}
                    onSelect={(t) => onSelectSuggestion?.(t)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function AssistantTextWithCitations({
  text,
  onSelectScreenshot,
}: {
  text: string;
  onSelectScreenshot?: (id: number) => void;
}) {
  const parts = parseTextWithRefs(text);
  const refIds = collectRefs(parts);
  return (
    <>
      <div className={ASSISTANT_PROSE}>
        {parts.map((p, i) =>
          p.type === "text" ? (
            <Streamdown key={i}>{p.text}</Streamdown>
          ) : (
            <CitationChip key={i} id={p.id} onClick={onSelectScreenshot} />
          ),
        )}
      </div>
      {refIds.length > 0 && (
        <CitationSources ids={refIds} onSelect={onSelectScreenshot} />
      )}
    </>
  );
}

function UserTextWithAttachments({
  text,
  onSelectScreenshot: _onSelectScreenshot,
}: {
  text: string;
  onSelectScreenshot?: (id: number) => void;
}) {
  const decoded = decodeAttachments(text);
  const { data: shots = [] } = useQuery({
    queryKey: queryKeys.screenshotsByIds(decoded.ids),
    queryFn: () => getScreenshotsByIds(decoded.ids),
    enabled: decoded.ids.length > 0,
    staleTime: 60_000,
  });

  const attachmentData: AttachmentData[] = shots.map((s) => ({
    type: "file",
    id: String(s.id),
    url: convertFileSrc(s.thumbnail_path ?? s.file_path),
    filename: `#${s.id} · ${s.app_name ?? "unknown"}`,
    mediaType: "image/webp",
  })) as AttachmentData[];

  return (
    <div className="space-y-2">
      {decoded.ids.length > 0 && (
        <Attachments variant="inline">
          {attachmentData.map((data) => (
            <Attachment key={data.id} data={data}>
              <AttachmentPreview />
              <AttachmentInfo />
            </Attachment>
          ))}
        </Attachments>
      )}
      {decoded.text && (
        <div className="text-sm text-text-primary whitespace-pre-wrap">
          {decoded.text}
        </div>
      )}
    </div>
  );
}
