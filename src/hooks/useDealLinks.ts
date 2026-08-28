import { toast } from "sonner";
import { DealPanelData } from "@/components/crm/deals-panel";
// 여기서 받는 값은 `useDealPanelData` 가 API 에서 만든 것이다(뷰 모델이 아니다).
// 계층 구분과 이름을 가른 이유는 그 파일의 타입 주석에 있다.
import type {
  DealLinkedSeller,
  DealLinkedTask,
} from "@/hooks/useDealPanelData";
import { SearchResultItem } from "@/components/crm/link-search-dialog";
import { normalizeDealPanelData } from "@/utils/deal-panel-helpers";

export function useDealLinks({
  deal,
  linkedSellers,
  linkedTasks,
  fetchLinkedCampaigns,
  fetchLinkedSellers,
  fetchLinkedTasks,
  onUpdated,
}: {
  deal: DealPanelData | null;
  linkedSellers: DealLinkedSeller[];
  linkedTasks: DealLinkedTask[];
  fetchLinkedCampaigns: (deal: DealPanelData) => Promise<void>;
  fetchLinkedSellers: (deal: DealPanelData) => Promise<void>;
  fetchLinkedTasks: (deal: DealPanelData) => Promise<void>;
  onUpdated?: (deal: DealPanelData) => void;
}) {
  async function handleCampaignLinkSelection(item: SearchResultItem) {
    if (!deal) return;
    try {
      const response = await fetch(`/api/links/campaign/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: deal.id }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error ?? "캠페인 연결에 실패했습니다.");
      }
      if (data?.logWarning) {
        toast.warning(data.logWarning);
      }
      toast.success("캠페인이 연결되었습니다.");
      await fetchLinkedCampaigns(deal);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "캠페인 연결에 실패했습니다.",
      );
    }
  }

  async function handleCampaignUnlink(campaignId: string) {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? "캠페인 연결 해제에 실패했습니다.");
      }
      toast.success("캠페인 연결이 해제되었습니다.");
      if (deal) {
        await fetchLinkedCampaigns(deal);
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "캠페인 연결 해제에 실패했습니다.",
      );
    }
  }

  async function handleTaskUnlink(taskId: string) {
    try {
      const response = await fetch(`/api/outreach/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "DROPPED",
          dropReason: "연결 해제",
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? "영업 테스크 연결 해제에 실패했습니다.");
      }
      toast.success("영업 테스크가 종료(해제)되었습니다.");
      if (deal) {
        await fetchLinkedTasks(deal);
        await fetchLinkedSellers(deal);
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "영업 테스크 연결 해제에 실패했습니다.",
      );
    }
  }

  async function handleSellerUnlink(sellerId: string) {
    try {
      const seller = linkedSellers.find((s) => s.id === sellerId);
      if (!seller) return;
      const targetTasks = linkedTasks.filter(
        (t) => t.sellerName === seller.name,
      );
      if (targetTasks.length === 0) {
        toast.info("해제할 연결 테스크가 없습니다.");
        return;
      }

      await Promise.all(
        targetTasks.map(async (task) => {
          await fetch(`/api/outreach/${task.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "DROPPED",
              dropReason: "셀러 연결 해제",
            }),
          });
        }),
      );
      toast.success("셀러 연결이 해제되었습니다.");
      if (deal) {
        await fetchLinkedSellers(deal);
        await fetchLinkedTasks(deal);
      }
    } catch {
      toast.error("셀러 연결 해제에 실패했습니다.");
    }
  }

  async function handleLinkPartner(partnerId: string) {
    if (!deal) return;
    try {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "거래처 연결에 실패했습니다.");
      }
      const updated = await res.json();
      toast.success("거래처가 연결되었습니다.");
      onUpdated?.(
        normalizeDealPanelData(
          { ...deal, partnerId, ...updated } as Record<string, unknown>,
          deal,
        ),
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "거래처 연결에 실패했습니다.",
      );
    }
  }

  async function handleSellerLinkSelection(sellerId: string) {
    if (!deal) return;
    try {
      const response = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealId: deal.id,
          sellerId,
          status: "PROPOSED",
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? "셀러 연결에 실패했습니다.");
      }
      toast.success("셀러가 연결되었습니다.");
      await fetchLinkedSellers(deal);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "셀러 연결에 실패했습니다.",
      );
    }
  }

  return {
    handleCampaignLinkSelection,
    handleCampaignUnlink,
    handleTaskUnlink,
    handleSellerUnlink,
    handleLinkPartner,
    handleSellerLinkSelection,
  };
}
