// 최저가 감시 — 오너 「같은 상품 / 다른 상품」 표시의 원인 근거(2026-11-13 오너 지시).
//
// 오너 지시: 「다른 상품」 표시는 단순 배제 기록이 아니라, 그 후보가 왜 처음에 같은 상품 후보로 올라왔는지
// 원인을 파악해 판정을 고치는 데이터로 쓸 수 있어야 한다. 그래서 표시하는 순간 서버가 후보를 다시
// 판정해 축별 근거(브랜드가 어디서 잡혔나 · 검색어 낱말별 겹침 · 후보에만 있는 낱말)를 저장하고,
// 원인을 분류한다. 판정 규칙을 바꾸는 것은 이 데이터를 근거로 한 제안 + 오너 승인뿐이다(자동 반영 없음).
// 설계 정본: docs/private/specs/2026-11-13-price-match-three-axis.md (로컬 서고)
import {
  brandAxis,
  brandFoundIn,
  candidateExtraWords,
  productCoreWords,
  productScore,
  productWordHits,
  type BrandAxis,
  type WordHit,
} from "./match-axes";
import { MATCH_FLOOR } from "./outlier";
import { MODEL_MATCH_BONUS, matchesModelToken, type OwnerMatchLabelValue } from "./scoring";

export const MATCH_EVIDENCE_VERSION = 1;

export type MatchEvidence = {
  v: typeof MATCH_EVIDENCE_VERSION;
  searchQuery: string;
  identities: string[];
  brandMatch: BrandAxis;
  brandFoundIn: "productName" | "mall" | "both" | null;
  /** 상품 축 점수 — 화면·크론과 같은 값(모델명 보너스 포함). */
  matchScore: number;
  /** 낱말만으로 낸 점수(보너스 전). matchScore 와 다르면 모델명이 점수를 올린 것이다. */
  wordScore: number;
  modelName: string | null;
  modelBonus: boolean;
  wordHits: WordHit[];
  extraWords: string[];
  /**
   * 오너가 표시하던 순간 화면에 보이던 판정(참고값). 서버 재판정과 다르면 그 차이 자체가 진단 재료다
   * (예: 기존 「같은 상품」 표시로 면제돼 있던 후보를 「다른 상품」으로 바꾼 경우).
   */
  seen: SeenJudgment | null;
};

export type SeenJudgment = { matchScore: number | null; excludeReason: string | null; ownerLabel: string | null };

const MAX_SEEN_TEXT = 40;

/** 클라이언트가 보낸 참고값을 형식만 맞춰 받는다(판정에는 쓰지 않는다). */
export function sanitizeSeenJudgment(value: unknown): SeenJudgment | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const shortText = (v: unknown) => (typeof v === "string" && v.length <= MAX_SEEN_TEXT ? v : null);
  return {
    matchScore: typeof raw.matchScore === "number" && Number.isFinite(raw.matchScore) ? raw.matchScore : null,
    excludeReason: shortText(raw.excludeReason),
    ownerLabel: shortText(raw.ownerLabel),
  };
}

export function buildMatchEvidence(input: {
  searchQuery: string;
  identities: readonly string[];
  unit?: string | null;
  modelName?: string | null;
  candidate: { productName: string; mall?: string | null };
  seen?: SeenJudgment | null;
}): MatchEvidence {
  const { searchQuery, identities, unit, candidate } = input;
  const modelName = input.modelName ?? null;
  const coreWords = productCoreWords(searchQuery, { identities, unit });
  const wordScore = productScore(coreWords, candidate.productName);
  // scoring.scoreCandidate 와 같은 규칙 — 여기서 갈리면 화면이 올린 후보가 「시스템도 다르다고 봤다」로 기록된다.
  const modelBonus = !!modelName && matchesModelToken(candidate.productName, modelName);
  return {
    v: MATCH_EVIDENCE_VERSION,
    searchQuery,
    identities: [...identities],
    brandMatch: brandAxis(candidate, identities),
    brandFoundIn: brandFoundIn(candidate, identities),
    matchScore: modelBonus ? Math.min(100, wordScore + MODEL_MATCH_BONUS) : wordScore,
    wordScore,
    modelName,
    modelBonus,
    wordHits: productWordHits(coreWords, candidate.productName),
    extraWords: candidateExtraWords(searchQuery, candidate.productName, { identities, unit }),
    seen: input.seen ?? null,
  };
}

/** 근거 기준 시스템 판정 — 브랜드 축이 「없음」이 아니고 상품 점수가 하한 이상이면 같은 상품으로 본 것. */
export function evidenceSaidSame(evidence: Pick<MatchEvidence, "brandMatch" | "matchScore">): boolean {
  return evidence.brandMatch !== "missing" && evidence.matchScore >= MATCH_FLOOR;
}

