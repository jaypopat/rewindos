import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[23px] w-10 shrink-0 cursor-pointer items-center rounded-full border transition-colors outline-none",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:bg-primary data-[state=checked]:border-accent-deep",
        "data-[state=unchecked]:bg-surface-overlay data-[state=unchecked]:border-line-2",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-[17px] rounded-full transition-transform",
          "data-[state=checked]:translate-x-[19px] data-[state=checked]:bg-[#1c1208]",
          "data-[state=unchecked]:translate-x-[2px] data-[state=unchecked]:bg-text-muted"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
