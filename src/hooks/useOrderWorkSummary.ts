import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { OrderWorkSummary } from "@/lib/order-converter/order-work";

/** 주문 데이터는 아침 크론·주문 관리 진입·새로고침 버튼으로만 바뀐다 — 그보다 자주 물을 이유가 없다. */
const ORDER_WORK_REFETCH_MS = 5 * 60 * 1000;

async function fetchOrderWorkSummary(): Promise<OrderWorkSummary> {
  const res = await fetch("/api/order-work");
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "오늘 처리할 주문을 불러오지 못했습니다.");
  }
  return res.json();
}

/**
 * 홈 「오늘 처리할 주문」 카드 훅.
 * 서버는 네이버를 부르지 않는다(`/api/order-work` 헤더).
 */
export function useOrderWorkSummary() {
  return useQuery({
    queryKey: queryKeys.orderWork(),
    queryFn: fetchOrderWorkSummary,
    staleTime: 60 * 1000,
    refetchInterval: ORDER_WORK_REFETCH_MS,
  });
}
