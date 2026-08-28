import { describe, it, expect } from 'vitest';
import { computeSimilarityScore, extractSupplyMonths, computeSellerScore, scoreDealCandidate } from '../similarity';

describe('computeSimilarityScore — 기본 동작', () => {
  it('겹치는 단어가 있으면 양수 점수', () => {
    expect(computeSimilarityScore('상품A - VA-108 옵션명 5000', '상품A: [VA-108] 5천 옵션명형')).toBeGreaterThan(0);
  });

  it('겹치는 단어가 전혀 없으면 0', () => {
    expect(computeSimilarityScore('상품X', '상품Y')).toBe(0);
  });

  it('빈 문자열/null은 0', () => {
    expect(computeSimilarityScore('', '상품A')).toBe(0);
    expect(computeSimilarityScore('상품A', '')).toBe(0);
  });
});

describe('computeSimilarityScore — NFC/NFD 유니코드 정규화 (실사고 회귀)', () => {
  // 실사고(2026-07-15): 셀러명이 NFD(자모 분해형)로 저장돼 있으면 정규화 정규식([가-힣] 완성형
  // 범위만 통과)이 자모를 전부 걸러내 단어가 통째로 사라진다 — 시각적으로 같은 한글인데 유사도가
  // 항상 0이 되어, 캠페인 자동매핑의 sellerScore가 영구 0으로 고정되고 판매캠페인이 존재해도
  // 절대 연결되지 않았다(셀러 158명 중 3명이 이미 이 오염 상태). 픽스처명은 실제 셀러와 무관한
  // 가상 이름이며, NFD 여부만 테스트에 중요하다.
  const FIXTURE_NAME = '가상판매자';
  const nfd = (s: string) => s.normalize('NFD');

  it('NFD로 저장된 한글도 NFC와 동일하게 매칭된다', () => {
    const nfdName = nfd(FIXTURE_NAME);
    expect(nfdName).not.toBe(FIXTURE_NAME); // 픽스처가 실제로 NFD인지 확인(코드포인트 다름)
    expect(computeSimilarityScore(nfdName, `[${FIXTURE_NAME} X 브랜드]  상품A 마켓 ${FIXTURE_NAME}`)).toBeGreaterThan(0);
  });

  it('양쪽 다 NFD여도 매칭된다', () => {
    expect(computeSimilarityScore(nfd(FIXTURE_NAME), nfd(`${FIXTURE_NAME} 상품A`))).toBeGreaterThan(0);
  });

  it('NFD 문자열만 있고 겹치는 단어가 없으면 여전히 0(정규화가 오탐을 만들지 않음)', () => {
    expect(computeSimilarityScore(nfd(FIXTURE_NAME), nfd('상품X'))).toBe(0);
  });
});

