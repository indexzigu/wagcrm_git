/**
 * 발행(우리가 끊는) 세금계산서 **N:M 대조 판정** — 순수 함수. DB 를 쓰지 않는다.
 *
 * 짝 모듈 `receipt-match.ts` 는 수취를 1:1 로 판정하고, 공급자가 우리면 `ISSUED_BY_US` 로
 * 즉시 하드 리턴해 **버린다.** 이 파일이 그 버려진 절반을 받는다.
 *
 * ## ⛔ 수취 판정을 복사해 오면 절반을 놓친다 (타 세션 실측 2026-08-05)
 *
 * 실제 발행에서 관측된 패턴:
 * ① 정산 그룹을 **한 장으로 묶어** 끊은 건
 * ② 한 건을 **두 장으로 쪼갠** 건
 * ③ 금액에 원 단위 반올림 오차가 낀 건
 * ④ **통과 광고비가 계산서에만** 실린 건(공급사에서 받아 셀러에게 그대로 나가는 비용이라
 *    CRM 에 칸이 없다 — 오너 확인, **정상 상태**다)
 *
 * 수취 판정의 「후보 정확히 하나 · 금액 완전 일치」를 그대로 쓰면 ①②는 금액이 어긋나
 * 전부 「확인 필요」로 떨어진다. 그래서 이 파일은 **여러 장을 한 기대 건에 합산**한다(N:1).
 *
 * ## 1차 키는 품목명이다 (허용오차 정책이 확정될 때까지)
 *
 * 금액만으로는 위 4패턴을 가를 수 없다. 품목명에는 셀러·딜·회차가 **사람이 읽는 형태로**
 * 들어 있어 어느 캠페인인지를 직접 말해 준다(`etax-xml.ts` 의 `EtaxLineItem` 주석).
 *
 * ⚠️ **허용오차 숫자를 이 파일에서 정하지 않는다.** 「우리몰 물품대금 차액 규명과 허용오차
 * 정책」이 별도로 진행 중이고, "얼마까지 봐줄 것인가"는 코드가 아니라 정책이다. 기본값은
 * 수취와 같은 **0원(완전 일치)** 이고 호출부가 명시적으로만 완화한다 — 정책이 확정되면
 * 그 상수를 주입하는 것으로 끝난다.
 *
 * 즉 품목명은 **누구의 것인가**(식별)를, 금액은 **맞는가**(검증)를 담당한다. 품목명이
 * 식별을 틀려도 금액이 한 번 더 거른다 — 이 이중 관문이 오식별의 안전망이다.
 *
 * ⛔ 품목명·캠페인 라벨에는 셀러 실명이 들어간다 — 이 모듈이 만드는 문자열은 **오너 전용
 * 화면·응답에만** 쓰고 로그·추적 파일·커밋에 남기지 않는다(P0, 레포 public).
 */

import type { ParsedEtaxInvoice } from "./etax-xml";
import { toNfc } from "@/lib/text-normalize";
import type { ExpectedIssuance } from "./expected-issuances";
import { VERIFIED_TYPE_CODES, CORRECTIVE_TYPE_CODES } from "./receipt-match";

export type IssuanceMatchBasis =
  /** 품목명이 이 기대 건을 유일하게 지목했다 */
  | "LINE_ITEM"
  /** 품목명 신호가 없어, 이 상대의 열린 기대 건이 하나뿐이라는 사실로 특정했다 */
  | "SOLE_COUNTERPART";

export type IssuanceStatus =
  /** 자동 확정 가능 — 아래 조건 전부 충족 */
  | "CONFIRMED"
  /** 대조는 됐지만 확정 조건이 어긋남 — 사람이 봐야 한다 */
  | "NEEDS_REVIEW"
  /** 이 기대 건에 대응하는 계산서를 이번 스캔에서 못 봤다 */
  | "UNSEEN"
  /**
   * 이 건의 **타당 작성일자 구간 전체가 메일 조회 창보다 오래됐다** — 계산서가 왔더라도
   * 스캔이 그 시기를 보지 않았다.
   *
   * ⛔ `UNSEEN` 과 반드시 갈라야 한다. 기대 건은 캠페인 창(넓다)에서 나오고 계산서는 메일
   * 창(좁다)에서 나오므로, 둘의 차집합이 구조적으로 생긴다. 그 구간을 `UNSEEN` 으로 세면
   * **「안 봤다」가 「안 왔다」로 둔갑한다** — 이 트랙이 반복해 고쳐 온 실패(#297)의 같은
   * 부류다. 처방도 다르다: `UNSEEN` 은 상대에게 발행을 독촉할 일이고, 이쪽은 조회 창을
   * 넓히거나 사람이 직접 확인할 일이다.
   */
  | "OUT_OF_SCAN_RANGE"
  /** 상대 사업자등록번호가 CRM 에 없어 대조 자체가 불가능하다 */
  | "UNMATCHABLE";

