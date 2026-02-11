import { useState } from "react";
import type { BoundingBox } from "@/lib/api";

interface BoundingBoxOverlayProps {
  boxes: BoundingBox[];
  imageWidth: number;
  imageHeight: number;
  displayWidth: number;
  displayHeight: number;
  onHoverBox?: (boxId: number | null) => void;
}

export function BoundingBoxOverlay({
  boxes,
  imageWidth,
  imageHeight,
  displayWidth,
  displayHeight,
  onHoverBox,
}: BoundingBoxOverlayProps) {
  const [copiedId, setCopiedId] = useState<number | null>(null);

  if (!boxes.length || !displayWidth || !displayHeight) return null;

  const scaleX = displayWidth / imageWidth;
  const scaleY = displayHeight / imageHeight;

  const handleCopy = async (box: BoundingBox) => {
    await navigator.clipboard.writeText(box.text_content);
    setCopiedId(box.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      width={displayWidth}
      height={displayHeight}
      viewBox={`0 0 ${displayWidth} ${displayHeight}`}
    >
      {boxes.map((box) => {
        const x = box.x * scaleX;
        const y = box.y * scaleY;
        const w = box.width * scaleX;
        const h = box.height * scaleY;
        const opacity = box.confidence != null ? 0.2 + box.confidence * 0.6 : 0.5;

        return (
          <g key={box.id}>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill="rgba(34, 211, 238, 0.08)"
              stroke="var(--color-accent)"
              strokeWidth={1}
              strokeOpacity={opacity}
              rx={2}
              className="pointer-events-auto cursor-pointer hover:fill-[rgba(34,211,238,0.15)] hover:stroke-[rgba(34,211,238,0.8)] transition-all"
              onMouseEnter={() => onHoverBox?.(box.id)}
              onMouseLeave={() => onHoverBox?.(null)}
              onClick={(e) => {
                e.stopPropagation();
                handleCopy(box);
              }}
            />
            {copiedId === box.id && (
              <text
                x={x + w / 2}
                y={y + h / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fill="var(--color-accent)"
                fontSize="10"
                fontFamily="var(--font-mono)"
              >
                Copied
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
