import { useState, useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DealRow } from "@/components/crm/deals-grid";
import type { DealPanelData } from "@/components/crm/deals-panel";
import type { DealProfitabilityRow } from "@/components/crm/deal-profitability-table";
import type { DealStatus } from "@/lib/crm-types";
import { parseBaseMarginPolicy } from "@/lib/base-margin-policy";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";

function getSellerCount(candidateSellers: string | null | undefined): number {
  if (!candidateSellers) return 0;
  return candidateSellers.split(",").map((s) => s.trim()).filter(Boolean).length;
}

function mapDealResponse(deal: Record<string, unknown>): DealRow {
  return {
    id: deal.id as string,
    dealName: deal.dealName as string,
    brandName: (deal.brandName as string) ?? null,
    partnerName: ((deal.partner as Record<string, unknown>)?.name as string) ?? "",
    partnerId: deal.partnerId as string,
    costPrice: Number((deal.costPrice as { toString(): string })?.toString?.() ?? deal.costPrice ?? 0),
    sellingPrice: Number((deal.sellingPrice as { toString(): string })?.toString?.() ?? deal.sellingPrice ?? 0),
    listPrice: deal.listPrice != null ? Number(deal.listPrice) : null,
    floorPrice: deal.floorPrice != null ? Number(deal.floorPrice) : null,
    discountRate: deal.discountRate != null ? Number(deal.discountRate) : null,
    totalCommissionRate: deal.totalCommissionRate != null ? Number(deal.totalCommissionRate) : null,
    brokerageCommissionRate: deal.brokerageCommissionRate != null ? Number(deal.brokerageCommissionRate) : null,
    sourcingMemo: (deal.sourcingMemo as string) ?? null,
    candidateSellers: (deal.candidateSellers as string) ?? null,
    sellerCount: getSellerCount(deal.candidateSellers as string),
    status: (deal.status as DealStatus) ?? "SOURCING",
    campaignCount: ((deal._count as Record<string, number>)?.campaigns) ?? 0,
    taskCount: ((deal._count as Record<string, number>)?.salesTasks) ?? 0,
    createdAt: (deal.createdAt as string) ?? new Date().toISOString(),
    baseMarginPolicy: parseBaseMarginPolicy(deal.baseMarginPolicy as string | null | undefined),
  };
}

async function fetchDealsList(): Promise<DealRow[]> {
  const response = await fetch("/api/deals");
  if (!response.ok) throw new Error("Failed to fetch deals");
  const data = await response.json();
  return (data.deals ?? data).map(mapDealResponse);
}

