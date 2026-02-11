interface AskEmptyStateProps {
  onSuggest: (question: string) => void;
}

const SUGGESTED = [
  "What was that error I saw in VS Code?",
  "What did I work on this morning?",
  "How long did I spend on GitHub today?",
  "Show me what I was reading last hour",
];

export function AskEmptyState({ onSuggest }: AskEmptyStateProps) {
  return (
    <div className="flex-1 flex items-center justify-center px-8">
      <div className="max-w-md w-full animate-fade-in">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-2 h-2 bg-semantic animate-pulse-glow" />
            <span className="font-mono text-[10px] text-semantic uppercase tracking-[0.2em]">
              memory interface
            </span>
          </div>
          <h1 className="font-display text-4xl text-text-primary leading-none mb-2">
            Ask RewindOS
          </h1>
          <p className="text-sm text-text-muted leading-relaxed">
            Query your screen history in natural language.
            <br />
            Everything stays local.
          </p>
        </div>

        {/* Suggested queries */}
        <div className="space-y-1.5">
          <span className="font-mono text-[10px] text-text-muted uppercase tracking-widest">
            try asking
          </span>
          {SUGGESTED.map((q, i) => (
            <button
              key={q}
              onClick={() => onSuggest(q)}
              className="group w-full text-left px-3 py-2.5 border border-border/50 hover:border-semantic/40 bg-surface-raised/30 hover:bg-semantic/5 transition-all"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div className="flex items-start gap-2.5">
                <span className="font-mono text-xs text-semantic/60 group-hover:text-semantic shrink-0 mt-px">
                  {">"}
                </span>
                <span className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
                  {q}
                </span>
              </div>
            </button>
          ))}
        </div>

        {/* Keyboard hint */}
        <div className="mt-6 flex items-center gap-2 text-text-muted">
          <span className="font-mono text-[10px]">
            powered by local llm
          </span>
          <span className="text-border">|</span>
          <span className="font-mono text-[10px]">
            context from your captures
          </span>
        </div>
      </div>
    </div>
  );
}
