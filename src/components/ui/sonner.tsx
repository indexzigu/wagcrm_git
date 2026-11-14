"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonAlertIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // 오류 토스트는 닫을 때까지 남으므로(`@/lib/toast`) 닫는 수단이 반드시 보여야 한다.
      closeButton
      // sonner 기본 접근 이름은 영어(「Notifications」「Close toast」)다.
      containerAriaLabel="알림"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        // X 모양 아이콘을 쓰지 않는다 — 바로 옆 닫기 버튼(×)과 겹쳐 「x 가 두 개」로 읽혔다(2026-11-14).
        error: (
          <OctagonAlertIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          // 모달(시트·대화상자)이 열리면 Radix 가 body 에 pointer-events:none 을 건다. 알림은 body 직속이라
          // 그것을 물려받아 닫기 버튼이 눌리지 않았다(클릭이 아래 시트로 빠짐) — 알림 영역만 되살린다.
          // 모달 쪽은 `keepModalOpenOnToast`(@/lib/toast-region)가 알림 클릭을 「바깥 클릭」으로 읽지 않게 막는다.
          pointerEvents: "auto",
        } as React.CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: "알림 닫기",
        classNames: {
          toast: "cn-toast rounded-[12px] shadow-soft-md",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
