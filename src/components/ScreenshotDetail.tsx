import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getScreenshot, getImageUrl } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { AppDot } from "./AppDot";
import { BoundingBoxOverlay } from "./BoundingBoxOverlay";
import { BookmarkButton } from "./BookmarkButton";
import { AddToCollectionMenu } from "./AddToCollectionMenu";
import { formatTimestamp } from "@/lib/format";

interface ScreenshotDetailProps {
  screenshotId: number;
  onBack: () => void;
  searchQuery?: string;
  screenshotIds?: number[];
  onNavigate?: (id: number) => void;
}

function highlightText(text: string, query?: string): ReactNode[] {
  if (!query || !query.trim()) return [text];
  const words = query.trim().split(/\s+/).filter(Boolean);
  const pattern = new RegExp(`(${words.map(escapeRegex).join("|")})`, "gi");
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    i % 2 === 1 ? <mark key={i}>{part}</mark> : part || null,
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EMPTY_IDS: number[] = [];

export function ScreenshotDetail({ screenshotId, onBack, searchQuery, screenshotIds = EMPTY_IDS, onNavigate }: ScreenshotDetailProps) {
  const [showBoxes, setShowBoxes] = useState(false);
  const [_hoveredBox, setHoveredBox] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [imgSize, setImgSize] = useState({ width: 0, height: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const imgContainerRef = useRef<HTMLDivElement>(null);

  // Arrow key navigation
  const currentIndex = screenshotIds.indexOf(screenshotId);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < screenshotIds.length - 1;
  const canNavigate = !!onNavigate && screenshotIds.length > 1 && currentIndex >= 0;

  useEffect(() => {
    if (!canNavigate || !onNavigate) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && hasNext) {
        e.preventDefault();
        onNavigate(screenshotIds[currentIndex + 1]);
      }
      if (e.key === "ArrowLeft" && hasPrev) {
        e.preventDefault();
        onNavigate(screenshotIds[currentIndex - 1]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canNavigate, hasPrev, hasNext, currentIndex, screenshotIds, onNavigate]);

  const { data: detail, isLoading, isError } = useQuery({
    queryKey: queryKeys.screenshot(screenshotId),
    queryFn: () => getScreenshot(screenshotId),
  });

  const handleCopy = async () => {
    if (!detail?.ocr_text) return;
    await navigator.clipboard.writeText(detail.ocr_text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const measureImage = useCallback(() => {
    if (imgRef.current) {
      setImgSize({
        width: imgRef.current.clientWidth,
        height: imgRef.current.clientHeight,
      });
    }
  }, []);

  useEffect(() => {
    window.addEventListener("resize", measureImage);
    return () => window.removeEventListener("resize", measureImage);
  }, [measureImage]);

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col animate-fade-in">
        <div className="px-5 py-3">
          <Skeleton className="h-8 w-24" />
        </div>
        <div className="flex-1 flex gap-0 px-5 pb-5">
          <Skeleton className="flex-[2] rounded-lg" />
          <Skeleton className="flex-1 rounded-lg" />
        </div>
      </div>
    );
  }

  if (isError || !detail) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-signal-error">Failed to load screenshot</p>
        <Button variant="ghost" size="sm" onClick={onBack} className="text-text-secondary">
          Go back
        </Button>
      </div>
    );
  }

  const wordCount = detail.ocr_text ? detail.ocr_text.split(/\s+/).filter(Boolean).length : 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 animate-fade-in">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-5 py-2.5 border-b border-border/30 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="text-text-secondary hover:text-text-primary -ml-2"
        >
          <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
          </svg>
          Back
        </Button>

        <div className="w-px h-4 bg-border/50" />

        {canNavigate && (
          <>
            <div className="flex items-center gap-1">
              <button
                onClick={() => hasPrev && onNavigate!(screenshotIds[currentIndex - 1])}
                disabled={!hasPrev}
                className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-default transition-colors"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                </svg>
              </button>
              <span className="text-[10px] text-text-muted font-mono tabular-nums">
                {currentIndex + 1}/{screenshotIds.length}
              </span>
              <button
                onClick={() => hasNext && onNavigate!(screenshotIds[currentIndex + 1])}
                disabled={!hasNext}
                className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-default transition-colors"
              >
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            </div>
            <div className="w-px h-4 bg-border/50" />
          </>
        )}

        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-text-muted tabular-nums">{formatTimestamp(detail.timestamp)}</span>
          {detail.app_name && (
            <>
              <span className="text-border">|</span>
              <span className="inline-flex items-center gap-1 text-text-secondary">
                <AppDot appName={detail.app_name} size={6} />
                {detail.app_name}
              </span>
            </>
          )}
          {detail.window_title && (
            <>
              <span className="text-border">|</span>
              <span className="text-text-muted truncate max-w-[300px]">{detail.window_title}</span>
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <BookmarkButton screenshotId={screenshotId} size="md" />
          <AddToCollectionMenu screenshotId={screenshotId} />
          <div className="w-px h-4 bg-border/50" />
          {detail.bounding_boxes.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setShowBoxes(!showBoxes)}
              className={showBoxes ? "text-accent" : "text-text-muted hover:text-text-primary"}
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 3.75H6A2.25 2.25 0 0 0 3.75 6v1.5M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6v1.5m0 9V18A2.25 2.25 0 0 1 18 20.25h-1.5m-9 0H6A2.25 2.25 0 0 1 3.75 18v-1.5" />
              </svg>
              Boxes
            </Button>
          )}
          <span className="text-[10px] text-text-muted font-mono">
            {detail.width}x{detail.height}
          </span>
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex-1 flex min-h-0">
        {/* Image panel */}
        <div ref={imgContainerRef} className="flex-[2] p-4 flex items-center justify-center overflow-hidden relative">
          <div className="relative inline-block max-w-full max-h-full">
            <img
              ref={imgRef}
              src={getImageUrl(detail.file_path)}
              alt="Screenshot"
              className="rounded-lg border border-border/30 shadow-lg"
              style={{ maxHeight: "calc(100vh - 140px)", objectFit: "contain" }}
              onLoad={measureImage}
            />
            {showBoxes && imgSize.width > 0 && (
              <BoundingBoxOverlay
                boxes={detail.bounding_boxes}
                imageWidth={detail.width}
                imageHeight={detail.height}
                displayWidth={imgSize.width}
                displayHeight={imgSize.height}
                onHoverBox={setHoveredBox}
              />
            )}
          </div>
        </div>

        {/* OCR text panel */}
        <div className="flex-1 min-w-[240px] max-w-[380px] border-l border-border/30 flex flex-col">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30 shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-text-secondary">OCR Text</span>
              {detail.ocr_text && (
                <span className="text-[10px] text-text-muted font-mono">{wordCount} words</span>
              )}
            </div>
            {detail.ocr_text && (
              <Button
                variant="ghost"
                size="xs"
                onClick={handleCopy}
                className="text-text-muted hover:text-text-primary text-[10px] h-6"
              >
                {copied ? (
                  <>
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9.75a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                    </svg>
                    Copy
                  </>
                )}
              </Button>
            )}
          </div>

          <ScrollArea className="flex-1">
            {detail.ocr_text ? (
              <div className="px-4 py-3">
                <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap break-words leading-relaxed">
                  {highlightText(detail.ocr_text, searchQuery)}
                </pre>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full px-4">
                <p className="text-xs text-text-muted">No OCR text available</p>
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </div>
  );
}