export type MatchCause =
  // 시스템이 같은 상품으로 올렸는데 오너가 「다른 상품」 — 왜 올라왔나
  | "NO_IDENTITY"
  | "BRAND_VIA_MALL"
  | "MODEL_NAME"
  | "PARTIAL_WORDS"
  | "SHARED_WORDS"
  // 시스템이 뺐는데 오너가 「같은 상품」 — 왜 놓쳤나
  | "BRAND_NOT_FOUND"
  | "WORDS_DIFFER";

export const MATCH_CAUSE_LABEL: Record<MatchCause, string> = {
  NO_IDENTITY: "브랜드·회사 이름이 없어 회사로 못 거름",
  BRAND_VIA_MALL: "판매처 이름만 보고 같은 회사로 봄",
  MODEL_NAME: "모델명이 겹쳐 점수가 오름",
  PARTIAL_WORDS: "글자 조각이 겹쳐 점수가 오름",
  SHARED_WORDS: "같은 회사의 다른 상품(검색어 낱말 공유)",
  BRAND_NOT_FOUND: "상품명·판매처에 브랜드·회사 이름 없음",
  WORDS_DIFFER: "상품명 표기가 검색어와 다름",
};

/** 오너 표시와 시스템 판정이 어긋났을 때 원인을 분류한다. 일치하면 null. */
export function classifyLabelCause(label: OwnerMatchLabelValue, evidence: MatchEvidence): MatchCause | null {
  const saidSame = evidenceSaidSame(evidence);
  if (label === "DIFFERENT") {
    if (!saidSame) return null;
    if (evidence.brandMatch === "unknown") return "NO_IDENTITY";
    if (evidence.brandFoundIn === "mall") return "BRAND_VIA_MALL";
    if (evidence.modelBonus && evidence.wordScore < MATCH_FLOOR) return "MODEL_NAME";
    const fullOnly = evidence.wordHits.length === 0
      ? 0
      : (evidence.wordHits.filter((h) => h.hit === "full").length / evidence.wordHits.length) * 100;
    if (fullOnly < MATCH_FLOOR) return "PARTIAL_WORDS";
    return "SHARED_WORDS";
  }
  if (saidSame) return null;
  return evidence.brandMatch === "missing" ? "BRAND_NOT_FOUND" : "WORDS_DIFFER";
}

export type LabelInsights = {
  causes: Array<{ cause: MatchCause; label: string; count: number }>;
  /** 「다른 상품」 표시 후보에만 있던 낱말 빈도 상위 — 다른 상품을 가르는 낱말 후보. */
  differentWords: Array<{ word: string; count: number }>;
};

const MAX_INSIGHT_WORDS = 5;

export function parseMatchEvidence(text: string | null | undefined): MatchEvidence | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as MatchEvidence;
    return parsed && parsed.v === MATCH_EVIDENCE_VERSION ? parsed : null;
  } catch {
    // 깨진 근거 한 줄 때문에 집계 전체를 막지 않는다 — 그 줄만 집계에서 빠진다.
    return null;
  }
}

function isMatchCause(value: string | null | undefined): value is MatchCause {
  return value != null && value in MATCH_CAUSE_LABEL;
}

export function summarizeLabelInsights(
  rows: ReadonlyArray<{ label: string; cause: string | null; evidence: string | null }>,
): LabelInsights {
  const causeCounts = new Map<MatchCause, number>();
  const wordCounts = new Map<string, number>();
  for (const row of rows) {
    if (isMatchCause(row.cause)) causeCounts.set(row.cause, (causeCounts.get(row.cause) ?? 0) + 1);
    // 시스템이 같은 상품으로 올렸던(원인이 있는) 「다른 상품」만 센다 — 이미 맞게 거른 다른 회사 제품의
    // 낱말까지 세면 판정을 고칠 단서(같은 회사 다른 라인의 낱말)가 묻힌다(재검토 L1).
    // 한계: 「같은 상품」 쪽과 대조하지 않으므로 「공식」「무료배송」 같은 범용어가 섞일 수 있다.
    if (row.label !== "DIFFERENT" || !isMatchCause(row.cause)) continue;
    for (const word of parseMatchEvidence(row.evidence)?.extraWords ?? []) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }
  return {
    causes: Array.from(causeCounts, ([cause, count]) => ({ cause, label: MATCH_CAUSE_LABEL[cause], count })).sort(
      (a, b) => b.count - a.count,
    ),
    differentWords: Array.from(wordCounts, ([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
      .slice(0, MAX_INSIGHT_WORDS),
  };
}
