/**
 * 수취 세금계산서 **대조 판정** — 순수 함수.
 *
 * ## 이 모듈이 막으려는 것
 *
 * "메일이 왔다 → 수취 완료"는 **위험하다.** 셀러가 세무 지식이 적어 잘못 발행하는 경우가
 * 실제로 있고(오너), 잘못 발행된 계산서도 똑같이 「왔다」로 잡힌다. 자동으로 완료가 찍히면
 * 오너가 검증을 건너뛰므로, **틀린 계산서가 맞다고 확인된 상태**로 남는다 — 아무것도 안 한
 * 것보다 나쁘다.
 *
 * 그래서 판정은 **기본 거부**다. `VERIFIED` 는 아래 조건이 **전부** 참일 때만 나온다:
 *
 * 1. 첨부 XML 파싱 성공(제목·본문 폴백은 절대 `VERIFIED` 가 될 수 없다)
 * 2. 공급받는자 사업자번호 == 우리
 * 3. 상대 사업자번호로 기대 건이 **정확히 하나** 특정됨
 * 4. 그 기대 건의 금액이 **알려져 있고** 합계와 일치(허용오차 이내)
 * 5. 같은 승인번호가 처음 관측됨(중복 발행 아님)
 * 6. 계산서 종류 코드가 확인된 값(`0101`)
 * 7. 작성일자가 파싱되고, 타당 창이 주어졌다면 그 안
 *
 * 하나라도 어긋나면 **사유를 붙여** 표면화한다. 이게 이 기능의 핵심 가치다.
 */

import type { ParsedEtaxInvoice } from "./etax-xml";
import type { ExpectedReceivable } from "./expected-receivables";

/** 판정 근거의 등급. 폴백 건은 화면에서 반드시 구분해 표시해야 한다. */
export type ReceiptConfidence =
  /** 국세청 표준 XML 첨부를 파싱해 대조함 */
  | "ATTACHMENT"
  /** 첨부가 없어 제목·발신자만으로 추정함 — 검증이 아니다 */
  | "SUBJECT_FALLBACK";

export type ReceiptStatus =
  /** 수취 확인 — 위 7조건 전부 충족 */
  | "VERIFIED"
  /** 확인 필요 — 사유 참조 */
  | "NEEDS_REVIEW"
  /**
   * **우리가 발행한** 계산서 — 수취 대상이 아니다(오류도 아니다).
   *
   * 실측(2026-08-04): 세금계산서 전용 폴더에는 발행·수취 메일이 **섞여 있고**, 국세청
   * 보안메일 비밀번호는 양방향 모두 우리 사업자번호라 똑같이 열린다. 이걸 `NOT_OURS` 로
   * 묶으면 **우리가 끊은 계산서가 「무관한 남의 계산서」와 같은 칸**에 들어간다.
   */
  | "ISSUED_BY_US"
  /** 우리와 무관한 계산서(양쪽 어디에도 우리가 없다) */
  | "NOT_OURS";

