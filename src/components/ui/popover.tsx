"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 4,
  portal = true,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  /**
   * `false` 면 Portal 을 생략하고 트리거와 같은 DOM 트리에 렌더한다.
   *
   * ⚠️ **Dialog 안에서 쓰는 팝오버는 이 값을 `false` 로 둔다.** Radix Dialog 는
   * 내용을 `RemoveScroll` 로 감싸며 예외(`shards`)를 DialogContent 하나로만 준다.
   * `react-remove-scroll` 은 `document` 의 `wheel` 을 `{passive:false}` 로 잡아
   * 타깃이 shard 밖이면 `preventDefault()` 하므로, body 로 포털된 팝오버는
   * **클릭·호버는 되는데 내부 목록만 스크롤되지 않는다**(실사고: 레퍼런스 인박스
   * 「딜에 배정하기」 딜 선택 목록). 같은 트리 안에 렌더하면 shard 에 포함돼 풀린다.
   */
  portal?: boolean
}) {
  const content = (
    <PopoverPrimitive.Content
      data-slot="popover-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-lg border bg-popover p-4 text-popover-foreground shadow-overlay outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      {...props}
    />
  )

  return portal ? (
    <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal>
  ) : (
    content
  )
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
