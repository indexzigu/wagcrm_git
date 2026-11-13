// 최저가 감시 — 「같은 회사로 볼 이름」 제안(순수함수, 서버/클라 공유).
//
// 왜 제안인가(오너 결정 2026-11-14): 같은 상품인데 상품명에 브랜드 대신 회사 이름만 있거나, 판매 조건의
// 브랜드 이름이 쇼핑몰 표기보다 길면(예: 「브랜드 서브라인」 ↔ 상품명엔 「브랜드」만) 브랜드 축에서
// 「브랜드 없음」으로 빠진다. 거래처 이름을 판정에 자동으로 넣으면 플랫폼·유통사 거래처에서 무관한
// 후보가 같은 회사로 통과하므로, 근거 후보와 함께 제안만 하고 판정은 오너가 저장한 이름으로만 바뀐다.
// 설계 정본: docs/private/specs/2026-11-13-price-match-three-axis.md (로컬 서고, 추가 3)
import { brandAxis, type BrandAxis } from "./match-axes";
import { MAX_BRAND_ALIASES, MAX_BRAND_ALIAS_LENGTH } from "./match-context";
import { MATCH_FLOOR } from "./outlier";

export type AliasSuggestionSource = "COMPANY" | "BRAND_PREFIX";

export type AliasSuggestion = {
  name: string;
  source: AliasSuggestionSource;
  /** 이 이름이 있으면 같은 회사로 통과했을 후보의 상품명(서로 다른 것, 최대 MAX_EVIDENCE 개). */
  evidence: string[];
  /** 근거 후보 수(중복 상품명 포함 전체). */
  evidenceCount: number;
};

export type AliasSuggestionCandidate = {
  productName?: string | null;
  mall?: string | null;
  matchScore: number;
  brandMatch?: BrandAxis;
};

const MAX_EVIDENCE = 3;

/**
 * 회사 이름이어도 제안하지 않는 이름 — 판매 플랫폼·채널 이름(이것으로 시작하는 이름 포함: 「네이버파이낸셜」). 상품명에 「카카오전용특가」처럼 흔히 섞여
 * 있어, 제안했다가 오너가 받아들이면 무관한 후보가 같은 회사로 통과한다(2026-11-14 운영 데이터 확인).
 */
const PLATFORM_NAMES = ["카카오", "네이버", "쿠팡", "11번가", "지마켓", "옥션", "롯데온", "ssg", "위메프", "티몬", "토스"];

const CORPORATE_MARKS = /\(주\)|㈜|주식회사|\(유\)|유한회사/g;

/** 거래처 이름에서 법인 표기를 걷어낸다. 2자 미만이면 null. */
export function cleanCompanyName(name: string | null | undefined): string | null {
  const cleaned = (name ?? "").replace(CORPORATE_MARKS, " ").replace(/\s+/g, " ").trim();
  return cleaned.length >= 2 ? cleaned : null;
}

function isPlatformName(name: string): boolean {
  const compactName = name.toLowerCase().replace(/\s+/g, "");
  return PLATFORM_NAMES.some((platform) => compactName.startsWith(platform));
}

/** 브랜드 이름이 여러 낱말이면 첫 낱말(2자 이상). 한 낱말이면 null — 그건 이미 브랜드 축이 본다. */
export function brandPrefix(brandName: string | null | undefined): string | null {
  const words = (brandName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  return words[0].length >= 2 ? words[0] : null;
}

/**
 * 「브랜드 없음」으로 빠졌지만 상품명 점수가 목록 하한(MATCH_FLOOR) 이상인 후보에서 회사 이름·브랜드 첫
 * 낱말이 발견되면, 그 이름을 근거 후보와 함께 제안한다. 이미 등록된 이름·플랫폼 이름은 제안하지 않는다.
 */
export function suggestBrandAliases(input: {
  brandName: string | null | undefined;
  companyName: string | null | undefined;
  aliases: readonly string[];
  candidates: readonly AliasSuggestionCandidate[];
}): AliasSuggestion[] {
  // 저장 API 가 거절할 제안은 내지 않는다 — 누르면 항상 실패하는 버튼이 된다.
  if (input.aliases.length >= MAX_BRAND_ALIASES) return [];
  const pool = input.candidates.filter((c) => c.brandMatch === "missing" && c.matchScore >= MATCH_FLOOR);
  if (pool.length === 0) return [];

  const known = [input.brandName ?? "", ...input.aliases];
  const options: Array<{ name: string; source: AliasSuggestionSource }> = [];
  const company = cleanCompanyName(input.companyName);
  if (company && !isPlatformName(company)) options.push({ name: company, source: "COMPANY" });
  const prefix = brandPrefix(input.brandName);
  if (prefix && !isPlatformName(prefix)) options.push({ name: prefix, source: "BRAND_PREFIX" });

  const suggestions: AliasSuggestion[] = [];
  for (const option of options) {
    if (option.name.length > MAX_BRAND_ALIAS_LENGTH) continue;
    // 이미 등록된 이름(띄어쓰기 무시)과 같으면 제안하지 않는다.
    if (brandAxis({ productName: option.name }, known.filter(Boolean)) === "match") continue;
    if (suggestions.some((s) => brandAxis({ productName: s.name }, [option.name]) === "match")) continue;
    const hits = pool.filter((c) => brandAxis(c, [option.name]) === "match");
    if (hits.length === 0) continue;
    const evidence = Array.from(new Set(hits.map((c) => (c.productName ?? "").trim()).filter(Boolean))).slice(0, MAX_EVIDENCE);
    suggestions.push({ ...option, evidence, evidenceCount: hits.length });
  }
  return suggestions;
}
