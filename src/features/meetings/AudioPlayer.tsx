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

  // WebKitGTK's media element delegates to GStreamer, which can only fetch
  // file:// and http(s):// — not blob: or asset:// — so the backend serves the
  // recording (transcoded to WAV) from a loopback HTTP server and we point the
  // <audio> at that URL.
  useEffect(() => {
    let alive = true;
    setError(null);
    setSrc(null);
    invoke<string>("get_meeting_audio_url", { path })
      .then((url) => {
        if (alive) setSrc(url);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
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
