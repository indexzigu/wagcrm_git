// 순수 문자열 유사도 — fs/prisma 의존 없음(클라이언트 번들 안전).
// mapping-service.ts(서버 전용)와 claim-derive.ts(클라 도달) 양쪽에서 재사용.
export function computeSimilarityScore(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;

  const normalize = (s: string) => {
    // NFC 정규화 우선 — 한글이 NFD(자모 분해형: 초성/중성/종성이 별개 코드포인트)로 저장된
    // 문자열이 들어오면, 아래 [가-힣] 완성형 범위 필터가 자모를 전부 걸러내 단어가 통째로
    // 사라진다(셀러명이 NFD로 저장된 실사고 2026-07-15 — 정규화 전엔 유사도가 항상 0이라
    // 자동매핑의 sellerScore가 영구 0으로 고정됐다).
    // 시각적으로 동일한 한글이 인코딩만 다르다는 이유로 매칭이 영구 실패하지 않게 여기서 흡수한다.
    let res = s.normalize('NFC').toLowerCase();
    // 할인율 표시 [27%] 등 제외
    res = res.replace(/\[\d+%\]/g, ' ');
    // 불필요한 단어 제외 (제품, 수량 등)
    res = res.replace(/와이그라운드|단품|제품|수량|개월분|혼합|set/g, ' ');
    res = res.replace(/(\d+)\s*(박스|세트|통|종|개)/g, '$1 ');
    res = res.replace(/[^a-z0-9가-힣\s]/g, ' ');
    return res.trim();
  };

  const words1 = Array.from(new Set(normalize(str1).split(/\s+/).filter(Boolean)));
  const words2 = Array.from(new Set(normalize(str2).split(/\s+/).filter(Boolean)));

  if (words1.length === 0 || words2.length === 0) return 0;

  let textMatchCount = 0;
  let numberMatchCount = 0;

  for (const w1 of words1) {
    const isW1Num = /^\d+$/.test(w1);

    const hasMatch = words2.some(w2 => {
      const isW2Num = /^\d+$/.test(w2);
      if (isW1Num || isW2Num) return w1 === w2;
      return w1 === w2 || (w1.length > 1 && w2.includes(w1)) || (w2.length > 1 && w1.includes(w2));
    });

    if (hasMatch) {
      if (isW1Num) numberMatchCount++;
      else textMatchCount++;
    }
  }

  // 텍스트 매치가 하나도 없는데 숫자만 매치된 경우는 우연일 확률이 매우 높으므로 무시
  // (단, 애초에 대상 문자열이 100% 숫자로만 이루어져 있다면 예외)
  if (textMatchCount === 0 && !words1.every(w => /^\d+$/.test(w))) {
    return 0;
  }

  return textMatchCount + (numberMatchCount * 0.5);
}

/**
 * 옵션명/딜명에서 '월 공급량'(N개월분·N개월치)을 추출한다. 없으면 null.
 *
 * 왜 별도 추출인가(실사고 2026-07-18, prod [셀러 X 브랜드] 3종 혼합 SET):
 * `computeSimilarityScore`의 정규화는 '개월분'을 잡음 단어로 **삭제**하고 'N종/N박스'를 숫자만
 * 남긴다. 그 결과 "3종 혼합 (3개월분)"과 "3종 혼합 (1개월분)"이 Set dedup을 거치며 둘 다
 * `{…, 3}` 토큰으로 뭉개져, 3개월분 옵션이 1개월분·3개월분 딜 양쪽과 유사도 동점(1.5=1.5)이
 * 됐다. autoMap의 선착순 tie-break가 먼저 순회된 1개월분 딜로 오배정하고(가격 동점깨기도
 * 매핑가≠딜정가라 무력), 3개월분 딜은 고아가 됐다. 기간은 "얼마나 비슷한가"가 아니라 "같은
 * 구매 단위인가"를 가르는 **이산 판별 신호**이므로, 점수에 뭉개기 전에 구조화 추출해
 * 완전일치 게이트(mapping-service)의 근거로 쓴다.
 *
 * 정밀도 우선(false positive가 정상 매칭을 오탈락시키므로): '개월분'·'개월치'(공급 접미사)만
 * 인정하고 '개월 할부'·'개월 무이자'(설치 결제) 같은 마케팅 문구는 배제한다 — 옵션의 폴백
 * 소스에 "무이자 12개월 할부"가 섞여도 12로 오독해 게이트가 정상 매칭을 걸러버리지 않게 한다.
 * 선행 `[\d.]` 차단으로 "1.5개월분"을 5로 오독하지 않는다(도메인은 정수 개월만 쓰므로 이런
 * 입력은 null로 흘려 게이트를 비활성화 — 안전한 방향). 표기는 같아도 인코딩만 다른 NFD
 * 저장분을 놓치지 않도록 NFC 정규화 후 매칭한다(similarity 본체와 동일한 방어).
 */
