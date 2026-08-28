import type { ComponentType, ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl border-dashed p-6 text-center text-balance",
        className
      )}
      {...props}
    />
  )
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn("flex max-w-sm flex-col items-center gap-2", className)}
      {...props}
    />
  )
}

const emptyMediaVariants = cva(
  "mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function EmptyMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
  return (
    <div
      data-slot="empty-icon"
      data-variant={variant}
      className={cn(emptyMediaVariants({ variant, className }))}
      {...props}
    />
  )
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-title"
      className={cn(
        "font-heading text-sm font-medium tracking-tight",
        className
      )}
      {...props}
    />
  )
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <div
      data-slot="empty-description"
      className={cn(
        "text-sm/relaxed text-muted-foreground [&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className
      )}
      {...props}
    />
  )
}

function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn(
        "flex w-full max-w-sm min-w-0 flex-col items-center gap-2.5 text-sm text-balance",
        className
      )}
      {...props}
    />
  )
}

/**
 * DataEmpty — CRM 패널의 "데이터 없음" 정본 빈 상태.
 *
 * 그동안 각 패널이 손으로 짠 `flex-col items-center + border-dashed + text-xs muted`
 * 블록을 하나의 미니멀 치료법으로 통일한다. 텍스트 밀도를 최소로 유지(제목 text-xs·
 * 설명 text-[10px])해 미니멀 기조와 충돌하지 않는다.
 *
 * - `bordered`(기본 true): 점선 테두리 + 옅은 배경. 카드 내부의 서브섹션 empty엔 false.
 * - "완료 축하"류(체크·Sparkles)와는 의미가 다르므로 이 컴포넌트는 "없음"에만 쓴다.
 */
function DataEmpty({
  icon: Icon,
  title,
  description,
  bordered = true,
  className,
  children,
}: {
  icon?: ComponentType<{ className?: string }>
  title: ReactNode
  description?: ReactNode
  bordered?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <Empty
      className={cn(
        "flex-none gap-1.5 py-8",
        bordered && "rounded-xl border border-dashed border-border/60 bg-muted/30",
        className
      )}
    >
      {Icon ? (
        <EmptyMedia className="mb-0">
          <Icon className="size-5 text-muted-foreground/60" />
        </EmptyMedia>
      ) : null}
      <EmptyTitle className="text-xs font-normal text-muted-foreground">
        {title}
      </EmptyTitle>
      {description ? (
        <EmptyDescription className="text-[10px] leading-relaxed text-muted-foreground/80">
          {description}
        </EmptyDescription>
      ) : null}
      {children}
    </Empty>
  )
}

export {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
  DataEmpty,
}
