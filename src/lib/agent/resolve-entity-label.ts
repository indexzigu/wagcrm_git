/**
 * 승인 카드가 entityId 문자열이 아니라 실제 대상 엔티티명을 보여주기 위한 서버측
 * 해석 헬퍼 (청사진 §0-6). 승인자가 모델이 넣은 문자열이 아니라 실제 대상을 보게 한다.
 *
 * 대상이 존재하지 않아도 throw하지 않고 null을 반환한다 — 목록/상세 조회 자체를
 * 막아서는 안 되기 때문이다(엔티티가 삭제된 오래된 기안도 목록에는 보여야 함).
 * 실제 실행 전 존재 검증(throw)은 write-executor.assertEntityExists가 담당한다.
 */
import { getPrisma } from "@/lib/prisma";
import { sellerDisplayName } from "@/lib/seller-display-name";

export type ResolvableEntityType = "PARTNER" | "SELLER" | "DEAL" | "CAMPAIGN";

function isResolvableEntityType(value: unknown): value is ResolvableEntityType {
  return value === "PARTNER" || value === "SELLER" || value === "DEAL" || value === "CAMPAIGN";
}

export async function resolveEntityLabel(
  entityType: string | null | undefined,
  entityId: string | null | undefined
): Promise<string | null> {
  if (!entityType || !entityId) return null;
  if (!isResolvableEntityType(entityType)) return null;

  const prisma = getPrisma();

  switch (entityType) {
    case "DEAL": {
      const deal = await prisma.deal.findUnique({ where: { id: entityId } });
      return deal?.dealName ?? null;
    }
    case "PARTNER": {
      const partner = await prisma.partner.findUnique({ where: { id: entityId } });
      return partner?.name ?? null;
    }
    case "SELLER": {
      const seller = await prisma.seller.findUnique({ where: { id: entityId } });
      return seller ? sellerDisplayName(seller) : null;
    }
    case "CAMPAIGN": {
      const campaign = await prisma.salesCampaign.findUnique({
        where: { id: entityId },
        include: { deal: true, seller: true },
      });
      if (!campaign) return null;
      if (campaign.campaignName) return campaign.campaignName;
      const dealName = campaign.deal?.dealName ?? "";
      const sellerName = campaign.seller ? sellerDisplayName(campaign.seller) : "";
      const combined = [dealName, sellerName].filter(Boolean).join(" - ");
      return combined || null;
    }
    default:
      return null;
  }
}

/** 기안 내용(args)에 든 대상 id 를 화면 이름으로 푼 것 — 카드 미리보기가 id 대신 보여준다. */
export type ProposalArgLabels = { seller: string | null; deal: string | null };

/**
 * [캘린더수집] 새 회차 생성(`create_campaign_round`) 기안은 대상 캠페인이 아직 없어 배지(`targetEntityName`)로
 * 이름을 보여줄 수 없다 — args 의 셀러·판매 조건 id 를 여기서 이름으로 푼다. 셀러는 별칭이 있으면 별칭
 * (P2 Seller Alias Priority). 다른 액션·모양이 깨진 내용은 조회 없이 null 이고, 대상이 지워졌으면 그 칸만 null
 * (위 `resolveEntityLabel` 과 같이 throw 하지 않는다 — 목록 조회를 막지 않는다).
 */
export async function resolveProposalArgLabels(payload: unknown): Promise<ProposalArgLabels | null> {
  if (typeof payload !== "object" || payload === null) return null;
  const { action, args } = payload as { action?: unknown; args?: unknown };
  if (action !== "create_campaign_round" || typeof args !== "object" || args === null) return null;
  const { dealId, sellerId } = args as { dealId?: unknown; sellerId?: unknown };
  if (typeof dealId !== "string" || typeof sellerId !== "string") return null;

  const prisma = getPrisma();
  const [seller, deal] = await Promise.all([
    prisma.seller.findUnique({ where: { id: sellerId }, select: { name: true, alias: true } }),
    prisma.deal.findUnique({ where: { id: dealId }, select: { dealName: true } }),
  ]);
  const sellerLabel = seller ? sellerDisplayName(seller) : null;
  return { seller: sellerLabel, deal: deal?.dealName ?? null };
}
