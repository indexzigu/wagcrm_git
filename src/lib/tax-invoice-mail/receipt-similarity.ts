/**
 * 수취 계산서의 **유사도 보조 판정** — 순수 함수.
 *
 * ## 이 모듈이 하는 일과 하지 않는 일
 *
 * `judgeReceipt()` 는 default-deny 다 — 사업자번호로 기대 건을 정확히 하나 특정하고 금액이
 * 맞아야만 `VERIFIED` 다. 그 계약은 **이 모듈이 건드리지 않는다.** 여기서 하는 것은 이미
 * 「확인 필요」로 떨어진 건에 **오너가 누를 수 있는 근거를 덧붙이는** 것뿐이고, 유사도가
 * 아무리 높아도 상태는 `NEEDS_REVIEW` 로 남는다(오너 확정 2026-08-12: 항상 1클릭 승인 대기 —
 * 금전 기록이라 오판 비용이 크고 사람 확인 흔적이 남아야 한다).
 *
 * ## 왜 완전 일치로는 안 되는가 (오너 확정 2026-08-12)
 *
 * 그룹 캠페인은 공급사·셀러 계산서를 **그룹당 1장씩 합산 발행**하는데, 이메일에 찍히는
 * 상호·품목명은 **내부 관리명과 정확히 일치하지 않는다** — 캠페인명은 우리가 관리하기 편한
 * 이름으로 짓기 때문이다. 그래서 이름 신호는 완전 일치가 아니라 **토큰 양방향 부분일치**로
 * 본다(주문 귀속이 상품명·옵션명을 같은 방식으로 다루는 것과 같은 이유 — `campaign-orders.ts`).
 *
 * ## ⛔ 판정 불가를 0점으로 치지 않는다
 *
 * 인코딩을 못 믿어 상호가 null 이거나(`etax-xml.ts` 의 `trustNames`) 품목 줄이 없는 계산서가
 * 실재한다. 그때 그 신호를 **불일치로 세면** 정상 건이 바닥에 못 미쳐 제안이 사라진다 —
 * 이 레포가 `seller-fit.ts`·`deal-seller-matching.ts` 에서 반복해 고쳐 온 "미입력을 낙제로"
 * 부류다. 그래서 신호는 3값(`MATCH`/`MISS`/`UNKNOWN`)이고 `UNKNOWN` 은 **모수에서 빠진다.**
 *
 * ## ⛔ 셀러 실명이 흐른다 (P0, 레포 public)
 *
 * 품목명·상호에는 셀러 실명·상호가 들어간다. 이 모듈이 만드는 근거 문자열은 **오너 화면
 * 전용**이다 — 로그·추적 파일·커밋·PR 본문·테스트 픽스처에 실명을 남기지 말 것
 * (`etax-xml.ts` 의 `EtaxLineItem` 주석과 같은 등급).
 */

import type { ParsedEtaxInvoice } from "./etax-xml";
import type { ExpectedReceivable, ReceivableSlot } from "./expected-receivables";
import type { MismatchCode, ReceiptVerdict } from "./receipt-match";

/**
 * 유사도 제안을 붙이는 사유. **그 외에는 제안하지 않는다.**
 *
 * ⛔ 여기에 `UNRELATED_COUNTERPART` 를 넣지 말 것 — 그건 「CRM 에 아예 없는 발행자」라
 * 캠페인 정산과 무관한 경비 계산서라는 뜻이다(`receipt-match.ts` 가 `NO_EXPECTED_MATCH` 와
 * 일부러 갈라 놓은 축). 거기까지 후보를 추리면 임대료·SaaS 계산서에 캠페인 승인 버튼이
 * 붙는다.
 *
 * ⛔ `DUPLICATE_ISSUE`·`CORRECTIVE_DOCUMENT` 도 넣지 않는다 — 처방이 「사람이 체인을 봐야
 * 한다」이지 「이 건으로 완료를 찍어라」가 아니다.
 */
const SUGGESTIBLE_CODES: readonly MismatchCode[] = [
  "AMOUNT_MISMATCH",
  "EXPECTED_AMOUNT_ESTIMATED",
  "AMBIGUOUS_MATCH",
  "NO_EXPECTED_MATCH",
  "MERGED_CANDIDATE",
];

