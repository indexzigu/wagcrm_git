/**
 * 승인 카드가 entityId 문자열이 아니라 실제 대상 엔티티명을 보여주기 위한 서버측
 * 해석 헬퍼 (청사진 §0-6). 승인자가 모델이 넣은 문자열이 아니라 실제 대상을 보게 한다.
 *
 * 대상이 존재하지 않아도 throw하지 않고 null을 반환한다 — 목록/상세 조회 자체를
 * 막아서는 안 되기 때문이다(엔티티가 삭제된 오래된 기안도 목록에는 보여야 함).
 * 실제 실행 전 존재 검증(throw)은 write-executor.assertEntityExists가 담당한다.
 */
import { getPrisma } from "@/lib/prisma";

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
      return seller?.name ?? null;
    }
    case "CAMPAIGN": {
      const campaign = await prisma.salesCampaign.findUnique({
        where: { id: entityId },
        include: { deal: true, seller: true },
      });
      if (!campaign) return null;
      if (campaign.campaignName) return campaign.campaignName;
      const dealName = campaign.deal?.dealName ?? "";
      const sellerName = campaign.seller?.name ?? "";
      const combined = [dealName, sellerName].filter(Boolean).join(" - ");
      return combined || null;
    }
    default:
      return null;
  }
}
