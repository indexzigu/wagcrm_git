"use client"

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { SearchIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center border-b px-3" data-slot="command-input-wrapper">
      <SearchIcon className="mr-2 size-4 shrink-0 opacity-50" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      // scrollbar-gutter:stable — 타이핑으로 결과 수가 바뀌면 스크롤바가 등장/소멸하며
      // 행 폭이 밀려 말줄임 위치가 흔들린다(P8 Layout Stability ①). 팝오버 폭은
      // 트리거에 묶여 있어 스스로 넓어지지 못하므로 자리를 미리 예약한다.
      // 선례: link-search-dialog 의 결과 스크롤러가 같은 이유로 채택했다.
      className={cn(
        "max-h-[300px] overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-6 text-center text-sm"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground [&_[data-slot=command-group-heading]]:px-2 [&_[data-slot=command-group-heading]]:py-1.5 [&_[data-slot=command-group-heading]]:text-xs [&_[data-slot=command-group-heading]]:font-medium [&_[data-slot=command-group-heading]]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      // ⚠️ 활성 행 표시는 **배경 하나로 끝내지 말 것**(P8 §3 「색은 캐리어에 탄다」).
      // cmdk 는 aria-activedescendant 방식이라 이 표시가 키보드 이동의 **유일한 지표**인데,
      // 종전 `bg-accent`(#F8FAFC on #FFFFFF)는 **1.03:1** 이고 `accent-foreground` 는
      // `foreground` 와 같은 값이라 ↑↓ 로 옮겨도 화면이 사실상 바뀌지 않았다
      // (WCAG 2.2 SC 2.4.7 · 1.4.11 실패). P8 이 구 `ring-primary/45` 를 폐기한 것과 같은
      // 실패 모드다. 그래서 캐리어를 하나 더 얹는다 — 실제 지표는 **좌측 프라이머리 바**로,
      // `--primary` #0A3D62 는 흰 팝오버 대비 **11.31:1** 이다(직접 계산). `bg-muted` 는
      // 보조 캐리어일 뿐 단독으로는 1.10:1 이라 근거가 되지 못한다.
      // ⛔ 투명 테두리를 「정리」한다며 지우지 말 것 — 상시 2px 을 잡아 둬야 선택 시
      // 레이아웃이 밀리지 않는다. styleseed 의 colored-left-border 금지는 **모든 행**에
      // 두르는 장식을 겨냥한 것이라 활성 1행에는 걸리지 않는다.
      className={cn(
        "relative flex cursor-default gap-2 select-none items-center rounded-sm border-l-2 border-transparent px-2 py-1.5 text-sm outline-none data-[selected=true]:border-primary data-[selected=true]:bg-muted data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandSeparator,
  CommandItem,
}