export type MismatchCode =
  /** 공급받는자가 우리가 아님 */
  | "NOT_ADDRESSED_TO_US"
  /** 공급자가 우리다 = 우리가 발행한 건 */
  | "ISSUED_BY_US"
  /** 첨부가 없거나 표준 XML 이 아님 → 검증 불가 */
  | "NO_ATTACHMENT_EVIDENCE"
  /**
   * 첨부는 있는데 **비밀번호가 걸려** 열지 못했다(오너: 통상 우리 사업자번호를 쓴다).
   * `NO_ATTACHMENT_EVIDENCE` 와 처방이 다르다 — 이쪽은 "자료가 없다"가 아니라 "여는 수단이
   * 아직 없다"이므로, 오너가 수동으로 열어 확인하면 바로 판정할 수 있다.
   */
  | "ATTACHMENT_PASSWORD_PROTECTED"
  /** 상대 사업자번호를 읽지 못함 */
  | "COUNTERPART_UNKNOWN"
  /**
   * 발행자는 CRM 이 **아는 상대**(셀러·거래처)인데 대응하는 정산 건이 없음.
   * → 캠페인 창이 어긋났거나 **셀러가 잘못 발행**했을 수 있다. 진짜 확인 대상이다.
   */
  | "NO_EXPECTED_MATCH"
  /**
   * 발행자가 CRM 에 아예 없는 사업자 → 캠페인 정산과 무관한 계산서(임대료·SaaS 등 경비).
   *
   * ⚠️ 이 둘을 **하나로 합치지 말 것.** 합치면 "잘못된 사업자번호로 발행된 셀러 계산서"가
   * 경비 계산서와 같은 칸에 들어가고, 화면이 그 칸을 접는 순간 이 엔진이 막으려던 실패가
   * 그대로 재현된다(오너 실측: 월 총 15~20건 중 비캠페인이 5~10건이라 접고 싶어지는 크기다).
   */
  | "UNRELATED_COUNTERPART"
  /** 후보가 둘 이상이라 어느 건인지 특정 불가 */
  | "AMBIGUOUS_MATCH"
  /**
   * 이 계산서가 **여러 정산 건을 묶어** 발행된 것으로 보인다 — 관찰이지 판정이 아니다.
   *
   * 실측(2026-08-08): **정산 그룹이 아닌 별개 캠페인 2건**이 계산서 1장으로 묶인 건이
   * 실재한다(`groupId` 가 둘 다 null 이라 기존 그룹 합산 로직이 원천적으로 못 덮는다).
   * 그때 판정은 「이 발행자의 정산 건이 2건인데 금액이 일치하는 건이 없습니다」로 끝나
   * **무엇을 하라는 것인지 말하지 않았다.**
   *
   * ⛔ **자동 확정하지 않는다**(오너 확정 2026-08-08). 계산서 1장을 근거로 여러 캠페인의
   * 필드를 찍는 것은 `expected-issuances.ts` 의 그룹 후퇴 가드가 막던 사고(부분 일치를
   * 전체 확인으로 둔갑)를 그룹 경계 밖에서 재현하는 것이다. 이 사유의 값어치는 오직
   * **「안 왔다」로 보이던 것을 「묶여서 왔을 수 있다」로 바꾸는 것**이다.
   *
   * ⚠️ 허용오차 안에 드는 것을 조건으로 하지 않는다 — 실측 건의 차이가 만원대였고,
   * 그 정도를 허용오차로 흡수하면 단일 특정이 무너진다(`SUB_HUNDRED_TRUNCATION_TOLERANCE_WON`
   * 주석의 실측). 대신 **합이 어느 단건보다 계산서에 가까운가**만 본다 — 그것이
   * 「한 건이 아니라 묶음으로 보인다」의 정직한 정의이고, 자동 확정을 하지 않으므로
   * 느슨해도 안전하다.
   */
  | "MERGED_CANDIDATE"
  /** 금액 불일치 */
  | "AMOUNT_MISMATCH"
  /**
   * 금액이 정확히 일치하지는 않지만 허용오차 이내라 통과시켰다 — **차단하지 않는 표시**다.
   *
   * 오너 확정(2026-08-06): 브랜드사가 100원 단위 미만을 절삭해 집행하는 관행이 실재하므로
   * 그 수준의 오차는 봐주되, **오차가 있었다는 사실 자체는 화면에 남긴다.** 표시 없이
   * 조용히 흡수하면 절삭인지 입력 오류인지 사후에 구분할 수 없다.
   */
  | "AMOUNT_TOLERATED"
  /** 기대 금액 기준이 미확정이라 대조 자체가 불가(우리몰 물품대금) */
  | "EXPECTED_AMOUNT_UNKNOWN"
  /**
   * 금액이 다르지만 **기대액이 공식 추정**이라 계산서가 틀렸다고 단정할 수 없다.
   *
   * ⛔ `AMOUNT_MISMATCH` 와 반드시 갈라야 한다 — **처방이 정반대**이기 때문이다.
   * 저쪽은 「상대가 잘못 발행했다」라 상대에게 확인할 일이고, 이쪽은 「우리 추정이 실물을
   * 못 맞춘다」라 **오너가 수기 물품대금을 넣을 일**이다. 합치면 오너가 매달 같은 행을
   * 보며 상대를 의심하게 되는데, 정작 필요한 동작은 우리 쪽 입력이다.
   *
   * 실측(2026-08-08, 홈택스 20개월): 우리몰 공급사 매입계산서는 **상품별·월별**로 끊겨
   * 캠페인 경계와 아예 정렬되지 않는다. 그 축의 그룹 판정 불능이 7건이었고, 공식
   * (`총매출 − 영업수익`)이 실물을 재현할 수 없다는 것은 이미 확정된 사실이다
   * (`expected-receivables.ts` 의 수기 물품대금 주석). **여기서 허용오차를 키워
   * 덮으려 하지 말 것** — 그 시도는 이미 실측 기각됐다.
   */
  | "EXPECTED_AMOUNT_ESTIMATED"
  /** 같은 승인번호가 이미 관측됨 */
  | "DUPLICATE_ISSUE"
  /** 작성일자를 읽지 못함 */
  | "WRITTEN_DATE_MISSING"
  /** 작성일자가 타당 창 밖 */
  | "WRITTEN_DATE_OUT_OF_RANGE"
  /**
   * **수정세금계산서**(TypeCode `0201`, 실물 확정 2026-08-06) — 자동 대조 대상이 아니다.
   *
   * 실물 체인: 원본(`0101`) → 취소분(`0201`, **음수 금액**) → 재발행분(`0201`). 취소분은
   * 기대액과 원리적으로 일치할 수 없고, 재발행분은 체인을 합산해야 뜻이 생긴다. 그래서
   * 단건 금액 대조로 통과·차단을 말하지 않고 전용 사유로 오너에게 넘긴다.
   * `UNVERIFIED_DOCUMENT_TYPE`("모르는 코드")과 처방이 다르다 — 이쪽은 **아는 코드**다.
   */
  | "CORRECTIVE_DOCUMENT"
  /** 확인되지 않은 계산서 종류 코드 */
  | "UNVERIFIED_DOCUMENT_TYPE"
  /** 이미 수취 완료로 기록된 건 */
  | "ALREADY_MARKED"
  /** UTF-8 이 아닌 선언이라 이름 값을 신뢰할 수 없음 */
  | "ENCODING_UNTRUSTED";

