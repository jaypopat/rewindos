import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { exportJournal } from "@/lib/api";
import { dateToKey } from "@/lib/time-ranges";
import { subDays } from "date-fns";
import { X, Download, Copy } from "lucide-react";

interface ExportDialogProps {
  onClose: () => void;
}

export function ExportDialog({ onClose }: ExportDialogProps) {
  const [startDate, setStartDate] = useState(() => dateToKey(subDays(new Date(), 30)));
  const [endDate, setEndDate] = useState(() => dateToKey(new Date()));
  const [exported, setExported] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const exportMutation = useMutation({
    mutationFn: () => exportJournal(startDate, endDate),
    onSuccess: (data) => setExported(data),
  });

  const handleCopy = async () => {
    if (exported) {
      await navigator.clipboard.writeText(exported);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-surface border border-border/50 rounded-xl shadow-xl w-[480px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <h2 className="text-sm font-medium text-text-primary">Export Journal</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-secondary transition-colors">
            <X className="size-4" strokeWidth={2} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[10px] text-text-muted font-mono uppercase tracking-wider">
                From
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full mt-1 bg-surface-raised border border-border/30 rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50"
              />
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-text-muted font-mono uppercase tracking-wider">
                To
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full mt-1 bg-surface-raised border border-border/30 rounded-md px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent/50"
              />
            </div>
          </div>

          <button
            onClick={() => exportMutation.mutate()}
            disabled={exportMutation.isPending}
            className="w-full flex items-center justify-center gap-2 bg-accent/15 hover:bg-accent/25 text-accent text-xs font-medium py-2 rounded-lg transition-colors disabled:opacity-50"
          >
            {exportMutation.isPending ? (
              <div className="w-3 h-3 border border-accent/30 border-t-accent rounded-full animate-spin" />
            ) : (
              <Download className="size-3" strokeWidth={2} />
            )}
            Export as Markdown
          </button>

          {exported && (
            <div className="space-y-2">
              <div className="bg-surface-raised border border-border/30 rounded-lg p-3 max-h-40 overflow-y-auto">
                <pre className="text-[10px] text-text-muted font-mono whitespace-pre-wrap">
                  {exported.slice(0, 2000)}
                  {exported.length > 2000 && "..."}
                </pre>
              </div>
              <button
                onClick={handleCopy}
                className="flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 transition-colors"
              >
                <Copy className="size-3" strokeWidth={2} />
                {copied ? "Copied!" : "Copy to clipboard"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
