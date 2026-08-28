/**
 * PriceSheetRow → Deal 매핑 제안 (Phase 3 청사진 §2, 결정 5).
 * computeSimilarityScore(order-converter/similarity.ts)를 재사용해 productName/optionName을
 * 기존 Deal.dealName과 비교하고, 임계값(초기 2.0) 이상이면 SUGGESTED, 미달이면 NEW_DEAL.
 * 무검수 자동매핑은 절대 하지 않는다 — mappingStatus는 어디까지나 "제안"이고, MAPPED로
 * 바뀌는 것은 검수자가 review-table에서 확정할 때뿐이다(PriceSheetRowRepository.updateMapping).
 */
import { getPrisma } from "@/lib/prisma";
import { computeSimilarityScore } from "@/lib/order-converter/similarity";

export const MAPPING_SUGGEST_THRESHOLD = 2.0;

export type DealCandidate = {
  id: string;
  dealName: string;
  brandName: string | null;
  partnerId: string | null;
};

export type MappingSuggestion = {
  status: "SUGGESTED" | "NEW_DEAL";
  bestDealId: string | null;
  bestScore: number;
  candidates: Array<{ dealId: string; dealName: string; score: number }>;
};

/**
 * partnerId가 있으면 해당 거래처 딜로 후보를 좁히고, 없으면 전체 활성 딜(MAIN)을 대상으로 한다.
 * 순수 계산 로직(suggestMappingForRow)과 DB 조회(loadDealCandidates)를 분리해
 * 스코어링 로직을 DB 없이 유닛테스트할 수 있게 한다.
 */
export async function loadDealCandidates(partnerId: string | null): Promise<DealCandidate[]> {
  const prisma = getPrisma();
  const deals = await prisma.deal.findMany({
    where: {
      dealType: "MAIN",
      ...(partnerId ? { partnerId } : {}),
    },
    select: { id: true, dealName: true, brandName: true, partnerId: true },
  });
  return deals;
}

/** 순수 함수: 행의 productName/optionName과 후보 딜 목록으로부터 최적 매핑을 계산한다. */
export function suggestMappingForRow(
  row: { productName: string | null; optionName: string | null },
  candidates: DealCandidate[]
): MappingSuggestion {
  const queryText = [row.productName, row.optionName].filter(Boolean).join(" ");

  const scored = candidates
    .map((deal) => ({
      dealId: deal.id,
      dealName: deal.dealName,
      score: computeSimilarityScore(queryText, deal.dealName),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const bestScore = best?.score ?? 0;
  const status: MappingSuggestion["status"] =
    bestScore >= MAPPING_SUGGEST_THRESHOLD ? "SUGGESTED" : "NEW_DEAL";

  return {
    status,
    bestDealId: status === "SUGGESTED" ? best.dealId : null,
    bestScore,
    candidates: scored.slice(0, 5),
  };
}

/**
 * PriceSheet 하나의 전체 미매핑 행에 대해 매핑 제안을 계산하고 mappingStatus를 갱신한다.
 *
 * m1: where에 mappingStatus in [UNMAPPED, SUGGESTED]를 걸어 검수자가 이미 MAPPED/NEW_DEAL로
 * 확정했거나 APPLIED로 반영이 끝난 행은 재매핑 대상에서 제외한다 — 그렇지 않으면 재매칭
 * 실행 시 검수자가 확정한 매핑이나 반영 완료 표시가 SUGGESTED/NEW_DEAL로 덮어써질 수 있다.
 */
export async function suggestMappingsForSheet(priceSheetId: string, partnerId: string | null) {
  const prisma = getPrisma();
  const rows = await prisma.priceSheetRow.findMany({
    where: { priceSheetId, mappingStatus: { in: ["UNMAPPED", "SUGGESTED"] } },
    orderBy: [{ tableSegment: "asc" }, { rowIndex: "asc" }],
  });

  const candidates = await loadDealCandidates(partnerId);

  const results: Array<{ rowId: string; suggestion: MappingSuggestion }> = [];
  for (const row of rows) {
    const suggestion = suggestMappingForRow(
      { productName: row.productName, optionName: row.optionName },
      candidates
    );
    await prisma.priceSheetRow.update({
      where: { id: row.id },
      data: {
        mappingStatus: suggestion.status,
        mappedDealId: suggestion.status === "SUGGESTED" ? suggestion.bestDealId : null,
      },
    });
    results.push({ rowId: row.id, suggestion });
  }

  return results;
}
