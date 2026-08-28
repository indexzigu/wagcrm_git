import { useState, useCallback, useRef, useEffect } from "react";
import { type DealPanelData, normalizeDealPanelData } from "@/utils/deal-panel-helpers";
import { sortLinkedCampaignsByStartDate } from "@/lib/entity-linking";
import type { OutreachStatus } from "@/lib/validations/outreach";

export type LinkedCampaign = {
  id: string;
  sellerName: string;
  salesChannel: string;
  status: string;
  startDate: string;
  endDate: string;
};

/**
 * 딜에 연결된 셀러·테스크의 **API 응답 모양**이다.
 *
 * ⛔ `linked-sellers-list`·`linked-tasks-list` 가 내보내는 동명의 타입과 **합치지
 * 말 것** — 그쪽은 여러 화면이 공유하는 **목록 컴포넌트의 props**(뷰 모델)라
 * `title`·`dueDate` 처럼 표시용 이름을 쓰고, 캠페인·파트너 화면의 다른 모양도
 * 함께 받는다. 두 계층은 `deals-panel.tsx` 의 `<LinkedTasksList tasks={...map}>`
 * 에서 **명시적으로 매핑**된다(`sellerName` → `title`, `proposedAt` → `dueDate`).
 * 합치면 목록 props 가 아웃리치 전용 필드를 떠안는다.
 *
 * 이름을 `Deal*` 로 가른 이유가 그것이다 — 종전에는 양쪽이 똑같이 `LinkedSeller`
 * 였고, 2026-08-07 실제로 뷰 타입을 도메인 자리에 잘못 붙여 타입 에러 3건이 났다.
 */
export type DealLinkedSeller = {
  id: string;
  name: string;
  snsHandle: string;
  snsType: string;
  source: "outreach" | "campaign";
  status?: string;
  followers?: number | null;
  fitLevel?: string | null;
};

export type DealLinkedTask = {
  id: string;
  sellerName: string;
  status: OutreachStatus;
  proposedAt: string;
};

export function useDealPanelData({
  deal,
  onUpdated,
  open,
}: {
  deal: DealPanelData | null;
  onUpdated?: (deal: DealPanelData) => void;
  open: boolean;
}) {
  const [linkedCampaigns, setLinkedCampaigns] = useState<LinkedCampaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);
  const [campaignsError, setCampaignsError] = useState<string>();

  const fetchedDealIdRef = useRef<string | null>(null);

  const [linkedSellers, setLinkedSellers] = useState<DealLinkedSeller[]>([]);
  const [loadingSellers, setLoadingSellers] = useState(false);

  const [linkedTasks, setLinkedTasks] = useState<DealLinkedTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);

  const fetchDealDetails = useCallback(async () => {
    if (!deal) return;
    try {
      const res = await fetch(`/api/deals/${deal.id}`);
      if (res.ok) {
        const updated = await res.json();
        onUpdated?.(
          normalizeDealPanelData(updated as Record<string, unknown>, deal),
        );
      }
    } catch (err) {
      console.error("Failed to fetch deal details", err);
    }
  }, [deal, onUpdated]);

  const fetchLinkedCampaigns = useCallback(
    async (activeDeal: DealPanelData) => {
      setLoadingCampaigns(true);
      setCampaignsError(undefined);
      try {
        let campaigns = activeDeal.campaigns;
        if (!campaigns) {
          const response = await fetch(`/api/deals/${activeDeal.id}`);
          if (!response.ok) {
            throw new Error("연결된 캠페인을 불러오지 못했습니다.");
          }
          const data = await response.json();
          campaigns = data.campaigns ?? [];
          onUpdated?.(
            normalizeDealPanelData(data as Record<string, unknown>, activeDeal),
          );
        }

        const filtered = sortLinkedCampaignsByStartDate(
          (campaigns as Array<Record<string, unknown>>).map((campaign) => ({
            id: campaign.id as string,
            sellerName: campaign.sellerName as string,
            salesChannel: (campaign.salesChannel as string) ?? "공동구매",
            status: campaign.status as string,
            startDate: campaign.startDate as string,
            endDate: campaign.endDate as string,
          })),
        );
        setLinkedCampaigns(filtered);
      } catch (error) {
        setLinkedCampaigns([]);
        setCampaignsError(
          error instanceof Error
            ? error.message
            : "연결된 캠페인을 불러오지 못했습니다.",
        );
      } finally {
        setLoadingCampaigns(false);
      }
    },
    [onUpdated],
  );

  useEffect(() => {
    if (open && deal) {
      const timer = setTimeout(() => {
        void fetchLinkedCampaigns(deal);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [deal, fetchLinkedCampaigns, open]);

  const fetchLinkedSellers = useCallback(async (activeDeal: DealPanelData) => {
    setLoadingSellers(true);
    try {
      const response = await fetch(`/api/deals/${activeDeal.id}/sellers`);
      if (response.ok) {
        const data = await response.json();
        setLinkedSellers(data.sellers ?? []);
      } else {
        setLinkedSellers([]);
      }
    } catch {
      setLinkedSellers([]);
    } finally {
      setLoadingSellers(false);
    }
  }, []);


  useEffect(() => {
    if (open && deal) {
      if (fetchedDealIdRef.current !== deal.id) {
        fetchedDealIdRef.current = deal.id;
        const timer = setTimeout(() => {
          void fetchDealDetails();
          void fetchLinkedSellers(deal);
        }, 0);
        return () => clearTimeout(timer);
      }
    } else {
      fetchedDealIdRef.current = null;
    }
  }, [open, deal, fetchDealDetails, fetchLinkedSellers]);

  const fetchLinkedTasks = useCallback(async (activeDeal: DealPanelData) => {
    setLoadingTasks(true);
    try {
      const response = await fetch(`/api/outreach?dealId=${activeDeal.id}`);
      if (response.ok) {
        const data = await response.json();
        const outreaches: Array<{
          id: string;
          sellerName: string;
          status: OutreachStatus;
          proposedAt: string;
        }> = data.outreaches ?? [];
        setLinkedTasks(
          outreaches.map((t) => ({
            id: t.id,
            sellerName: t.sellerName,
            status: t.status,
            proposedAt: t.proposedAt,
          })),
        );
      } else {
        setLinkedTasks([]);
      }
    } catch {
      setLinkedTasks([]);
    } finally {
      setLoadingTasks(false);
    }
  }, []);

  useEffect(() => {
    if (open && deal) {
      const timer = setTimeout(() => {
        void fetchLinkedTasks(deal);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [deal, fetchLinkedTasks, open]);

  return {
    linkedCampaigns,
    loadingCampaigns,
    campaignsError,
    linkedSellers,
    loadingSellers,
    linkedTasks,
    loadingTasks,
    fetchDealDetails,
    fetchLinkedCampaigns,
    fetchLinkedSellers,
    fetchLinkedTasks,
  };
}