export interface MismatchReason {
  code: MismatchCode;
  /** 오너가 읽을 한 줄. 숫자는 담되 셀러 실명은 호출부가 채운다. */
  message: string;
}

export interface ReceiptVerdict {
  status: ReceiptStatus;
  confidence: ReceiptConfidence;
  /** 특정된 기대 건의 key. 특정 실패면 null. */
  matchedKey: string | null;
  /** 후보가 여럿이었을 때 그 목록(진단용) */
  candidateKeys: string[];
  reasons: MismatchReason[];
  /** 대조에 쓴 값들(화면 표시용) */
  observed: {
    issueId: string | null;
    writtenDate: string | null;
    counterpartBusinessNumber: string | null;
    totalAmount: number | null;
    expectedTotalAmount: number | null;
    /** 관측 − 기대. 둘 다 알 때만 채운다. */
    amountDelta: number | null;
  };
}

/**
 * 확인된 계산서 종류 코드. 샘플로 실물 확인된 것은 `0101`(일반 세금계산서) 하나다.
 * 그 외는 **모른다고 말한다** — 통과시키지 않는다.
 */
export const VERIFIED_TYPE_CODES: readonly string[] = ["0101"];

/**
 * 수정세금계산서 코드 — **실물 3건으로 확정**(2026-08-06, 취소분·재발행분·수취·발행 모두
 * `0201`). 자동 대조 불가는 위 `CORRECTIVE_DOCUMENT` 주석 참조. ⛔ `VERIFIED_TYPE_CODES`
 * 에 합치지 말 것 — "정상 통과 가능"과 "아는데 사람이 봐야 함"은 다른 목록이다.
 */
