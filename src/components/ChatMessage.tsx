import { createElement, useMemo, type ReactNode } from "react";
import type { ChatMessage as ChatMessageType } from "@/context/AskContext";
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

  // Collect all referenced IDs to show as source cards at the bottom
  const referencedRefs = useMemo(() => {
    if (!message.references || refIds.length === 0) return [];
    return refIds
      .map((id) => message.references!.find((r) => r.id === id))
      .filter((r): r is NonNullable<typeof r> => r != null);
  }, [message.references, refIds]);

  const unreferencedRefs = useMemo(() => {
    if (!message.references) return [];
    if (refIds.length === 0) return message.references;
    return [];
  }, [message.references, refIds]);

  const allSourceRefs = [...referencedRefs, ...unreferencedRefs];

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
        {/* Rendered content — inline refs become small clickable chips */}
        <div className="text-sm text-text-secondary leading-relaxed space-y-2 [&_strong]:text-text-primary [&_strong]:font-semibold [&_code]:font-mono [&_code]:text-xs [&_code]:bg-surface-overlay [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-accent">
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
            // Render text with basic markdown-like formatting
            return <span key={`text-${i}`}>{formatMarkdown(seg.value)}</span>;
          })}
        </div>

        {/* Source cards — always shown at bottom, never inline */}
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
          </div>
        )}
      </div>
    </div>
  );
}

function formatMarkdown(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*.*?\*\*|`.*?`|\n)/g);
  return tokens.map((token, i) => {
    if (token.startsWith("**") && token.endsWith("**")) {
      return createElement("strong", { key: i }, token.slice(2, -2));
    }
    if (token.startsWith("`") && token.endsWith("`")) {
      return createElement("code", { key: i }, token.slice(1, -1));
    }
    if (token === "\n") {
      return createElement("br", { key: i });
    }
    return token || null;
  });
}
