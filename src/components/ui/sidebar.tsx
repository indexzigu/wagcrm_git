"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PanelLeftIcon } from "lucide-react"

// 폭의 정본. `AppShellFrame`(루트 셸)도 이 값으로 `--sidebar-width` 계열 변수를 심으므로
// export 한다 — 셸이 자기 리터럴을 들면 사이드바와 자리표시 폭이 갈린다.
const SIDEBAR_WIDTH = "10rem"
const SIDEBAR_WIDTH_MOBILE = "18rem"
const SIDEBAR_WIDTH_ICON = "3rem"
/**
 * 마우스가 사이드바를 벗어난 뒤 **접기 시작할 때까지** 기다리는 시간(ms, 오너 확정
 * 2026-08-28). 대각선으로 지나갈 때의 깜빡임을 막는다.
 *
 * 🪤 이 지연은 **CSS 가 아니라 여기(JS)가 소유한다** — 상태를 React 가 구동하므로
 * CSS `transition-delay` 로 두면 상태 전환과 어긋난 채 두 벌이 된다.
 */
const SIDEBAR_PEEK_CLOSE_DELAY_MS = 150

/**
 * 스크롤 엣지 판정 임계값(px). scrollTop 과 scrollHeight - clientHeight 는 소수로
 * 오고 확대 배율에서 더 어긋나므로, 정확 비교(scrollTop === max)를 쓰면 하단에
 * 0.5px 이 남아 페이드가 영영 꺼지지 않는다.
 */
const SCROLL_EDGE_EPSILON_PX = 1

// useLayoutEffect 는 서버에서 아무 일도 하지 않고 경고만 낸다. 이 프리미티브는
// SSR 을 타므로 클라이언트에서만 레이아웃 이펙트를 쓴다.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect

type SidebarContextProps = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }

  return context
}

/**
 * 호버 오버레이(peek)의 펼침·접힘 구동부. `SidebarProvider` **안에서만** 호출한다.
 *
 * ⛔ **호버와 포커스를 독립 처리하지 말 것.** 펼침 조건은 `호버 중 || 포커스가 안에
 * 있음` 하나의 **합성 상태**이고, 접기 타이머는 **발화 시점에 두 조건을 다시 확인한
 * 뒤에만** 실제로 접는다. 재확인이 없으면, 마우스로 펼치고 Tab 으로 항목에 간 뒤
 * 마우스만 치웠을 때 **키보드로 라벨을 읽는 도중 패널이 닫힌다**(ss-ux 검토 P0,
 * 계약 `sidebar-peek.test.tsx`).
 *
 * 두 조건을 ref 로 드는 것은 의도다 — 렌더에 직접 쓰이지 않고(렌더는 provider 의
 * `open` 이 소유한다) 타이머 콜백이 **최신 값**을 봐야 하므로, state 로 두면 클로저가
 * 낡은 값을 잡는다.
 */
