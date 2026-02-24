import { useState, useEffect } from "react";
import { getImageUrl, type TimelineEntry } from "@/lib/api";
import { SPEEDS } from "@/features/rewind/rewind-utils";

export function usePlayback(screenshots: TimelineEntry[]) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<(typeof SPEEDS)[number]>(1);

  // -- Auto-play ------------------------------------------------------------
  useEffect(() => {
    if (!isPlaying || screenshots.length === 0) return;
    const ms = 1000 / playbackSpeed;
    const id = window.setInterval(() => {
      setCurrentIndex((prev) => {
        if (prev >= screenshots.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, ms);
    return () => clearInterval(id);
  }, [isPlaying, playbackSpeed, screenshots.length]);

  // -- Image preloading (+/-5 around current) -------------------------------
  useEffect(() => {
    if (screenshots.length === 0) return;
    const lo = Math.max(0, currentIndex - 5);
    const hi = Math.min(screenshots.length - 1, currentIndex + 5);
    for (let i = lo; i <= hi; i++) {
      const img = new Image();
      img.src = getImageUrl(screenshots[i].file_path);
    }
  }, [currentIndex, screenshots]);

  return {
    currentIndex,
    setCurrentIndex,
    isPlaying,
    setIsPlaying,
    playbackSpeed,
    setPlaybackSpeed,
  };
}
