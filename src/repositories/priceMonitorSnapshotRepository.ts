import { getPrisma } from "@/lib/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import type { EvaluatedCandidate } from "@/lib/price-monitor/pipeline";
import type { PriceVerdict } from "@/lib/price-monitor/verdict";

// naverOrderSnapshotRepository.ts와 동일한 Json/String 이원화 관례:
// SQLite는 Json 컬럼 타입을 지원하지 않으므로 문자열로 직렬화하고, Postgres는 객체 그대로 저장한다.

export interface PriceMonitorSnapshotUpsertInput {
  dealId: string;
  campaignId?: string | null;
  snapshotDate: string;
  searchQuery: string;
  ourUnitPrice: number | null;
  minValidPrice: number | null;
  verdict: PriceVerdict;
  validCount: number;
  rawResults: EvaluatedCandidate[];
  evidence?: Record<string, unknown> | null;
}

// 순수 함수라 유닛테스트에서 DB 없이 직렬화 왕복을 검증할 수 있도록 export한다.
export function serializeJsonField(value: unknown): unknown {
  return isSqliteDatabaseUrl() ? JSON.stringify(value ?? null) : value;
}

export function parseJsonField<T = any>(value: unknown): T | null {
  if (value == null) return null;
  return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
}

export const priceMonitorSnapshotRepository = {
  // dealId+snapshotDate 조합 하나로 1일 1스냅샷을 유지한다(같은 날 재실행 시 덮어쓰기).
  async upsertDaily(input: PriceMonitorSnapshotUpsertInput) {
    const prisma = getPrisma();
    const {
      dealId,
      campaignId,
      snapshotDate,
      searchQuery,
      ourUnitPrice,
      minValidPrice,
      verdict,
      validCount,
      rawResults,
      evidence,
    } = input;

    const serializedRawResults = serializeJsonField(rawResults);
    const serializedEvidence = serializeJsonField(evidence ?? null);

    const existing = await prisma.priceMonitorSnapshot.findFirst({
      where: { dealId, snapshotDate },
    });

    const data = {
      dealId,
      campaignId: campaignId ?? null,
      snapshotDate,
      searchQuery,
      ourUnitPrice,
      minValidPrice,
      verdict,
      validCount,
      rawResults: serializedRawResults as any,
      evidence: serializedEvidence as any,
    };

    if (existing) {
      return prisma.priceMonitorSnapshot.update({ where: { id: existing.id }, data });
    }
    return prisma.priceMonitorSnapshot.create({ data });
  },

  async findLatestByDeal(dealId: string) {
    const prisma = getPrisma();
    return prisma.priceMonitorSnapshot.findFirst({
      where: { dealId },
      orderBy: { snapshotDate: "desc" },
    });
  },

  async findByDealAndDate(dealId: string, snapshotDate: string) {
    const prisma = getPrisma();
    return prisma.priceMonitorSnapshot.findFirst({
      where: { dealId, snapshotDate },
    });
  },

  async findRecentViolations(sinceDate: string) {
    const prisma = getPrisma();
    return prisma.priceMonitorSnapshot.findMany({
      where: { verdict: "VIOLATED", snapshotDate: { gte: sinceDate } },
      orderBy: { snapshotDate: "desc" },
    });
  },

  parseRawResults(row: { rawResults: unknown }): EvaluatedCandidate[] {
    return parseJsonField<EvaluatedCandidate[]>(row.rawResults) ?? [];
  },

  parseEvidence(row: { evidence: unknown }): Record<string, unknown> | null {
    return parseJsonField<Record<string, unknown>>(row.evidence);
  },
};
