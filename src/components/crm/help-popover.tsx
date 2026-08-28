"use client";

import { Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * 라벨 옆 **설명 팝오버** — 상시 표시하면 카드가 길어지는 안내를 「눌러서 보는」 자리로
 * 옮긴다(오너 지시 2026-08-28: 정산 기준액 서브텍스트 · 매출 상세 내역의 정산 단계 안내).
 *
 * ⚠️ **툴팁이 아니라 팝오버인 것은 의도다.** 이 자리에 들어가는 문장은 3~4줄이라
 * 툴팁 폭(이 레포 관례 240px)에서 잘리고, 툴팁은 hover 에 의존해 터치·키보드에서
 * 열기 어렵다. 팝오버는 클릭·Enter 로 열리고 Esc 로 닫힌다.
 *
 * ⛔ 트리거를 아이콘만 있는 `div` 로 바꾸지 말 것 — 접근 이름(`ariaLabel`)이 붙은
 * 버튼이라야 "무엇에 대한 설명인지"가 스크린리더와 테스트 양쪽에서 식별된다.
 */
export function HelpPopover({
  ariaLabel,
  title,
  text,
  className,
}: {
  /** 접근 이름. 예: `정산 기준액 설명` · `최종 정산 기준 데이터 안내`. */
  ariaLabel: string;
  /** 팝오버 안 제목(선택) — 안내가 독립된 덩어리일 때만 쓴다. */
  title?: string;
  text: string;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            // ⚠️ `size-6`(24px) 는 취향이 아니라 하한이다 — 이 레포의 고밀도 CRM 예외도
            // **조작 영역 ≥24×24 CSS px** 까지이고(styleseed Golden Rule 8 · WCAG 2.5.8),
            // 아이콘만 14~16px 로 두면 그 아래로 내려간다. 아이콘은 작게, 영역만 넓힌다.
            "inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus-ring",
            className,
          )}
        >
          <Info className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        {title ? <div className="mb-1 text-xs font-semibold text-foreground">{title}</div> : null}
        <p className="text-[11px] leading-5 text-muted-foreground">{text}</p>
      </PopoverContent>
    </Popover>
  );
}