export type IssuanceMismatchCode =
  /** 이미 발행 완료로 기록된 건 */
  | "ALREADY_MARKED"
  /** 그룹이 캠페인별로 후퇴해 자동 확정 대상이 아니다(그룹 필드는 멤버가 공유한다) */
  | "GROUP_FELL_BACK"
  /** 기대 금액 근거가 결번이라 대조가 성립하지 않음 */
  | "EXPECTED_AMOUNT_UNKNOWN"
  /** 계산서 합계를 읽지 못함 */
  | "INVOICE_AMOUNT_MISSING"
  /** 금액 불일치 */
  | "AMOUNT_MISMATCH"
  /**
   * 금액이 허용오차 안이라 **흡수했다** — 확정을 막지 않는 **비차단** 사유다.
   *
   * ⛔ 조용히 흡수하지 않는 것이 오너 요구다("오차가 발생하면 발생했다는 표시는 필요할 것
   * 같다" — 2026-08-06). 발행은 **쓰기 경로**라 수취보다 더 중요하다: 흡수한 채 날짜만
   * 찍고 끝내면, 나중에 그 차이가 브랜드사의 100원 미만 절삭이었는지 **입력 오류**였는지
   * 사후에 구분할 수단이 사라진다. 이 사유는 크론 응답과 **감사 로그 양쪽**에 실린다.
   */
  | "AMOUNT_TOLERATED"
  /**
   * 수정세금계산서(`0201`)다 — 자동 대조하지 않는다.
   *
   * `UNVERIFIED_DOCUMENT_TYPE`("모르는 코드")과 갈라야 처방이 보인다. 실물 체인은
   * 원본(`0101`) → 취소분(`0201`, 총액이 원본의 **부호 반전**) → 재발행분(`0201`)이라
   * (타 세션 실물 확정 2026-08-06), 취소분은 단건 금액 대조가 원리적으로 불가하고
   * 재발행분은 체인 합산이 필요하다. 둘 다 이 회차의 범위 밖이다.
   */
  | "CORRECTIVE_DOCUMENT"
  /** 확인되지 않은 계산서 종류 코드(수정계산서 등) */
  | "UNVERIFIED_DOCUMENT_TYPE"
  /** 작성일자를 읽지 못함 */
  | "WRITTEN_DATE_MISSING"
  /** 작성일자가 타당 창 밖 */
  | "WRITTEN_DATE_OUT_OF_RANGE"
  /** 같은 승인번호가 두 번 이상 관측됨(중복 발행 의심) */
  | "DUPLICATE_ISSUE"
  /** UTF-8 이 아닌 선언이라 품목명·상호를 신뢰할 수 없음 */
  | "ENCODING_UNTRUSTED";

/** 계산서 쪽에서 본, 어느 기대 건에도 붙지 못한 사유. */
export type UnassignedCode =
  /** 공급자가 우리가 아니다 = 우리가 발행한 계산서가 아니다 */
  | "NOT_ISSUED_BY_US"
  /** 공급받는자 사업자번호를 읽지 못했다 */
  | "COUNTERPART_UNKNOWN"
  /** 그 상대에 대한 발행 기대 건이 CRM 에 없다 */
  | "NO_EXPECTED_MATCH"
  /** 후보가 둘 이상인데 품목명으로도 좁혀지지 않았다 */
  | "AMBIGUOUS_MATCH";

export interface IssuanceReason {
  code: IssuanceMismatchCode;
  /** 오너가 읽을 한 줄. ⚠️ 셀러 실명·금액이 들어갈 수 있다(P0). */
  message: string;
}

