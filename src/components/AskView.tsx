import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAskChat } from "@/context/AskContext";
import { AskEmptyState } from "./AskEmptyState";
import { ChatMessage } from "./ChatMessage";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";

interface AskViewProps {
  onSelectScreenshot: (id: number) => void;
}

export function AskView({ onSelectScreenshot }: AskViewProps) {
  const { messages, isStreaming, error, sendMessage, newSession } = useAskChat();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(
    (text?: string) => {
      const msg = (text ?? input).trim();
      if (!msg || isStreaming) return;
      sendMessage(msg);
      setInput("");
    },
    [input, isStreaming, sendMessage],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleNewSession = useCallback(() => {
    newSession();
    setInput("");
    inputRef.current?.focus();
  }, [newSession]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header bar */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-border/50 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 bg-semantic" />
          <span className="font-mono text-xs text-text-muted uppercase tracking-wider">
            ask
          </span>
          {messages.length > 0 && (
            <span className="font-mono text-[10px] text-text-muted">
              {Math.ceil(messages.length / 2)} exchange{Math.ceil(messages.length / 2) !== 1 ? "s" : ""}
            </span>
          )}
        </div>

        {messages.length > 0 && (
          <button
            onClick={handleNewSession}
            className="flex items-center gap-1.5 px-2 py-1 font-mono text-[11px] text-text-muted hover:text-text-secondary border border-border/50 hover:border-border transition-all"
          >
            <Plus className="size-3" strokeWidth={2} />
            new chat
          </button>
        )}
      </div>

      {/* Messages area */}
      {messages.length === 0 ? (
        <AskEmptyState onSuggest={(q) => handleSubmit(q)} />
      ) : (
        <ScrollArea className="flex-1">
          <div ref={scrollRef} className="px-5 py-4 max-w-2xl mx-auto">
            {messages.map((msg, i) => (
              <ChatMessage
                key={`${msg.role}-${i}`}
                message={msg}
                isStreaming={isStreaming && i === messages.length - 1 && msg.role === "assistant"}
                onScreenshotClick={onSelectScreenshot}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      {/* Error display */}
      {error && (
        <div className="mx-5 mb-2 px-3 py-2 border border-signal-error/30 bg-signal-error/5">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-signal-error uppercase tracking-wider">err</span>
            <span className="text-xs text-signal-error/80 truncate">{error}</span>
          </div>
        </div>
      )}

      {/* Input bar */}
      <div className="border-t border-border/50 px-5 py-3 shrink-0">
        <div className="max-w-2xl mx-auto">
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2.5 border transition-all",
              isStreaming
                ? "border-semantic/30 bg-semantic/5"
                : "border-border/60 bg-surface-raised/30 focus-within:border-semantic/40 focus-within:bg-surface-raised/50",
            )}
          >
            <span className="font-mono text-sm text-semantic/50 shrink-0 select-none">
              {">_"}
            </span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? "thinking..." : "ask about your screen history"}
              disabled={isStreaming}
              className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted/50 outline-none disabled:opacity-50"
            />
            <button
              onClick={() => handleSubmit()}
              disabled={isStreaming || !input.trim()}
              className={cn(
                "shrink-0 px-2 py-1 font-mono text-[11px] uppercase tracking-wider transition-all",
                input.trim() && !isStreaming
                  ? "text-semantic hover:bg-semantic/10"
                  : "text-text-muted/30 cursor-default",
              )}
            >
              send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
