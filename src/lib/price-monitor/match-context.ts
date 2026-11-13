// 최저가 감시 판정 맥락(브랜드 정체성 이름 · 오너 표시 · 정확도) 순수 도우미 — 서버/클라 공유.
// 설계 정본: docs/private/specs/2026-11-13-price-match-three-axis.md (로컬 서고)
import type { OwnerMatchLabelValue } from "./scoring";

/** 「같은 회사로 볼 이름」 저장 상한 — 저장 API 와 이름 제안이 같이 쓴다(제안이 저장 불가한 이름을 내지 않게). */
export const MAX_BRAND_ALIASES = 20;
export const MAX_BRAND_ALIAS_LENGTH = 40;

/** 오너가 입력한 「같은 회사로 볼 이름」 텍스트(줄바꿈·쉼표 구분)를 목록으로. */
export function parseBrandAliases(text: string | null | undefined): string[] {
  if (!text) return [];
  const names = text.split(/[\n,]/).map((name) => name.trim()).filter(Boolean);
  return Array.from(new Set(names));
}

/** 저장용 텍스트(줄바꿈 구분). 비면 null. */
export function formatBrandAliases(names: readonly string[]): string | null {
  const cleaned = parseBrandAliases(names.join("\n"));
  return cleaned.length > 0 ? cleaned.join("\n") : null;
}

/** 브랜드 축 정체성 이름 = 딜 브랜드명 + 등록된 회사 이름. */
export function buildBrandIdentities(brandName: string | null | undefined, aliasesText: string | null | undefined): string[] {
  return parseBrandAliases([brandName ?? "", aliasesText ?? ""].join("\n"));
}

const DERIVED_FIELDS = new Set([
  "matchScore",
  "brandMatch",
  "ownerLabel",
  "extractedQuantity",
  "unitPrice",
  "excludeReason",
]);

/**
 * 저장된 후보(스냅샷 rawResults)를 다시 판정하기 전에 지난 판정의 흔적을 지운다.
 * 남겨 두면 scoreCandidate 의 스프레드가 옛 excludeReason 을 그대로 실어 유효 후보가 배제분처럼 보인다.
 */
export function stripDerivedFields<T extends Record<string, unknown>>(candidate: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(candidate).filter(([key]) => !DERIVED_FIELDS.has(key)));
}

/** 오너 표시가 당시 시스템 판단과 같았는가 — 시스템도 「같은 상품」(브랜드·상품 축 통과)으로 봤는지와 대조. */
export function isLabelAgreement(label: OwnerMatchLabelValue, systemSaidSame: boolean): boolean {
  return label === "SAME" ? systemSaidSame : !systemSaidSame;
}

export type MatchAccuracy = { total: number; agreed: number };

export function summarizeAccuracy(
  rows: ReadonlyArray<{ label: OwnerMatchLabelValue; systemSaidSame: boolean }>,
): MatchAccuracy {
  return {
    total: rows.length,
    agreed: rows.filter((row) => isLabelAgreement(row.label, row.systemSaidSame)).length,
  };
}
