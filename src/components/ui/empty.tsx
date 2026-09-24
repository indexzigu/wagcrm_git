import type { ComponentType, ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { CircleAlert, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
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
        <EmptyDescription className="text-[10px] leading-relaxed text-muted-foreground">
          {description}
        </EmptyDescription>
      ) : null}
      {children}
    </Empty>
  )
}

/** 조회 실패 안내의 기본 할 일 문구 — 원인(제목) 뒤에 붙는 「무엇을 하면 되는가」. */
const LOAD_ERROR_HINT = "연결을 확인하고 다시 불러오세요."

/**
 * 조회 실패 — `DataEmpty` 의 짝이다. **실패를 빈 상태와 같은 얼굴로 그리지 말 것**:
 * 운영자가 「없다」로 읽고 넘어간다(정산 조회가 실패하면 이번 달 정산이 빈 것으로
 * 오판하게 된다 — interfaces 점검 #9, 2026-09-24).
 *
 * 빈 상태와 갈라 보이게 하는 장치는 셋이다: 점선이 아닌 실선 테두리, 심각도 아이콘,
 * 제자리 「다시 불러오기」. `role="alert"` 라 화면낭독기에도 바로 전달된다.
 */
function DataLoadError({
  title,
  description = LOAD_ERROR_HINT,
  onRetry,
  retrying = false,
  bordered = true,
  touch = false,
  className,
}: {
  /** 무엇을 못 불러왔는가 — 「정산 목록을 불러오지 못했습니다.」 */
  title: ReactNode
  /** 할 일. 기본값은 `LOAD_ERROR_HINT`. */
  description?: ReactNode
  onRetry: () => void
  /** 재조회 중이면 버튼을 잠그고 아이콘을 돌린다(연타 방지). */
  retrying?: boolean
  bordered?: boolean
  /** 터치 표면(모바일 UA 분기) — 다시 불러오기 버튼을 44px 로 키운다(P3 터치 하한). */
  touch?: boolean
  className?: string
}) {
  return (
    <div
      role="alert"
      data-slot="data-load-error"
      className={cn(
        "flex w-full flex-col items-center justify-center gap-1.5 py-8 text-center",
        bordered && "rounded-xl border border-border/60 bg-muted/30",
        className
      )}
    >
      <CircleAlert className="size-5 text-status-urgent-text" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
      <Button
        type="button"
        variant="outline"
        size={touch ? "default" : "sm"}
        className={cn("mt-1.5", touch && "h-11 rounded-xl")}
        onClick={onRetry}
        disabled={retrying}
      >
        <RefreshCw data-icon="inline-start" className={retrying ? "animate-spin" : undefined} />
        다시 불러오기
      </Button>
    </div>
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
  DataLoadError,
}