/** 대조 대상이 되는, 스캔에서 나온 계산서 1장. */
export interface ScannedIssuedInvoice {
  /** 메일 식별자(진단·역추적용) */
  mailUid: number;
  parsed: ParsedEtaxInvoice;
}

export interface IssuanceVerdict {
  key: string;
  status: IssuanceStatus;
  /** 이 기대 건에 붙은 계산서들 */
  assigned: Array<{
    mailUid: number;
    issueId: string | null;
    writtenDate: string | null;
    totalAmount: number | null;
    basis: IssuanceMatchBasis;
  }>;
  reasons: IssuanceReason[];
  observed: {
    /** 붙은 계산서 합계(전부 읽혔을 때만). 한 장이라도 못 읽으면 null. */
    totalAmount: number | null;
    expectedTotalAmount: number | null;
    /** 관측 − 기대. 둘 다 알 때만. */
    amountDelta: number | null;
    /** 자동 확정이 찍을 날짜 = 계산서 작성일자. 여러 장이면 가장 늦은 것. */
    writtenDate: string | null;
  };
}

export interface UnassignedInvoice {
  mailUid: number;
  issueId: string | null;
  code: UnassignedCode;
  message: string;
  /** 후보가 여럿이라 못 정한 경우 그 후보들(진단용) */
  candidateKeys: string[];
}

export interface MatchIssuedInvoicesInput {
  invoices: readonly ScannedIssuedInvoice[];
  expected: readonly ExpectedIssuance[];
  /** 우리 사업자등록번호(숫자 10자리) */
  ourBusinessNumber: string;
  /**
   * 금액 허용오차(원). **기본 0 = 완전 일치.** 위 헤더의 경고 참조 — 정책이 확정되기
   * 전까지 이 값을 코드 안에서 키우지 말 것.
   */
  amountToleranceWon?: number;
  /**
   * 메일 조회 창의 시작일(`YYYY-MM-DD`). 주면, 타당 작성일자 구간이 **통째로** 이 날짜보다
   * 이른 기대 건을 `UNSEEN` 이 아니라 `OUT_OF_SCAN_RANGE` 로 낸다.
   *
   * 왜 필요한가: 기대 건은 캠페인 창(넓다)에서, 계산서는 메일 창(좁다)에서 나온다. 안 주면
   * 그 차집합이 전부 「미발행 후보」로 세어져 **조회하지 않은 구간을 안 왔다고 단정**한다.
   */
  scanWindowFromDate?: string | null;
}

export interface MatchIssuedInvoicesResult {
  verdicts: IssuanceVerdict[];
  unassigned: UnassignedInvoice[];
}

function normalizeDigits(raw: string): string {
  return raw.replace(/\D/g, "");
}

function formatWon(value: number): string {
  return `${value.toLocaleString("ko-KR")}원`;
}

/**
 * 품목명 대조용 접기 — 공백·기호를 지우고 소문자로 접는다. 계산서와 CRM 이 같은 이름을
 * 띄어쓰기·괄호만 다르게 적는 경우가 흔해서다.
 *
 * 🔴 **`toNfc` 를 먼저 태운다.** 한쪽(품목명)은 **메일 첨부의 계산서 XML** 에서 오고 다른
 * 쪽(캠페인 라벨)은 우리 DB 에서 온다 — 형태가 갈리면 눈에 같은 이름이 안 맞아 후보
 * 좁히기가 조용히 실패한다(편지함 이름·엑셀 헤더와 같은 축, 2026-09-02).
 *
 * ⚠️ 이름이 `normalizeForCompare` 가 아닌 것은 의도다 — `text-normalize` 의 그것은 기호를
 * 남기므로 **계약이 다르다**. 같은 이름으로 두면 grep 이 서로 다른 답을 준다(실측: 정의가
 * 3개였다).
 */
function foldLabelForMatch(raw: string): string {
  return toNfc(raw).replace(/[\s\-_/·,.()[\]{}]/g, "").toLowerCase();
}

/**
 * 캠페인 라벨에서 **식별 토큰**을 뽑는다. 2자 미만은 우연 일치가 너무 흔해 버린다.
 *
 * ⚠️ 불용어 목록을 두지 않는 것은 **의도**다. 이 점수는 절대 문턱이 아니라 후보 사이의
 * **상대 판별자**로만 쓰이므로(아래 `pickByLineItems`), 「회차」·「광고」처럼 모든 후보가
 * 공유하는 토큰은 전 후보의 점수를 똑같이 올려 순위를 바꾸지 못한다. 순위를 가르는 것은
 * 결국 그 캠페인에만 있는 토큰이다 — 목록을 손으로 관리하면 오히려 그게 표류한다.
 */
