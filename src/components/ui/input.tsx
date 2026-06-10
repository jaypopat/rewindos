import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-[7px] border border-line-2 bg-surface-raised px-2.5 text-[13px] text-text-primary transition-colors outline-none",
        "placeholder:text-text-muted selection:bg-accent-muted",
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-text-primary",
        "focus-visible:border-line-hi",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-signal-error",
        className
      )}
      {...props}
    />
  )
}

export { Input }
