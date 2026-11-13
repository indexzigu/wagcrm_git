// 최저가 감시 — 「같은 상품인가」를 세 축으로 나눠 보는 순수함수(서버/클라 공유).
//
// 왜 축을 나누나(오너 지적 2026-11-13): 종전 점수는 "우리 검색어 낱말이 상대 상품명에 몇 개
// 있나 × 20" 한 줄이라, 다른 회사 제품이 낱말을 많이 공유하면 85%, 같은 제품이 상품명을 다르게
// 띄어 쓰면 48%가 나왔다. 오너 정의대로 ①브랜드·회사 ②상품 ③구성(수량)을 따로 판정한다.
// 구성 축은 기존 수량 추출(query-builder.inferQuantityFromName + outlier QUANTITY_MISMATCH)을 쓴다.
// 설계 정본: docs/private/specs/2026-11-13-price-match-three-axis.md (로컬 서고)

export type BrandAxis = "match" | "missing" | "unknown";

/** 정체성 이름(브랜드·회사)으로 인정하는 최소 길이 — 1자는 우연 포함이 너무 쉽다. */
const MIN_IDENTITY_LENGTH = 2;
/** 상품 핵심어로 인정하는 최소 길이. */
const MIN_CORE_WORD_LENGTH = 2;
/**
 * 부분 점수(글자 2개 조각)를 주는 최소 낱말 길이. 부분 점수는 붙여 쓴 합성어("올리브레몬" ↔
 * "올리브 엔 레몬")를 살리려는 것인데, 짧은 낱말에 주면 "비타민c" ↔ "비타민d" 처럼 다른 상품이
 * 조각을 공유해 같은 상품으로 통과한다(코드 리뷰 2026-11-13).
 */
const MIN_PARTIAL_WORD_LENGTH = 5;

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;

/** 검색어·상품명에 섞여 든 URL 을 지운다(검색어 끝에 카카오 선물하기 링크가 붙어 나간 결함). */
export function stripUrls(value: string): string {
  return value.replace(URL_PATTERN, " ").replace(/\s+/g, " ").trim();
}