function identityTokens(label: string): string[] {
  // 쪼개기 전에 NFC 로 맞춘다 — 구분자 매칭이 형태에 좌우되지 않게.
  // ⚠️ **아래 `length >= 2` 때문은 아니다.** 그 필터는 `foldLabelForMatch`(내부에 NFC) 를
  //    거친 뒤에 걸리므로 선행 정규화가 없어도 토큰 집합은 같다 — 실측으로 확인했고,
  //    종전 주석은 그 순서를 잘못 읽어 「없으면 토큰이 갈린다」고 적고 있었다.
  return toNfc(label)
    .split(/[\s\-_/·,.()[\]{}×xX]+/)
    .map((token) => foldLabelForMatch(token))
    .filter((token) => token.length >= 2);
}

/** 계산서의 품목명을 한 덩어리로 이어 붙인다(정규화 후). 이름이 없으면 빈 문자열. */
function lineItemHaystack(parsed: ParsedEtaxInvoice): string {
  return parsed.lineItems
    .map((item) => item.name)
    .filter((name): name is string => Boolean(name))
    .map((name) => foldLabelForMatch(name))
    .join("|");
}

/**
 * 품목명으로 후보를 좁힌다. **유일한 최고 점수**일 때만 채택한다 — 동점이면 특정하지
 * 못한 것이므로 `null` 을 돌려주고 호출부가 `AMBIGUOUS_MATCH` 로 표면화한다.
 * 조용히 하나를 고르지 않는다.
 */
function pickByLineItems(
  candidates: readonly ExpectedIssuance[],
  haystack: string,
): ExpectedIssuance | null {
  if (haystack.length === 0) return null;

  let best: ExpectedIssuance | null = null;
  let bestScore = 0;
  let tied = false;

  for (const candidate of candidates) {
    const score = identityTokens(candidate.campaignLabel).filter((token) =>
      haystack.includes(token),
    ).length;
    if (score === 0) continue;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }

  return tied ? null : best;
}

/**
 * 발행 계산서들을 기대 건에 배정하고 판정한다.
 *
 * `CONFIRMED`(자동 확정 가능)는 아래가 **전부** 참일 때만 나온다. 기본은 거부다.
 *
 * 1. 배정된 계산서가 1장 이상이고 전부 첨부 파싱본이다(제목 폴백은 애초에 들어오지 못한다)
 * 2. 그 계산서들의 공급자가 전부 우리다
 * 3. 공급받는자 사업자번호가 기대 건의 상대와 일치한다
 * 4. 계산서 종류 코드가 확인된 값(`0101`)이다
 * 5. 작성일자가 읽히고 타당 창 안이다
 * 6. 승인번호가 이번 스캔에서 중복되지 않는다
 * 7. 기대 금액이 **알려져 있고**, 배정된 계산서 합계가 허용오차 안이다
 * 8. 아직 완료로 기록되지 않았다
 * 9. **쓰기 대상이 있다**(`writeTarget !== null`) — 그룹이 캠페인별로 후퇴했으면 자동
 *    확정하지 않는다. 그룹 필드는 멤버 전원이 공유하므로 멤버 1건을 근거로 찍으면 나머지
 *    의무까지 함께 완료로 굳는다(`expected-issuances.ts` 헤더 참조).
 */