export const CORRECTIVE_TYPE_CODES: readonly string[] = ["0201"];

/**
 * 수취 대조 허용오차 기본 정책값(원) — **오너 확정 2026-08-06.**
 *
 * 근거: 브랜드사가 100원 단위 미만을 절삭하고 집행하는 관행이 실재한다(오너). 즉 절삭으로
 * 생길 수 있는 차이의 상한은 99원이다. 실측(전용 편지함 1년치 수취 전수)상 1원~1만원
 * 구간의 오차는 관측 0건이라 이 값은 현행 판정을 한 건도 바꾸지 않으며, 오답 후보와의
 * 최소 거리보다 두 자릿수 작아 오탐 여지도 없다. ⛔ 더 키우는 것은 오너 승인 사안이다 —
 * 실측상 십만원대부터 단일 특정이 무너지고 모호 매칭이 생긴다.
 *
 * `judgeReceipt` 의 파라미터 기본값은 여전히 0(순수 함수는 정책을 내장하지 않는다) —
 * 이 상수는 **호출부(라우트)가 명시적으로 넘기는** 정책값이다.
 */
export const SUB_HUNDRED_TRUNCATION_TOLERANCE_WON = 99;

export interface JudgeReceiptInput {
  /** 첨부 파싱 결과. null 이면 폴백 경로다. */
  parsed: ParsedEtaxInvoice | null;
  /** 첨부가 없을 때 제목·발신자로 추정한 상대 사업자번호(있으면). */
  fallbackCounterpartBusinessNumber?: string | null;
  expected: readonly ExpectedReceivable[];
  /** 우리 사업자등록번호(숫자 10자리) */
  ourBusinessNumber: string;
  /** 이번 스캔에서 이미 본 승인번호들 — 중복 발행 판정용 */
  seenIssueIds?: readonly string[];
  /**
   * CRM 이 아는 **모든** 상대의 사업자등록번호(거래처 + 셀러 소속사).
   * 조회 창 밖 캠페인의 상대도 포함해야 한다 — 창만 어긋난 건을 "모르는 상대"로 오분류하면
   * 잘못 발행된 계산서가 경비로 접힌다. 미지정이면 이 구분을 하지 않는다(전부 NO_EXPECTED_MATCH).
   */
  knownCounterpartBusinessNumbers?: readonly string[];
  /** 첨부가 있었지만 비밀번호가 걸려 열지 못했는가(정체 판별 결과) */
  attachmentPasswordSuspected?: boolean;
  /**
   * 금액 허용오차(원). **기본 0 = 완전 일치 요구.**
   * VAT 계산을 공급가액에서 역산하면 원 단위가 1원 어긋날 수 있으나, 허용오차를 두는 순간
   * "얼마까지 봐줄 것인가"가 정책이 되므로 기본값은 봐주지 않는 쪽이다.
   */
  amountToleranceWon?: number;
}

function normalizeDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

function formatWon(value: number): string {
  return `${value.toLocaleString("ko-KR")}원`;
}

/** 품목명 목록을 한 줄로. 길면 자른다 — 사유 문구가 화면을 잠식하지 않게. */
const ITEM_HINT_MAX = 60;

/**
 * 금액이 어긋났을 때 **왜 어긋났는지**를 품목명이 말해 준다.
 *
 * 실측(2026-08-05): 통과 광고비가 계산서에만 실리는 경우가 있다 — 공급사에서 받아 셀러에게
 * 그대로 나가는 비용이라 캠페인에 기록하지 않는 것이 **정상**이고(오너 확인, 현행 UI 에 칸이
 * 없다), 그래서 CRM 금액과 계산서 금액이 구조적으로 다르다. 품목명이 없으면 이 정상 상태가
 * 「금액 불일치」라는 오류처럼만 보인다.
 *
 * ⛔ 품목명에는 셀러 실명이 들어간다 — 이 문자열은 **오너 전용 화면에만** 쓰고 로그·추적
 * 파일에 남기지 않는다(P0).
 */
