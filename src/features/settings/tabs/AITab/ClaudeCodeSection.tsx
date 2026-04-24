import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { claudeDetect, claudeRegisterMcp } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { SectionTitle } from "../../primitives/SectionTitle";
import { Field } from "../../primitives/Field";

export function ClaudeCodeSection() {
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
          <button
            onClick={() => register.mutate()}
            disabled={register.isPending}
            className="font-mono text-xs px-3 py-1 border border-semantic/40 text-semantic hover:bg-semantic/10 transition-all"
          >
            {register.isPending ? "registering..." : "Connect to Claude Code"}
          </button>
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
