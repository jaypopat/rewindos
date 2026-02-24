import { useMemo, useState } from "react";
import Markdown from "markdown-to-jsx";
import type { ChatMessage as ChatMessageType } from "@/context/AskContext";
import { ScreenshotRefCard } from "@/components/ScreenshotRefCard";

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  onScreenshotClick?: (id: number) => void;
}

const MARKDOWN_OVERRIDES = {
  h1: { props: { className: "text-base font-semibold text-text-primary mt-3 mb-1" } },
  h2: { props: { className: "text-sm font-semibold text-text-primary mt-2.5 mb-1" } },
  h3: { props: { className: "text-sm font-medium text-text-primary mt-2 mb-0.5" } },
  ul: { props: { className: "list-disc list-inside space-y-0.5 my-1" } },
  ol: { props: { className: "list-decimal list-inside space-y-0.5 my-1" } },
  li: { props: { className: "text-sm text-text-secondary" } },
  p: { props: { className: "my-1" } },
  strong: { props: { className: "text-text-primary font-semibold" } },
  em: { props: { className: "italic" } },
  code: { props: { className: "font-mono text-xs bg-surface-overlay px-1 py-0.5 text-accent rounded" } },
  pre: { props: { className: "bg-surface-overlay border border-border/30 rounded-md p-3 my-2 overflow-x-auto text-xs font-mono" } },
  a: { props: { className: "text-accent hover:underline", target: "_blank", rel: "noopener" } },
  blockquote: { props: { className: "border-l-2 border-semantic/30 pl-3 my-2 text-text-muted italic" } },
  table: { props: { className: "border-collapse my-2 text-xs" } },
  th: { props: { className: "border border-border/30 px-2 py-1 text-left font-medium text-text-primary bg-surface-overlay" } },
  td: { props: { className: "border border-border/30 px-2 py-1 text-text-secondary" } },
  hr: { props: { className: "border-border/30 my-3" } },
};

const MAX_COLLAPSED_SOURCES = 3;

export function ChatMessage({ message, isStreaming, onScreenshotClick }: ChatMessageProps) {
  const isUser = message.role === "user";
  const [showAllSources, setShowAllSources] = useState(false);

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

  // Collect all referenced IDs to show as source cards at the bottom
  const referencedRefs = useMemo(() => {
    if (!message.references || refIds.length === 0) return [];
    return refIds
      .map((id) => message.references!.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => r != null);
  }, [message.references, refIds]);

  const unreferencedRefs = useMemo(() => {
    if (!message.references) return [];
    if (refIds.length === 0) {
      return showAllSources
        ? message.references
        : message.references.slice(0, MAX_COLLAPSED_SOURCES);
    }
    return [];
  }, [message.references, refIds, showAllSources]);

  const allSourceRefs = [...referencedRefs, ...unreferencedRefs];
  const hiddenSourceCount =
    refIds.length === 0 && message.references && !showAllSources
      ? Math.max(0, message.references.length - MAX_COLLAPSED_SOURCES)
      : 0;

  if (isUser) {
    return (
      <div className="flex justify-end mb-4 animate-fade-in-up">
        <div className="max-w-[75%]">
          <div className="flex items-center justify-end gap-2 mb-1">
            <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">you</span>
          </div>
          <div className="px-3 py-2.5 bg-accent/8 border border-accent/20 text-sm text-text-primary leading-relaxed whitespace-pre-wrap">
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
        {/* Rendered content — inline refs become small clickable chips */}
        <div className="text-sm text-text-secondary leading-relaxed">
          {segments.map((seg, i) => {
            if (seg.type === "ref") {
              return (
                <button
                  type="button"
                  key={`ref-${seg.value}`}
                  className="inline-flex items-center font-mono text-[10px] text-accent/80 hover:text-accent cursor-pointer hover:underline mx-0.5"
                  onClick={() => onScreenshotClick?.(parseInt(seg.value))}
                >
                  [#{seg.value}]
                </button>
              );
            }
            return (
              <Markdown
                key={`text-${i}`}
                options={{ forceBlock: false, overrides: MARKDOWN_OVERRIDES }}
              >
                {seg.value}
              </Markdown>
            );
          })}
        </div>

        {/* Source cards — shown at bottom */}
        {allSourceRefs.length > 0 && (
          <div className="mt-3 pt-2 border-t border-border/30">
            <span className="font-mono text-[10px] text-text-muted uppercase tracking-wider">sources</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {allSourceRefs.map((ref) => (
                <ScreenshotRefCard
                  key={ref.id}
                  reference={ref}
                  onClick={() => onScreenshotClick?.(ref.id)}
                />
              ))}
            </div>
            {hiddenSourceCount > 0 && (
              <button
                onClick={() => setShowAllSources(true)}
                className="font-mono text-[10px] text-text-muted hover:text-text-secondary mt-1.5 transition-colors"
              >
                +{hiddenSourceCount} more sources
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