function useSidebarPeek() {
  const { setOpen } = useSidebar()
  const hovering = React.useRef(false)
  const focusInside = React.useRef(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = React.useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const sync = React.useCallback(() => {
    clear()
    if (hovering.current || focusInside.current) {
      setOpen(true)
      return
    }
    timer.current = setTimeout(() => {
      timer.current = null
      // ⛔ 이 재확인을 지우지 말 것 — 위 주석의 사고가 그대로 재발한다.
      if (!hovering.current && !focusInside.current) setOpen(false)
    }, SIDEBAR_PEEK_CLOSE_DELAY_MS)
  }, [clear, setOpen])

  React.useEffect(() => clear, [clear])

  return React.useMemo(
    () => ({
      onMouseEnter: () => {
        hovering.current = true
        sync()
      },
      onMouseLeave: () => {
        hovering.current = false
        sync()
      },
      onFocusCapture: () => {
        focusInside.current = true
        sync()
      },
      onBlurCapture: (event: React.FocusEvent<HTMLElement>) => {
        // 사이드바 **안에서** 항목 간 이동하는 blur 는 벗어난 것이 아니다.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        focusInside.current = false
        sync()
      },
    }),
    [sync]
  )
}

function SidebarProvider({
  defaultOpen = false,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }

      // ⛔ 여기에 쿠키 쓰기를 되살리지 말 것 — 사이드바는 호버로만 열리고(peek)
      //    저장할 상태가 없다. 되살리면 서버가 그 값을 읽어야 하고, 그 순간 앱 페이지
      //    20여 개의 문서 캐시가 다시 사라진다(티켓 T-052 가 그 사고다).
      //    설계 정본: `docs/private/specs/2026-08-28-sidebar-hover-overlay-design.md` §4
    },
    [setOpenProp, open]
  )

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open)
  }, [isMobile, setOpen, setOpenMobile])

  // ⛔ 상류의 Cmd+B 토글 단축키는 제거했다(2026-08-28) — 이 사이드바는 호버·포커스로만
  //    열리고 "고정으로 펼쳐 두기"가 없다(오너 확정). 단축키를 되살리면 그 토글이
  //    호버 상태와 다투고, 다음 호버 이벤트에 조용히 덮여 조작이 먹지 않는 것처럼 보인다.

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? "expanded" : "collapsed"

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar]
  )

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar",
          className
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  )
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  peek = false,
  className,
  children,
  dir,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right"
  variant?: "sidebar" | "floating" | "inset"
  collapsible?: "offcanvas" | "icon" | "none"
  /**
   * 호버 오버레이 모드. 켜면 **흐름 안의 빈 칸이 레일 폭에 고정**되어, 패널이 펼쳐져도
   * 본문이 밀리지 않고 그 위로 덮인다.
   *
   * 🪤 `data-collapsible` 속성 **하나가** 빈 칸 폭과 "접힘 모양" 클래스 전체
   * (`group-data-[collapsible=icon]:*`)를 동시에 구동한다 — 호버 시 후자는 풀려야 하고
   * 전자는 고정돼야 하므로 여기서 둘을 가른다.
   * ⛔ 빈 칸 폭을 `group-data-*` 변형으로 되돌리지 말 것(그 순간 본문이 다시 밀린다).
   *
   * ⚠️ **전제조건: `collapsible="icon"` 과 함께만 쓴다.** 기본값 `"offcanvas"` 로 두면
   * 접힘 상태에서 패널이 `left: -10rem` 으로 **화면 밖에 나가는데** 빈 칸은 레일 폭
   * 3rem 을 그대로 예약해, 화면엔 빈 띠만 남고 마우스·포커스를 받을 패널은 밖에 있어
   * **아무 반응도 하지 않는다.** 타입으로는 막을 수 없어 소스 스캔 계약
   * (`crm-sidebar-row-shape.contract.test.ts`)이 이 짝을 강제한다.
   *
   * 설계 정본: `docs/private/specs/2026-08-28-sidebar-hover-overlay-design.md` §3
   */
  peek?: boolean
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar()

  if (collapsible === "none") {
    return (
      <div
        data-slot="sidebar"
        className={cn(
          "flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground",
          className
        )}
        {...props}
      >
        {children}
      </div>
    )
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
        <SheetContent
          dir={dir}
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
          side={side}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-state={state}
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          "relative bg-transparent",
          peek
            ? // ⛔ 트랜지션도 붙이지 않는다 — peek 에서 이 폭은 변하지 않는다.
              //    변형(group-data-*)을 되살리면 그 순간 호버가 본문을 민다.
              //    ⚠️ 폭은 **접힘 상태 패널의 폭과 같아야** 한다 — floating·inset 은
              //    패딩이 더 붙으므로 그 갈래도 따라간다(안 맞추면 호버 이전 평상시부터
              //    본문과 패널이 겹치거나 틈이 남는다).
              variant === "floating" || variant === "inset"
              ? "w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
              : "w-(--sidebar-width-icon)"
            : [
                "w-(--sidebar-width) transition-[width] duration-200 ease-linear",
                "group-data-[collapsible=offcanvas]:w-0",
                "group-data-[side=right]:rotate-180",
                variant === "floating" || variant === "inset"
                  ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
                  : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
              ]
        )}
      />
      <div
        data-slot="sidebar-container"
        data-side={side}
        className={cn(
          "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear data-[side=left]:left-0 data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] data-[side=right]:right-0 data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)] md:flex",
          // Adjust the padding for floating and inset variants.
          variant === "floating" || variant === "inset"
            ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
          // P8 elevation: 상시 내비이지 포털 레이어가 아니므로 lg 다.
          // ⛔ `shadow-overlay` 금지 — 그 층의 자격은 "페이지 흐름과 완전히 분리된 포털
          //    레이어"(Popover·Dialog·툴팁)이고 이 컴포넌트는 거기 해당하지 않는다.
          //    설계 정본: `.../2026-08-28-sidebar-hover-overlay-design.md` §5-2
          //
          // ⛔ `ease-linear`(상류 기본값)로 되돌리지 말 것 — 오너가 승인한 목업이
          //    `ease-out` 이었으므로 linear 는 **승인된 느낌과 다른 구현**이다. 등속은
          //    끝까지 같은 속도라 도착이 뭉개지고, 사용자가 가장 주시하는 마지막 구간이
          //    가장 심심해진다(review-animations 기준 3). 지속시간 200ms 는 불변.
          peek && "ease-out group-data-[state=expanded]:shadow-soft-lg",
          className
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex size-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:shadow-soft-sm group-data-[variant=floating]:ring-1 group-data-[variant=floating]:ring-sidebar-border"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className={cn(className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeftIcon />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  )
}

function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar()

  return (
    <button
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      className={cn(
        "absolute inset-y-0 z-20 hidden w-4 transition-[left,right,translate,background-color] ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2",
        "in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
        "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
        "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-sidebar",
        "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
        "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
        className
      )}
      {...props}
    />
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        "relative flex w-full flex-1 flex-col bg-background md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-soft-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2",
        className
      )}
      {...props}
    />
  )
}

