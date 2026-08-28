// 주문 상품/옵션 ↔ 캠페인 매핑 매칭의 단일 진실(SSOT).
//
// 배경(2026-07): 이 매칭 블록은 `campaigns-handler.ts`(라이브 집계)와
// `closed-campaign-cache.ts`(마감 스냅샷)에 **byte-identical로 복붙**돼 있었고,
// 기본 정규화(`replace(/[^a-zA-Z0-9가-힣]/g, '')`)는 `CampaignEditModal.tsx`까지
// 3곳에서 각자 재정의됐다. 정규화 규칙을 한 곳만 고치면 나머지가 조용히 어긋난다.
//
// 또한 매칭 판정에는 두 축이 있는데 서로 다른 표준형을 봤다:
//  · 유사도(`computeSimilarityScore`)는 내부에서 NFC + 잡음 사전(제품/수량/[N%]/박스…)을
//    적용해 강건하다.
//  · `exactIncludes`(정규화 후 substring)는 특수문자만 제거해 잡음을 안 지웠다 →
//    "제품: A / 수량: 2개 [10%]" 같은 네이버 옵션 표기가 매핑 표의 "A"와 substring이
//    되지 못해, 유사도가 애매한(0.5 이하) 경계 케이스에서 딜 귀속이 실패했다.
// 이 파일이 두 경로·두 축을 한 표준형으로 수렴시킨다.

import { computeSimilarityScore } from './similarity';

export type MappingLike = {
  productName?: string | null;
  optionName?: string | null;
};

/**
 * 상품/옵션 텍스트 매칭용 기본 정규화 — 영숫자·한글만 남기고 소문자화.
 * 기존 3곳(handler·closed-campaign-cache·CampaignEditModal)과 byte-identical(회귀 0).
 */
export function normalizeMatchText(str: string | null | undefined): string {
  return (str || '').replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();
}

/**
 * 네이버 옵션명 표기 잡음(라벨 접두어·수량/구성 꼬리·할인율)을 지운 뒤 기본 정규화.
 * `computeSimilarityScore` 내부 잡음 사전과 정합 — exactIncludes 경로도 유사도 경로와
 * 같은 표준형을 보게 해, "맛: 딸기 / 용량: 500ml [27%]" ↔ 매핑 "딸기500ml"이 매칭된다.
 * NFC 정규화도 함께 적용(NFD 저장 한글이 [가-힣] 필터에 통째로 사라지는 트랩 방어).
 */
export function normalizeOptionMatchText(str: string | null | undefined): string {
  let s = (str || '').normalize('NFC').toLowerCase();
  s = s.replace(/\[\d+%\]/g, ' '); // 할인율 표시 [27%]
  // 옵션 축 라벨 접두어(전각/반각 콜론) — "제품:", "옵션:", "맛:", "용량:" 등
  s = s.replace(/(제품|상품|옵션|선택|색상|컬러|구성|타입|종류|맛|향|용량|사이즈|수량)\s*[:：]/g, ' ');
  s = s.replace(/단품|개월분|혼합|set/g, ' '); // similarity.ts 잡음 사전과 정합
  s = s.replace(/(\d+)\s*(박스|세트|통|종|개|팩|입)/g, '$1 '); // 수량 단위 꼬리 → 숫자만
  return s.replace(/[^a-z0-9가-힣]/g, '');
}

/** 정규화 두 문자열이 서로를 포함(substring)하는지 — 빈 문자열은 매칭 아님. */
function includesEither(a: string, b: string): boolean {
  if (a.length === 0) return false;
  return (b.length > 0 && b.includes(a)) || a.includes(b);
}

export type MappingMatchResult = {
  isMatch: boolean;
  productMatches: boolean;
  optionMatches: boolean;
  /**
   * 옵션명이 정규화 후 **완전일치**하는가. 한 스토어 상품에 옵션이 여러 개인 구조(공구 표준)에서
   * 주문을 어느 딜에 붙일지 가르는 **유일한 변별 신호**다 — 상품명은 모든 주문이 같은 스토어
   * 상품명이라 변별력이 0이면서 유사도 합산에는 크게 기여해 정답을 뒤집는다(아래 pickBestMapping 참조).
   * 매핑 표의 옵션명은 'N스토어 동기화'로 스토어 옵션에서 그대로 적재되므로 실주문과 바이트 일치한다.
   */
  optionExact: boolean;
  score: number;
};

