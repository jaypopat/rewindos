import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";

export const NOTIFIED_KEY = "rewindos-update-notified-tag";

/** One-time, dismissible "new version" notice. Shown at most once per release. */
export function UpdateToast({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { data } = useUpdateCheck();
  const [dismissed, setDismissed] = useState(false);

  if (
    dismissed ||
    !data?.available ||
    localStorage.getItem(NOTIFIED_KEY) === data.latest
  ) {
    return null;
  }

  const dismiss = () => {
    localStorage.setItem(NOTIFIED_KEY, data.latest);
    setDismissed(true);
  };

  return (
    <div
      role="status"
      className="fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-lg border border-line-2 bg-surface-raised px-4 py-3 text-[13px] text-text-secondary shadow-lg animate-in fade-in slide-in-from-bottom-2"
    >
      <span>
        RewindOS{" "}
        <span className="font-mono text-text-primary">{data.latest}</span>{" "}
        is available
      </span>
      <Button
        variant="outline"
        size="xs"
        onClick={() => {
          dismiss();
          onOpenSettings();
        }}
      >
        View
      </Button>
      <Button
        variant="quiet"
        size="icon-xs"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
