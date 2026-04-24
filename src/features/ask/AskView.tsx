import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/query-keys";
import { claudeDetect, getConfig } from "@/lib/api";
import { ollamaHealth } from "@/lib/ollama-chat";
import { useAskChat } from "@/context/AskContext";
import { AskMessages } from "./AskMessages";
import { ChatSidebar } from "./ChatSidebar";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";

interface AskViewProps {
  onSelectScreenshot: (id: number) => void;
}

interface ChatUrlConfig {
  chat: { ollama_url: string };
}

export function AskView({ onSelectScreenshot: _onSelectScreenshot }: AskViewProps) {
  const { messages, isStreaming, error, sendMessage, cancelStream } = useAskChat();
  const [input, setInput] = useState("");

  const { data: config } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: getConfig,
  });

  const { data: ollamaOnline = false } = useQuery({
    queryKey: queryKeys.ollamaHealth(),
    queryFn: () =>
      config
        ? ollamaHealth((config as unknown as ChatUrlConfig).chat.ollama_url)
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
    (textOverride?: string) => {
      const msg = (textOverride ?? input).trim();
      if (!msg || isStreaming || !chatReady) return;
      void sendMessage(msg);
      setInput("");
    },
    [input, isStreaming, chatReady, sendMessage],
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
        <div className="flex items-center justify-between px-5 py-2 border-b border-border/50 shrink-0">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "w-1.5 h-1.5 rounded-full transition-colors",
                chatReady ? "bg-signal-success" : "bg-signal-error",
              )}
              title={
                usingClaude
                  ? "Claude Code connected"
                  : ollamaOnline
                    ? "Ollama connected"
                    : "No chat backend available"
              }
            />
            <span className="font-mono text-xs text-text-muted uppercase tracking-wider">
              ask
            </span>
            <span
              className={cn(
                "font-mono text-[10px] uppercase tracking-wider",
                usingClaude ? "text-semantic" : "text-text-muted",
              )}
            >
              · {usingClaude ? "claude" : "local"}
            </span>
          </div>
        </div>

        {messages.length === 0 ? (
          <div className="flex-1 flex items-center justify-center min-h-0 px-5">
            <Suggestions>
              <Suggestion
                suggestion="what did I do in the last hour"
                onClick={(s) => submit(s)}
              />
              <Suggestion
                suggestion="last time I was in firefox"
                onClick={(s) => submit(s)}
              />
              <Suggestion
                suggestion="which apps did I use most today"
                onClick={(s) => submit(s)}
              />
            </Suggestions>
          </div>
        ) : (
          <AskMessages rows={messages} />
        )}

        {isStreaming && (
          <div className="px-5 py-1 shrink-0 flex items-center gap-2 text-text-muted">
            <Loader2 className="size-3 animate-spin" />
            <span className="font-mono text-[10px] uppercase tracking-wider">
              thinking
            </span>
          </div>
        )}

        {error && (
          <div className="mx-5 mb-2 px-3 py-2 border border-signal-error/30 bg-signal-error/5 shrink-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-signal-error uppercase tracking-wider">
                err
              </span>
              <span className="text-xs text-signal-error/80 truncate">
                {error}
              </span>
            </div>
          </div>
        )}

        <div className="border-t border-border/50 px-5 py-3 shrink-0">
          <div className="max-w-2xl mx-auto">
            <PromptInput onSubmit={onPromptSubmit}>
              <PromptInputTextarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  !chatReady
                    ? "connect claude or start ollama to chat"
                    : isStreaming
                      ? "thinking..."
                      : "ask about your screen history"
                }
                disabled={isStreaming || !chatReady}
              />
              <PromptInputFooter>
                <div />
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
    </div>
  );
}
