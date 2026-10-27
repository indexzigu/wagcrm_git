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
export type LinkedDealLabel = { name: string; sellingPrice: number; totalCommissionRate: number | null };

export type ProposalArgLabels = {
  seller: string | null;
  deal: string | null;
  /**
   * 판매캠페인 품목 추가(`add_campaign_items`, T-271)의 연결 줄 — 하위품목 id → 이름·판매가·총수수료율. 연결 줄은
   * args 에 id 만 있어 승인자가 무엇을 어떤 값으로 붙이는지 서버가 풀어 보여야 한다(판매가가 판단 가치).
   * 지워진 id 는 빠진다(미리보기가 「이름 확인 불가」로 그린다).
   */
  linkedDeals?: Readonly<Record<string, LinkedDealLabel>>;
  /** 판매캠페인 품목 추가 — 상위 판매 조건의 단위. 새 하위품목이 저장될 이름(`plannedOptionDealName`)을 미리보기가 그린다. */
  dealUnit?: string | null;
};

/**
 * [캘린더수집] 새 회차 생성(`create_campaign_round`) 기안은 대상 캠페인이 아직 없어 배지(`targetEntityName`)로
 * 이름을 보여줄 수 없다 — args 의 셀러·판매 조건 id 를 여기서 이름으로 푼다. 셀러는 별칭이 있으면 별칭
 * (P2 Seller Alias Priority). 다른 액션·모양이 깨진 내용은 조회 없이 null 이고, 대상이 지워졌으면 그 칸만 null
 * (위 `resolveEntityLabel` 과 같이 throw 하지 않는다 — 목록 조회를 막지 않는다).
 */
export async function resolveProposalArgLabels(payload: unknown): Promise<ProposalArgLabels | null> {
  if (typeof payload !== "object" || payload === null) return null;
  const { action, args } = payload as { action?: unknown; args?: unknown };
  if (action === "add_campaign_items" && typeof args === "object" && args !== null) {
    return resolveCampaignItemsLabels(args as { mainDealId?: unknown; items?: unknown });
  }
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

/** 판매캠페인 품목 추가 — 상위 판매 조건 이름과 연결 줄 하위품목 이름을 한 번에 푼다(셀러는 대상 배지가 보여 준다). */
async function resolveCampaignItemsLabels(args: { mainDealId?: unknown; items?: unknown }): Promise<ProposalArgLabels | null> {
  if (typeof args.mainDealId !== "string" || !Array.isArray(args.items)) return null;
  const linkIds = args.items
    .map((row) => (typeof row === "object" && row !== null ? (row as { dealId?: unknown }).dealId : undefined))
    .filter((id): id is string => typeof id === "string");
  const deals = await getPrisma().deal.findMany({
    where: { id: { in: [args.mainDealId, ...linkIds] } },
    select: { id: true, dealName: true, unit: true, sellingPrice: true, totalCommissionRate: true },
  });
  const byId = new Map(deals.map((deal) => [deal.id, deal]));
  const linkedDeals: Record<string, LinkedDealLabel> = {};
  for (const id of linkIds) {
    const deal = byId.get(id);
    if (!deal) continue;
    linkedDeals[id] = {
      name: deal.dealName,
      sellingPrice: Number(deal.sellingPrice),
      totalCommissionRate: deal.totalCommissionRate == null ? null : Number(deal.totalCommissionRate),
    };
  }
  const main = byId.get(args.mainDealId);
  return { seller: null, deal: main?.dealName ?? null, linkedDeals, dealUnit: main?.unit ?? null };
}
