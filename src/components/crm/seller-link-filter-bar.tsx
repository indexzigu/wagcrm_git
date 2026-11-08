"use client";

// [셀러분석] 「링크 조건」 줄 — 슬랙 봇이 보낸 셀러 목록 링크(주소 필터)가 무엇을 걸었는지 보여 준다.
// 조건이 걸린 채 목록이 줄어 있는데 이유가 안 보이면 오너는 셀러가 사라졌다고 읽는다 — 그래서 걸린 조건과
// 주소에서 읽지 못해 버린 조건(「반영 못한 조건」, 봇 답과 같은 말)을 함께 적는다. 칩은 표시일 뿐이고
// 동작은 「조건 지우기」 하나다(청록 채움은 화면당 하나 — 「신규 셀러」가 가졌으므로 테두리 버튼).
// 데스크톱 카드 안과 모바일 목록 위에서 같이 쓴다 — flex-wrap 이라 미디어쿼리 분기가 없다(P5).

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SellerLinkFilterBarProps {
  chips: string[];
  /** 주소에서 읽지 못한 조건의 화면 문구(「참여율 「abc」」) */
  unreadable: string[];
  /** 조건을 적용한 뒤 남은 셀러 수(세그먼트·검색 포함) */
  count: number;
  onClear: () => void;
  className?: string;
}

export function SellerLinkFilterBar({ chips, unreadable, count, onClear, className }: SellerLinkFilterBarProps) {
  if (chips.length === 0 && unreadable.length === 0) return null;

  return (
    <section
      aria-label="링크 조건"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border bg-slate-50/60 px-5 py-2",
        className,
      )}
    >
      <span className="text-xs font-medium text-muted-foreground">링크 조건</span>
      {chips.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <li
              key={chip}
              className="inline-flex h-6 items-center rounded-full bg-primary/10 px-2.5 text-xs font-medium text-primary"
            >
              {chip}
            </li>
          ))}
        </ul>
      ) : null}
      {unreadable.length > 0 ? (
        <p className="inline-flex items-center gap-1 text-xs font-medium text-status-urgent-text">
          <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          반영 못한 조건: {unreadable.join(" · ")}
        </p>
      ) : null}
      <span className="ml-auto text-xs text-slate-600 tabular-nums">셀러 {count}건</span>
      <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={onClear}>
        조건 지우기
      </Button>
    </section>
  );
}