function SidebarInput({
  className,
  ...props
}: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn("h-8 w-full bg-background shadow-none", className)}
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  )
}

function SidebarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn("mx-2 w-auto bg-sidebar-border", className)}
      {...props}
    />
  )
}

/**
 * 스크롤러의 잘린 엣지를 data 속성으로 표시한다(.scroll-fade-y 가 이 속성을 읽는다).
 *
 * setState 를 쓰지 않는다 — 스크롤 구동 값을 React 상태로 흘리면 프레임마다
 * 서브트리가 리렌더된다(styleseed mechanical check 5, AnimatedNumber 재작성 사유).
 * 판정 결과를 DOM 에 직접 쓰고 CSS 가 그것을 읽는 단방향이다.
 */
function useScrollEdges(ref: React.RefObject<HTMLDivElement | null>) {
  const update = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    const overflowing = max > SCROLL_EDGE_EPSILON_PX
    el.dataset.fadeTop = String(
      overflowing && el.scrollTop > SCROLL_EDGE_EPSILON_PX
    )
    el.dataset.fadeBottom = String(
      overflowing && el.scrollTop < max - SCROLL_EDGE_EPSILON_PX
    )
  }, [ref])

  // 매 커밋 1회, 페인트 전 — React 가 콘텐츠 높이를 바꾸는 경우(operator 분기로
  // 내비가 통째로 사라지거나, 승인대기 배지가 붙는 등)를 잡는다. ResizeObserver 는
  // 컨테이너 border-box 만 보므로 자식이 늘어 scrollHeight 가 바뀌는 것은 못 잡는다.
  // useEffect(패시브)가 아니라 useLayoutEffect 여야 하는 이유: 패시브 이펙트는
  // 페인트 **이후** 실행되므로, 넘치는 사이드바의 첫 페인트 프레임은 페이드 없이
  // 그려지고 다음 프레임에야 팝인한다. 그 첫 프레임이 바로 "정지 상태 — 사용자가
  // 스크롤하기 전"이라는, 이 기능이 존재하는 이유인 순간이다. 여기를 useEffect 로
  // "단순화"하면 그 프레임이 다시 사라진다.
  useIsomorphicLayoutEffect(update)

  // 구독은 마운트 1회 — 스크롤, 그리고 뷰포트 높이 변화·접힘 전환(폭 변화로
  // 항목이 줄바꿈되지는 않지만 높이 재계산 기회로 함께 쓴다).
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener("scroll", update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      el.removeEventListener("scroll", update)
      observer.disconnect()
    }
  }, [ref, update])
}