/** NFC·소문자·URL 제거 후 한글/영숫자 외 문자를 공백으로 바꾼다. */
function normalizeWords(value: string): string {
  return stripUrls(value.normalize("NFC").toLowerCase()).replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

/** 띄어쓰기 차이를 없앤 비교용 문자열. */
function compact(value: string): string {
  return normalizeWords(value).replace(/\s+/g, "");
}

function usableIdentities(identities: readonly string[]): string[] {
  return Array.from(new Set(identities.map(compact).filter((name) => name.length >= MIN_IDENTITY_LENGTH)));
}

/**
 * 축 ① 브랜드·회사: 상품명 또는 판매처명에 정체성 이름(브랜드·제조사 등) 중 하나라도 있으면 match.
 * 오너 관찰대로 상품명에는 브랜드만·회사만·둘 다 표시되는 경우가 섞여 있어 "하나라도"로 본다.
 * 정체성 이름이 하나도 설정되지 않았으면 unknown — 이 축을 판정에 쓰지 않는다.
 */
export function brandAxis(
  candidate: { productName?: string | null; mall?: string | null },
  identities: readonly string[],
): BrandAxis {
  const names = usableIdentities(identities);
  if (names.length === 0) return "unknown";
  const haystack = compact(`${candidate.productName ?? ""} ${candidate.mall ?? ""}`);
  return names.some((name) => haystack.includes(name)) ? "match" : "missing";
}

const QUANTITY_UNITS = "박스|세트|개|포|병|통|팩|봉|정|캡슐|매|입|구|ml|l|g|kg|mg";

function isQuantityWord(word: string, unit: string | null | undefined): boolean {
  if (/^\d+$/.test(word)) return true;
  const units = unit ? `${QUANTITY_UNITS}|${compact(unit)}` : QUANTITY_UNITS;
  return new RegExp(`^\\d+(?:${units})$`).test(word);
}

/**
 * 축 ② 상품의 비교 기준 낱말: 검색어에서 URL·정체성 이름·수량 표기를 뺀 나머지.
 * 브랜드를 빼는 이유 — 브랜드 일치는 축 ①이 보므로, 여기 남기면 같은 브랜드의 다른 상품이
 * 브랜드 낱말 덕에 점수를 받는다(종전 결함의 한 갈래).
 */
export function productCoreWords(
  query: string,
  options: { identities: readonly string[]; unit?: string | null },
): string[] {
  const names = usableIdentities(options.identities);
  const words = normalizeWords(query)
    .split(" ")
    .filter((word) => word.length >= MIN_CORE_WORD_LENGTH && !isQuantityWord(word, options.unit));
  const kept = words.filter((word) => !names.some((name) => name.includes(word) || word.includes(name)));
  // 검색어가 브랜드·수량뿐이면 비교할 상품 낱말이 0개가 되어 모든 후보가 0점(전부 배제 → 조용히 비교불가)이
  // 된다. 그때는 브랜드 낱말까지 상품 낱말로 쓴다(종전 단일 점수와 같은 재료).
  return Array.from(new Set(kept.length > 0 ? kept : words));
}

function bigrams(word: string): string[] {
  const grams: string[] = [];
  for (let i = 0; i < word.length - 1; i += 1) grams.push(word.slice(i, i + 2));
  return grams;
}

export type WordHit = { word: string; hit: "full" | "partial" | "none"; credit: number };

/**
 * 기준 낱말별 판정 — 상대 상품명(띄어쓰기 무시)에 통째로 있으면 full(1), 긴 낱말이 글자 2개 조각만
 * 겹치면 partial(겹친 조각 비율), 아니면 none(0). 오너 표시의 원인 근거로도 그대로 저장된다.
 */
export function productWordHits(coreWords: readonly string[], productName: string | null | undefined): WordHit[] {
  const name = compact(productName ?? "");
  return coreWords.map((word) => {
    if (name.length > 0 && name.includes(word)) return { word, hit: "full", credit: 1 };
    // 부분 점수는 붙여 쓴 한글 합성어용이다 — 영문·숫자 낱말은 임의 조각 하나로도 점수가 붙는다(재검토 L2).
    if (name.length === 0 || word.length < MIN_PARTIAL_WORD_LENGTH || !/^[가-힣]+$/.test(word)) {
      return { word, hit: "none", credit: 0 };
    }
    const grams = bigrams(word);
    const credit = grams.length === 0 ? 0 : grams.filter((gram) => name.includes(gram)).length / grams.length;
    return { word, hit: credit > 0 ? "partial" : "none", credit };
  });
}

/**
 * 축 ② 상품 점수(0~100): productWordHits 의 점수 평균. 부분 점수는 "올리브레몬" ↔ "올리브 엔 레몬"처럼
 * 표기만 다른 경우를 살리기 위한 것이다.
 */
export function productScore(coreWords: readonly string[], productName: string | null | undefined): number {
  const hits = productWordHits(coreWords, productName);
  if (hits.length === 0 || compact(productName ?? "").length === 0) return 0;
  return Math.round((hits.reduce((sum, h) => sum + h.credit, 0) / hits.length) * 100);
}

/** 정체성 이름이 상품명·판매처 중 어디서 잡혔나(오너 표시 원인 근거). 없으면 null. */
export function brandFoundIn(
  candidate: { productName?: string | null; mall?: string | null },
  identities: readonly string[],
): "productName" | "mall" | "both" | null {
  const names = usableIdentities(identities);
  const inName = names.some((name) => compact(candidate.productName ?? "").includes(name));
  const inMall = names.some((name) => compact(candidate.mall ?? "").includes(name));
  if (inName && inMall) return "both";
  if (inName) return "productName";
  if (inMall) return "mall";
  return null;
}

/**
 * 후보 상품명에만 있는 낱말(검색어·정체성 이름·수량 표기 제외) — 「같은 회사의 다른 상품」을 가르는
 * 낱말(맛·라인명 등)이 여기 나온다. 오너가 「다른 상품」으로 표시한 후보에서 모아 개선 재료로 쓴다.
 */
export function candidateExtraWords(
  query: string,
  productName: string | null | undefined,
  options: { identities: readonly string[]; unit?: string | null },
): string[] {
  const names = usableIdentities(options.identities);
  const queryCompact = compact(query);
  const words = normalizeWords(productName ?? "")
    .split(" ")
    .filter(
      (word) =>
        word.length >= MIN_CORE_WORD_LENGTH &&
        !isQuantityWord(word, options.unit) &&
        !queryCompact.includes(word) &&
        !names.some((name) => name.includes(word) || word.includes(name)),
    );
  return Array.from(new Set(words));
}

/** 오너 판정 기록을 후보에 다시 붙일 때 쓰는 열쇠 — 판매처+상품명(띄어쓰기·대소문자 무시). */
export function candidateNameKey(mall: string | null | undefined, productName: string | null | undefined): string {
  return `${compact(mall ?? "")}|${compact(productName ?? "")}`;
}

/**
 * 추적용 쿼리·조각을 뗀 상품 주소 — **기록용이고 표시 매칭에는 쓰지 않는다.** 쿠팡 제휴 주소처럼
 * 상품 식별자가 쿼리에만 있는 주소는 쿼리를 떼면 모든 상품이 같은 값이 되기 때문이다(코드 리뷰
 * 2026-11-13). 주소가 없거나 깨졌으면 null.
 */
export function candidateUrlKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.host.toLowerCase()}${parsed.pathname}`;
  } catch {
    return null;
  }
}
