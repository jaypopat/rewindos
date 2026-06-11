import { useState } from "react";
import type { AppConfig } from "@/lib/config";
import { SectionTitle } from "../primitives/SectionTitle";
import { Field } from "../primitives/Field";
import { TextInput } from "../primitives/TextInput";
import { NumberInput } from "../primitives/NumberInput";
import { Toggle } from "../primitives/Toggle";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { claudeDetect, claudeRegisterMcp, chatHealthCheck, chatListModels } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";

const PROVIDER_PRESETS = [
  { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", needsKey: false },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", needsKey: false },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  { id: "custom", label: "Custom", baseUrl: null, needsKey: true },
] as const;

interface TabProps {
  config: AppConfig;
  update: <S extends keyof AppConfig, K extends keyof AppConfig[S]>(
    section: S, key: K, value: AppConfig[S][K],
  ) => void;
}

export function AITab({ config, update }: TabProps) {
  const preset =
    PROVIDER_PRESETS.find((p) => p.id === config.chat.provider) ??
    PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
  const [testResult, setTestResult] = useState<string | null>(null);

  const test = useMutation({
    mutationFn: () => chatHealthCheck(config.chat),
    onSuccess: (ok) => setTestResult(ok ? "connected" : "unreachable"),
    onError: (e) => setTestResult(String(e)),
  });

  const { data: models } = useQuery({
    queryKey: queryKeys.chatModels(config.chat.base_url, config.chat.api_key),
    queryFn: () => chatListModels(config.chat),
    retry: false,
    staleTime: 30_000,
  });

  const onProviderChange = (id: string) => {
    update("chat", "provider", id);
    const p = PROVIDER_PRESETS.find((x) => x.id === id);
    if (p?.baseUrl) update("chat", "base_url", p.baseUrl);
    setTestResult(null);
  };

  return (
    <>
      <ClaudeCodeSection />
      <SectionTitle>Chat / Ask</SectionTitle>
      <Field label="Enabled">
        <Toggle
          checked={config.chat.enabled}
          onChange={(v) => update("chat", "enabled", v)}
        />
      </Field>
      <Field label="Provider">
        <Select value={preset.id} onValueChange={onProviderChange}>
          <SelectTrigger className="font-mono">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id} className="font-mono">
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Base URL">
        <TextInput
          value={config.chat.base_url}
          onChange={(v) => update("chat", "base_url", v)}
          disabled={preset.id !== "custom"}
        />
      </Field>
      {preset.needsKey && (
        <Field label="API Key">
          <TextInput
            type="password"
            value={config.chat.api_key}
            onChange={(v) => update("chat", "api_key", v)}
          />
        </Field>
      )}
      <Field label="Model">
        <>
          <TextInput
            value={config.chat.model}
            onChange={(v) => update("chat", "model", v)}
            list="chat-model-options"
          />
          <datalist id="chat-model-options">
            {(models ?? []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </>
      </Field>
      <Field label="">
        <div className="flex items-center gap-3">
          <Button
            variant="editorial"
            size="editorial"
            onClick={() => test.mutate()}
            disabled={test.isPending}
          >
            {test.isPending ? "testing..." : "Test connection"}
          </Button>
          {testResult && (
            <span
              className={`font-mono text-[11px] ${
                testResult === "connected" ? "text-signal-success" : "text-text-muted"
              }`}
            >
              {testResult}
            </span>
          )}
        </div>
      </Field>
      <Field label="Temperature">
        <NumberInput
          value={config.chat.temperature}
          min={0}
          max={2}
          step={0.1}
          onChange={(v) => update("chat", "temperature", v)}
        />
      </Field>
      <Field label="Max History Messages">
        <NumberInput
          value={config.chat.max_history_messages}
          min={2}
          max={50}
          onChange={(v) => update("chat", "max_history_messages", v)}
        />
      </Field>

      <SectionTitle>Semantic Search (Embeddings)</SectionTitle>
      <Field label="Enabled">
        <Toggle
          checked={config.semantic.enabled}
          onChange={(v) => update("semantic", "enabled", v)}
        />
      </Field>
      <Field label="Embedding Model">
        <TextInput
          value={config.semantic.model}
          onChange={(v) => update("semantic", "model", v)}
        />
      </Field>
    </>
  );
}
function ClaudeCodeSection() {
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: queryKeys.claudeStatus(),
    queryFn: claudeDetect,
    staleTime: 10_000,
  });

  const register = useMutation({
    mutationFn: claudeRegisterMcp,
    onSuccess: (next) => qc.setQueryData(queryKeys.claudeStatus(), next),
  });

  return (
    <>
      <SectionTitle>Claude Code</SectionTitle>
      <Field label="Status">
        <div className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              status?.available ? "bg-signal-success" : "bg-text-muted/40"
            }`}
          />
          <span className="font-mono text-xs text-text-secondary">
            {!status
              ? "checking..."
              : !status.available
                ? "not installed"
                : status.mcp_registered
                  ? "connected — MCP registered"
                  : "installed — MCP not registered"}
          </span>
        </div>
      </Field>
      {status?.available && !status.mcp_registered && (
        <Field label="">
          <Button
            variant="editorial"
            size="editorial"
            onClick={() => register.mutate()}
            disabled={register.isPending}
          >
            {register.isPending ? "registering..." : "Connect to Claude Code"}
          </Button>
        </Field>
      )}
      {status?.available && status.mcp_registered && (
        <p className="font-mono text-[11px] text-text-muted mt-1">
          Ask view will use Claude Code for agentic multi-turn retrieval.
        </p>
      )}
      {!status?.available && (
        <p className="font-mono text-[11px] text-text-muted mt-1">
          Install Claude Code CLI to enable agentic chat. Local Ollama chat remains available.
        </p>
      )}
    </>
  );
}