// 이름은 전부 가공(P0: 커밋에 셀러/브랜드 실명 금지). 버그는 이름이 아니라 구조에서 재현된다.
describe('extractSupplyMonths — 월 공급량(N개월분·N개월치) 추출', () => {
  it('공급 접미사(분·치)가 붙은 개월 표기를 숫자로 추출한다', () => {
    expect(extractSupplyMonths('비타플러스 - 3종 혼합 (1개월분)')).toBe(1);
    expect(extractSupplyMonths('비타플러스 - 3종 혼합 (3개월분)')).toBe(3);
    expect(extractSupplyMonths('제품: [비타플러스] 3종 혼합 SET / 수량: [27%] 3+3+3박스 (3개월분)')).toBe(3);
    expect(extractSupplyMonths('12개월분')).toBe(12);
    expect(extractSupplyMonths('12개월치')).toBe(12);
    expect(extractSupplyMonths('3 개월분')).toBe(3); // 숫자와 '개월' 사이 공백 허용
  });

  it('월 공급량이 없으면 null', () => {
    expect(extractSupplyMonths('비타플러스 3종 혼합 SET')).toBeNull();
    expect(extractSupplyMonths('3박스')).toBeNull(); // 박스는 개월이 아니다
    expect(extractSupplyMonths('')).toBeNull();
    expect(extractSupplyMonths(null)).toBeNull();
    expect(extractSupplyMonths(undefined)).toBeNull();
  });

  // 정밀도 회귀(code-review MEDIUM): 공급 접미사(분/치)가 없는 '개월'은 공급량이 아니다.
  // '무이자 N개월 할부' 같은 마케팅 문구를 옵션 폴백 소스에서 뽑아 정상 매칭을 오탈락시키면 안 된다.
  it('설치결제·기간 마케팅 문구(개월 할부·개월 무이자·정기구독)는 공급량으로 오독하지 않는다', () => {
    expect(extractSupplyMonths('무이자 12개월 할부 특가')).toBeNull();
    expect(extractSupplyMonths('6개월 무이자')).toBeNull();
    expect(extractSupplyMonths('6개월 정기구독')).toBeNull();
    expect(extractSupplyMonths('6개월')).toBeNull(); // 접미사 없는 맨 개월은 미인정
  });

  // 정밀도 회귀(code-review LOW): 소수 개월은 도메인에 없으므로 null로 흘려 게이트를 비활성화한다
  // (5 같은 엉뚱한 정수로 오독해 오탈락시키지 않는다).
  it('소수 개월(1.5개월분)은 뒷자리 숫자로 오독하지 않고 null', () => {
    expect(extractSupplyMonths('1.5개월분')).toBeNull();
  });

  it('NFD로 저장된 "개월분"도 NFC 정규화 후 추출한다', () => {
    expect(extractSupplyMonths('3개월분'.normalize('NFD'))).toBe(3);
  });

  // 실사고 물증: computeSimilarityScore만으로는 1개월분·3개월분 딜이 3개월분 옵션에 동점이 된다.
  // 이 동점이 게이트 도입의 근거다(extractSupplyMonths가 이 동점을 가른다).
  it('유사도 함수는 1개월분/3개월분 딜을 3개월분 옵션과 동점으로 만든다(게이트의 근거)', () => {
    const OPTION = '제품: [비타플러스] 3종 혼합 SET / 수량: [27%] 3+3+3박스 (3개월분)';
    const DEAL_1M = '비타플러스 - 3종 혼합 (1개월분)';
    const DEAL_3M = '비타플러스 - 3종 혼합 (3개월분)';
    const s1 = computeSimilarityScore(DEAL_1M, OPTION);
    const s3 = computeSimilarityScore(DEAL_3M, OPTION);
    expect(s1).toBe(s3); // 정규화가 '개월분'을 지워 동점 — 유사도만으로는 못 가른다
    // 게이트의 판별 신호는 구조화 추출로만 갈린다
    expect(extractSupplyMonths(DEAL_1M)).toBe(1);
    expect(extractSupplyMonths(DEAL_3M)).toBe(3);
    expect(extractSupplyMonths(OPTION)).toBe(3);
  });
});

describe('computeSellerScore — 셀러 매칭 점수(별칭 우선)', () => {
  it('별칭이 겹치면 별칭 가중치(×20), 이름만 겹치면 이름 가중치(×10)', () => {
    // 별칭이 스토어명과 1단어 겹침 → 1.0 × 20 = 20
    expect(computeSellerScore('가상셀러', null, '가상셀러 X 비타플러스 스토어')).toBe(20);
    // 이름만 겹침(별칭 없음) → 1.0 × 10 = 10
    expect(computeSellerScore(null, '가상셀러', '가상셀러 X 비타플러스 스토어')).toBe(10);
    // 둘 다 겹치면 큰 쪽(별칭) 채택
    expect(computeSellerScore('가상셀러', '가상셀러', '가상셀러 스토어')).toBe(20);
  });

  it('전혀 안 겹치면 0(후보 탈락 신호)', () => {
    expect(computeSellerScore('전혀다른셀러', '전혀다른이름', '가상셀러 스토어')).toBe(0);
    expect(computeSellerScore(null, null, '가상셀러 스토어')).toBe(0);
  });
});

