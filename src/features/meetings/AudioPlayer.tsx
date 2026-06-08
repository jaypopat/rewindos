import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";

export interface AudioHandle { seekTo: (seconds: number) => void; }

export const AudioPlayer = forwardRef<AudioHandle, { path: string }>(({ path }, ref) => {
  const el = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useImperativeHandle(ref, () => ({
    seekTo: (seconds: number) => {
      if (el.current) { el.current.currentTime = seconds; void el.current.play(); }
    },
  }));

  // WebKitGTK's <audio> can't load Tauri's asset:// protocol — its GStreamer
  // media backend bypasses custom scheme handlers — so fetch the bytes over IPC
  // and play them via a Blob URL, which WebKit handles natively.
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setError(false);
    setSrc(null);
    invoke<ArrayBuffer>("read_meeting_audio", { path })
      .then((bytes) => {
        if (!alive) return;
        url = URL.createObjectURL(new Blob([bytes], { type: "audio/ogg" }));
        setSrc(url);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  if (error) {
    return <div className="text-xs text-signal-error">Couldn't load audio.</div>;
  }
  if (!src) {
    return <div className="text-xs text-text-muted">Loading audio…</div>;
  }
  return <audio ref={el} src={src} controls className="w-full" />;
});
AudioPlayer.displayName = "AudioPlayer";
