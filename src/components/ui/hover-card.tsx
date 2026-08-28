"use client"

import * as React from "react"
import { HoverCard as HoverCardPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * 마우스를 올려서 보는 부유 패널.
 *
 * ⚠️ **`Popover`(눌러서 보기) · `Tooltip`(한 줄 힌트)과 역할이 다르다.**
 * - `HelpPopover` = 3~4줄 안내를 **클릭**으로 연다. 터치·키보드에서 열기 쉬운 대신 손이 든다.
 * - `Tooltip` = 이 레포 관례 폭 240px 짜리 한 줄 힌트. 표 형태 내역은 잘린다.
 * - 여기 = **정보 밀도가 있는 내역을 스치듯 확인**하는 자리(오너 요청: 금액의 출처를 롤오버로).
 *
 * ⛔ 여기에 **조작 요소를 넣지 말 것.** 호버로만 열리는 패널은 터치·키보드에서 도달할 수
 * 없으므로 안에 든 것이 조작이면 그 기능이 일부 사용자에게 존재하지 않는 것과 같다.
 * 읽기 전용 내역 전용이고, 트리거가 `tabIndex` 를 가지면 키보드 포커스로도 열린다
 * (Radix 기본 동작 — 그래서 트리거를 포커스 가능한 요소로 둔다).
 */
function HoverCard({
  openDelay = 120,
  closeDelay = 80,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return (
    <HoverCardPrimitive.Root
      data-slot="hover-card"
      openDelay={openDelay}
      closeDelay={closeDelay}
      {...props}
    />
  )
}

function HoverCardTrigger({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

function HoverCardContent({
  className,
  align = "start",
  sideOffset = 8,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        // 그림자는 `Popover` 와 같은 `shadow-overlay` 다 — 포털 부유 레이어는 밀도 사다리가
        // 아니라 별개 축이라 층이 하나뿐이다(P8 Elevation Ladder).
        className={cn(
          "z-50 w-72 origin-(--radix-hover-card-content-transform-origin) rounded-lg border bg-popover p-4 text-popover-foreground shadow-overlay outline-hidden data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