export function extractSupplyMonths(name: string | null | undefined): number | null {
  if (!name) return null;
  const match = name.normalize('NFC').match(/(?<![\d.])(\d+)\s*개월\s*(?:분|치)/);
  if (!match) return null;
  const months = Number.parseInt(match[1], 10);
  return Number.isFinite(months) && months > 0 ? months : null;
}

/**
 * 셀러(별칭·이름)와 스토어 문자열의 매칭 점수(별칭 최대 20, 이름 최대 10, 큰 쪽 채택).
 * autoMap·recommended-deals가 동일하게 쓰던 인라인 계산을 SSOT로 추출.
 */
export function computeSellerScore(
  alias: string | null | undefined,
  name: string | null | undefined,
  storeStr: string,
): number {
  const aliasSimilarity = computeSimilarityScore(alias || '', storeStr);
  const nameSimilarity = computeSimilarityScore(name || '', storeStr);
  return Math.max(aliasSimilarity * 20, nameSimilarity * 10);
}

export interface DealCandidateScore {
  /** 입력 sellerScore 를 그대로 통과(소비처 편의). */
  sellerScore: number;
  /** 옵션·상품명 유사도 + 포함 보너스. periodMismatch 시 0. */
  dealScore: number;
  /** 매핑가 == 딜 판매가일 때 50, 아니면 0. periodMismatch 시 0. */
  priceScore: number;
  /** sellerScore + dealScore + priceScore. periodMismatch 시 sellerScore 만. */
  totalScore: number;
  /** 옵션·딜 양쪽에 월 공급량이 있는데 서로 다름 → 이 딜은 후보에서 제외해야 함. */
  periodMismatch: boolean;
  /** 딜명에서 추출한 월 공급량(로그·진단용). */
  dealMonths: number | null;
}

/**
 * 하나의 (매핑 옵션 × 딜) 후보에 대한 매칭 점수와 기간 게이트 판정을 계산하는 **단일 SSOT**.
 *
 * autoMap(매핑→딜 자동연결)과 recommended-deals(드롭다운 추천 점수)가 동일한 스코어링 루프를
 * 복붙해 쓰다가, PR #45의 기간(개월분) 완전일치 게이트가 autoMap 인라인에만 적용돼 추천 점수
 * 화면에는 여전히 기간 불일치 딜이 높은 점수로 노출되던 drift(실사고 2026-07-19, 오너 관찰
 * "3개월분 옵션에 1개월분 딜이 아직도 50점")를 봉인하기 위해 스코어링을 이 함수로 통일한다.
 *
 * `periodMismatch=true`(옵션·딜 양쪽 월 공급량이 명시됐고 서로 다름)면 이 딜은 후보에서
 * 제외한다(소비처가 skip). 한쪽이라도 월 공급량이 없으면 게이트를 적용하지 않고 기존 점수
 * 규칙으로 폴백한다(회귀 안전).
 */
export function scoreDealCandidate(params: {
  sellerScore: number;
  dealName: string;
  optionName: string;
  productName: string;
  optionMonths: number | null;
  optionPrice: number;
  dealPrice: number;
}): DealCandidateScore {
  const { sellerScore, dealName, optionName, productName, optionMonths, optionPrice, dealPrice } = params;

  const dealMonths = extractSupplyMonths(dealName);
  const periodMismatch =
    optionMonths !== null && dealMonths !== null && optionMonths !== dealMonths;
  if (periodMismatch) {
    return { sellerScore, dealScore: 0, priceScore: 0, totalScore: sellerScore, periodMismatch: true, dealMonths };
  }

  let dealScore = 0;
  // 옵션명 단어 유사도(주 신호)
  const optionSimilarity = computeSimilarityScore(dealName, optionName);
  dealScore += optionSimilarity * 20;
  // 상품명 단어 유사도(옵션명으로 부족할 때 보완)
  const productSimilarity = computeSimilarityScore(dealName, productName);
  dealScore += productSimilarity * 5;
  // 완전 포함 보너스(단, 단어 매칭이 아예 없으면 의미 없는 포함일 수 있으므로 제외)
  if (dealName && optionName && (optionSimilarity > 0 || productSimilarity > 0) &&
      (dealName.includes(optionName) || optionName.includes(dealName))) {
    dealScore += 30;
  }

  let priceScore = 0;
  if (optionPrice > 0 && dealPrice > 0 && optionPrice === dealPrice) {
    priceScore = 50; // 가격 일치는 매우 강력한 신호
  }

  return { sellerScore, dealScore, priceScore, totalScore: sellerScore + dealScore + priceScore, periodMismatch: false, dealMonths };
}
