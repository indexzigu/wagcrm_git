import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { AutomationIncident } from "@/lib/automation-incidents";

/** 사고는 크론 회차마다 바뀐다 — 승인대기처럼 30초씩 물을 이유가 없다. */
const WAITING_REFETCH_MS = 5 * 60 * 1000;

async function fetchWaitingIncidents(): Promise<AutomationIncident[]> {
  const res = await fetch("/api/system/incidents?status=waiting_owner");
  if (!res.ok) throw new Error("조치대기 자동화 작업을 불러오지 못했습니다.");
  const body = await res.json();
  // 봉투가 어긋나면 빈 목록으로 위장하지 않는다 — 「조치대기 없음」과 「모름」이 같은 얼굴이 된다.
  if (!Array.isArray(body?.incidents)) throw new Error("조치대기 자동화 작업 응답 형식이 맞지 않습니다.");
  return body.incidents;
}

/** 홈 「오늘 처리할 일」의 「자동화 작업 조치대기」 원천(크론 자가 복구 2단계). */
export function useWaitingAutomationIncidents() {
  return useQuery({
    queryKey: queryKeys.automationWaitingIncidents(),
    queryFn: fetchWaitingIncidents,
    staleTime: 60 * 1000,
    refetchInterval: WAITING_REFETCH_MS,
  });
}