function itemHint(parsed: ParsedEtaxInvoice | null): string {
  const names = (parsed?.lineItems ?? [])
    .map((item) => item.name)
    .filter((name): name is string => Boolean(name));
  if (names.length === 0) return "";
  const joined = names.join(" · ");
  const shown = joined.length > ITEM_HINT_MAX ? `${joined.slice(0, ITEM_HINT_MAX)}…` : joined;
  return ` 품목: ${shown}`;
}

/**
 * 「이 계산서가 여러 정산 건을 묶은 것으로 보이는가」를 관찰한다(위 `MERGED_CANDIDATE`).
 *
 * 판정 기준은 **합이 어느 단건보다 계산서 총액에 가까운가** 하나뿐이다. 부분집합을
 * 탐색하지 않는다 — 조합이 폭발하고 우연히 맞는 조합을 집을 위험이 실익보다 크다
 * (오너가 합산 발행을 자동 확정하지 않기로 한 것과 같은 방향). 그래서 **그 상대의 열린
 * 기대 건 전부**를 한 덩어리로 보고 그 합만 본다.
 *
 * ⛔ **이미 완료로 기록된 기대 건은 제외한다**(교차 검증 적발 2026-08-08). 넣으면 다른
 * 계산서로 이미 종결된 금액이 합에 섞여, 실제로는 1건만 열려 있는데 「2건을 묶어
 * 발행됐다」고 말한다 — 게다가 이 사유는 「직접 완료 처리해 주세요」로 끝나므로 **오너를
 * 잘못된 동작으로 유도한다.** 초판은 이 필터 없이 위 문장만 적어 놨었다(주석과 구현이
 * 어긋난 상태).
 *
 * ⛔ 금액을 모르는 기대 건이 하나라도 있으면 합을 만들지 않는다(`null` 반환) — 아는
 * 것만 더하면 「일부만 반영된 합계」가 완전한 합계처럼 보이는 그럴듯한 오답이 된다.
 * 이 파일과 `expected-receivables.ts` 가 뺄셈·덧셈 양쪽에서 지켜 온 원칙 그대로다.
 *
 * ⚠️ **알려진 한계 — 부분집합을 안 보므로 우연히 가까워질 수 있다.** 무관한 소액 기대
 * 건이 섞여 합을 계산서 쪽으로 당기면 「묶음으로 보인다」가 뜬다. 그대로 두는 이유는
 * ①자동 확정이 없어 **틀려도 화면 문구 한 줄**이고 ②부분집합 탐색은 조합 폭발과 우연
 * 일치 위험이 실익보다 크다는 판단(오너가 합산 발행 자동 확정을 거부한 것과 같은 방향)
 * 이기 때문이다. 오탐이 실제로 성가셔지면 그때 **후보를 기간으로 좁히는** 쪽을 먼저
 * 검토한다(탐색을 늘리는 쪽이 아니라).
 */
function detectMergedCandidate(
  candidates: readonly ExpectedReceivable[],
  total: number | null,
): MismatchReason | null {
  if (total === null) return null;

  // 「열린」 기대 건만 — 완료된 건은 이 계산서와 무관하다(위 ⛔).
  const open = candidates.filter((item) => !item.alreadyMarkedAt);
  if (open.length < 2) return null;

  const amounts = open.map((item) => item.expectedTotalAmount);
  if (amounts.some((value) => value === null)) return null;

  const sum = (amounts as number[]).reduce((acc, value) => acc + value, 0);
  const sumGap = Math.abs(total - sum);
  const closestSingleGap = Math.min(...(amounts as number[]).map((value) => Math.abs(total - value)));

  // 합이 더 가깝지 않으면 묶음으로 볼 근거가 없다 — 조용히 아무 말도 하지 않는다.
  if (sumGap >= closestSingleGap) return null;

  return {
    code: "MERGED_CANDIDATE",
    message: `이 계산서가 정산 ${open.length}건을 묶어 발행된 것으로 보입니다. ${open.length}건 합계 ${formatWon(sum)} vs 계산서 ${formatWon(total)} (차이 ${formatWon(total - sum)}). 자동 확정하지 않으니 확인 후 직접 완료 처리해 주세요.`,
  };
}

