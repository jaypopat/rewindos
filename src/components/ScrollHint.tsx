import { useCallback, useEffect, useState, type RefObject } from "react";
import { ChevronDown } from "lucide-react";

/**
 * A floating "more below" affordance pinned to the bottom of a scroll
 * container's viewport. Renders only while there is content below the fold,
 * and disappears once the user scrolls near the bottom. Click scrolls one
 * viewport down. Mount it as a sibling of the scroller inside a `relative`
 * wrapper.
 */
export function ScrollHint({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const [visible, setVisible] = useState(false);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setVisible(el.scrollHeight - el.scrollTop - el.clientHeight > 80);
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Content height changes (data loading in) without the element resizing
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
      mo.disconnect();
    };
  }, [scrollRef, update]);

  if (!visible) return null;

  return (
    <button
      onClick={() => {
        const el = scrollRef.current;
        el?.scrollBy({ top: el.clientHeight * 0.8, behavior: "smooth" });
      }}
      title="More below"
      className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 grid place-items-center size-9 rounded-full border border-line-2 bg-surface-raised text-text-secondary hover:text-text-primary hover:border-line-hi transition-colors"
      style={{ boxShadow: "0 16px 40px -16px #000" }}
    >
      <ChevronDown
        className="size-4 animate-[gentleBounce_2s_ease-in-out_infinite]"
        strokeWidth={1.7}
      />
    </button>
  );
}
