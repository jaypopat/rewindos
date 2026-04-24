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
import { getConfig, ollamaListModels } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from "@/lib/claude-models";
import { useAskChat, type RootConfigShape } from "@/context/AskContext";
import { cn } from "@/lib/utils";

export function AskModelPicker() {
  const { activeChat, pendingModel, setPendingModel } = useAskChat();
  const [open, setOpen] = useState(false);

  const { data: config } = useQuery({
    queryKey: queryKeys.config(),
    queryFn: getConfig,
  });
  const ollamaUrl = (config as RootConfigShape | undefined)?.chat.ollama_url ?? "";
  const defaultOllama = (config as RootConfigShape | undefined)?.chat.model;

  const { data: ollamaModels = [] } = useQuery({
    queryKey: queryKeys.ollamaModels(ollamaUrl),
    queryFn: () => ollamaListModels(ollamaUrl),
    enabled: !!ollamaUrl,
    staleTime: 60_000,
  });

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

  // Editable state: no active chat yet (or chat not yet sent)
  const currentDisplay = pendingModel ?? defaultOllama ?? DEFAULT_CLAUDE_MODEL;

  const pick = (id: string) => {
    setPendingModel(id);
    setOpen(false);
  };

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 px-2 py-0.5 border border-border/40 bg-surface-raised/30 hover:border-border/60 focus:outline-none font-mono text-[10px] uppercase tracking-wider text-text-primary"
        >
          <Zap className="size-3 text-semantic" />
          {currentDisplay}
          <ChevronDown className="size-3 text-text-muted" />
        </button>
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
          <ModelSelectorGroup heading="Ollama (local)">
            {ollamaModels.length === 0 ? (
              <div className="px-2 py-1.5 font-mono text-[10px] text-text-muted/60 italic">
                no models pulled — run `ollama pull &lt;name&gt;`
              </div>
            ) : (
              ollamaModels.map((m) => (
                <ModelSelectorItem
                  key={m.name}
                  value={m.name}
                  onSelect={() => pick(m.name)}
                  className={cn(
                    "flex flex-col items-start gap-0.5",
                    currentDisplay === m.name && "bg-semantic/10",
                  )}
                >
                  <span className="text-sm text-text-primary">{m.name}</span>
                  {m.parameter_size && (
                    <span className="font-mono text-[10px] text-text-muted">
                      {m.parameter_size}
                    </span>
                  )}
                </ModelSelectorItem>
              ))
            )}
          </ModelSelectorGroup>
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
