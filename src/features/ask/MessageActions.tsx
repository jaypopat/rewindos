import { useState } from "react";
import { Copy, RefreshCw, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface MessageActionsProps {
  onCopy: () => void;
  onRegenerate: () => void;
  disabled?: boolean;
}

export function MessageActions({ onCopy, onRegenerate, disabled }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="flex items-center gap-1 mt-2 opacity-60 hover:opacity-100 transition-opacity">
      <ActionButton onClick={handleCopy} disabled={disabled} label={copied ? "copied" : "copy"}>
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </ActionButton>
      <ActionButton onClick={onRegenerate} disabled={disabled} label="regenerate">
        <RefreshCw className="size-3" />
      </ActionButton>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "flex items-center gap-1 px-1.5 py-0.5",
        "font-mono text-[10px] uppercase tracking-wider",
        "text-text-muted hover:text-text-primary border border-transparent hover:border-border/40",
        "disabled:opacity-40 disabled:hover:text-text-muted disabled:hover:border-transparent",
        "transition-colors",
      )}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}
