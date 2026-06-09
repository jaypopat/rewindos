import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";

export interface AudioHandle { seekTo: (seconds: number) => void; }

// HTMLMediaElement.error.code → human label, so a failure points at the cause.
const MEDIA_ERR: Record<number, string> = {
  1: "load aborted",
  2: "network error",
  3: "decode error",
  4: "format not supported",
};

export const AudioPlayer = forwardRef<AudioHandle, { path: string }>(({ path }, ref) => {
  const el = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    seekTo: (seconds: number) => {
      if (el.current) { el.current.currentTime = seconds; void el.current.play(); }
    },
  }));

  // WebKitGTK can neither load Tauri's asset:// protocol for media nor decode
  // Ogg-Opus, so the backend reads the file and transcodes it to WAV; we play
  // those PCM bytes via a Blob URL, which WebKit handles natively.
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setError(null);
    setSrc(null);
    invoke<ArrayBuffer>("read_meeting_audio", { path })
      .then((bytes) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
        setSrc(url);
      })
      .catch((e) => {
        if (alive) setError(`read failed — ${String(e)}`);
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  if (error) {
    return <div className="text-xs text-signal-error">Audio error: {error}</div>;
  }
  if (!src) {
    return <div className="text-xs text-text-muted">Loading audio…</div>;
  }
  return (
    <audio
      ref={el}
      src={src}
      controls
      className="w-full"
      onError={() => {
        const code = el.current?.error?.code;
        setError(`playback ${code ? (MEDIA_ERR[code] ?? `code ${code}`) : "failed"}`);
      }}
    />
  );
});
AudioPlayer.displayName = "AudioPlayer";
