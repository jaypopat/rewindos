import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Lock, Zap } from "lucide-react";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorSeparator,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { Button } from "@/components/ui/button";
import { getConfig, chatListModels, claudeDetect } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { CLAUDE_MODELS, resolveChatRoute } from "@/lib/claude-models";
import { useAskChat } from "@/context/AskContext";
import { cn } from "@/lib/utils";

export function AskModelPicker() {
  const { activeChat, pendingModel, setPendingModel } = useAskChat();
  const [open, setOpen] = useState(false);

  const { data: config } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: getConfig,
  });
  const baseUrl = config?.chat.base_url ?? "";
  const apiKey = config?.chat.api_key ?? "";
  const defaultOllama = config?.chat.model;

  const { data: ollamaModels = [] } = useQuery({
    queryKey: queryKeys.chatModels(baseUrl, apiKey),
    queryFn: async () => {
      if (!config?.chat) return [];
      const models = await chatListModels(config.chat);
      return models.filter((name) => !name.toLowerCase().includes("embed"));
    },
    enabled: !!baseUrl && !!config,
    staleTime: 60_000,
  });

  // Shares AskView's cached query — no extra CLI probe on mount.
  const { data: claudeStatus } = useQuery({
    queryKey: queryKeys.claudeStatus(),
    queryFn: claudeDetect,
    staleTime: 30_000,
  });
  const claudeReady = !!(claudeStatus?.available && claudeStatus.mcp_registered);

  // Locked state: chat is active and has a model set
  if (activeChat?.model) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-0.5 border border-border/40 bg-surface-raised/30">
        <Zap className="size-3 text-semantic" />
        <span className="font-mono text-[10px] text-text-primary uppercase tracking-wider">
          {activeChat.model}
        </span>
        <Lock className="size-2.5 text-text-muted" />
      </div>
    );
  }

  // Editable state: no active chat yet (or chat not yet sent).
  // Display MUST mirror what a send would actually use: the same resolveChatRoute
  // the send path calls (AskContext), with the same inputs. Anything else shows a
  // model that won't be the one answering (e.g. "qwen…" shown, sonnet used).
  const currentDisplay =
    resolveChatRoute({
      selectedModel: pendingModel ?? null,
      claudeReady,
      ollamaDefaultModel: defaultOllama ?? "",
    }).model || "…";

  const pick = (id: string) => {
    setPendingModel(id);
    setOpen(false);
  };

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          type="button"
          className="h-auto flex items-center gap-1.5 px-2 py-0.5 border border-border/40 bg-surface-raised/30 hover:border-border/60 focus:outline-none font-mono text-[10px] uppercase tracking-wider text-text-primary"
        >
          <Zap className="size-3 text-semantic" />
          {currentDisplay}
          <ChevronDown className="size-3 text-text-muted" />
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent title="Choose a model">
        <ModelSelectorInput placeholder="search models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No matches.</ModelSelectorEmpty>
          <ModelSelectorGroup heading="Claude Code">
            {CLAUDE_MODELS.map((m) => (
              <ModelSelectorItem
                key={m.id}
                value={m.id}
                onSelect={() => pick(m.id)}
                className={cn(
                  "flex flex-col items-start gap-0.5",
                  currentDisplay === m.id && "bg-semantic/10",
                )}
              >
                <span className="text-sm text-text-primary">{m.label}</span>
                <span className="font-mono text-[10px] text-text-muted">
                  {m.description}
                </span>
              </ModelSelectorItem>
            ))}
          </ModelSelectorGroup>
          <ModelSelectorSeparator />
          <ModelSelectorGroup heading="Local provider">
            {ollamaModels.length === 0 ? (
              <div className="px-2 py-1.5 font-mono text-[10px] text-text-muted/60 italic">
                no models found — check your provider settings
              </div>
            ) : (
              ollamaModels.map((m) => (
                <ModelSelectorItem
                  key={m}
                  value={m}
                  onSelect={() => pick(m)}
                  className={cn(
                    currentDisplay === m && "bg-semantic/10",
                  )}
                >
                  <span className="text-sm text-text-primary">{m}</span>
                </ModelSelectorItem>
              ))
            )}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