export type SimilaritySignalKind = "WRITTEN_DATE" | "CAMPAIGN_NAME" | "COUNTERPART_NAME";

/**
 * 신호 판정 3값. `UNKNOWN` 은 「이 계산서로는 이 축을 볼 수 없다」이고 불일치가 아니다 —
 * 점수 모수에서 빠진다(위 헤더 ⛔).
 */
export type SimilaritySignalResult = "MATCH" | "MISS" | "UNKNOWN";

export interface SimilaritySignal {
  kind: SimilaritySignalKind;
  result: SimilaritySignalResult;
  /** 오너가 읽을 근거 한 줄. **셀러 실명이 들어갈 수 있다**(오너 화면 전용). */
  detail: string;
}

export interface ReceiptSuggestion {
  /** 제안 대상 기대 건의 key(`campaignId:slot`) */
  key: string;
  campaignId: string;
  campaignLabel: string;
  slot: ReceivableSlot;
  counterpartLabel: string;
  /** 완료를 기록할 필드. null 이면 승인해도 찍을 자리가 없다 — 호출부가 버튼을 감춘다. */
  trackingField: "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt" | null;
  signals: SimilaritySignal[];
  /** 일치한 신호 수 */
  matchedSignalCount: number;
  /** 판정 가능했던 신호 수(= 모수). `UNKNOWN` 은 여기서 빠진다. */
  evaluatedSignalCount: number;
  expectedTotalAmount: number | null;
  observedTotalAmount: number | null;
  /** 관측 − 기대. 둘 다 알 때만 채운다. */
  amountDelta: number | null;
  /** |차이| / 기대액. 기대액이 0이거나 모르면 null — 화면이 "얼마나 미비한가"를 말하는 근거. */
  amountDeltaRatio: number | null;
}

export interface SuggestReceiptMatchInput {
  verdict: ReceiptVerdict;
  parsed: ParsedEtaxInvoice | null;
  /** 판정에 쓴 기대 건 전량 — B 경로(사업자번호 미매칭)에서 후보 풀이 된다. */
  expected: readonly ExpectedReceivable[];
}

/**
 * 이름 신호에서 걷어내는 도메인 불용어.
 *
 * 이 단어들은 **거의 모든 계산서 품목명과 캠페인명에 동시에 등장**하므로, 남겨 두면 서로
 * 다른 그룹끼리도 이름 신호가 일치해 버려 신호가 신호이기를 그만둔다. 완전 일치가 아니라
 * 부분일치로 보는 설계라 이 정리가 특히 중요하다.
 */
const NAME_STOPWORDS: ReadonlySet<string> = new Set([
  "수수료",
  "광고비",
  "대행",
  "대행료",
  "정산",
  "캠페인",
  "공구",
  "공동구매",
  "판매",
  "매출",
  "용역",
  "물품",
  "상품",
  "세금계산서",
  "계산서",
  "주식회사",
  "유한회사",
  "회차",
]);

/** 토큰 최소 길이. 1자 토큰은 부분일치에서 거의 모든 것과 맞아 신호를 무너뜨린다. */
const MIN_TOKEN_LENGTH = 2;

/**
 * 이름을 비교 가능한 토큰으로 쪼갠다.
 *
 * 한글·영문·숫자만 남기고(괄호·중점·하이픈 등 표기 차이를 흡수) 소문자화한 뒤, 짧은 토큰과
 * 불용어를 뺀다. ⛔ 숫자 토큰을 통째로 버리지 말 것 — 회차·연월(`2026`·`08`)이 실제로 캠페인을
 * 가르는 신호이고, 길이 바닥이 이미 1자리 잡음을 걸러 준다.
 */
export function tokenizeName(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  const tokens = raw
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/u)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !NAME_STOPWORDS.has(token));
  return new Set(tokens);
}

/**
 * **양방향 부분일치** — 한쪽 토큰이 다른 쪽 토큰의 부분 문자열이면 일치로 본다.
 *
 * 내부 관리명과 계산서 표기가 다르다는 오너 확정 전제(헤더 참조)에서 나온 규칙이다. 예를
 * 들어 계산서 품목명의 축약형이 캠페인명의 긴 표기에 포함되는 형태가 실무의 기본형이라,
 * 완전 일치로 보면 정상 건이 전부 미일치가 된다.
 */
function hasOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): string | null {
  for (const a of left) {
    for (const b of right) {
      if (a === b || a.includes(b) || b.includes(a)) return a === b ? a : `${a}↔${b}`;
    }
  }
  return null;
}

/** 계산서 품목명 전부를 한 덩어리 토큰 집합으로. 인코딩 불신이면 `name` 이 null 이라 자연히 빈다. */
function lineItemTokens(parsed: ParsedEtaxInvoice | null): Set<string> {
  const tokens = new Set<string>();
  for (const item of parsed?.lineItems ?? []) {
    for (const token of tokenizeName(item.name)) tokens.add(token);
  }
  return tokens;
}

function evaluateWrittenDate(
  parsed: ParsedEtaxInvoice | null,
  candidate: ExpectedReceivable,
): SimilaritySignal {
  const written = parsed?.writtenDate ?? null;
  const from = candidate.validWrittenDateFrom;
  const to = candidate.validWrittenDateTo;

  if (written === null) {
    return { kind: "WRITTEN_DATE", result: "UNKNOWN", detail: "작성일자를 읽지 못해 대조 불가" };
  }
  if (from === null && to === null) {
    return { kind: "WRITTEN_DATE", result: "UNKNOWN", detail: "이 건의 타당 기간이 없어 대조 불가" };
  }

  // "YYYY-MM-DD" 는 고정 자릿수라 사전식 비교가 날짜 비교와 일치한다(`expected-receivables.ts`
  // 의 extremeDateKey 와 같은 규약).
  const inRange = (from === null || written >= from) && (to === null || written <= to);
  return {
    kind: "WRITTEN_DATE",
    result: inRange ? "MATCH" : "MISS",
    detail: inRange
      ? `작성일자 ${written} 가 정산 기간(${from ?? "-"} ~ ${to ?? "-"}) 안`
      : `작성일자 ${written} 가 정산 기간(${from ?? "-"} ~ ${to ?? "-"}) 밖`,
  };
}

function evaluateCampaignName(
  itemTokens: ReadonlySet<string>,
  candidate: ExpectedReceivable,
): SimilaritySignal {
  if (itemTokens.size === 0) {
    return { kind: "CAMPAIGN_NAME", result: "UNKNOWN", detail: "계산서에 읽을 수 있는 품목명이 없음" };
  }
  const campaignTokens = tokenizeName(candidate.campaignLabel);
  if (campaignTokens.size === 0) {
    return { kind: "CAMPAIGN_NAME", result: "UNKNOWN", detail: "캠페인명에 대조할 토큰이 없음" };
  }
  const overlap = hasOverlap(itemTokens, campaignTokens);
  return {
    kind: "CAMPAIGN_NAME",
    result: overlap ? "MATCH" : "MISS",
    detail: overlap ? `품목명 ↔ 캠페인명 일치(${overlap})` : "품목명과 캠페인명에 겹치는 표현 없음",
  };
}

function evaluateCounterpartName(
  parsed: ParsedEtaxInvoice | null,
  candidate: ExpectedReceivable,
): SimilaritySignal {
  // 인코딩을 못 믿으면 파서가 이름을 null 로 비운다 — 깨진 문자열로 비교하지 않는다.
  const issuerTokens = tokenizeName(parsed?.invoicerName ?? null);
  if (issuerTokens.size === 0) {
    return { kind: "COUNTERPART_NAME", result: "UNKNOWN", detail: "발행자 상호를 신뢰할 수 없어 대조 불가" };
  }
  const counterpartTokens = tokenizeName(candidate.counterpartLabel);
  if (counterpartTokens.size === 0) {
    return { kind: "COUNTERPART_NAME", result: "UNKNOWN", detail: "CRM 상대 이름에 대조할 토큰이 없음" };
  }
  const overlap = hasOverlap(issuerTokens, counterpartTokens);
  return {
    kind: "COUNTERPART_NAME",
    result: overlap ? "MATCH" : "MISS",
    detail: overlap ? `발행자 상호 ↔ 상대 이름 일치(${overlap})` : "발행자 상호와 상대 이름이 겹치지 않음",
  };
}

