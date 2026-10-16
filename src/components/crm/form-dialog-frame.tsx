"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * FormDialogFrame — 만드는 창(딜·거래처·셀러·캠페인·조합)과 고르는 창(LinkSearchDialog)이
 * 함께 쓰는 데스크톱 팝업 골격: 머리(구분선) · 고정 도구줄(선택) · 네이티브 스크롤 본문 · 바닥 띠.
 *
 * 종전엔 창마다 골격이 셋으로 갈려 있었다(바닥 고정 띠 / 버튼이 본문과 함께 스크롤 / 구분선 없는
 * 기본 창). 고르는 창은 자기를 연 만드는 창과 생김새가 달랐다(2026-10-16 오너 점검).
 *
 * 스크롤은 Radix ScrollArea 가 아니라 네이티브다 — Radix 는 Windows(비오버레이 스크롤바)에서
 * 「잘렸는데 스크롤바가 없는」 상태를 만든다(PR #57). scrollbar-gutter 는 스크롤바 등장으로
 * 폭이 흔들리는 것을 막는다(P8 Layout Stability ①).
 */
export type FormDialogFrameProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** md = 단일 폼(기본), xl = 목록을 품은 폼(조합 캠페인). */
  size?: "md" | "xl";
  /**
   * 창 높이를 고정할 때(예: 고르는 창 — 불러오는 중·빈 목록·결과가 바뀌어도 중앙 정렬된 창이
   * 위아래로 움직이지 않게). 생략하면 내용 높이 + 85vh 상한.
   */
  heightClassName?: string;
  /** 머리와 본문 사이에 스크롤되지 않고 머무는 줄(검색 입력 등). */
  toolbar?: React.ReactNode;
  /** 바닥 띠 안의 버튼들. 폼 본문이 버튼을 직접 그리면(FormDialogActions) 생략한다. */
  footer?: React.ReactNode;
  /** 스크롤 영역 밖에 고정되는 오류 줄 — 본문을 내려봐도 실패 사유가 보인다(PR #57 관례). */
  error?: React.ReactNode;
  bodyClassName?: string;
  className?: string;
  children: React.ReactNode;
} & Pick<
  React.ComponentProps<typeof DialogContent>,
  "onOpenAutoFocus" | "onCloseAutoFocus" | "aria-describedby"
>;

export function FormDialogFrame({
  title,
  description,
  size = "md",
  heightClassName,
  toolbar,
  footer,
  error,
  bodyClassName,
  className,
  children,
  ...contentProps
}: FormDialogFrameProps) {
  return (
    <DialogContent
      {...contentProps}
      className={cn(
        "flex flex-col gap-0 overflow-hidden bg-gradient-to-b from-white to-slate-50 p-0",
        size === "xl" ? "sm:max-w-xl" : "sm:max-w-md",
        heightClassName ?? "max-h-[85vh]",
        className,
      )}
    >
      <DialogHeader className="shrink-0 gap-1.5 border-b border-border/70 px-6 py-5 pr-12">
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      {toolbar ? <div className="shrink-0 px-6 pt-4">{toolbar}</div> : null}
      <div
        data-slot="form-dialog-body"
        className={cn(
          // 본문이 바닥 띠(FormDialogActions)를 품으면 아래 여백을 띠가 대신한다 — 남겨 두면 끝까지
          // 내렸을 때 띠 아래로 빈 줄이 생긴다.
          "min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-gutter:stable] has-data-[slot=form-dialog-actions]:pb-0",
          bodyClassName,
        )}
      >
        {children}
      </div>
      {error ? <div className="shrink-0 px-6 pb-3">{error}</div> : null}
      {footer ? <FormDialogFooterBand>{footer}</FormDialogFooterBand> : null}
    </DialogContent>
  );
}

const FOOTER_BAND = "flex items-center justify-end gap-3 border-t border-border/70 bg-slate-50 px-6 py-4";

function FormDialogFooterBand({ children }: { children: React.ReactNode }) {
  return <div className={cn("shrink-0", FOOTER_BAND)}>{children}</div>;
}

/**
 * FormDialogActions — 버튼을 본문 컴포넌트가 직접 그려야 하는 폼(딜·거래처·셀러 — 모바일 Drawer 와
 * 본문을 공유한다)용. FormDialogFrame 본문 안에서는 바닥에 붙는 띠(sticky)로 그려져 FormDialogFrame
 * 의 footer 와 같은 모습이 되고, Drawer 처럼 그 본문 밖에서는 구분선 있는 평범한 버튼 줄이 된다.
 *
 * 띠를 본문 좌우 끝까지 펴는 음수 여백은 `in-data-[slot=form-dialog-body]:` 변형에만 걸린다 —
 * 본문 px-6 과 짝이므로 둘 중 하나를 바꾸면 함께 바꾼다(아래 여백은 본문 쪽이 0 으로 비운다). Drawer 에서는 걸리지 않아 넘쳐 흐르지 않는다.
 */
export function FormDialogActions({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="form-dialog-actions"
      className={cn(
        // 배경: 모바일 Drawer 처럼 바깥이 스크롤할 때 입력칸이 버튼 줄 밑으로 비치지 않게.
        "sticky bottom-0 z-10 mt-6 flex items-center justify-end gap-3 border-t border-border/70 bg-background pt-4",
        // FormDialogFrame 본문 안: 좌우·아래 여백을 상쇄하고 바닥 띠와 같은 배경·여백을 얹는다.
        "in-data-[slot=form-dialog-body]:-mx-6 in-data-[slot=form-dialog-body]:bg-slate-50 in-data-[slot=form-dialog-body]:px-6 in-data-[slot=form-dialog-body]:pb-4",
        className,
      )}
    >
      {children}
    </div>
  );
}
