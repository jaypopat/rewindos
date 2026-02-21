import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { isBookmarked, toggleBookmark } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface BookmarkButtonProps {
  screenshotId: number;
  size?: "sm" | "md";
  className?: string;
}

export function BookmarkButton({ screenshotId, size = "sm", className }: BookmarkButtonProps) {
  const queryClient = useQueryClient();

  const { data: bookmarked = false } = useQuery({
    queryKey: queryKeys.isBookmarked(screenshotId),
    queryFn: () => isBookmarked(screenshotId),
  });

  const mutation = useMutation({
    mutationFn: () => toggleBookmark(screenshotId),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.isBookmarked(screenshotId) });
      const previous = queryClient.getQueryData(queryKeys.isBookmarked(screenshotId));
      queryClient.setQueryData(queryKeys.isBookmarked(screenshotId), !bookmarked);
      return { previous };
    },
    onError: (_err, _vars, context) => {
      queryClient.setQueryData(queryKeys.isBookmarked(screenshotId), context?.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.isBookmarked(screenshotId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks() });
    },
  });

  const iconSize = size === "sm" ? "size-3.5" : "size-4";

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        mutation.mutate();
      }}
      className={cn(
        "transition-colors",
        bookmarked
          ? "text-yellow-400 hover:text-yellow-300"
          : "text-text-muted hover:text-yellow-400",
        className,
      )}
      title={bookmarked ? "Remove bookmark" : "Add bookmark"}
    >
      <Star
        className={iconSize}
        strokeWidth={1.5}
        fill={bookmarked ? "currentColor" : "none"}
      />
    </button>
  );
}
