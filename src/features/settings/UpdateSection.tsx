import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { SectionTitle } from "./primitives/SectionTitle";
import { Field } from "./primitives/Field";
import { installUpdate, restartApp, type UpdateProgress, type UpdateStatus } from "@/lib/api";
import { useUpdateCheck } from "@/hooks/useUpdateCheck";
import { NOTIFIED_KEY } from "@/components/UpdateToast";

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
  const queryClient = useQueryClient();
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const done = progress?.stage === "done";

  // Keep a ref so the event listener always reads the latest `data.latest`
  // without a stale closure (the effect only re-runs when `installing` changes).
  const latestTagRef = useRef<string | undefined>(undefined);
  latestTagRef.current = data?.latest;

  useEffect(() => {
    if (!installing) return;
    const unlisten = listen<UpdateProgress>("update-progress", (e) => {
      if (e.payload.stage === "error") {
        setInstallError(e.payload.message);
        setInstalling(false);
        setProgress(null);
      } else {
        setProgress(e.payload);
        if (e.payload.stage === "done") {
          // Suppress the toast for this tag so it never re-appears after install.
          const tag = latestTagRef.current;
          if (tag) {
            localStorage.setItem(NOTIFIED_KEY, tag);
          }
          // Mark the shared cache as settled so no refetch consumer re-shows
          // the "Update to vX" card.
          queryClient.setQueryData<UpdateStatus>(["update-check"], (d) =>
            d ? { ...d, available: false } : d,
          );
        }
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [installing, queryClient]);

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
      <Field
        label="Version"
        hint={
          data && (
            <>
              <span className="font-mono text-text-secondary">{data.current}</span>
              {!data.available && !done && " · Up to date"}
              {done && " · Restart pending"}
            </>
          )
        }
      >
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="editorial"
            size="editorial"
            onClick={() => refetch()}
            disabled={isFetching || installing}
          >
            {isFetching ? "Checking…" : "Check for updates"}
          </Button>
          {error && !isFetching && (
            <p className="font-mono text-[11px] text-text-muted text-right" role="alert">
              Could not reach the releases API.
            </p>
          )}
        </div>
      </Field>
      {/* Show the update card while the update is available OR while in the
          done/restart-pending state (available flips false after install). */}
      {(data?.available || done) && (
        <Field label={`Update to ${data?.latest ?? ""}`}>
          <div className="flex flex-col gap-2 items-start">
            {done ? (
              <Button
                variant="editorial"
                size="editorial"
                onClick={() => restartApp()}
              >
                Restart RewindOS to finish
              </Button>
            ) : data?.install_kind === "script" ? (
              <>
                {!installing && (
                  <Button
                    variant="editorial"
                    size="editorial"
                    onClick={onInstall}
                  >
                    Update now
                  </Button>
                )}
                {installing && (
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
                {installError && (
                  <span
                    className="font-mono text-[11px] text-text-muted"
                    role="alert"
                  >
                    {installError}
                  </span>
                )}
              </>
            ) : data?.install_kind === "packaged" ? (
              <p className="font-mono text-[11px] text-text-muted">
                Update through your package manager (pacman, apt, dnf).
              </p>
            ) : (
              <p className="font-mono text-[11px] text-text-muted">
                You&apos;re running a source build: pull the latest and rebuild
                (make install) to update.
              </p>
            )}
            {data?.release_notes && (
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
