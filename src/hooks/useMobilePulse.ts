import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { MobilePulseResponse } from "@/lib/mobile-pulse-data";

/**
 * GET /api/mobile/pulse 공용 훅 — 홈 "오늘의 펄스" 카드와 일정탭 "오늘 운영
 * 현황" 바가 같은 캐시를 공유한다(Vercel·Supabase 사용량 절감, 2026-07-23).
 *
 * 종전에는 두 컴포넌트가 각자 useState fetch를 소유해 탭 전환(홈↔일정)마다
 * 매번 함수 호출 + DB 조회가 발생했다. 캐시를 루트 QueryClient(gcTime 24h)로
 * 옮기면 staleTime(60s — 서버 pulse가 읽는 동기화 주기와 정렬) 안의 재마운트는
 * 네트워크 요청 0회가 된다.
 *
 * 계약 유지(오너 확정 2026-07-15): 자동 폴링 금지 — refetchInterval 없음,
 * refetchOnWindowFocus는 전역 default(false)를 상속. 재조회는 각 소비자의
 * 수동 새로고침 버튼(refetch)뿐이다.
 */
async function fetchMobilePulse(): Promise<MobilePulseResponse> {
  const response = await fetch("/api/mobile/pulse", { cache: "no-store" });
  if (!response.ok) throw new Error(`pulse ${response.status}`);
  return (await response.json()) as MobilePulseResponse;
}

export function useMobilePulse() {
  const query = useQuery({
    queryKey: queryKeys.mobilePulse(),
    queryFn: fetchMobilePulse,
    staleTime: 60 * 1000,
  });

  // 에러 삼킴 금지(P0) — 근거는 콘솔, 화면 표기는 각 소비자가 담당한다.
  const { error } = query;
  React.useEffect(() => {
    if (error) console.error("mobile pulse fetch failed:", error);
  }, [error]);

  return query;
}
