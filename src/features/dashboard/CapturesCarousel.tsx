import { useCallback, useEffect, useRef, useState } from "react";
import { getImageUrl, type TimelineEntry } from "@/lib/api";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface CapturesCarouselProps {
  captures: TimelineEntry[];
  onSelect: (id: number) => void;
}

export function CapturesCarousel({ captures, onSelect }: CapturesCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener("scroll", updateScrollState, { passive: true });
    const ro = new ResizeObserver(updateScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      ro.disconnect();
    };
  }, [updateScrollState, captures]);

  const scroll = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    // Scroll by ~3 card widths
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-mono text-[10px] text-text-muted uppercase tracking-[0.2em]">
          Today's Captures
        </h2>
        <div className="flex items-center gap-2">
          {/* Arrow buttons */}
          <button
            onClick={() => scroll(-1)}
            disabled={!canScrollLeft}
            className="p-1 rounded text-text-muted hover:text-text-primary disabled:opacity-20 disabled:cursor-default transition-colors"
            aria-label="Scroll left"
          >
            <ChevronLeft className="size-4" strokeWidth={2} />
          </button>
          <button
            onClick={() => scroll(1)}
            disabled={!canScrollRight}
            className="p-1 rounded text-text-muted hover:text-text-primary disabled:opacity-20 disabled:cursor-default transition-colors"
            aria-label="Scroll right"
          >
            <ChevronRight className="size-4" strokeWidth={2} />
          </button>
          <span className="text-[10px] text-text-muted font-mono tabular-nums">
            {captures.length} captures
          </span>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex gap-2 overflow-x-auto scroll-smooth [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:hidden"
      >
        {captures.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className="group relative shrink-0 w-56 aspect-video overflow-hidden rounded-lg border border-border/30 hover:border-accent/50 bg-surface-raised transition-all hover:scale-[1.02]"
          >
            <img
              src={getImageUrl(s.thumbnail_path!)}
              alt=""
              className="w-full h-full object-cover opacity-75 group-hover:opacity-100 transition-opacity"
              loading="lazy"
            />
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent px-2 py-1.5">
              <span className="text-[10px] text-white/90 font-mono tabular-nums">
                {new Date(s.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
              {s.app_name && (
                <span className="text-[9px] text-white/50 ml-1.5">{s.app_name}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
