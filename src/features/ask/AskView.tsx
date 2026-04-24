import { useState } from "react";
import { useAskChat } from "@/context/AskContext";

interface AskViewProps {
  onSelectScreenshot: (id: number) => void;
}

// NOTE: This is a transitional stub. Task 9 adds the ai-elements-based
// AskMessages renderer and Task 10 replaces this view with a ChatSidebar +
// full PromptInput shell. Until then, this placeholder exercises the new
// AskContext API (DB-backed messages, chatId-keyed active chat) so the app
// still mounts and you can smoke-test sendMessage end-to-end.
export function AskView({ onSelectScreenshot: _onSelectScreenshot }: AskViewProps) {
  const { activeChatId, messages, isStreaming, error, sendMessage, startNewChat } =
    useAskChat();
  const [input, setInput] = useState("");

  const submit = () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    void sendMessage(text);
  };

  return (
    <div className="flex flex-col h-full p-4 gap-3 font-mono text-xs">
      <div className="flex items-center gap-3">
        <span className="text-text-muted uppercase tracking-wider">
          ask — transitional stub
        </span>
        <button
          type="button"
          className="text-accent hover:underline"
          onClick={startNewChat}
        >
          new chat
        </button>
        <span className="text-text-muted">
          chat id: {activeChatId ?? "—"}
        </span>
      </div>

      {error && <div className="text-red-400">{error}</div>}

      <div className="flex-1 overflow-auto border border-border/30 p-3 space-y-2">
        {messages.length === 0 && (
          <div className="text-text-muted">
            No messages. Send one to start a new chat.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="border-l border-border/30 pl-2">
            <div className="text-text-muted uppercase tracking-wider">
              {m.role} · {m.block_type}
              {m.is_partial ? " · partial" : ""}
            </div>
            <pre className="whitespace-pre-wrap text-text-primary">
              {m.content_json}
            </pre>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <input
          className="flex-1 bg-transparent border border-border/30 px-2 py-1 text-text-primary outline-none focus:border-accent"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={isStreaming ? "streaming…" : "ask something"}
          disabled={isStreaming}
        />
        <button
          type="button"
          className="border border-border/30 px-3 text-text-primary hover:border-accent"
          onClick={submit}
          disabled={isStreaming || !input.trim()}
        >
          send
        </button>
      </div>
    </div>
  );
}