function SidebarContent({ className, ref, ...props }: React.ComponentProps<"div">) {
  const innerRef = React.useRef<HTMLDivElement>(null)
  useScrollEdges(innerRef)

  // 매 렌더 새 함수면 콜백 ref 아이덴티티가 바뀌어 React 19 가 매번 detach·재attach
  // 한다 — 안정된 아이덴티티를 유지하도록 메모이즈한다.
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      innerRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )

  return (
    <div
      // 내부 훅과 호출자 ref 를 함께 채운다 — 프리미티브라 ref 를 삼키지 않는다.
      ref={setRefs}
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        "no-scrollbar scroll-fade-y flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto overflow-x-hidden",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div"

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 ring-sidebar-ring outline-hidden transition-[margin,opacity] duration-200 ease-linear group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0 focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroupAction({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={cn(
        "absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform group-data-[collapsible=icon]:hidden after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

function SidebarGroupContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn("w-full text-sm", className)}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("flex w-full min-w-0 flex-col gap-0", className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  )
}

// 사이드바 메뉴 아이콘 크기의 정본은 아래 base 문자열의 `[&_svg]:size-*` 하나다.
// 이 유틸은 `.\[\&_svg\]\:size-* svg` 로 컴파일돼 특이성이 (0,1,1) 이라, 소비처가
// <svg> 자체에 붙인 `size-*`(0,1,0) 을 **소스 순서와 무관하게 항상 이긴다**
// (Tailwind v4 는 둘을 같은 @layer utilities 에 넣어 레이어로도 갈리지 않는다).
// 실사고 2026-08-18: crm-sidebar 가 아이콘마다 size-[18px] 를 선언했는데 실제 렌더는
// 16px 였고 tsc·eslint·테스트가 전부 통과했다 — 죽은 선언을 지우고 값을 여기로 올렸다.
// ⛔ 소비처에서 크기를 바꿔야 하면 <svg> 가 아니라 **버튼의 className** 에
// `[&_svg]:size-*` 로 넘길 것. 같은 요소·같은 변형 접두사라야 cn() 의 tailwind-merge
// 가 이 base 를 정상 대체한다(자식 svg 에 붙이면 twMerge 시야 밖이라 특이성에 진다).
const sidebarMenuButtonVariants = cva(
  "peer/menu-button group/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm ring-sidebar-ring outline-hidden transition-[width,height,padding] group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-open:hover:bg-sidebar-accent data-open:hover:text-sidebar-accent-foreground data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground [&_svg]:size-[18px] [&_svg]:shrink-0 [&>span:last-child]:truncate",
  {
    variants: {
      variant: {
        default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        outline:
          "bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]",
      },
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 text-sm group-data-[collapsible=icon]:p-0!",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean
  isActive?: boolean
  tooltip?: string | React.ComponentProps<typeof TooltipContent>
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot.Root : "button"
  const { isMobile, state } = useSidebar()

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  )

  if (!tooltip) {
    return button
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        // 펼쳐져 있으면 라벨이 이미 보인다 — 툴팁이 같은 라벨을 옆에 한 번 더 쓴다.
        // 툴팁이 원래 하던 일(아이콘만 있을 때 정체 식별)은 펼침이 완전히 대체한다.
        // ⛔ `isMobile` 단독으로 되돌리지 말 것(설계서 §5-4, 계약 `sidebar-peek.test.tsx`).
        hidden={isMobile || state === "expanded"}
        {...tooltip}
      />
    </Tooltip>
  )
}

function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean
  showOnHover?: boolean
}) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        "absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground ring-sidebar-ring outline-hidden transition-transform group-data-[collapsible=icon]:hidden peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0",
        showOnHover &&
          "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 peer-data-active/menu-button:text-sidebar-accent-foreground aria-expanded:opacity-100 md:opacity-0",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuBadge({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        "pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium text-sidebar-foreground tabular-nums select-none group-data-[collapsible=icon]:hidden peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 peer-data-active/menu-button:text-sidebar-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<"div"> & {
  showIcon?: boolean
}) {
  // Random width between 50 to 90%.
  const [width] = React.useState(() => {
    return `${Math.floor(Math.random() * 40) + 50}%`
  })

  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn("flex h-8 items-center gap-2 rounded-md px-2", className)}
      {...props}
    >
      {showIcon && (
        <Skeleton
          className="size-4 rounded-md"
          data-sidebar="menu-skeleton-icon"
        />
      )}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={
          {
            "--skeleton-width": width,
          } as React.CSSProperties
        }
      />
    </div>
  )
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5 group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  )
}

function SidebarMenuSubItem({
  className,
  ...props
}: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn("group/menu-sub-item relative", className)}
      {...props}
    />
  )
}

function SidebarMenuSubButton({
  asChild = false,
  size = "md",
  isActive = false,
  className,
  ...props
}: React.ComponentProps<"a"> & {
  asChild?: boolean
  size?: "sm" | "md"
  isActive?: boolean
}) {
  const Comp = asChild ? Slot.Root : "a"

  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        "flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground ring-sidebar-ring outline-hidden group-data-[collapsible=icon]:hidden hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[size=md]:text-sm data-[size=sm]:text-xs data-active:bg-sidebar-accent data-active:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  SIDEBAR_PEEK_CLOSE_DELAY_MS,
  SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_ICON,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
  useSidebarPeek,
}
