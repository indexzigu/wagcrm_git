"use client";

import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { MobileSheetCloseChip } from "./mobile-sheet-close-chip";
import { cn } from "@/lib/utils";

/**
 * 풀스크린 시트 공용 헤더 — **흐름(non-sticky)**. 탭 상단바와 같은 언어다
 * (오너 확정 2026-07-16: "상단바 고정이 유의미하지 않다" — 구 sticky 글래스 바 폐기).
 * 본문과 함께 스크롤하며, 닫기는 MobileSheetCloseChip(화면 고정)이 담당한다 —
 * 유일한 탈출구라 스크롤 밖으로 내보낼 수 없어서다(칩 파일 주석 참조).
 *
 * MobileTopBar 자체를 재사용하지 않는 이유: 그쪽은 탭 본문 위에 떠 있는 rounded-2xl
 * 글래스 "카드"이고, 시트는 열리면 화면 자체가 되므로 풀블리드가 관례다. 게다가 시트는
 * Radix 의 SheetTitle·SheetDescription 을 품어야 접근성 계약이 성립한다. 타이포 위계
 * (제목 18px · 서브 12px)만 공유해 탭↔시트 전환 시 인상이 튀지 않게 한다.
 *
 * ⛔ **캡션 슬롯("WAG CRM")을 되살리지 말 것**(오너 지시 2026-08-26) — 사유는
 * `mobile-top-bar.tsx` 의 같은 주석이 정본이다. 두 셸이 짝으로 움직여야 탭↔시트
 * 위계가 갈리지 않는다.
 *
 * 캠페인 상세 시트는 상태 배지·셀러·차수를 얹은 자체 헤더를 쓰므로 이 셸을 쓰지 않는다
 * (닫기 칩은 공유).
 */
export function MobileSheetHeader({
  title,
  description,
  closeLabel,
  className,
}: {
  title: string;
  description: string;
  /** 닫기 칩 aria-label — 시트마다 다르게 준다 */
  closeLabel: string;
  className?: string;
}) {
  return (
    <>
      {/* 칩은 fixed 라 렌더 위치와 무관하게 화면 우상단에 뜬다. pr-12 는 겹침 예약 폭. */}
      <MobileSheetCloseChip label={closeLabel} />
      <header
        className={cn(
          "mobile-sheet-safe-top border-b border-slate-200/60 pb-3 pl-4 pr-12",
          className,
        )}
      >
        {/* 구 flex 헤더(닫기 버튼과 나란)의 min-w-0/flex-1 잔재 제거 — 지금은 block 흐름. */}
        <div>
          <SheetTitle className="text-lg font-semibold tracking-tight text-foreground">
            {title}
          </SheetTitle>
          <SheetDescription className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </SheetDescription>
        </div>
      </header>
    </>
  );
}