export function matchIssuedInvoices(
  input: MatchIssuedInvoicesInput,
): MatchIssuedInvoicesResult {
  const {
    invoices,
    expected,
    ourBusinessNumber,
    amountToleranceWon = 0,
    scanWindowFromDate = null,
  } = input;
  const ours = normalizeDigits(ourBusinessNumber);

  const unassigned: UnassignedInvoice[] = [];
  const assignments = new Map<string, Array<{ invoice: ScannedIssuedInvoice; basis: IssuanceMatchBasis }>>();

  // 승인번호 중복은 **스캔 전체**를 봐야 판정된다 — 배정 루프 안에서 누적하면 첫 장은
  // 통과하고 두 번째 장만 걸려, 같은 건이 한 번은 확정되고 한 번은 보류되는 상태가 된다.
  const issueIdCounts = new Map<string, number>();
  for (const invoice of invoices) {
    const id = invoice.parsed.issueId;
    if (id) issueIdCounts.set(id, (issueIdCounts.get(id) ?? 0) + 1);
  }

  for (const invoice of invoices) {
    const { parsed } = invoice;

    // ── 방향 판정 — 가장 먼저, 단독으로 끝낸다(수취 엔진과 같은 규율).
    if (parsed.invoicerBusinessNumber !== ours) {
      unassigned.push({
        mailUid: invoice.mailUid,
        issueId: parsed.issueId,
        code: "NOT_ISSUED_BY_US",
        message: "공급자가 우리가 아닙니다. 발행 대조 대상이 아닙니다.",
        candidateKeys: [],
      });
      continue;
    }

    const counterpart = parsed.invoiceeBusinessNumber;
    if (!counterpart) {
      unassigned.push({
        mailUid: invoice.mailUid,
        issueId: parsed.issueId,
        code: "COUNTERPART_UNKNOWN",
        message: "공급받는자 사업자등록번호를 읽지 못했습니다.",
        candidateKeys: [],
      });
      continue;
    }

    const byCounterpart = expected.filter(
      (item) =>
        item.counterpartBusinessNumber !== null &&
        normalizeDigits(item.counterpartBusinessNumber) === counterpart,
    );

    if (byCounterpart.length === 0) {
      unassigned.push({
        mailUid: invoice.mailUid,
        issueId: parsed.issueId,
        code: "NO_EXPECTED_MATCH",
        message: `공급받는자(${counterpart})에 대응하는 발행 기대 건이 없습니다. 캠페인 창이 어긋났거나 캠페인과 무관한 발행일 수 있습니다.`,
        candidateKeys: [],
      });
      continue;
    }

    let matched: ExpectedIssuance | null = null;
    let basis: IssuanceMatchBasis = "SOLE_COUNTERPART";

    // ① 품목명 — 1차 키. 후보가 하나뿐이어도 품목명이 지목하면 그 근거를 남긴다.
    const byLineItem = pickByLineItems(byCounterpart, lineItemHaystack(parsed));
    if (byLineItem) {
      matched = byLineItem;
      basis = "LINE_ITEM";
    } else if (byCounterpart.length === 1) {
      // ② 품목명 신호가 없다(이름이 비었거나 어느 캠페인도 지목하지 않았다). 이 상대의
      //    기대 건이 하나뿐이면 그것으로 특정한다 — 금액 대조가 뒤에서 한 번 더 거른다.
      matched = byCounterpart[0];
      basis = "SOLE_COUNTERPART";
    }

    if (!matched) {
      unassigned.push({
        mailUid: invoice.mailUid,
        issueId: parsed.issueId,
        code: "AMBIGUOUS_MATCH",
        message: `같은 공급받는자의 발행 기대 건이 ${byCounterpart.length}건인데 품목명으로도 어느 건인지 특정하지 못했습니다.`,
        candidateKeys: byCounterpart.map((item) => item.key),
      });
      continue;
    }

    const bucket = assignments.get(matched.key);
    if (bucket) bucket.push({ invoice, basis });
    else assignments.set(matched.key, [{ invoice, basis }]);
  }

  const verdicts = expected.map((item) =>
    judgeExpectedIssuance(
      item,
      assignments.get(item.key) ?? [],
      issueIdCounts,
      amountToleranceWon,
      scanWindowFromDate,
    ),
  );

  return { verdicts, unassigned };
}

