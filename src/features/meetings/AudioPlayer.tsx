import { forwardRef, useImperativeHandle, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

export interface AudioHandle { seekTo: (seconds: number) => void; }

export const AudioPlayer = forwardRef<AudioHandle, { path: string }>(({ path }, ref) => {
  const el = useRef<HTMLAudioElement>(null);
  useImperativeHandle(ref, () => ({
    seekTo: (seconds: number) => {
      if (el.current) { el.current.currentTime = seconds; void el.current.play(); }
    },
  }));
  return <audio ref={el} src={convertFileSrc(path)} controls className="w-full" />;
});
AudioPlayer.displayName = "AudioPlayer";
