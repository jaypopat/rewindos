interface AskEmptyStateProps {
  onSuggest: (question: string) => void;
}

const SUGGESTED = [
  "What was that error I saw in VS Code?",
  "What did I work on this morning?",
  "How long did I spend on GitHub today?",
  "What did we discuss in my last meeting?",
];

export function AskEmptyState({ onSuggest }: AskEmptyStateProps) {
  return (
    <div className="flex-1 flex items-center justify-center px-8">
      <div className="max-w-[560px] w-full animate-fade-in">
        <div className="kicker mb-4">Ask · grounded in your captures</div>
        <h1 className="font-display text-[40px] leading-[1.08] tracking-tight mb-4">
          Ask your memory anything.
        </h1>
        <p className="text-[15px] text-text-secondary leading-relaxed mb-9 max-w-[46ch]">
          Grounded in everything you've seen — screenshots, text, and meeting
          transcripts. References link back to the exact frame.
        </p>

        <div className="flex flex-wrap gap-2">
          {SUGGESTED.map((q) => (
            <button
              key={q}
              onClick={() => onSuggest(q)}
              className="inline-flex items-center h-8 px-3.5 rounded-[7px] text-[12.5px] font-[450] text-text-secondary border border-line-2 hover:border-line-hi hover:text-text-primary hover:bg-panel transition-colors"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
