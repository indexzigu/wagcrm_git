"use client";
// /pipeline?campaignId=<id> 딥링크 소비 — 홈 브리핑 행 클릭과 deals-panel의 기존 유도가
// 이 경로로 들어온다. 종전에는 push하는 쪽만 있고 읽는 쪽이 없어 파라미터가 무시됐다.
import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";

export function useCampaignDeepLink(onOpen: (campaignId: string) => void): void {
  const searchParams = useSearchParams();
  const consumedRef = useRef(false);
  useEffect(() => {
    if (consumedRef.current) return;
    const id = searchParams?.get("campaignId");
    if (!id) return;
    consumedRef.current = true;
    onOpen(id);
    // ponytail: URL 정리는 생략 — 파라미터 잔존은 무해하고 replace는 리렌더만 유발한다.
    // onOpen은 의도적으로 의존성에서 제외(매 렌더 새 함수여도 재발화 금지 — consumedRef가 게이트).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
}
