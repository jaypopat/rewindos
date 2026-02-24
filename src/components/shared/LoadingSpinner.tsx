import { cn } from "@/lib/utils";

interface LoadingSpinnerProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  sm: "w-3 h-3 border",
  md: "w-4 h-4 border-2",
  lg: "w-6 h-6 border-2",
} as const;

export function LoadingSpinner({ size = "md", className }: LoadingSpinnerProps) {
  return (
    <div
      className={cn(
        "border-accent/30 border-t-accent rounded-full animate-spin",
        sizeClasses[size],
        className,
      )}
    />
  );
}