describe('scoreDealCandidate — 딜 후보 점수 + 기간 게이트 SSOT (autoMap·recommended-deals 공유)', () => {
  const SELLER = 10;
  const OPTION_3M = '제품: [비타플러스] 3종 혼합 SET / 수량: [27%] 3+3+3박스 (3개월분)';
  const DEAL_1M = '비타플러스 - 3종 혼합 (1개월분)';
  const DEAL_3M = '비타플러스 - 3종 혼합 (3개월분)';

  it('실사고 봉인: 3개월분 옵션 vs 1개월분 딜 → periodMismatch=true, 후보 탈락(점수 0)', () => {
    const r = scoreDealCandidate({
      sellerScore: SELLER, dealName: DEAL_1M, optionName: OPTION_3M,
      productName: OPTION_3M, optionMonths: 3, optionPrice: 212200, dealPrice: 75900,
    });
    expect(r.periodMismatch).toBe(true);
    expect(r.dealScore).toBe(0);
    expect(r.priceScore).toBe(0);
    expect(r.totalScore).toBe(SELLER); // sellerScore 만 통과 — dealScore/priceScore 미가산
    expect(r.dealMonths).toBe(1);
  });

  it('3개월분 옵션 vs 3개월분 딜 → 게이트 통과, 유사도 점수 정상 가산', () => {
    const r = scoreDealCandidate({
      sellerScore: SELLER, dealName: DEAL_3M, optionName: OPTION_3M,
      productName: OPTION_3M, optionMonths: 3, optionPrice: 212200, dealPrice: 228800,
    });
    expect(r.periodMismatch).toBe(false);
    expect(r.dealScore).toBeGreaterThan(0);
    expect(r.totalScore).toBeGreaterThan(SELLER);
    expect(r.dealMonths).toBe(3);
  });

  // 게이트가 없으면 두 딜이 동점이라 갈리지 않는다는 물증(음성 대조군).
  it('게이트가 1개월분/3개월분 딜의 동점을 가른다: 3개월분만 후보로 남는다', () => {
    const bad = scoreDealCandidate({
      sellerScore: SELLER, dealName: DEAL_1M, optionName: OPTION_3M,
      productName: OPTION_3M, optionMonths: 3, optionPrice: 0, dealPrice: 0,
    });
    const good = scoreDealCandidate({
      sellerScore: SELLER, dealName: DEAL_3M, optionName: OPTION_3M,
      productName: OPTION_3M, optionMonths: 3, optionPrice: 0, dealPrice: 0,
    });
    expect(bad.periodMismatch).toBe(true);
    expect(good.periodMismatch).toBe(false);
    // 게이트 후: 1개월분은 탈락(sellerScore 만), 3개월분은 정상 점수 → 명확히 갈림
    expect(good.totalScore).toBeGreaterThan(bad.totalScore);
  });

  it('한쪽이라도 월 공급량이 없으면 게이트 미적용 → 기존 점수 폴백(회귀 안전)', () => {
    // 딜에 개월분 표기 없음
    const noDealMonths = scoreDealCandidate({
      sellerScore: SELLER, dealName: '비타플러스 - 3종 혼합', optionName: OPTION_3M,
      productName: OPTION_3M, optionMonths: 3, optionPrice: 0, dealPrice: 0,
    });
    expect(noDealMonths.periodMismatch).toBe(false);
    // 옵션에 개월분 표기 없음(optionMonths=null)
    const noOptionMonths = scoreDealCandidate({
      sellerScore: SELLER, dealName: DEAL_1M, optionName: '비타플러스 3종 혼합',
      productName: '비타플러스 3종 혼합', optionMonths: null, optionPrice: 0, dealPrice: 0,
    });
    expect(noOptionMonths.periodMismatch).toBe(false);
  });

  it('가격 완전일치 시 priceScore=50 가산, 불일치면 0', () => {
    const match = scoreDealCandidate({
      sellerScore: SELLER, dealName: DEAL_3M, optionName: OPTION_3M,
      productName: OPTION_3M, optionMonths: 3, optionPrice: 228800, dealPrice: 228800,
    });
    expect(match.priceScore).toBe(50);
    const noMatch = scoreDealCandidate({
      sellerScore: SELLER, dealName: DEAL_3M, optionName: OPTION_3M,
      productName: OPTION_3M, optionMonths: 3, optionPrice: 212200, dealPrice: 228800,
    });
    expect(noMatch.priceScore).toBe(0);
  });
});
