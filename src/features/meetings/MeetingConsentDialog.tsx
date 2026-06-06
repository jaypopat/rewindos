export function MeetingConsentDialog({
  onAgree,
  onCancel,
  busy = false,
  errorMessage = null,
}: {
  onAgree: () => void;
  onCancel: () => void;
  busy?: boolean;
  errorMessage?: string | null;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="meeting-consent-title"
    >
      <div className="bg-surface border border-border/50 rounded-xl shadow-xl w-[440px]">
        <div className="px-5 py-4 border-b border-border/50">
          <h2 id="meeting-consent-title" className="text-sm font-medium text-text-primary">
            Record &amp; transcribe this meeting?
          </h2>
        </div>
        <div className="px-5 py-4 space-y-2 text-sm text-text-secondary">
          <p>
            RewindOS will capture your microphone and system audio, transcribe it
            locally with whisper, and store the transcript (and audio, if enabled)
            on this device.
          </p>
          <p className="text-xs text-text-muted">
            Recording laws vary — make sure everyone present consents to being
            recorded. Nothing leaves your machine.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-border/50 flex gap-2 justify-end">
          {errorMessage && (
            <p className="text-xs text-red-400 mr-auto self-center">{errorMessage}</p>
          )}
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onAgree}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50"
          >
            {busy ? "Starting…" : "I understand — start"}
          </button>
        </div>
      </div>
    </div>
  );
}