/**
 * 제안 바닥 — **일치 2개 이상 + 모수 2개 이상.**
 *
 * 신호가 3개이고 그중 날짜가 하나뿐이므로, 이 바닥은 「이름 계열 신호 최소 1개 일치」를
 * 자동으로 강제한다(날짜만으로는 절대 2점이 안 된다). 날짜는 정산 창이 넓어(캠페인 종료
 * +90일, `campaign-facts.ts`) 혼자서는 변별력이 약하기 때문에 이 성질이 중요하다.
 */
const MIN_MATCHED_SIGNALS = 2;

export function suggestReceiptMatch(input: SuggestReceiptMatchInput): ReceiptSuggestion | null {
  const { verdict, parsed, expected } = input;

  // 유사도는 **판정을 뒤집지 않는다** — 이미 확인된 건·우리 발행분·남의 계산서는 대상 밖이다.
  if (verdict.status !== "NEEDS_REVIEW") return null;

  const codes = new Set(verdict.reasons.map((reason) => reason.code));
  if (!SUGGESTIBLE_CODES.some((code) => codes.has(code))) return null;

  // 후보 풀: 사업자번호로 좁혀진 게 있으면 그 안(A 경로), 없으면 전체(B 경로).
  // ⛔ 이미 완료로 기록된 건은 뺀다 — 승인해도 할 일이 없고, 다른 계산서로 종결된 금액을
  //    다시 제안하면 오너를 잘못된 동작으로 유도한다(`detectMergedCandidate` 와 같은 이유).
  const pool = (
    verdict.candidateKeys.length > 0
      ? expected.filter((item) => verdict.candidateKeys.includes(item.key))
      : expected
  ).filter((item) => !item.alreadyMarkedAt);
  if (pool.length === 0) return null;

  const observed = parsed?.amounts.totalAmount ?? null;
  const itemTokens = lineItemTokens(parsed);

  const scored = pool.map((candidate) => {
    const signals = [
      evaluateWrittenDate(parsed, candidate),
      evaluateCampaignName(itemTokens, candidate),
      evaluateCounterpartName(parsed, candidate),
    ];
    const evaluated = signals.filter((signal) => signal.result !== "UNKNOWN");
    const matched = signals.filter((signal) => signal.result === "MATCH");
    const expectedAmount = candidate.expectedTotalAmount;
    const amountDelta = observed !== null && expectedAmount !== null ? observed - expectedAmount : null;

    return {
      candidate,
      signals,
      matchedSignalCount: matched.length,
      evaluatedSignalCount: evaluated.length,
      amountDelta,
      amountDeltaRatio:
        amountDelta !== null && expectedAmount !== null && expectedAmount !== 0
          ? Math.abs(amountDelta) / Math.abs(expectedAmount)
          : null,
    };
  });

  const qualified = scored.filter(
    (row) =>
      row.matchedSignalCount >= MIN_MATCHED_SIGNALS &&
      row.evaluatedSignalCount >= MIN_MATCHED_SIGNALS,
  );
  if (qualified.length === 0) return null;

  const best = Math.max(...qualified.map((row) => row.matchedSignalCount));
  const leaders = qualified.filter((row) => row.matchedSignalCount === best);

  // ⛔ 동점이면 제안하지 않는다. 조용히 하나를 고르면 이 엔진이 막으려던 실패(그럴듯한
  //    오답을 사람이 확인한 것으로 굳히기)를 그대로 재현한다. 모호함은 모호하다고 말한다.
  if (leaders.length !== 1) return null;

  const winner = leaders[0];
  return {
    key: winner.candidate.key,
    campaignId: winner.candidate.campaignId,
    campaignLabel: winner.candidate.campaignLabel,
    slot: winner.candidate.slot,
    counterpartLabel: winner.candidate.counterpartLabel,
    trackingField: winner.candidate.trackingField,
    signals: winner.signals,
    matchedSignalCount: winner.matchedSignalCount,
    evaluatedSignalCount: winner.evaluatedSignalCount,
    expectedTotalAmount: winner.candidate.expectedTotalAmount,
    observedTotalAmount: observed,
    amountDelta: winner.amountDelta,
    amountDeltaRatio: winner.amountDeltaRatio,
  };
}
