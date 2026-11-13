import { getPrisma } from "@/lib/prisma";
import type { OwnerMatchLabel, OwnerMatchLabelValue } from "@/lib/price-monitor/scoring";
import { summarizeAccuracy, type MatchAccuracy } from "@/lib/price-monitor/match-context";
import { summarizeLabelInsights, type LabelInsights } from "@/lib/price-monitor/label-evidence";
import { resolveMonitorFields } from "@/lib/price-monitor/query-builder";

// 최저가 감시 — 오너 「같은 상품 / 다른 상품」 표시 저장소. 스칼라 컬럼만 쓴다(Json 이원화 없음).
// dealId 는 항상 루트 딜 id 다(resolveRootDealId 로 해소한 뒤 넘길 것).

export type PriceMatchLabelInput = {
  dealId: string;
  nameKey: string;
  urlKey: string | null;
  label: OwnerMatchLabelValue;
  channel: string | null;
  mall: string | null;
  productName: string;
  url: string | null;
  systemSaidSame: boolean;
  /** 원인 분류(label-evidence MatchCause) — 오너와 시스템이 같은 판정이면 null. */
  cause: string | null;
  searchQuery: string | null;
  /** 축별 판정 근거 JSON 텍스트(label-evidence MatchEvidence). */
  evidence: string | null;
};

export type MatchDealContext = {
  rootDealId: string;
  /** 표시한 딜의 브랜드명(옵션이면 자식 ?? 부모 — cron resolveMonitorFields 와 같은 순서). */
  brandName: string | null;
  unit: string | null;
  /** 모델명(자식 ?? 부모 supplementaryInfo) — 화면·크론의 모델명 보너스와 같은 재료. */
  modelName: string | null;
  /** 루트 딜의 「같은 회사로 볼 이름」. */
  aliasesText: string | null;
};

export function isOwnerMatchLabelValue(value: unknown): value is OwnerMatchLabelValue {
  return value === "SAME" || value === "DIFFERENT";
}

export const priceMatchLabelRepository = {
  /** 옵션 딜이면 부모 id, 아니면 자기 id. 딜이 없으면 null. */
  async resolveRootDealId(dealId: string): Promise<string | null> {
    return (await priceMatchLabelRepository.resolveRootDealIds([dealId])).get(dealId) ?? null;
  },

  /** 여러 딜을 한 번에 루트 id 로 해소한다(없는 딜은 빠진다). */
  async resolveRootDealIds(dealIds: readonly string[]): Promise<Map<string, string>> {
    if (dealIds.length === 0) return new Map();
    const deals = await getPrisma().deal.findMany({
      where: { id: { in: [...dealIds] } },
      select: { id: true, parentDealId: true },
    });
    return new Map(deals.map((deal) => [deal.id, deal.parentDealId ?? deal.id]));
  },

  /** 표시 시점 재판정에 필요한 딜 맥락. 딜이 없으면 null. */
  async findMatchContext(dealId: string): Promise<MatchDealContext | null> {
    const fields = {
      dealName: true,
      brandName: true,
      unit: true,
      unitQuantity: true,
      supplementaryInfo: true,
      monitorBrandAliases: true,
    } as const;
    const deal = await getPrisma().deal.findUnique({
      where: { id: dealId },
      select: { id: true, parentDealId: true, ...fields, parentDeal: { select: fields } },
    });
    if (!deal) return null;
    const parent = deal.parentDeal;
    // cron·재판정과 같은 해소(자식 ?? 부모) — 여기서 갈리면 기록된 근거가 화면과 어긋난다.
    const resolved = resolveMonitorFields(deal, parent);
    return {
      rootDealId: deal.parentDealId ?? deal.id,
      brandName: resolved.brandName,
      unit: resolved.unit,
      modelName: resolved.modelName,
      aliasesText: parent ? parent.monitorBrandAliases : deal.monitorBrandAliases,
    };
  },

  async findByRootDealIds(rootDealIds: readonly string[]): Promise<Map<string, OwnerMatchLabel[]>> {
    const byRoot = new Map<string, OwnerMatchLabel[]>();
    if (rootDealIds.length === 0) return byRoot;
    const rows = await getPrisma().priceMatchLabel.findMany({
      where: { dealId: { in: [...rootDealIds] } },
      select: { dealId: true, nameKey: true, urlKey: true, label: true },
    });
    for (const row of rows) {
      if (!isOwnerMatchLabelValue(row.label)) continue;
      const list = byRoot.get(row.dealId) ?? [];
      list.push({ nameKey: row.nameKey, urlKey: row.urlKey, label: row.label });
      byRoot.set(row.dealId, list);
    }
    return byRoot;
  },

  async upsert(input: PriceMatchLabelInput) {
    const { dealId, nameKey, ...rest } = input;
    return getPrisma().priceMatchLabel.upsert({
      where: { dealId_nameKey: { dealId, nameKey } },
      create: { dealId, nameKey, ...rest },
      update: rest,
    });
  },

  async remove(dealId: string, nameKey: string): Promise<number> {
    const result = await getPrisma().priceMatchLabel.deleteMany({ where: { dealId, nameKey } });
    return result.count;
  },

  /**
   * 전체 오너 표시 중 시스템 판단과 같았던 비율 + 어긋난 원인별 건수 + 「다른 상품」을 가른 낱말 빈도 —
   * 자동 판정 정확도 계측이자 판정 개선 재료(2026-11-13 오너 지시).
   * 전 행을 읽는다 — 오너가 손으로 누르는 표시라 행 수가 작다. 커지면 최근 창으로 좁힐 것.
   */
  async accuracy(): Promise<MatchAccuracy & LabelInsights> {
    const rows = await getPrisma().priceMatchLabel.findMany({
      select: { label: true, systemSaidSame: true, cause: true, evidence: true, productName: true },
      orderBy: { updatedAt: "desc" },
    });
    const valid = rows.flatMap((row) => (isOwnerMatchLabelValue(row.label) ? [{ ...row, label: row.label }] : []));
    return { ...summarizeAccuracy(valid), ...summarizeLabelInsights(valid) };
  },

  async findBrandAliases(rootDealIds: readonly string[]): Promise<Map<string, string | null>> {
    if (rootDealIds.length === 0) return new Map();
    const rows = await getPrisma().deal.findMany({
      where: { id: { in: [...rootDealIds] } },
      select: { id: true, monitorBrandAliases: true },
    });
    return new Map(rows.map((row) => [row.id, row.monitorBrandAliases]));
  },

  async saveBrandAliases(rootDealId: string, aliasesText: string | null) {
    return getPrisma().deal.update({ where: { id: rootDealId }, data: { monitorBrandAliases: aliasesText } });
  },
};
