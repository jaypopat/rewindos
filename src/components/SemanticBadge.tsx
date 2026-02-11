interface SemanticBadgeProps {
  mode: string | undefined;
}

export function SemanticBadge({ mode }: SemanticBadgeProps) {
  if (mode !== "hybrid") return null;

  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 border border-semantic/30 bg-semantic/5 text-semantic text-[10px] font-mono uppercase tracking-wider">
      <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />
      </svg>
      ai search
    </span>
  );
}