/**
 * 매핑 1건이 주문 상품명(pName)·옵션명(oName)에 매칭되는지 판정한다.
 * - 상품/옵션 각각: 유사도 > 0.5 **또는** 정규화 substring(1차) **또는** 옵션 잡음제거 substring(2차 폴백).
 * - 2차 폴백은 1차 실패 시에만 시도하므로 기존 매칭 결과는 불변(회귀 안전), 잡음 때문에
 *   놓치던 건만 추가로 건진다.
 * - hasProduct && hasOption이면 둘 다 매칭돼야 isMatch(AND) — 딜 귀속의 정밀도 유지.
 */
export function evaluateMappingMatch(
  m: MappingLike,
  pName: string,
  oName: string,
): MappingMatchResult {
  const hasProduct = !!m.productName;
  const hasOption = !!m.optionName;
  if (!hasProduct && !hasOption) {
    return { isMatch: false, productMatches: false, optionMatches: false, optionExact: false, score: 0 };
  }

  let productMatches = false;
  let pScore = 0;
  if (hasProduct) {
    pScore = computeSimilarityScore(m.productName as string, pName);
    const inc = includesEither(normalizeMatchText(m.productName), normalizeMatchText(pName));
    productMatches = pScore > 0.5 || inc;
  }

  let optionMatches = false;
  let optionExact = false;
  let oScore = 0;
  if (hasOption) {
    oScore = computeSimilarityScore(m.optionName as string, oName);
    const normM = normalizeMatchText(m.optionName);
    const normO = normalizeMatchText(oName);
    optionExact = normM.length > 0 && normM === normO;
    let inc = includesEither(normM, normO);
    if (!inc) {
      // 2차 폴백: 옵션 잡음(라벨·수량·할인율)을 지운 표준형으로 재시도.
      inc = includesEither(normalizeOptionMatchText(m.optionName), normalizeOptionMatchText(oName));
    }
    optionMatches = oScore > 0.5 || inc;
  }

  let isMatch = false;
  if (hasProduct && hasOption) isMatch = productMatches && optionMatches;
  else if (hasProduct) isMatch = productMatches;
  else if (hasOption) isMatch = optionMatches;

  const score = (hasProduct ? pScore : 0) + (hasOption ? oScore : 0);
  return { isMatch, productMatches, optionMatches, optionExact, score };
}

/**
 * 주문 상품/옵션에 가장 잘 맞는 매핑을 고른다. 없으면 null.
 * handler·closed-campaign-cache의 `bestMapping` 선택 루프를 대체한다.
 *
 * **선택 규칙: ① 옵션명 완전일치 티어 → ② 유사도 합산 점수.**
 *
 * ②만 쓰면 안 되는 이유(2026-07-17 실사고, prod 실측): 공구 스토어는 **상품 1개에 옵션 N개**가
 * 표준이라 그 상품의 모든 주문이 **같은 상품명**을 갖는다. 즉 pScore(상품명 유사도)는 매핑 간
 * 변별력이 0인데 합산에서는 큰 비중을 차지해, "매핑 표에 적힌 상품명이 스토어 상품명과 우연히
 * 더 많은 단어를 공유하는 행"이 정답을 이겨버렸다.
 *   실측: 스토어명 "…이노시톨 / 철분 / 칼마디 3종 최저가 마켓"에서
 *   - 3종혼합 매핑(상품명 "이노시톨+칼마디+철분") → pScore 3.0
 *   - 칼마디 매핑(상품명 "칼마디K 2X PGA")        → pScore 1.0
 *   칼마디 주문에 대해 3종혼합(3.0+1.5=4.5) > 칼마디 정답(1.0+2.5=3.5) → **칼마디 주문 13건과
 *   3종혼합 3개월 8건이 전부 "3종혼합 1개월" 딜 하나로 흡수**(해당 딜 27건)되고, 정답 딜 4개는
 *   0건이 됐다. 동점(4.5) 시 선착순으로 갈리던 것도 같은 뿌리다.
 * 매핑 표의 옵션명은 'N스토어 동기화'로 스토어 옵션에서 그대로 적재되므로 실주문 옵션과 바이트
 * 일치한다 — 완전일치를 최우선 티어로 두면 이 축이 결정론적으로 정답을 고른다.
 */
export function pickBestMapping<T extends MappingLike>(
  mappings: readonly T[],
  pName: string,
  oName: string,
): T | null {
  let best: T | null = null;
  let bestTier = -1;
  let highestScore = -1;
  for (const m of mappings) {
    const { isMatch, optionExact, score } = evaluateMappingMatch(m, pName, oName);
    if (!isMatch) continue;
    const tier = optionExact ? 1 : 0;
    if (tier > bestTier || (tier === bestTier && score > highestScore)) {
      bestTier = tier;
      highestScore = score;
      best = m;
    }
  }
  return best;
}