async function fetchDealDetailPayload(deal: DealRow): Promise<DealPanelData> {
  try {
    const response = await fetch(`/api/deals/${deal.id}`);
    if (response.ok) {
      const data = await response.json();
      return {
        id: deal.id,
        dealName: data.dealName ?? deal.dealName,
        brandName: data.brandName ?? deal.brandName ?? null,
        partnerName: data.partnerName ?? data.partner?.name ?? deal.partnerName,
        partnerId: data.partnerId ?? deal.partnerId,
        costPrice: Number(data.costPrice ?? deal.costPrice ?? 0),
        sellingPrice: Number(data.sellingPrice ?? deal.sellingPrice ?? 0),
        listPrice: data.listPrice ?? deal.listPrice ?? null,
        floorPrice: data.floorPrice ?? deal.floorPrice ?? null,
        supplyPrice: data.supplyPrice ?? null,
        discountRate: data.discountRate ?? deal.discountRate ?? null,
        totalCommissionRate: data.totalCommissionRate ?? deal.totalCommissionRate ?? null,
        brokerageCommissionRate: data.brokerageCommissionRate ?? deal.brokerageCommissionRate ?? null,
        sourcingMemo: data.sourcingMemo ?? deal.sourcingMemo ?? null,
        candidateSellers: data.candidateSellers ?? deal.candidateSellers ?? null,
        status: data.status ?? deal.status,
        baseMarginPolicy: parseBaseMarginPolicy(data.baseMarginPolicy),
        createdAt: deal.createdAt,
        dealType: data.dealType ?? "MAIN",
        parentDealId: data.parentDealId ?? null,
        options: data.options ?? [],
        campaigns: data.campaigns ?? [],
      };
    }
    return {
      id: deal.id,
      dealName: deal.dealName,
      brandName: deal.brandName ?? null,
      partnerName: deal.partnerName,
      partnerId: deal.partnerId,
      costPrice: deal.costPrice,
      sellingPrice: deal.sellingPrice,
      listPrice: deal.listPrice ?? null,
      floorPrice: deal.floorPrice ?? null,
      supplyPrice: null,
      discountRate: deal.discountRate ?? null,
      totalCommissionRate: deal.totalCommissionRate ?? null,
      brokerageCommissionRate: deal.brokerageCommissionRate ?? null,
      sourcingMemo: deal.sourcingMemo ?? null,
      candidateSellers: deal.candidateSellers ?? null,
      status: deal.status,
      baseMarginPolicy: { byChannel: {} },
      createdAt: deal.createdAt,
      campaigns: [],
    };
  } catch {
    return {
      id: deal.id,
      dealName: deal.dealName,
      brandName: deal.brandName ?? null,
      partnerName: deal.partnerName,
      partnerId: deal.partnerId,
      costPrice: deal.costPrice,
      sellingPrice: deal.sellingPrice,
      listPrice: deal.listPrice ?? null,
      floorPrice: deal.floorPrice ?? null,
      supplyPrice: null,
      discountRate: deal.discountRate ?? null,
      totalCommissionRate: deal.totalCommissionRate ?? null,
      brokerageCommissionRate: deal.brokerageCommissionRate ?? null,
      sourcingMemo: deal.sourcingMemo ?? null,
      candidateSellers: deal.candidateSellers ?? null,
      status: deal.status,
      baseMarginPolicy: { byChannel: {} },
      createdAt: deal.createdAt,
      campaigns: [],
    };
  }
}

async function fetchProfitability(): Promise<DealProfitabilityRow[]> {
  const response = await fetch("/api/deals/profitability");
  if (!response.ok) throw new Error("Failed to fetch profitability deals");
  const data = await response.json();
  return data.deals ?? [];
}

