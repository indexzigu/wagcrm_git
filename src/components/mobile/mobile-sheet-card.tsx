"use client";

import { formatCurrency } from "@/lib/format";
import { MONEY_ROW_AMOUNT_NEUTRAL, MONEY_ROW_SETTLED_MUTED } from "@/lib/money-direction";
import type { MoneySlotAmountDisplay } from "@/lib/tax-filing-board";
import { cn } from "@/lib/utils";

/**
 * 시트 본문 공용 카드·행 문법 (오너 목업 확정 2026-07-15 §2·§4).
 *
 * 탭 표면(일정탭 카드 스택)과 같은 언어를 시트 본문에도 쓴다 — 페이지는 slate-50,
 * 내용은 흰 유리 카드. 정산 대기 시트(카드 2장)·예비 일정 시트(폼 카드)·캠페인 상세
 * 시트(일정·정산 카드)가 이 프리미티브를 공유하므로 마크업을 각자 복제하지 않는다.
 */

export function MobileSheetCard({
  title,
  chip,
  ariaLabel,
  children,
  className,
}: {
  /** 카드 헤더 제목 — 없으면 헤더 줄 자체를 렌더하지 않는다(예: 폼 카드) */
  title?: string;
  /** 헤더 우측 카운트 칩. 합계는 제목 문장에 섞지 않고 여기로 분리한다 */
  chip?: string;
  ariaLabel?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={ariaLabel ?? title}
      className={cn(
        "rounded-2xl border border-white/60 bg-white/85 shadow-soft-sm backdrop-blur-md",
        className,
      )}
    >
      {title ? (
        <div className="flex items-center justify-between gap-2 px-6 pb-2 pt-2.5">
          <h2 className="truncate text-[13px] font-bold text-slate-800">{title}</h2>
          {chip ? (
            <span className="shrink-0 rounded-full border border-slate-100 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-slate-500">
              {chip}
            </span>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * 카드 안의 한 줄 — 아이콘 원 + 2줄(라벨/값) + 우측 슬롯.
 *
 * onClick 을 주면 탭 가능한 행(button)으로, 없으면 표시 전용(div)으로 렌더한다.
 * 정산 대기 시트의 행은 캠페인 상세를 여는 버튼이고, 상세 시트의 일정 행은 표시
 * 전용이라 두 모드가 모두 필요하다.
 */
export function MobileSheetRow({
  icon,
  label,
  value,
  valueClassName,
  trailing,
  onClick,
  overdue,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
  overdue?: boolean;
}) {
  const content = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-slate-100 bg-slate-50">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col justify-center">
        {/* slate-500(=--muted-foreground, 4.6:1). 목업은 이 줄에 slate-400(#94A3B8)을
            썼지만 흰 카드 위 2.6:1 로 WCAG AA(4.5:1) 미달이다 — 정산 대기 시트에서는
            이 줄이 "딜명 · 셀러명"(행의 1차 식별 정보)이라 더더욱 읽혀야 한다.
            목업의 위계(작은 위 / 진한 아래)는 그대로 두고 톤만 올렸다. */}
        <span className="truncate text-[10px] font-medium leading-tight text-slate-500">
          {label}
        </span>
        <span
          className={cn(
            "mt-0.5 truncate text-xs font-semibold leading-tight text-slate-700",
            valueClassName,
          )}
        >
          {value}
        </span>
      </span>
      {trailing}
    </>
  );

  const rowClassName = "flex min-h-11 w-full items-center gap-2.5 border-t border-slate-100 px-6 py-3 text-left";

  if (!onClick) {
    return (
      <div className={rowClassName} data-overdue={overdue ? "true" : undefined}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      data-overdue={overdue ? "true" : undefined}
      className={cn(
        rowClassName,
        "transition-colors duration-150 active:bg-slate-50/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
      )}
    >
      {content}
    </button>
  );
}

/**
 * 행 우측 금액 — 대기 건은 진하게, 완료 건은 한 단계 낮은 무채 랭크(`MONEY_ROW_SETTLED_MUTED`).
 *
 * 강등해도 #64748B 까지만 내린다. 금액은 비활성 컨트롤이 아니라 읽히라고 있는
 * 정보라 WCAG 1.4.3 면제 대상이 아니다 — 흰 카드 위 4.6:1 로 AA 를 유지한다.
 *
 * ⛔ **굵기를 함께 내리지 말 것**(구 `font-medium text-slate-500`). 종전 주석은
 * *"강등은 굵기와 톤이 함께 만든다"* 고 선언했지만, 같은 개념을 구현한 다른 두 표면
 * (`MobileScheduleDayList` · 상세 시트 `SettlementRow`)은 **색만** 내린다 — 굵기가 갈리면
 * tabular-nums 정렬이 광학적으로 흔들린다. 세 표면이 서로 다른 처방을 각자 주석으로
 * 선언하고 있던 것이 이 통합(2026-08-26, 오너 승인)이 고친 드리프트다.
 *
 * ⚠️ `dim` 은 이 통합 시점에 **소비처가 0곳**이었다 — 그래서 함께 맞췄다. 죽은 분기를
 * 옛 처방인 채로 남기면 다음 세션이 그걸 소비하는 순간 세 번째 사본이 생긴다.
 */
export function MobileSheetAmount({
  amount,
  dim,
}: {
  /**
   * 숫자가 아니라 **판정**을 받는다 — 합산 이관은 금액이 아니라 상태라 `₩0` 으로 적으면
   * 「확인된 0원」으로 읽힌다(`MoneySlotAmountDisplay`, T-057).
   */
  amount: MoneySlotAmountDisplay;
  dim?: boolean;
}) {
  return (
    <span
      className={cn(
        "shrink-0 text-xs tabular-nums",
        // 목록 행 금액은 무채색이다 — 방향은 왼쪽 아이콘이 말한다(규칙·근거는 lib/money-direction).
        // 여기에 방향색을 넣으면 행마다 색이 붙어 아무것도 안 튄다(P8 §2).
        // ⚠️ 종전 주석의 *"색은 지연 배지에 양보한다"* 는 근거는 소멸했다 — 그 배지는 제거됐다
        // (아래 🪦). 양보할 대상이 없어졌다고 여기에 색을 넣는 것은 규칙의 오독이다.
        "font-bold",
        // 상태 문구는 숫자가 아니므로 굵기를 한 단계 낮춘다(자릿수 정렬은 무해해서 둔다).
        amount.kind === "STATE" && "font-medium",
        dim ? MONEY_ROW_SETTLED_MUTED : MONEY_ROW_AMOUNT_NEUTRAL,
      )}
    >
      {amount.kind === "AMOUNT"
        ? `₩${formatCurrency(amount.amount)}`
        : amount.kind === "STATE"
          ? amount.text
          : "금액 미정"}
    </span>
  );
}

/*
 * 🪦 `MobileOverdueBadge`(「지연」 배지) 는 제거됐다 — 오너 지시 2026-08-26:
 * *"예정일이 지난건 색을 다르게 표시하거나 배지나 서브텍스트로 표기하지마"*,
 * 범위 재확인 답 *"전부 다 제거"*. 소비처 2곳(캠페인 상세 시트 일정·정산 행 ·
 * 정산 대기 목록)에서 함께 걷었다.
 *
 * ⛔ **되살리지 말 것.** "예정일이 지났는데 아무 신호가 없다"는 결함처럼 보이지만
 * 오너가 그 결과를 알고 내린 결정이다(제거 시 화면에 경과 신호가 **하나도 남지
 * 않는다**는 점을 보고받은 뒤 "전부 다"로 답했다). 계약 테스트가 부재를 고정한다.
 *
 * ⚠️ 아래 `MobileSheetRow` 의 `overdue` prop 과 `data-overdue` 속성은 **남겼다** —
 * CSS 소비처가 0곳이라 화면에 아무것도 그리지 않고(전수 grep 실측), 정산 대기 시트의
 * **연체 우선 정렬**이 같은 판정을 쓰기 때문이다. 오너가 금지한 것은 표기이지 순서가
 * 아니다. ⛔ 그 속성에 스타일을 얹으면 이 결정을 우회하는 것이 된다.
 */
