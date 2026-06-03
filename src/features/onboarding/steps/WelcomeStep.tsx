export function WelcomeStep() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold text-text-primary">Welcome to RewindOS</h2>
      <p className="text-sm leading-relaxed text-text-secondary">
        RewindOS quietly captures your screen every few seconds, reads the text on it
        (OCR), and gives you instant full-text search of everything you've seen.
      </p>
      <p className="text-sm leading-relaxed text-text-secondary">
        It's <span className="font-medium text-text-primary">100% local</span> — your
        screenshots and their text never leave this machine. No cloud, no account, no
        telemetry.
      </p>
      <p className="text-xs text-text-muted">
        Next, we'll make sure capture is actually working on your setup.
      </p>
    </div>
  );
}
