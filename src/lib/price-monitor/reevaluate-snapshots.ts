// 오너가 「같은 상품 / 다른 상품」을 표시하거나 회사 이름을 바꾼 직후, 그 딜 가족(루트+옵션)의
// 최신 스냅샷을 저장된 후보로 다시 판정한다 — 홈 「최저가 방어」 카드가 다음 정기 조회(13시)를
// 기다리지 않고 바뀌게 하기 위함. 외부 호출 없음(저장된 후보만 쓴다).
import { getPrisma } from "@/lib/prisma";
import { evaluateMarketPrice } from "./pipeline";
import { inferQuantityFromName, resolveMonitorFields } from "./query-builder";
import { buildBrandIdentities, stripDerivedFields } from "./match-context";
import type { ScorableCandidate } from "./scoring";
import { priceMonitorSnapshotRepository } from "@/repositories/priceMonitorSnapshotRepository";
import { priceMatchLabelRepository } from "@/repositories/priceMatchLabelRepository";

export type ReevaluateSummary = {
  reevaluated: number;
  /** 우리 총가가 기록되지 않은 옛 스냅샷 등, 다시 판정할 재료가 없어 건너뛴 수. */
  skipped: number;
};

const DEAL_FIELDS = {
  id: true,
  dealName: true,
  brandName: true,
  unit: true,
  unitQuantity: true,
  supplementaryInfo: true,
  parentDealId: true,
  monitorBrandAliases: true,
} as const;

function isScorable(value: Record<string, unknown>): value is ScorableCandidate & Record<string, unknown> {
  return typeof value.price === "number" && typeof value.totalPrice === "number";
}

export async function reevaluateLatestSnapshots(rootDealId: string): Promise<ReevaluateSummary> {
  const prisma = getPrisma();
  const family = await prisma.deal.findMany({
    where: { OR: [{ id: rootDealId }, { parentDealId: rootDealId }] },
    select: DEAL_FIELDS,
  });
  const root = family.find((deal) => deal.id === rootDealId);
  if (!root) return { reevaluated: 0, skipped: 0 };

  const labels = (await priceMatchLabelRepository.findByRootDealIds([rootDealId])).get(rootDealId) ?? [];
  const summary: ReevaluateSummary = { reevaluated: 0, skipped: 0 };

  for (const deal of family) {
    const snapshot = await priceMonitorSnapshotRepository.findLatestByDeal(deal.id);
    if (!snapshot) continue;
    const evidence = priceMonitorSnapshotRepository.parseEvidence(snapshot);
    const ourTotalPrice = evidence?.ourTotalPrice;
    if (typeof ourTotalPrice !== "number" || ourTotalPrice <= 0) {
      summary.skipped += 1;
      continue;
    }

    const parent = deal.id === rootDealId ? null : root;
    const resolved = resolveMonitorFields(
      deal,
      parent ? { ...parent, unitQuantity: null } : null,
    );
    const expectedQuantity = resolved.unitQuantity ?? inferQuantityFromName(resolved.dealName, resolved.unit);
    const candidates = priceMonitorSnapshotRepository
      .parseRawResults(snapshot)
      .map((candidate) => stripDerivedFields(candidate as unknown as Record<string, unknown>))
      .filter(isScorable);

    const result = evaluateMarketPrice({
      candidates,
      targetQuery: snapshot.searchQuery,
      ourTotalPrice,
      expectedUnit: resolved.unit,
      expectedQuantity,
      modelName: resolved.modelName,
      brandIdentities: buildBrandIdentities(resolved.brandName, root.monitorBrandAliases),
      ownerLabels: labels,
    });

    await priceMonitorSnapshotRepository.upsertDaily({
      dealId: deal.id,
      campaignId: snapshot.campaignId,
      snapshotDate: snapshot.snapshotDate,
      searchQuery: snapshot.searchQuery,
      ourUnitPrice: result.ourUnitPrice,
      minValidPrice: result.minValidItem?.totalPrice ?? null,
      verdict: result.verdict,
      validCount: result.validCount,
      rawResults: result.allScored,
      evidence: { ...evidence, reevaluatedAt: new Date().toISOString() },
    });
    summary.reevaluated += 1;
  }
  return summary;
}
