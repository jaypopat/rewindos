import { useMemo } from "react";
import type { ChatMessage as ChatMessageType } from "@/hooks/useAskStream";
import { ScreenshotRefCard } from "./ScreenshotRefCard";

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  onScreenshotClick?: (id: number) => void;
}

export function ChatMessage({ message, isStreaming, onScreenshotClick }: ChatMessageProps) {
  const isUser = message.role === "user";

  // Parse [REF:ID] markers from content
  const { segments, refIds } = useMemo(() => {
    const refPattern = /\[REF:(\d+)\]/g;
    const ids: number[] = [];
    const parts: { type: "text" | "ref"; value: string }[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = refPattern.exec(message.content)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: "text", value: message.content.slice(lastIndex, match.index) });
      }
      parts.push({ type: "ref", value: match[1] });
      ids.push(parseInt(match[1]));
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < message.content.length) {
      parts.push({ type: "text", value: message.content.slice(lastIndex) });
    }

    return { segments: parts.length > 0 ? parts : [{ type: "text" as const, value: message.content }], refIds: ids };
  }, [message.content]);

  if (isUser) {
    return (
      <div className="flex justify-end mb-4 animate-fade-in-up">
        <div className="max-w-[75%]">
          <div className="flex items-center justify-end gap-2 mb-1">
            <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">you</span>
          </div>
          <div className="px-3 py-2.5 bg-accent/8 border border-accent/20 text-sm text-text-primary leading-relaxed">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="mb-5 animate-fade-in-up">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="w-1.5 h-1.5 bg-semantic" />
        <span className="font-mono text-[10px] text-semantic uppercase tracking-wider">rewindos</span>
        {isStreaming && (
          <span className="typing-cursor font-mono text-semantic text-xs">_</span>
        )}
      </div>

      <div className="pl-3.5 border-l border-semantic/20">
        {/* Rendered content */}
        <div className="text-sm text-text-secondary leading-relaxed space-y-2 [&_strong]:text-text-primary [&_strong]:font-semibold [&_code]:font-mono [&_code]:text-xs [&_code]:bg-surface-overlay [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-accent">
          {segments.map((seg, i) => {
            if (seg.type === "ref") {
              const ref = message.references?.find((r) => r.id === parseInt(seg.value));
              if (ref && onScreenshotClick) {
                return (
                  <ScreenshotRefCard
                    key={`ref-${i}`}
                    reference={ref}
                    onClick={() => onScreenshotClick(ref.id)}
                  />
                );
              }
              return (
                <span
                  key={`ref-${i}`}
                  className="inline-flex items-center font-mono text-xs text-accent cursor-pointer hover:underline"
                  onClick={() => onScreenshotClick?.(parseInt(seg.value))}
                >
                  [#{seg.value}]
                </span>
              );
            }
            // Render text with basic markdown-like formatting
            return <span key={`text-${i}`} dangerouslySetInnerHTML={{ __html: formatMarkdown(seg.value) }} />;
          })}
        </div>

        {/* Unreferenced screenshot refs at the bottom */}
        {message.references && message.references.length > 0 && refIds.length === 0 && (
          <div className="mt-3 pt-2 border-t border-border/30">
            <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">sources</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {message.references.map((ref) => (
                <ScreenshotRefCard
                  key={ref.id}
                  reference={ref}
                  onClick={() => onScreenshotClick?.(ref.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.*?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br />");
}
