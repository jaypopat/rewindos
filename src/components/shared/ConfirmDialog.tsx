interface ConfirmDialogProps {
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-surface-base border border-border rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl">
        <h3 className="text-base font-medium text-text-primary mb-2">{title}</h3>
        <div className="text-sm text-text-secondary mb-4">{description}</div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-surface-raised transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors disabled:opacity-50 ${
              destructive
                ? "bg-red-500/90 hover:bg-red-500 text-white"
                : "bg-accent/15 hover:bg-accent/25 text-accent"
            }`}
          >
            {loading ? "..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
