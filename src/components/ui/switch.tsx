"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        // 썸 위치는 translate가 아니라 flex justify(start→end) 플립으로 잡고,
        // 아래 motion 썸의 layout 스프링이 그 이동을 애니메이트한다(animate-ui 방식).
        // 기하: border-box 트랙 - 1px 보더 = 콘텐츠폭, 여기서 썸 크기를 빼면 이동거리 =
        // default 14px · sm 10px 로 기존 translate-x-[calc(100%-2px)]와 동일.
        "peer group/switch relative inline-flex shrink-0 items-center justify-start rounded-full border border-transparent transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:justify-end data-checked:bg-primary data-unchecked:bg-input dark:data-unchecked:bg-input/80 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb asChild>
        <motion.div
          data-slot="switch-thumb"
          layout
          transition={{ type: "spring", stiffness: 300, damping: 25 }}
          className="pointer-events-none block rounded-full bg-background ring-0 group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 dark:data-checked:bg-primary-foreground dark:data-unchecked:bg-foreground"
        />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  )
}

export { Switch }
