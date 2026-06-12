import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { SectionTitle } from "./primitives/SectionTitle";
import { Field } from "./primitives/Field";
import { installUpdate, restartApp, type UpdateProgress } from "@/lib/api";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";

type RenderableStage = Exclude<UpdateProgress["stage"], "error">;

function progressLabel(p: UpdateProgress & { stage: RenderableStage }): string {
  switch (p.stage) {
    case "downloading":
      return `Downloading… ${p.pct}%`;
    case "verifying":
      return "Verifying checksum…";
    case "installing":
      return "Installing…";
    case "restarting_daemon":
      return "Restarting daemon…";
    case "done":
      return "Done";
  }
}

export function UpdateSection() {
  const { data, isFetching, refetch, error } = useUpdateCheck();
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const done = progress?.stage === "done";

  useEffect(() => {
    if (!installing) return;
    const unlisten = listen<UpdateProgress>("update-progress", (e) => {
      if (e.payload.stage === "error") {
        setInstallError(e.payload.message);
        setInstalling(false);
        setProgress(null);
      } else {
        setProgress(e.payload);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [installing]);

  const onInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    setProgress(null);
    try {
      await installUpdate();
    } catch (e) {
      setInstallError(String(e));
      setInstalling(false);
    }
  };

  return (
    <>
      <SectionTitle>Updates</SectionTitle>
      <Field label="Version">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-text-secondary">
            {data ? data.current : "—"}
          </span>
          {data && !data.available && (
            <span className="font-mono text-[11px] text-text-muted">
              Up to date
            </span>
          )}
          <Button
            variant="editorial"
            size="editorial"
            onClick={() => refetch()}
            disabled={isFetching || installing}
          >
            {isFetching ? "Checking…" : "Check for updates"}
          </Button>
        </div>
        {error && !isFetching && (
          <p className="font-mono text-[11px] text-text-muted mt-1" role="alert">
            Could not reach the releases API.
          </p>
        )}
      </Field>
      {data?.available && (
        <Field label={`Update to ${data.latest}`}>
          <div className="flex flex-col gap-2 items-start">
            {data.installable ? (
              <>
                {!installing && !done && (
                  <Button
                    variant="editorial"
                    size="editorial"
                    onClick={onInstall}
                  >
                    Update now
                  </Button>
                )}
                {installing && !done && (
                  <span
                    className="font-mono text-[11px] text-text-muted"
                    role="status"
                    aria-live="polite"
                  >
                    {progress && progress.stage !== "error"
                      ? progressLabel(progress)
                      : "Starting…"}
                  </span>
                )}
                {done && (
                  <Button
                    variant="editorial"
                    size="editorial"
                    onClick={() => restartApp()}
                  >
                    Restart RewindOS to finish
                  </Button>
                )}
                {installError && (
                  <span
                    className="font-mono text-[11px] text-text-muted"
                    role="alert"
                  >
                    {installError}
                  </span>
                )}
              </>
            ) : (
              <p className="font-mono text-[11px] text-text-muted">
                You&apos;re running a source build — pull the latest and rebuild
                (make install) to update.
              </p>
            )}
            {data.release_notes && (
              <pre className="font-mono text-[11px] text-text-muted max-h-32 overflow-y-auto whitespace-pre-wrap border border-line rounded p-2 w-full">
                {data.release_notes}
              </pre>
            )}
          </div>
        </Field>
      )}
    </>
  );
}