export function useDeals(initialDeals: DealRow[]) {
  const queryClient = useQueryClient();

  // --- 1) 목록 쿼리 ---
  const listQuery = useQuery({
    queryKey: queryKeys.deals.list(),
    queryFn: fetchDealsList,
    initialData: initialDeals,
    staleTime: 5 * 60 * 1000, // warm(5m)
  });
  const deals = listQuery.data ?? initialDeals;

  const setDeals = useCallback(
    (updater: DealRow[] | ((prev: DealRow[]) => DealRow[])) => {
      queryClient.setQueryData<DealRow[]>(queryKeys.deals.list(), (prev) => {
        const base = prev ?? initialDeals;
        return typeof updater === "function"
          ? (updater as (prev: DealRow[]) => DealRow[])(base)
          : updater;
      });
    },
    [queryClient, initialDeals]
  );

  // SSR로 initialDeals가 바뀌면(예: 서버 재검증) 목록 쿼리 데이터도 동기화한다 — 기존 useEffect와 동일 의도.
  useEffect(() => {
    queryClient.setQueryData<DealRow[]>(queryKeys.deals.list(), initialDeals);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDeals]);

  const [newDealDialogOpen, setNewDealDialogOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  // --- 2) 상세 쿼리 (선택된 딜이 있을 때만) ---
  const [selectedDealSeed, setSelectedDealSeed] = useState<DealRow | null>(null);

  const detailQuery = useQuery({
    queryKey: selectedDealSeed ? queryKeys.deals.detail(selectedDealSeed.id) : ["deals", "detail", "none"],
    queryFn: () => fetchDealDetailPayload(selectedDealSeed as DealRow),
    enabled: selectedDealSeed !== null,
    staleTime: 5 * 60 * 1000,
  });

  const selectedDeal = selectedDealSeed ? detailQuery.data ?? null : null;

  // setSelectedDeal(null)은 패널을 닫는 용도로만 쓰인다(기존 소비 패턴). 값 세팅은
  // handleDealUpdated처럼 캐시(setQueryData)를 통해 이루어지므로, 여기서는 null 케이스만 처리한다.
  const setSelectedDeal = useCallback((updater: DealPanelData | null | ((prev: DealPanelData | null) => DealPanelData | null)) => {
    const resolved = typeof updater === "function" ? (updater as (prev: DealPanelData | null) => DealPanelData | null)(selectedDeal) : updater;
    if (resolved === null) {
      setSelectedDealSeed(null);
      return;
    }
    if (selectedDealSeed) {
      queryClient.setQueryData<DealPanelData>(queryKeys.deals.detail(selectedDealSeed.id), resolved);
    }
  }, [selectedDeal, selectedDealSeed, queryClient]);

  const fetchDeals = useCallback(async () => {
    try {
      const refreshedDeals = await fetchDealsList();
      queryClient.setQueryData(queryKeys.deals.list(), refreshedDeals);
      return refreshedDeals;
    } catch (error) {
      console.error("Failed to fetch deals:", error);
    }
    return null;
  }, [queryClient]);

  const handleNewDealSuccess = useCallback(async () => {
    setNewDealDialogOpen(false);
    toast.success("새로운 딜이 성공적으로 추가되었습니다.");
    const refreshed = await fetchDeals();
    if (!refreshed) {
      window.location.reload();
    }
  }, [fetchDeals]);

  const fetchDealDetail = useCallback(async (deal: DealRow) => {
    // 기존 구현은 fetch 완료(성공/폴백 모두) 후에만 패널을 열었다 — 순서를 그대로 보존한다.
    // queryClient.fetchQuery로 캐시를 채워 동일 deal 재방문 시 stale-while-revalidate 혜택을 받되,
    // 최초 오픈 시점의 "로딩 후 표시" 시맨틱은 유지한다. 캐시에 이미 값이 있으면 fetchQuery가
    // 즉시 반환하므로(백그라운드 재검증은 이어서 발생) 재방문 시 패널이 즉시 열린다.
    setSelectedDealSeed(deal);
    await queryClient.fetchQuery({
      queryKey: queryKeys.deals.detail(deal.id),
      queryFn: () => fetchDealDetailPayload(deal),
      staleTime: 5 * 60 * 1000,
    });
    setPanelOpen(true);
  }, [queryClient]);

  // --- 3) 수익성 쿼리 ---
  const [profitabilityEnabled, setProfitabilityEnabled] = useState(false);

  const profitabilityQuery = useQuery({
    queryKey: queryKeys.deals.profitability(),
    queryFn: fetchProfitability,
    enabled: profitabilityEnabled,
    staleTime: 5 * 60 * 1000,
  });

  const profitabilityDeals = profitabilityQuery.data ?? [];
  // isLoading만 보면 캐시가 이미 있는 상태에서 invalidateQueries가 트리거한
  // 백그라운드 재요청(isFetching이지만 isLoading=false) 동안 스피너가 사라져
  // "탭 진입 시 항상 로딩 표시"였던 기존 시맨틱이 깨진다. isFetching을 OR로
  // 추가해 백그라운드 갱신 중에도 스피너를 유지한다.
  const profitabilityLoading =
    profitabilityEnabled && (profitabilityQuery.isLoading || profitabilityQuery.isFetching);

  // 기존 시그니처(cancelledRef 기반 취소)를 그대로 보존 — 내부적으로는 쿼리를 활성화하고
  // enabled에 맡긴다. cancelledRef.cancelled는 더 이상 실제로 필요하지 않지만, 소비 컴포넌트가
  // 넘겨주는 인자 형태는 그대로 받아들인다(호환성 유지).
  //
  // invalidateQueries를 매 진입마다 강제하는 이유: 이 훅으로 마이그레이션되기 전
  // 기존 구현은 프로피터빌리티 탭 진입 시 항상 새로 fetch했다(캐시 개념 자체가 없었음).
  // staleTime(5m)만 믿고 invalidate를 제거하면, 5분 내 재진입 시 조용히 그
  // "매 진입 fetch" 동작이 깨져 동작 보존 원칙에 어긋난다. 중복 네트워크 요청
  // 비용보다 동작 보존을 우선했다 — 필요 시 이후 별도 작업으로 staleTime에
  // 맡기는 최적화를 검토할 것.
  const fetchProfitabilityDeals = useCallback(async (_cancelledRef: { cancelled: boolean }) => {
    setProfitabilityEnabled(true);
    await queryClient.invalidateQueries({ queryKey: queryKeys.deals.profitability() });
  }, [queryClient]);

  const handleDealUpdated = useCallback((updated: DealPanelData) => {
    // 함수형 merge: updated(낙관값)에 없는 필드(options/campaigns/dealType 등)가
    // 기존 캐시값을 지워버리지 않도록 병합한다. selectedDeal은 detailQuery.data를
    // 그대로 노출하므로, 여기서 필드가 비면 패널에 즉시 깜빡임/누락이 발생한다.
    queryClient.setQueryData<DealPanelData>(
      selectedDealSeed ? queryKeys.deals.detail(selectedDealSeed.id) : queryKeys.deals.detail(updated.id),
      (prev) => (prev ? { ...prev, ...updated } : updated)
    );
    setDeals((prevDeals) =>
      prevDeals.map((d) =>
        d.id === updated.id
          ? {
              ...d,
              dealName: updated.dealName,
              brandName: updated.brandName,
              partnerName: updated.partnerName,
              partnerId: updated.partnerId,
              costPrice: updated.costPrice,
              sellingPrice: updated.sellingPrice,
              listPrice: updated.listPrice ?? null,
              floorPrice: updated.floorPrice ?? null,
              discountRate: updated.discountRate ?? null,
              totalCommissionRate: updated.totalCommissionRate ?? null,
              brokerageCommissionRate: updated.brokerageCommissionRate ?? null,
              sourcingMemo: updated.sourcingMemo ?? null,
              candidateSellers: updated.candidateSellers ?? null,
              status: updated.status,
              baseMarginPolicy: updated.baseMarginPolicy,
            }
          : d
      )
    );
    // 순수 상태 동기화 — 토스트 금지. 필드수정·상세 리페치·캠페인/거래처 연결 등
    // 여러 경로의 하위 단계로 호출되므로 여기서 토스트하면 액션마다 중복된다.
    // 피드백은 각 액션의 단일 소유 지점에서만 띄운다. [[wagcrm-partner-toast-ownership]]
  }, [setDeals, queryClient, selectedDealSeed]);

  const handleDealDeleted = useCallback(() => {
    setSelectedDeal(null);
    // 토스트는 액션 지점(deals-panel 삭제 핸들러)에서 단일 노출.
    window.location.reload();
  }, [setSelectedDeal]);

  return {
    deals,
    setDeals,
    newDealDialogOpen,
    setNewDealDialogOpen,
    selectedDeal,
    setSelectedDeal,
    panelOpen,
    setPanelOpen,
    profitabilityDeals,
    profitabilityLoading,
    fetchDeals,
    handleNewDealSuccess,
    fetchDealDetail,
    fetchProfitabilityDeals,
    handleDealUpdated,
    handleDealDeleted,
  };
}
