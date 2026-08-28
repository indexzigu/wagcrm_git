import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SellerSummary } from "@/lib/crm-types";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";

export type SellerRow = SellerSummary;

async function fetchSellers(): Promise<SellerRow[]> {
  const response = await fetch("/api/sellers");
  if (!response.ok) throw new Error("셀러 목록을 불러오지 못했습니다");
  const data = await response.json();
  return (data.sellers ?? data) as SellerRow[];
}

export function useSellers(initialSellers: SellerRow[]) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.sellers(),
    queryFn: fetchSellers,
    initialData: initialSellers,
    staleTime: 5 * 60 * 1000, // warm(5m) — 서버 cache-policy warm 투영
  });

  const sellers = query.data ?? initialSellers;

  const setSellers = useCallback(
    (updater: SellerRow[] | ((prev: SellerRow[]) => SellerRow[])) => {
      queryClient.setQueryData<SellerRow[]>(queryKeys.sellers(), (prev) => {
        const base = prev ?? initialSellers;
        return typeof updater === "function"
          ? (updater as (prev: SellerRow[]) => SellerRow[])(base)
          : updater;
      });
    },
    [queryClient, initialSellers]
  );

  const [selectedSeller, setSelectedSeller] = useState<SellerRow | null>(null);
  const [sellerPanelMode, setSellerPanelMode] = useState<"view" | "create">("view");

  const handleInlinePatch = useCallback(async (id: string, patch: Record<string, unknown>) => {
    return withMutationFeedback(
      (async () => {
        const response = await fetch(`/api/sellers/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) throw new Error("셀러 수정에 실패했습니다");
        const updated = (await response.json()) as SellerRow;
        setSellers((previous) =>
          previous.map((row) => (row.id === id ? updated : row))
        );
        return updated;
      })(),
      "셀러 정보가 수정되었습니다."
    ).catch(() => null);
  }, [setSellers]);

  // 순수 상태 동기화 — 토스트 금지. 필드수정·채널동기화·이력·연결 등 여러 액션의
  // 하위 단계로 반복 호출되므로, 여기서 토스트하면 액션마다 중복된다.
  // 피드백은 각 액션의 단일 소유 지점(컴포넌트 핸들러)에서만 띄운다. [[wagcrm-partner-toast-ownership]]
  const handleSellerUpdated = useCallback((updated: SellerRow) => {
    setSellers((prev) =>
      prev.map((seller) => (seller.id === updated.id ? { ...seller, ...updated } : seller))
    );
    setSelectedSeller((prev: SellerRow | null) => (prev?.id === updated.id ? { ...prev, ...updated } : prev));
  }, [setSellers]);

  const handleSellerCreated = useCallback((created: SellerRow) => {
    setSellers((prev) => [created, ...prev]);
    setSellerPanelMode("view");
    setSelectedSeller(created);
    toast.success("새로운 셀러가 추가되었습니다.");
  }, [setSellers]);

  const handleSellersBulkCreated = useCallback((createdRows: Array<Record<string, unknown>>) => {
    if (createdRows.length === 0) return;
    const mapped: SellerRow[] = createdRows.map((c) => ({
      id: c.id as string,
      name: c.name as string,
      alias: (c.alias as string) ?? null,
      snsType: c.snsType as SellerRow["snsType"],
      snsHandle: c.snsHandle as string,
      currentFollowers: (c.currentFollowers as number) ?? 0,
      campaignCount: 0,
      category: (c.category as string) ?? null,
      channelUrl: (c.channelUrl as string) ?? null,
      isMonitored: (c.isMonitored as boolean) ?? false,
      createdAt: c.createdAt as string | undefined,
    }));
    setSellers((prev) => {
      const existing = new Set(prev.map((s) => s.id));
      const fresh = mapped.filter((m) => !existing.has(m.id));
      return [...fresh, ...prev];
    });
  }, [setSellers]);

  // 백그라운드 스크래핑 보강분을 반영하기 위한 강제 재조회.
  const refetchSellers = useCallback(() => {
    void query.refetch();
  }, [query]);

  const handleSellerDeleted = useCallback((sellerId: string) => {
    setSellers((prev) => prev.filter((s) => s.id !== sellerId));
    setSelectedSeller(null);
    // 토스트는 액션 지점(seller-detail 삭제 핸들러)에서 단일 노출.
  }, [setSellers]);

  return {
    sellers,
    setSellers,
    selectedSeller,
    setSelectedSeller,
    sellerPanelMode,
    setSellerPanelMode,
    handleInlinePatch,
    handleSellerUpdated,
    handleSellerCreated,
    handleSellersBulkCreated,
    handleSellerDeleted,
    refetchSellers,
  };
}