function judgeExpectedIssuance(
  item: ExpectedIssuance,
  hits: ReadonlyArray<{ invoice: ScannedIssuedInvoice; basis: IssuanceMatchBasis }>,
  issueIdCounts: ReadonlyMap<string, number>,
  amountToleranceWon: number,
  scanWindowFromDate: string | null,
): IssuanceVerdict {
  const reasons: IssuanceReason[] = [];
  const assigned = hits.map(({ invoice, basis }) => ({
    mailUid: invoice.mailUid,
    issueId: invoice.parsed.issueId,
    writtenDate: invoice.parsed.writtenDate,
    totalAmount: invoice.parsed.amounts.totalAmount,
    basis,
  }));

  const expectedTotalAmount = item.expectedTotalAmount;

  if (hits.length === 0) {
    // 대조 키가 없는 건을 「미발행」으로 세면 화면이 「안 끊었다」고 단정하지만 실제로는
    // 「우리가 확인할 수단이 없다」다 — 수취 엔진의 `unmatchable` 과 같은 구분이다.
    //
    // 조회 창 밖도 같은 부류다: 타당 구간이 **통째로** 메일 창보다 이르면 계산서가 왔더라도
    // 우리가 그 시기를 보지 않았다. `validWrittenDateTo` 가 없으면(창 미지정) 판단 근거가
    // 없으므로 단정하지 않고 기존대로 둔다 — 모르는 것을 아는 척하지 않는다.
    const outOfScanRange =
      scanWindowFromDate !== null &&
      item.validWrittenDateTo !== null &&
      item.validWrittenDateTo < scanWindowFromDate;

    const status: IssuanceStatus =
      item.counterpartBusinessNumber === null
        ? "UNMATCHABLE"
        : outOfScanRange
          ? "OUT_OF_SCAN_RANGE"
          : "UNSEEN";
    return {
      key: item.key,
      status,
      assigned,
      reasons: item.alreadyMarkedAt
        ? [{ code: "ALREADY_MARKED", message: "이미 발행 완료로 기록된 건입니다." }]
        : [],
      observed: {
        totalAmount: null,
        expectedTotalAmount,
        amountDelta: null,
        writtenDate: null,
      },
    };
  }

  // ── 합계. 한 장이라도 못 읽으면 합계를 만들지 않는다 — 읽힌 것만 더하면
  //    "일부만 반영된 합계"가 완전한 합계처럼 보이는 그럴듯한 오답이 된다.
  const amounts = hits.map((hit) => hit.invoice.parsed.amounts.totalAmount);
  const totalAmount = amounts.some((value) => value === null)
    ? null
    : amounts.reduce<number>((acc, value) => acc + (value as number), 0);

  if (totalAmount === null) {
    reasons.push({
      code: "INVOICE_AMOUNT_MISSING",
      message: "계산서에서 합계 금액을 읽지 못해 대조하지 못했습니다.",
    });
  }

  for (const { invoice } of hits) {
    const { parsed } = invoice;

    // ⛔ 화이트리스트다 — 확인된 코드(`0101`)만 통과한다. 수정계산서(`0201`)는 사유를
    //    정밀화해 갈라 주되, **판정 자체는 화이트리스트가 이미 막고 있다.** 블랙리스트로
    //    바꾸지 말 것 — 목록에 없는 새 코드가 원본처럼 통과한다.
    if (parsed.typeCode !== null && !VERIFIED_TYPE_CODES.includes(parsed.typeCode)) {
      reasons.push(
        CORRECTIVE_TYPE_CODES.includes(parsed.typeCode)
          ? {
              code: "CORRECTIVE_DOCUMENT",
              message: `수정세금계산서(${parsed.typeCode})입니다. 취소분은 금액이 부호 반전이고 재발행분은 체인 합산이 필요해 자동 대조하지 않습니다.`,
            }
          : {
              code: "UNVERIFIED_DOCUMENT_TYPE",
              message: `확인되지 않은 계산서 종류 코드(${parsed.typeCode})입니다.`,
            },
      );
    }
    if (parsed.declaredEncoding !== null && !/^UTF-?8$/.test(parsed.declaredEncoding)) {
      reasons.push({
        code: "ENCODING_UNTRUSTED",
        message: `UTF-8 이 아닌 인코딩(${parsed.declaredEncoding}) 선언이라 품목명을 신뢰할 수 없습니다.`,
      });
    }
    if (parsed.writtenDate === null) {
      reasons.push({ code: "WRITTEN_DATE_MISSING", message: "작성일자를 읽지 못했습니다." });
    } else {
      const from = item.validWrittenDateFrom;
      const to = item.validWrittenDateTo;
      if ((from && parsed.writtenDate < from) || (to && parsed.writtenDate > to)) {
        reasons.push({
          code: "WRITTEN_DATE_OUT_OF_RANGE",
          message: `작성일자(${parsed.writtenDate})가 이 캠페인의 타당 구간(${from ?? "-"} ~ ${to ?? "-"}) 밖입니다.`,
        });
      }
    }
    if (parsed.issueId && (issueIdCounts.get(parsed.issueId) ?? 0) > 1) {
      reasons.push({
        code: "DUPLICATE_ISSUE",
        message: `같은 승인번호(${parsed.issueId})의 계산서가 두 번 이상 관측됐습니다(중복 발행 의심).`,
      });
    }
  }

  if (expectedTotalAmount === null) {
    reasons.push({
      code: "EXPECTED_AMOUNT_UNKNOWN",
      message:
        item.amountBlockingReasons.length > 0
          ? `기대 금액을 계산할 수 없습니다(${item.amountBlockingReasons.join(" · ")}).`
          : `기대 금액 기준이 확정되지 않아 대조하지 못했습니다(${item.amountBasis}).`,
    });
  } else if (totalAmount !== null) {
    const delta = totalAmount - expectedTotalAmount;
    if (Math.abs(delta) > amountToleranceWon) {
      reasons.push({
        code: "AMOUNT_MISMATCH",
        message: `금액이 다릅니다. 계산서 ${hits.length}장 합계 ${formatWon(totalAmount)} vs 정산 ${formatWon(expectedTotalAmount)} (차이 ${formatWon(delta)}). 통과 광고비처럼 CRM 에 칸이 없는 항목이 실렸을 수 있습니다.`,
      });
    } else if (delta !== 0) {
      // 흡수했다는 **사실 자체**를 남긴다(비차단). 조용한 흡수는 절삭인지 입력 오류인지
      // 사후 구분을 없앤다 — 오너 요구다.
      reasons.push({
        code: "AMOUNT_TOLERATED",
        message: `금액 차이 ${formatWon(delta)}를 허용오차(±${formatWon(amountToleranceWon)}) 안으로 보고 확정했습니다. 계산서 ${formatWon(totalAmount)} vs 정산 ${formatWon(expectedTotalAmount)}.`,
      });
    }
  }

  if (item.writeTarget === null) {
    reasons.push({
      code: "GROUP_FELL_BACK",
      message:
        "정산 그룹 안에서 채널·상대가 갈려 캠페인별로 나뉜 건입니다. 그룹의 발행일 필드는 멤버 전원이 공유하므로 자동으로 찍지 않습니다(수동 확인 필요).",
    });
  }

  if (item.alreadyMarkedAt) {
    reasons.push({ code: "ALREADY_MARKED", message: "이미 발행 완료로 기록된 건입니다." });
  }

  const writtenDates = hits
    .map((hit) => hit.invoice.parsed.writtenDate)
    .filter((value): value is string => value !== null);
  // 여러 장이면 가장 늦은 작성일자를 쓴다 — 의무가 전부 이행된 시점이 그때다.
  const writtenDate =
    writtenDates.length === 0 ? null : writtenDates.reduce((a, b) => (a > b ? a : b));

  /**
   * 확정을 막지 않는 사유. **현재 하나뿐이다** — 허용오차 흡수는 "봐주기로 한 정책"이지
   * 판정 실패가 아니다.
   *
   * ⚠️ 수취 판정(`receipt-match.ts`)은 `ALREADY_MARKED` 도 비차단으로 두지만 **여기서는
   * 차단이다.** 저쪽은 읽기 전용이라 이미 찍힌 건을 `VERIFIED` 로 표시해도 아무 일이
   * 없지만, 이쪽은 **쓰기 경로**다 — 확정으로 올리면 감사 로그가 한 번 더 쌓이고
   * "기계가 또 찍었다"는 잘못된 기록이 남는다. 두 모듈을 같은 목록으로 통일하지 말 것.
   */
  const NON_BLOCKING: readonly IssuanceMismatchCode[] = ["AMOUNT_TOLERATED"];
  const blocking = reasons.filter((reason) => !NON_BLOCKING.includes(reason.code));
  const status: IssuanceStatus = blocking.length === 0 ? "CONFIRMED" : "NEEDS_REVIEW";

  return {
    key: item.key,
    status,
    assigned,
    reasons,
    observed: {
      totalAmount,
      expectedTotalAmount,
      amountDelta:
        totalAmount !== null && expectedTotalAmount !== null
          ? totalAmount - expectedTotalAmount
          : null,
      writtenDate,
    },
  };
}
