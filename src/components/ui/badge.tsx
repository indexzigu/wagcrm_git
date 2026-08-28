import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

export const badgeSizeClassName = {
  compact: "h-4 rounded-md px-1.5 py-0 text-[10px] font-medium leading-none",
  count: "h-4 min-w-4 rounded-full px-1 py-0 text-[9px] font-bold leading-none tabular-nums",
} as const

const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden border border-transparent whitespace-nowrap transition-[color,background-color,border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-focus-ring has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      size: {
        default: "h-5 rounded-2xl px-2 py-0.5 text-xs font-medium",
        compact: badgeSizeClassName.compact,
        count: badgeSizeClassName.count,
      },
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          // 포커스 링 오버라이드 제거 — 베이스의 ring-focus-ring 을 상속한다.
          // 구 ring-destructive/20 은 흰 배경 위 약 1.31:1 로 사실상 안 보였다.
          "bg-destructive/10 text-destructive dark:bg-destructive/20 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        // urgent tint 배경 위 텍스트: 기본 --status-urgent(#BF5050)은 이 /10 틴트 위에서 ~4.11:1로
        // AA(4.5:1) 미달 → 어두운 --status-urgent-text(#8F3C3C)로 ~6.4:1 확보. status-pending과 동일 패턴.
        "status-urgent":
          "bg-status-urgent/10 text-status-urgent-text border-status-urgent/20",
        "status-active":
          "bg-status-active/10 text-status-active border-status-active/20",
        "status-pending":
          "bg-status-pending/10 text-status-pending-text border-status-pending/20",
        "status-info":
          "bg-status-info/10 text-status-info border-status-info/20",
        // dedicated-tint 계열(고정 -bg + 어두운 텍스트) — 원색 /10로 배경을 만들면 대비가 얕아
        // caution(#B45309 on /10 = 4.38)·success 계열이 AA 미달이 되므로 전용 -bg 토큰을 쓴다.
        "status-caution":
          "bg-status-caution-bg text-status-caution border-status-caution/20",
        "status-success":
          "bg-status-success-bg text-status-success border-status-success/20",
      },
    },
    defaultVariants: {
      size: "default",
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      data-size={size}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
