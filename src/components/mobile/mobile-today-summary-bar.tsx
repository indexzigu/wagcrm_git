"use client";

import { RefreshCwIcon } from "lucide-react";
import { useMobilePulse } from "@/hooks/useMobilePulse";
import { cn } from "@/lib/utils";
import { MobileTopBar } from "./mobile-top-bar";

/**
 * 일정탭 topbar — 진행중 캠페인 배송 진행 현황 (오너 피드백 2026-07-14).
 *
 * 아코디언 제거: 구 펼침 영역(동기화 시간·전체 캠페인 링크)은 특별한 정보가
 * 아니어서 접기/펼치기 자체를 없앴다. 남는 것 —
 * - 제목 "오늘 운영 현황" + 진행중 전 캠페인의 배송 진행(배타 3단계: 주문·배송중·배송완료).
 * - 우측 수동 새로고침 버튼(자동 폴링 금지 — useMobilePulse 공용 훅이 보장,
 *   홈 펄스 카드와 캐시 공유라 탭 전환 재마운트가 중복 요청을 만들지 않는다).
 * 셸은 3탭 공용 MobileTopBar(일정탭 카드 디자인 정본)를 쓴다.
 */

export function MobileTodaySummaryBar() {
  const { data, error, isPending, isFetching, refetch } = useMobilePulse();

  // 기존 계약 유지: 실패 시 화면에 실패 문구 명시(에러 삼킴 금지 — 콘솔 로그는 훅 담당).
  const errorMessage = error ? "진행 현황을 불러오지 못했습니다" : null;
  const initialLoading = isPending && errorMessage === null;
  const fulfillment = data?.fulfillment;

  return (
    <MobileTopBar
      title="오늘 운영 현황"
      className="mb-2"
      right={
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          aria-label="배송 현황 새로고침"
          className="flex size-11 shrink-0 items-center justify-center text-muted-foreground"
        >
          <RefreshCwIcon className={cn("size-4", isFetching && "animate-spin")} />
        </button>
      }
    >
      {initialLoading ? (
        <span
          aria-busy="true"
          aria-label="진행 현황 불러오는 중"
          className="mt-1 block h-4 w-44 animate-pulse rounded bg-muted"
        />
      ) : errorMessage || !fulfillment ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{errorMessage ?? "진행 현황 없음"}</p>
      ) : (
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs tabular-nums text-muted-foreground">
          <span>
            주문 <span className="font-semibold text-foreground">{fulfillment.ordered}</span>
          </span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          <span>
            배송중 <span className="font-semibold text-foreground">{fulfillment.shipping}</span>
          </span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          <span>
            배송완료{" "}
            <span className="font-semibold text-foreground">{fulfillment.completed}</span>
          </span>
        </p>
      )}
    </MobileTopBar>
  );
}