/**
 * 수취 계산서 1건을 판정한다.
 *
 * ⛔ 이 함수는 DB 를 쓰지 않는다 — 무엇을 근거로 완료를 찍을지는 보드 재작성이 끝난 뒤
 * 결정할 사안이라 이번 범위 밖이다. 여기서는 **판정 결과를 돌려주기만** 한다.
 */
export function judgeReceipt(input: JudgeReceiptInput): ReceiptVerdict {
  const {
    parsed,
    expected,
    ourBusinessNumber,
    seenIssueIds = [],
    amountToleranceWon = 0,
    fallbackCounterpartBusinessNumber = null,
    knownCounterpartBusinessNumbers,
    attachmentPasswordSuspected = false,
  } = input;

  const reasons: MismatchReason[] = [];
  const confidence: ReceiptConfidence = parsed ? "ATTACHMENT" : "SUBJECT_FALLBACK";
  const ours = normalizeDigits(ourBusinessNumber);

  const counterpart =
    parsed?.invoicerBusinessNumber ??
    (fallbackCounterpartBusinessNumber ? normalizeDigits(fallbackCounterpartBusinessNumber) : null);

  const observedBase = {
    issueId: parsed?.issueId ?? null,
    writtenDate: parsed?.writtenDate ?? null,
    counterpartBusinessNumber: counterpart,
    totalAmount: parsed?.amounts.totalAmount ?? null,
  };

  // ── 1. 방향 판정 — 가장 먼저, 그리고 단독으로 끝낸다.
  //    수취(공급받는자=우리) / 발행(공급자=우리) / 무관 을 가른다. 이 셋을 뭉개면
  //    우리가 끊은 계산서가 남의 계산서와 같은 칸에 들어간다(실측으로 확인된 함정).
  if (parsed && parsed.invoiceeBusinessNumber !== null && parsed.invoiceeBusinessNumber !== ours) {
    const issuedByUs = parsed.invoicerBusinessNumber === ours;
    return {
      status: issuedByUs ? "ISSUED_BY_US" : "NOT_OURS",
      confidence,
      matchedKey: null,
      candidateKeys: [],
      reasons: [
        issuedByUs
          ? {
              code: "ISSUED_BY_US",
              message: "우리가 발행한 계산서입니다. 수취 대상이 아닙니다.",
            }
          : {
              code: "NOT_ADDRESSED_TO_US",
              message: `공급받는자가 우리 사업자번호가 아닙니다(수신처 ${parsed.invoiceeBusinessNumber}).`,
            },
      ],
      observed: { ...observedBase, expectedTotalAmount: null, amountDelta: null },
    };
  }

  if (!parsed) {
    reasons.push(
      attachmentPasswordSuspected
        ? {
            code: "ATTACHMENT_PASSWORD_PROTECTED",
            message:
              "첨부에 비밀번호가 걸려 있어 열지 못했습니다. 통상 공급받는자 사업자등록번호입니다.",
          }
        : {
            code: "NO_ATTACHMENT_EVIDENCE",
            message: "표준 세금계산서 첨부가 없어 금액·작성일자를 검증하지 못했습니다.",
          },
    );
  } else {
    if (parsed.invoiceeBusinessNumber === null) {
      reasons.push({
        code: "NOT_ADDRESSED_TO_US",
        message: "첨부에서 공급받는자 사업자번호를 읽지 못했습니다.",
      });
    }
    if (parsed.typeCode !== null && !VERIFIED_TYPE_CODES.includes(parsed.typeCode)) {
      reasons.push(
        CORRECTIVE_TYPE_CODES.includes(parsed.typeCode)
          ? {
              code: "CORRECTIVE_DOCUMENT",
              message:
                "수정세금계산서입니다. 원본·취소분·재발행분을 묶어서 봐야 하므로 자동 대조하지 않습니다.",
            }
          : {
              code: "UNVERIFIED_DOCUMENT_TYPE",
              message: `확인되지 않은 계산서 종류 코드(${parsed.typeCode})입니다.`,
            },
      );
    }
    if (parsed.writtenDate === null) {
      reasons.push({ code: "WRITTEN_DATE_MISSING", message: "작성일자를 읽지 못했습니다." });
    }
    if (parsed.declaredEncoding !== null && !/^UTF-?8$/.test(parsed.declaredEncoding)) {
      reasons.push({
        code: "ENCODING_UNTRUSTED",
        message: `UTF-8 이 아닌 인코딩(${parsed.declaredEncoding}) 선언이라 상호·성명은 표시하지 않습니다.`,
      });
    }
  }

  // ── 2. 중복 발행
  if (parsed?.issueId && seenIssueIds.includes(parsed.issueId)) {
    reasons.push({
      code: "DUPLICATE_ISSUE",
      message: "같은 승인번호의 계산서를 이미 확인했습니다(중복 발행 의심).",
    });
  }

  // ── 3. 상대로 기대 건 좁히기
  if (!counterpart) {
    reasons.push({
      code: "COUNTERPART_UNKNOWN",
      message: "발행자(공급자) 사업자등록번호를 확인하지 못했습니다.",
    });
    return {
      status: "NEEDS_REVIEW",
      confidence,
      matchedKey: null,
      candidateKeys: [],
      reasons,
      observed: { ...observedBase, expectedTotalAmount: null, amountDelta: null },
    };
  }

  const byCounterpart = expected.filter(
    (item) =>
      item.counterpartBusinessNumber !== null &&
      normalizeDigits(item.counterpartBusinessNumber) === counterpart,
  );

  if (byCounterpart.length === 0) {
    // 아는 상대인가 모르는 상대인가로 가른다 — 접어도 되는 건과 반드시 봐야 하는 건이 갈린다.
    const known =
      knownCounterpartBusinessNumbers === undefined ||
      knownCounterpartBusinessNumbers.some((value) => normalizeDigits(value) === counterpart);
    reasons.push(
      known
        ? {
            code: "NO_EXPECTED_MATCH",
            message:
              "CRM 이 아는 거래 상대인데 대응하는 정산 건이 없습니다. 캠페인 기간이 어긋났거나 잘못 발행됐을 수 있습니다.",
          }
        : {
            code: "UNRELATED_COUNTERPART",
            message: "CRM 에 없는 발행자입니다. 캠페인 정산과 무관한 계산서(경비 등)로 보입니다.",
          },
    );
    return {
      status: "NEEDS_REVIEW",
      confidence,
      matchedKey: null,
      candidateKeys: [],
      reasons,
      observed: { ...observedBase, expectedTotalAmount: null, amountDelta: null },
    };
  }

  // ── 4. 금액으로 후보 특정
  const total = parsed?.amounts.totalAmount ?? null;
  const withinTolerance = (expectedAmount: number | null): boolean =>
    expectedAmount !== null && total !== null && Math.abs(total - expectedAmount) <= amountToleranceWon;

  const amountMatches = byCounterpart.filter((item) => withinTolerance(item.expectedTotalAmount));
  const candidateKeys = byCounterpart.map((item) => item.key);

  let matched: ExpectedReceivable | null = null;
  if (amountMatches.length === 1) {
    matched = amountMatches[0];
  } else if (amountMatches.length > 1) {
    reasons.push({
      code: "AMBIGUOUS_MATCH",
      message: `같은 발행자·같은 금액의 정산 건이 ${amountMatches.length}건이라 어느 건인지 특정할 수 없습니다.`,
    });
  } else if (byCounterpart.length === 1) {
    // 후보는 하나인데 금액이 안 맞는 경우 — 그 건에 붙여 "금액 불일치"로 말한다.
    matched = byCounterpart[0];
  } else {
    reasons.push({
      code: "AMBIGUOUS_MATCH",
      message: `이 발행자의 정산 건이 ${byCounterpart.length}건인데 금액이 일치하는 건이 없습니다.`,
    });
    // 어느 단건과도 안 맞을 때만 「묶여서 왔나」를 묻는다 — 단건이 맞으면 그게 답이다.
    const merged = detectMergedCandidate(byCounterpart, total);
    if (merged) reasons.push(merged);
  }

  const expectedAmount = matched?.expectedTotalAmount ?? null;
  const amountDelta = total !== null && expectedAmount !== null ? total - expectedAmount : null;

  if (matched) {
    if (expectedAmount === null) {
      reasons.push({
        code: "EXPECTED_AMOUNT_UNKNOWN",
        message: `기대 금액 기준이 확정되지 않아 대조하지 못했습니다(${matched.amountBasis}).`,
      });
    } else if (total === null) {
      reasons.push({
        code: "AMOUNT_MISMATCH",
        message: "첨부에서 합계 금액을 읽지 못해 대조하지 못했습니다.",
      });
    } else if (!withinTolerance(expectedAmount)) {
      // ⛔ 기대액이 **공식 추정**이면 「계산서가 틀렸다」고 말하지 않는다. 처방이 다르다
      //    (위 `EXPECTED_AMOUNT_ESTIMATED` 주석) — 상대를 의심할 일이 아니라 오너가
      //    수기 물품대금을 넣을 일이다.
      reasons.push(
        matched.amountIsEstimate
          ? {
              code: "EXPECTED_AMOUNT_ESTIMATED",
              message: `계산서 ${formatWon(total)}, 추정 ${formatWon(expectedAmount)} (차이 ${formatWon(total - expectedAmount)}). 기대액이 공식 추정이라 대조할 수 없습니다. 수기 물품대금에 실제 계산서 합계를 넣어 주세요.${itemHint(parsed)}`,
            }
          : {
              code: "AMOUNT_MISMATCH",
              message: `금액이 다릅니다. 계산서 ${formatWon(total)} vs 정산 ${formatWon(expectedAmount)} (차이 ${formatWon(total - expectedAmount)}).${itemHint(parsed)}`,
            },
      );
    } else if (total !== expectedAmount) {
      // 허용오차 이내로 통과하되 **오차가 있었다는 사실은 남긴다**(오너 확정 2026-08-06).
      // 조용히 흡수하면 100원 미만 절삭 관행인지 입력 오류인지 사후 구분이 안 된다.
      reasons.push({
        code: "AMOUNT_TOLERATED",
        message: `금액이 허용오차 이내에서 다릅니다. 계산서 ${formatWon(total)} vs 정산 ${formatWon(expectedAmount)} (차이 ${formatWon(total - expectedAmount)}, 100원 미만 절삭 관행 수준).`,
      });
    }

    if (matched.alreadyMarkedAt) {
      reasons.push({
        code: "ALREADY_MARKED",
        message: "이미 수취 완료로 기록된 건입니다.",
      });
    }

    const from = matched.validWrittenDateFrom;
    const to = matched.validWrittenDateTo;
    const written = parsed?.writtenDate ?? null;
    if (written && ((from && written < from) || (to && written > to))) {
      reasons.push({
        code: "WRITTEN_DATE_OUT_OF_RANGE",
        message: `작성일자(${written})가 이 캠페인의 타당 구간(${from ?? "-"} ~ ${to ?? "-"}) 밖입니다.`,
      });
    }
  }

  // 차단하지 않는 사유 2종: 이미 완료 기록(정보성)·허용오차 흡수 표시(오너 확정 2026-08-06).
  const NON_BLOCKING: readonly MismatchCode[] = ["ALREADY_MARKED", "AMOUNT_TOLERATED"];
  const blocking = reasons.filter((reason) => !NON_BLOCKING.includes(reason.code));
  const status: ReceiptStatus =
    confidence === "ATTACHMENT" && matched !== null && blocking.length === 0
      ? "VERIFIED"
      : "NEEDS_REVIEW";

  return {
    status,
    confidence,
    matchedKey: matched?.key ?? null,
    candidateKeys,
    reasons,
    observed: { ...observedBase, expectedTotalAmount: expectedAmount, amountDelta },
  };
}
