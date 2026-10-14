/**
 * 캠페인 계산서 여러 장(T-240 후속) 판정 SSOT — **client-safe 순수 모듈**(Prisma·node 무의존).
 *
 * 무엇인가: 월정산 거래처(`Partner.monthlySettlement`)의 캠페인은 한 회차가 월을 넘기면 공급사
 * 계산서가 9월분·10월분으로 나뉜다. 캠페인은 **1단위 그대로** 두고(셀러 정산·완료·리포트 모두
 * 캠페인 단위) 계산서만 달별로 붙는다. #159 의 「월별 정산 줄」은 캠페인을 달로 쪼갠 셈이라
 * 오너가 기각했다(2026-10-08).
 *
 * 오너 확정(2026-10-08):
 * - 그룹 캠페인 = 계산서 1장(그룹은 딜을 나눠 관리하는 단위일 뿐). 읽기는 그룹 멤버 전원의 행을 모은다.
 * - 「몇 월분」 = 계산서 **작성일의 달**. 월정산은 그 달 말일자로 끊고 다음 달 초에 발급된다.
 * - 칸에 보이는 낱말은 한 낱말(문장·지시문 금지), 할 일이 없으면 날짜나 「—」. 풀이는 마우스를
 *   올리면 뜨는 작은 창으로 — 낱말·풀이 모두 아래 표 하나가 소유한다(화면에서 다시 쓰지 말 것).
 * - 줄은 캠페인 기간에 걸친 달마다 처음부터 있고 내용만 바뀐다. 계산서를 끊지 않는 달도 줄을
 *   지우지 않고 「없음」으로 남긴다(줄이 생기고 사라지면 화면이 흔들린다).
 *
 * 쓰기·완료 게이트는 `src/services/campaignInvoiceService.ts` 가 소유한다.
 * 설계 정본: docs/private/specs/2026-10-08-invoice-autofill-flow.md (+ -design-critique.md)
 */
import { toKstYmd } from "./date-utils";
import { normalizeForCompare } from "./text-normalize";
import { SUB_HUNDRED_TRUNCATION_TOLERANCE_WON } from "./tax-invoice-mail/receipt-match";
import { lineItemNamesHaystack, pickByLabelTokens } from "./tax-invoice-mail/line-item-label-match";
import {
  TAX_INVOICE_OBLIGATION_TABLE,
  resolveTaxFilingChannelGroup,
} from "./tax-filing-board";

export type InvoiceDirection = "ISSUE" | "RECEIVE";
export type InvoiceRowStatus = "RECORDED" | "WAIVED" | "DISMISSED";
/** MAIL = 오너가 메일 계산서를 확인해 기록 · MAIL_AUTO = 크론이 확인 없이 기록(T-242) · MANUAL = 직접 입력 */
export type InvoiceRowSource = "MAIL" | "MAIL_AUTO" | "MANUAL";

/** 저장된 계산서 행(화면·판정용 직렬형 — 날짜는 KST "YYYY-MM-DD"). */
export type CampaignInvoiceRow = {
  id: string;
  campaignId: string;
  direction: InvoiceDirection;
  yearMonth: string;
  status: InvoiceRowStatus;
  writtenAt: string | null;
  approvalNo: string | null;
  supplyAmount: number | null;
  taxAmount: number | null;
  totalAmount: number | null;
  itemName: string | null;
  source: InvoiceRowSource;
  mailReceivedAt: string | null;
  note: string | null;
};

/**
 * 메일에서 읽은 계산서 한 장의 요약 — 수취 조회 API(`/api/settlement/tax-invoice-receipts`)의
 * `results[].invoice` 가 이 모양이다. ⛔ 품목명에는 셀러 실명이 들어갈 수 있다 — 오너 전용 화면에만.
 */
export type InvoiceMailSummary = {
  issueId: string | null;
  typeCode: string | null;
  writtenDate: string | null;
  invoicerBusinessNumber: string | null;
  invoiceeBusinessNumber: string | null;
  supplyAmount: number | null;
  taxAmount: number | null;
  totalAmount: number | null;
  itemName: string | null;
  receivedAt: string | null;
};

/**
 * 달별 줄의 상태.
 * - RECORDED: 기록됨(칸에는 낱말 대신 작성일)
 * - AMENDED: 기록한 계산서에 같은 상대·같은 달의 수정세금계산서가 따라왔다 — 확인 전까지 「끝」이 아니다
 * - WAIVED: 오너가 「이 달은 계산서 없음」으로 표시
 * - PENDING: 메일에서 맞는 계산서를 찾았고 오너 확인을 기다린다
 * - NOT_DUE: 그 달이 아직 안 끝났다(작성일이 월말이라 그 전엔 발행 전)
 * - NOT_FOUND: 달은 끝났는데 메일함에 맞는 메일이 없다
 * - OUT_OF_SCAN: 메일함을 본 기간보다 이전 달이거나 메일함을 못 읽어 판단할 수 없다
 * - MINOR_MISMATCH: 정산서 없이 메일 계산서 한 장을 캠페인 전액과 맞춰 보니 허용오차(99원)는 넘고 전액의
 *   `MINOR_DELTA_RATIO` 이내로 어긋난다(또는 한 달짜리 캠페인인데 전액보다 적다 — 한 달이면 나눠 끊을 달이 없다) — 정산 오류일 수
 *   있어 오너가 원인을 본다. 자동 기록하지 않는다(오너 확정 2026-10-14).
 * - OVER_EXPECTED: 계산서 한 장이 전액보다 비율 이상 많다 — 다른 건이 섞였거나 기대액이 틀렸을 수 있다.
 *   자동 기록하지 않는다(오너 확정 2026-10-14).
 * - POSSIBLE_SPLIT: 달을 넘는 캠페인의 계산서 한 장이 전액보다 비율 이상 적다 — 달을 나눠 끊었을 수 있지만
 *   정산서로 확인되지 않았다. **결론이 아니다**(정산서는 오지 않을 수 있다). 자동 기록하지 않는다.
 * - COVERED: 이 달엔 기록이 없지만 기록한 계산서들의 합계가 캠페인 전액과 맞는다 — 월정산이어도 한 번에
 *   끊은 것이다(오너 확정 2026-10-14). 끝난 달로 센다(`isFullAmountCovered`).
 */
export type InvoiceMonthState =
  | "RECORDED"
  | "AMENDED"
  | "WAIVED"
  | "PENDING"
  | "NOT_DUE"
  | "NOT_FOUND"
  | "OUT_OF_SCAN"
  | "MINOR_MISMATCH"
  | "OVER_EXPECTED"
  | "POSSIBLE_SPLIT"
  | "COVERED";

/**
 * 칸에 보이는 낱말 — null 이면 낱말 대신 값(RECORDED = 작성일, NOT_DUE = 「—」)을 그린다.
 * 기준(2026-10-08 조사, docs/private/specs/2026-10-08-status-display-conventions.md):
 * 한 낱말 · 문장·지시문 금지 · 할 일이 없으면 상태 낱말을 쓰지 않는다.
 * ⛔ 「확인대기」와 「미발견」을 「대기」 하나로 합치지 말 것 — 오너가 누를 차례인지 메일이 올
 * 차례인지가 갈리지 않으면 신호가 죽는다.
 */
export const INVOICE_MONTH_LABEL: Record<InvoiceMonthState, string | null> = {
  RECORDED: null,
  AMENDED: "수정됨",
  WAIVED: "없음",
  PENDING: "확인대기",
  NOT_DUE: null,
  NOT_FOUND: "미발견",
  OUT_OF_SCAN: "조회불가",
  MINOR_MISMATCH: "오류 가능성",
  OVER_EXPECTED: "기대액 초과",
  POSSIBLE_SPLIT: "분할 가능성",
  COVERED: "한 번에",
};

/** 마우스를 올리면(키보드 포커스·터치 포함) 뜨는 풀이 — 오너 지시(2026-10-08). */
export const INVOICE_MONTH_HINT: Record<InvoiceMonthState, string> = {
  RECORDED: "계산서를 기록했습니다.",
  AMENDED: "기록한 계산서에 수정세금계산서가 따라왔습니다. 「조회」에서 다시 확인해 주세요.",
  WAIVED: "이 달은 계산서를 끊지 않는 달로 표시했습니다.",
  PENDING: "메일함에서 이 달 계산서를 찾았습니다. 「조회」에서 확인하면 기록됩니다.",
  NOT_DUE: "이 달이 끝나야 발행합니다(작성일이 월말).",
  NOT_FOUND: "달은 끝났는데 메일함에 맞는 계산서 메일이 없습니다. 발행했다면 메일이 오는 대로 바뀝니다.",
  OUT_OF_SCAN: "메일함을 확인한 기간보다 이전 달이라 판단할 수 없습니다. 필요하면 「조회」에서 직접 입력하세요.",
  MINOR_MISMATCH: "정산 오류 가능성 · 원인 확인 필요. 계산서 금액이 캠페인 전액과 조금 다릅니다. 「조회」에서 확인해 주세요.",
  OVER_EXPECTED: "기대액 초과 · 다른 건 포함 또는 기대액 오류 가능. 계산서 금액이 캠페인 전액보다 많습니다. 「조회」에서 확인해 주세요.",
  POSSIBLE_SPLIT: "분할 발행 가능성 · 정산 메일 미확인. 계산서 금액이 캠페인 전액보다 적어 달을 나눠 끊었을 수 있습니다. 결론이 아니니 「조회」에서 확인해 주세요.",
  COVERED: "다른 달 계산서에 캠페인 전액이 들어 있습니다(금액 일치). 이 달은 따로 끊지 않습니다.",
};

/** 캠페인 계산서 조회 API(`GET /api/campaigns/[id]/invoices`)의 응답. */
export type CampaignInvoiceView =
  | { applicable: false }
  | {
      applicable: true;
      direction: InvoiceDirection;
      counterpartBusinessNumber: string | null;
      counterpartLabel: string;
      periodStart: string;
      periodEnd: string;
      /** 그룹이면 멤버 수, 아니면 1 */
      memberCount: number;
      /** 셀러 별칭·이름 — 정산서 메일을 이 단위 것으로 고르는 키(T-242) */
      sellerLabels: string[];
      /** 레거시 단일 날짜(KST) — 레거시 모드 판정·표시용 */
      legacyDate: string | null;
      legacyMode: boolean;
      /** 단위 공급사 계산서 전액(원) — 세무 보드와 같은 금액. null = 모름(전액 판정 안 함) */
      expectedTotalAmount: number | null;
      /** 전액이 수동 입력값에서 계산됐는가 — 어긋남 달에 「CRM 금액 재확인」 풀이 */
      expectedFromManual: boolean;
      rows: CampaignInvoiceRow[];
      /** 메일 후보에서 뺄 승인번호 — 어느 캠페인에든 기록된 것 + 이 단위에서 「이 메일이 아님」 */
      excludedIssueIds: string[];
    };

/** 「—」 처럼 낱말이 없는 상태에서 칸에 그리는 값. */
export const INVOICE_MONTH_EMPTY_MARK = "—";

/** 상태 점의 색 축 — 할 일이 있는 것만 색을 받는다(P8 「정상 상태는 안 튄다」). */
/**
 * 달 상태에 덧붙는 고정 풀이 — 판정을 바꾸지 않고 오너가 볼 곳만 짚는다.
 * EXPECTED_FROM_MANUAL: 전액이 수동 입력값(영업수익·물품대금 등)에서 계산됐다 — 어긋남의 원인이 CRM 쪽 금액일 수 있다.
 */
export type InvoiceMonthNote = "EXPECTED_FROM_MANUAL";
export const INVOICE_MONTH_NOTE_HINT: Record<InvoiceMonthNote, string> = {
  EXPECTED_FROM_MANUAL: "기대액이 수동 입력값에서 계산됨 · CRM 금액 재확인",
};

export const INVOICE_MONTH_TONE: Record<InvoiceMonthState, "none" | "info" | "caution" | "slate"> = {
  RECORDED: "none",
  AMENDED: "caution",
  WAIVED: "none",
  PENDING: "info",
  NOT_DUE: "none",
  NOT_FOUND: "slate",
  OUT_OF_SCAN: "slate",
  MINOR_MISMATCH: "caution",
  OVER_EXPECTED: "caution",
  POSSIBLE_SPLIT: "caution",
  COVERED: "none",
};

/**
 * 끝난 달로 세는 상태 — 화면의 n/m 이 완료 게이트(`summarizeInvoiceRows`)와 같은 달을 세게 한다.
 * AMENDED 는 기록이 있어 게이트는 통과하지만 화면은 「확인 전까지 끝이 아니다」로 세지 않는다(종전 그대로).
 */
export function isInvoiceMonthDone(state: InvoiceMonthState): boolean {
  return state === "RECORDED" || state === "WAIVED" || state === "COVERED";
}

export type InvoiceMonth = {
  yearMonth: string;
  state: InvoiceMonthState;
  /** 이 달에 기록된 계산서(RECORDED 행). 분할 발행이면 여러 장일 수 있다. */
  recorded: CampaignInvoiceRow[];
  /** 「이 달은 계산서 없음」 행 */
  waived: CampaignInvoiceRow | null;
  /** 아직 기록·제외되지 않은 일반 계산서(0101) 후보 */
  candidates: InvoiceMailSummary[];
  /** 아직 처리되지 않은 수정세금계산서(0201) */
  amendments: InvoiceMailSummary[];
  /** 정산서가 예고한 이 달 계산서(T-242) — 미리 보기용, 기록의 근거는 아니다 */
  expected: StatementExpectation[];
  /** 덧붙는 고정 풀이 코드(`INVOICE_MONTH_NOTE_HINT`) — 대개 빈 목록 */
  notes: InvoiceMonthNote[];
  /**
   * 기록한 계산서 합계가 전액과 어긋난다(`judgeRecordedMismatch`) — 달은 끝났지만(작성일을 그대로 보인다)
   * 오너가 원인을 봐야 한다. 기록이 있는 달에만 붙고, 끝난 달 수(n/m)는 그대로 세되 「확인 필요」를 함께 보인다.
   */
  mismatch: RecordedMismatchKind | null;
};

const YEAR_MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isValidYearMonth(value: string): boolean {
  return YEAR_MONTH_RE.test(value);
}

/** 날짜의 KST 달("YYYY-MM"). */
export function toKstYearMonth(date: Date): string {
  return toKstYmd(date).slice(0, 7);
}

/** "2026-12" → "2027-01". */
export function nextYearMonth(yearMonth: string): string {
  const match = YEAR_MONTH_RE.exec(yearMonth);
  if (!match) throw new Error(`invalid yearMonth: ${yearMonth}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** "2026-09" → "9월". 해가 다르면 호출부가 연도를 덧붙인다. */
export function formatInvoiceMonth(yearMonth: string): string {
  return `${Number(yearMonth.slice(5, 7))}월`;
}

/**
 * 공급사 계산서의 방향 — 채널 의무표(`TAX_INVOICE_OBLIGATION_TABLE`)가 유일한 정본이다.
 * ⛔ 채널 분기를 여기서 다시 쓰지 말 것. 브랜드몰 = 우리가 발행(수수료), 그 외 = 우리가 수취(물품대금).
 */
export function resolveSupplierInvoiceDirection(salesChannel: string): InvoiceDirection {
  const obligation =
    TAX_INVOICE_OBLIGATION_TABLE[resolveTaxFilingChannelGroup(salesChannel)].supplierInvoiceIssuedAt;
  // 현행 표는 모든 채널에 공급사 의무가 있다 — 비면 표가 바뀐 것이므로 조용히 고르지 않고 터뜨린다.
  if (!obligation) throw new Error(`공급사 계산서 의무가 없는 채널: ${salesChannel}`);
  return obligation.direction;
}

/** 캠페인(또는 그룹 포락선) 기간에 걸친 KST 달 목록 — 시작 달부터 종료 달까지 빠짐없이. */
export function listYearMonths(periodStart: Date, periodEnd: Date): string[] {
  const first = toKstYearMonth(periodStart);
  const last = toKstYearMonth(periodEnd);
  if (first > last) return [first];
  const months: string[] = [];
  for (let ym = first; ym <= last; ym = nextYearMonth(ym)) months.push(ym);
  return months;
}

/**
 * 계산서를 받을 수 있는 달인가 — 기간의 달 + 종료 뒤 두 달(이월분 정산서가 다음 달에 온다).
 * 그보다 먼 달은 다른 캠페인의 계산서를 잘못 고른 것일 가능성이 크다. 쓰기 경로(서비스)와 자동 기록
 * 판정(`planAutoRecords`)이 같은 창을 써야 판정이 고른 것을 쓰기가 거절하지 않는다.
 */
export function isAcceptableInvoiceMonth(periodMonths: readonly string[], yearMonth: string): boolean {
  if (periodMonths.length === 0) return false;
  const last = nextYearMonth(nextYearMonth(periodMonths[periodMonths.length - 1]));
  return yearMonth >= periodMonths[0] && yearMonth <= last;
}

const VERIFIED_TYPE_CODE = "0101";
const CORRECTIVE_TYPE_CODE = "0201";

function digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/**
 * 메일 계산서 중 이 단위(캠페인·그룹)의 공급사 계산서일 수 있는 것을 달별로 고른다.
 *
 * 판정 키는 **구조뿐**이다: 방향(우리가 공급자인가/공급받는자인가) · 상대 사업자번호 · 작성일의 달.
 * 금액 부분합 조합 매칭은 기각된 이력이 있다 — 같은 달에 같은 브랜드 계산서가 여러 장 오는 것이
 * 정상이라(프로모션마다 1장), 어느 장이 이 캠페인 것인지는 오너가 확인 창에서 고른다.
 * ⛔ 상대 사업자번호가 없으면 아무것도 고르지 않는다 — 「모르는 상대」를 이 캠페인 것으로 넘기지 않는다.
 */
export function findInvoiceCandidates(input: {
  mails: readonly InvoiceMailSummary[];
  direction: InvoiceDirection;
  ourBusinessNumber: string;
  counterpartBusinessNumber: string | null;
  /** 이미 어떤 캠페인에든 기록됐거나 이 단위에서 「이 메일이 아님」으로 뺀 승인번호 */
  excludedIssueIds: ReadonlySet<string>;
}): { candidatesByMonth: Map<string, InvoiceMailSummary[]>; amendmentsByMonth: Map<string, InvoiceMailSummary[]> } {
  const candidatesByMonth = new Map<string, InvoiceMailSummary[]>();
  const amendmentsByMonth = new Map<string, InvoiceMailSummary[]>();
  const ours = digits(input.ourBusinessNumber);
  const counterpart = digits(input.counterpartBusinessNumber);
  if (!counterpart || !ours) return { candidatesByMonth, amendmentsByMonth };

  const seen = new Set<string>();
  for (const mail of input.mails) {
    if (!mail.writtenDate || !isValidYearMonth(mail.writtenDate.slice(0, 7))) continue;
    const invoicer = digits(mail.invoicerBusinessNumber);
    const invoicee = digits(mail.invoiceeBusinessNumber);
    const matchesDirection =
      input.direction === "ISSUE"
        ? invoicer === ours && invoicee === counterpart
        : invoicer === counterpart && invoicee === ours;
    if (!matchesDirection) continue;
    if (mail.issueId) {
      if (input.excludedIssueIds.has(mail.issueId) || seen.has(mail.issueId)) continue;
      seen.add(mail.issueId);
    }
    const ym = mail.writtenDate.slice(0, 7);
    const target =
      mail.typeCode === VERIFIED_TYPE_CODE
        ? candidatesByMonth
        : mail.typeCode === CORRECTIVE_TYPE_CODE
          ? amendmentsByMonth
          : null;
    // 확인되지 않은 종류 코드는 고르지 않는다(통과시키지 않는다 — receipt-match 와 같은 규칙).
    if (!target) continue;
    const list = target.get(ym);
    if (list) list.push(mail);
    else target.set(ym, [mail]);
  }
  return { candidatesByMonth, amendmentsByMonth };
}

/**
 * 월정산 발급 관례: 작성일 = 그 달 말일, 실제 발급(메일 수신) = 다음 달 초. 메일 조회 시작일이
 * 다음 달 10일보다 늦으면 그 달의 발급 메일은 조회 범위 앞에 있었을 수 있다 → 「조회불가」.
 */
function issuanceMailExpectedBy(yearMonth: string): string {
  return `${nextYearMonth(yearMonth)}-10`;
}

/**
 * 기록한 계산서들이 캠페인 전액을 이미 담았는가(오너 확정 2026-10-14) — 월정산 거래처여도 발행된
 * 계산서의 금액 합계가 단위 전액(`resolveSupplierInvoiceUnitTotal`, 세무 보드와 같은 금액)과
 * ±`INVOICE_AMOUNT_TOLERANCE_WON` 안에서 맞으면 달을 나누지 않고 한 번에 끊은 것이다. 그러면 기록이
 * 없는 나머지 달도 끝난 달이다(COVERED).
 *
 * 판단 근거는 **계산서에 적힌 금액**이다(날짜 기입은 사후 조치 — 오너). 금액을 모르는 기록이 하나라도
 * 있거나 전액을 모르면(null) 판단하지 않는다(종전 동작 그대로).
 */
export function isFullAmountCovered(
  rows: readonly CampaignInvoiceRow[],
  expectedTotalAmount: number | null | undefined,
): boolean {
  if (expectedTotalAmount == null || !(expectedTotalAmount > 0)) return false;
  const recorded = rows.filter((row) => row.status === "RECORDED");
  if (recorded.length === 0) return false;
  let sum = 0;
  for (const row of recorded) {
    if (row.totalAmount === null) return false;
    sum += row.totalAmount;
  }
  return Math.abs(sum - expectedTotalAmount) <= INVOICE_AMOUNT_TOLERANCE_WON;
}

/** 기록한 계산서 합계 — 금액을 모르는 기록이 하나라도 있으면 null(판단하지 않는다). */
export function sumRecordedInvoiceTotal(rows: readonly CampaignInvoiceRow[]): number | null {
  let sum = 0;
  for (const row of rows) {
    if (row.status !== "RECORDED") continue;
    if (row.totalAmount === null) return null;
    sum += row.totalAmount;
  }
  return sum;
}

/**
 * 「조금 어긋남」과 「나눠 끊었을 수 있음」의 경계 — 전액 대비 비율(오너 확정 2026-10-14, 기본 5%).
 * 허용오차(`INVOICE_AMOUNT_TOLERANCE_WON`)는 넘고 이 비율 이내면 정산 오류 가능성, 넘으면(달을 넘는 캠페인에서
 * 계산서가 전액보다 적을 때) 분할 발행 가능성이다. 조정할 수 있게 이름을 붙여 내보낸다.
 */
export const MINOR_DELTA_RATIO = 0.05;

/** 전액과 어긋난 계산서의 세 모양 — 달 상태 이름과 같다. */
export type RecordedMismatchKind = "MINOR_MISMATCH" | "OVER_EXPECTED" | "POSSIBLE_SPLIT";

/**
 * 차이(계산서 − 전액, 허용오차 밖)를 세 모양으로 가른다. 비율 이내면 오류 가능성, 크면 부호로 —
 * 많으면 다른 건이 섞였거나 기대액 오류, 적으면(달을 넘는 캠페인만) 나눠 끊었을 수 있다.
 * 한 달짜리 캠페인은 나눠 끊을 달이 없어 적어도 오류 가능성이다.
 */
export function classifyAmountDelta(delta: number, expected: number, crossesMonth: boolean): RecordedMismatchKind {
  if (Math.abs(delta) <= expected * MINOR_DELTA_RATIO) return "MINOR_MISMATCH";
  if (delta > 0) return "OVER_EXPECTED";
  return crossesMonth ? "POSSIBLE_SPLIT" : "MINOR_MISMATCH";
}

export type RecordedMismatch = { kind: RecordedMismatchKind; delta: number };

/**
 * 달은 전부 끝났는데(기록 또는 「없음」) 기록한 계산서 합계가 전액과 허용오차 밖으로 어긋나는가(오너 규칙
 * 2026-10-14 「원인 확인 필요」 — 실렌더 지적 R0: 기록된 장이 어긋나면 n/m 이 깨끗한 완료로 읽혔다).
 * 완료 게이트는 막지 않는다(검토 신호이지 잠금이 아니다 — 오너). 열린 달이 남아 있으면 그 달의 상태가
 * 신호를 나르므로 여기서는 null. 기록이 한 장도 없으면(전부 「없음」) 어긋남이 아니다.
 */
export function judgeRecordedMismatch(input: {
  periodMonths: readonly string[];
  rows: readonly CampaignInvoiceRow[];
  expectedTotalAmount: number | null | undefined;
}): RecordedMismatch | null {
  const expected = input.expectedTotalAmount;
  if (expected == null || !(expected > 0)) return null;
  const live = input.rows.filter((row) => row.status !== "DISMISSED");
  const recorded = live.filter((row) => row.status === "RECORDED");
  if (recorded.length === 0) return null;
  const sum = sumRecordedInvoiceTotal(live);
  if (sum === null) return null;
  const months = new Set(input.periodMonths);
  for (const row of live) months.add(row.yearMonth);
  const allClosed = [...months].every((ym) => live.some((row) => row.yearMonth === ym));
  if (!allClosed) return null;
  const delta = sum - expected;
  if (Math.abs(delta) <= INVOICE_AMOUNT_TOLERANCE_WON) return null;
  return { kind: classifyAmountDelta(delta, expected, input.periodMonths.length > 1), delta };
}

/**
 * 정산서 없이 계산서만으로 본 단위 판정(오너 확정 2026-10-14 「계산서 발행 여부를 먼저 파악하고 계산서에
 * 기입된 내역으로 상태를 판단한다」).
 * - NONE: 판단할 재료가 없다(전액을 모름·기록 금액을 모름·아직 안 끝난 달에 계산서 후보가 없음)
 * - MATCH: 기록한 계산서 + 후보 계산서 합계가 전액과 ±99원 — 한 번(또는 계산서들이 스스로 보인 분할)으로 끝
 * - STATEMENT_EXPLAINED: 정산서가 그 계산서들을 설명한다 — 정산서 경로(달별)에 맡긴다
 * - MINOR_MISMATCH / OVER_EXPECTED / POSSIBLE_SPLIT: 후보 한 장이 어긋난다(달 상태와 같은 이름)
 * - AMBIGUOUS: 후보가 여러 장인데 합계가 전액과 안 맞는다 — 어느 장인지 오너가 고른다(종전 그대로)
 */
export type FullAmountVerdict =
  | { kind: "NONE" }
  | { kind: "MATCH"; mails: InvoiceMailSummary[]; delta: number }
  | { kind: "STATEMENT_EXPLAINED" }
  | { kind: "MINOR_MISMATCH" | "OVER_EXPECTED" | "POSSIBLE_SPLIT"; mail: InvoiceMailSummary; delta: number }
  | { kind: "AMBIGUOUS" };

/**
 * 판정 순서: 0) 캠페인 기간이 달을 넘는가(넘지 않으면 계산서 한 장이 정상이라 어긋남은 늘 「오류 가능성」)
 * 1) 기록 + 후보 합계 ≈ 전액 → MATCH 2) 정산서가 설명하면 정산서 경로 3) 후보 한 장의 차이를 비율로 가른다.
 * 후보는 받을 수 있는 달(`isAcceptableInvoiceMonth`) 중 아직 끝나지 않은 달의 일반(0101) 계산서다.
 */
export function judgeFullAmount(input: {
  /** 캠페인(그룹 포락선) 기간의 달 — `listYearMonths` */
  periodMonths: readonly string[];
  /** 이미 기록·「없음」인 달 */
  closedMonths: ReadonlySet<string>;
  expectedTotalAmount: number | null | undefined;
  /** 기록한 계산서 합계(`sumRecordedInvoiceTotal`) — null = 금액 모르는 기록이 있다 */
  recordedTotalAmount: number | null;
  candidatesByMonth: ReadonlyMap<string, readonly InvoiceMailSummary[]>;
  expectationsByMonth?: ReadonlyMap<string, readonly StatementExpectation[]>;
}): FullAmountVerdict {
  const expected = input.expectedTotalAmount;
  if (expected == null || !(expected > 0) || input.recordedTotalAmount === null) return { kind: "NONE" };
  const pool: InvoiceMailSummary[] = [];
  for (const [yearMonth, mails] of input.candidatesByMonth) {
    if (input.closedMonths.has(yearMonth) || !isAcceptableInvoiceMonth(input.periodMonths, yearMonth)) continue;
    pool.push(...mails.filter((mail) => mail.issueId && mail.writtenDate));
  }
  if (pool.length === 0) return { kind: "NONE" };
  if (pool.some((mail) => mail.totalAmount === null)) return { kind: "AMBIGUOUS" };
  const poolTotal = pool.reduce((sum, mail) => sum + (mail.totalAmount as number), 0);
  const delta = input.recordedTotalAmount + poolTotal - expected;
  if (Math.abs(delta) <= INVOICE_AMOUNT_TOLERANCE_WON) return { kind: "MATCH", mails: pool, delta };

  const expectations = input.expectationsByMonth ?? new Map<string, readonly StatementExpectation[]>();
  if (expectations.size > 0) {
    const everyMailExplained = pool.every((mail) =>
      matchesExpectedAmount(mail.totalAmount, expectations.get((mail.writtenDate as string).slice(0, 7)) ?? []),
    );
    const statementTotal = [...expectations.values()].flat().reduce((sum, item) => sum + item.totalAmount, 0);
    if (everyMailExplained || Math.abs(statementTotal - poolTotal) <= INVOICE_AMOUNT_TOLERANCE_WON) {
      return { kind: "STATEMENT_EXPLAINED" };
    }
  }
  if (pool.length > 1) return { kind: "AMBIGUOUS" };
  return { kind: classifyAmountDelta(delta, expected, input.periodMonths.length > 1), mail: pool[0], delta };
}

/**
 * 달별 줄을 만든다. 줄 = 기간에 걸친 달 ∪ 이미 기록된 행의 달(행은 사실이고 기간은 기대다 —
 * 캠페인 날짜를 줄여도 기록한 계산서가 화면에서 사라지지 않게).
 */
export function deriveInvoiceMonths(input: {
  periodStart: Date;
  periodEnd: Date;
  rows: readonly CampaignInvoiceRow[];
  candidatesByMonth: ReadonlyMap<string, readonly InvoiceMailSummary[]>;
  amendmentsByMonth: ReadonlyMap<string, readonly InvoiceMailSummary[]>;
  /** 메일함 조회 시작일(KST "YYYY-MM-DD"). null = 메일함을 못 읽었다. */
  scanSinceYmd: string | null;
  today: Date;
  /** 정산서 예상(T-242). 없으면 빈 목록 */
  expectationsByMonth?: ReadonlyMap<string, readonly StatementExpectation[]>;
  /** 단위 공급사 계산서 전액(원, 세무 보드와 같은 금액). null·생략 = 모름 → COVERED 판정 안 함 */
  expectedTotalAmount?: number | null;
  /** 전액이 수동 입력값에서 계산됐는가(`resolveSupplierInvoiceUnitTotal`) — 어긋남 달에 고정 풀이를 붙인다 */
  expectedFromManual?: boolean;
}): InvoiceMonth[] {
  const live = input.rows.filter((row) => row.status !== "DISMISSED");
  const covered = isFullAmountCovered(live, input.expectedTotalAmount);
  const periodMonths = listYearMonths(input.periodStart, input.periodEnd);
  const monthSet = new Set(periodMonths);
  for (const row of live) monthSet.add(row.yearMonth);
  const currentMonth = toKstYearMonth(input.today);
  // 정산서 없이 계산서만으로 본 판정 — 후보 한 장이 어긋나면 그 달을 「확인대기」 대신 어긋남으로 보인다.
  const verdict = covered
    ? ({ kind: "NONE" } as const)
    : judgeFullAmount({
        periodMonths,
        closedMonths: new Set(live.map((row) => row.yearMonth)),
        expectedTotalAmount: input.expectedTotalAmount,
        recordedTotalAmount: sumRecordedInvoiceTotal(live),
        candidatesByMonth: input.candidatesByMonth,
        expectationsByMonth: input.expectationsByMonth,
      });
  const reviewMonth =
    verdict.kind === "MINOR_MISMATCH" || verdict.kind === "OVER_EXPECTED" || verdict.kind === "POSSIBLE_SPLIT"
      ? { yearMonth: (verdict.mail.writtenDate as string).slice(0, 7), state: verdict.kind }
      : null;
  // 달은 다 끝났는데 기록한 금액이 어긋난다 — 기록이 있는 달마다 표시(작성일은 그대로, 낱말·색만 바뀐다).
  const recordedMismatch = judgeRecordedMismatch({ periodMonths, rows: live, expectedTotalAmount: input.expectedTotalAmount });
  const handledIssueIds = new Set(
    input.rows.map((row) => row.approvalNo).filter((value): value is string => Boolean(value)),
  );

  return [...monthSet].sort().map((yearMonth) => {
    const recorded = live.filter((row) => row.yearMonth === yearMonth && row.status === "RECORDED");
    const waived = live.find((row) => row.yearMonth === yearMonth && row.status === "WAIVED") ?? null;
    const candidates = [...(input.candidatesByMonth.get(yearMonth) ?? [])];
    const amendments = (input.amendmentsByMonth.get(yearMonth) ?? []).filter(
      (mail) => !mail.issueId || !handledIssueIds.has(mail.issueId),
    );

    let state: InvoiceMonthState;
    if (recorded.length > 0) state = amendments.length > 0 ? "AMENDED" : "RECORDED";
    else if (waived) state = "WAIVED";
    // 한 번에 끊어 닫힌 달에 수정세금계산서가 따라왔으면 끝으로 두지 않는다(화면 전용 — 게이트는 메일을 모른다).
    else if (covered) state = amendments.length > 0 ? "AMENDED" : "COVERED";
    else if (reviewMonth?.yearMonth === yearMonth) state = reviewMonth.state;
    else if (candidates.length > 0) state = "PENDING";
    else if (yearMonth >= currentMonth) state = "NOT_DUE";
    else if (input.scanSinceYmd === null || issuanceMailExpectedBy(yearMonth) < input.scanSinceYmd)
      state = "OUT_OF_SCAN";
    else state = "NOT_FOUND";

    const expected = [...(input.expectationsByMonth?.get(yearMonth) ?? [])];
    const mismatch = recorded.length > 0 && recordedMismatch ? recordedMismatch.kind : null;
    const reviewKind = mismatch ?? (state === "MINOR_MISMATCH" || state === "OVER_EXPECTED" ? state : null);
    const notes: InvoiceMonthNote[] =
      input.expectedFromManual && (reviewKind === "MINOR_MISMATCH" || reviewKind === "OVER_EXPECTED") ? ["EXPECTED_FROM_MANUAL"] : [];
    return { yearMonth, state, recorded, waived, candidates, amendments, expected, notes, mismatch };
  });
}

/**
 * 단위의 달별 기록 진행 — 「끝난 달」 = RECORDED 또는 WAIVED 행이 있는 달, 그리고 기록한 계산서 합계가
 * 단위 전액과 맞으면(`isFullAmountCovered`) 나머지 달 전부.
 */
export type InvoiceProgress = {
  done: number;
  total: number;
  openMonths: string[];
  /**
   * 달은 다 끝났는데 기록한 계산서 합계가 전액과 어긋난다(`judgeRecordedMismatch`) — 세무 보드 행은 남기고
   * 봇·크론은 이유 코드로 보인다. 완료 게이트는 이 값을 보지 않는다(검토 신호 — 오너).
   */
  review: { reason: RecordedMismatchKind; label: string } | null;
};

/**
 * 완료 판정에 쓰는 요약 — 메일 후보와 무관하게 **저장된 행만으로** 정해진다(서버 게이트가 메일을
 * 읽지 않아도 같은 답을 내야 한다). 수정세금계산서 확인 여부는 메일을 봐야 알므로 화면 쪽
 * `deriveInvoiceMonths` 의 AMENDED 로만 드러난다.
 */
export function summarizeInvoiceRows(input: {
  periodStart: Date;
  periodEnd: Date;
  rows: readonly CampaignInvoiceRow[];
  /** 단위 공급사 계산서 전액(원). null·생략 = 모름 → 전액 판정 안 함 */
  expectedTotalAmount?: number | null;
}): InvoiceProgress {
  const live = input.rows.filter((row) => row.status !== "DISMISSED");
  const monthSet = new Set(listYearMonths(input.periodStart, input.periodEnd));
  for (const row of live) monthSet.add(row.yearMonth);
  const months = [...monthSet].sort();
  const covered = isFullAmountCovered(live, input.expectedTotalAmount);
  const openMonths = covered
    ? []
    : months.filter(
        (ym) => !live.some((row) => row.yearMonth === ym && (row.status === "RECORDED" || row.status === "WAIVED")),
      );
  const mismatch = judgeRecordedMismatch({ periodMonths: listYearMonths(input.periodStart, input.periodEnd), rows: live, expectedTotalAmount: input.expectedTotalAmount });
  return {
    done: months.length - openMonths.length,
    total: months.length,
    openMonths,
    review: mismatch ? { reason: mismatch.kind, label: AUTO_RECORD_REVIEW_LABEL[mismatch.kind] } : null,
  };
}

/**
 * 월정산 공급사 계산서 날짜를 단일 날짜 경로(체크리스트·캠페인 수정·수취 승인)로 쓰려 할 때의 거절 문구.
 * 세 경로가 같은 문장을 써야 오너가 어디서 막혀도 같은 곳(달별 계산서 창)으로 간다(T-244·T-248).
 */
export const MONTHLY_INVOICE_MANAGED_MESSAGE =
  "월정산 거래처의 공급사 계산서는 캠페인 상세 계산서 칸의 「조회」에서 달별로 기록합니다.";

/** 완료를 막을 때 오너에게 보일 문구(토스트·409 응답). */
export function buildInvoiceIncompleteMessage(openMonths: readonly string[]): string {
  const label = openMonths.map(formatInvoiceMonth).join("·");
  return `공급사 계산서가 아직 다 기록되지 않아 정산 완료로 바꿀 수 없습니다(${label}분).`;
}

/**
 * 레거시 날짜 롤업 값 — **모든 달이 끝났을 때만** 기록된 작성일 중 가장 늦은 날을 준다.
 * 호출부는 캠페인(그룹) 날짜가 비어 있을 때만 쓴다(⛔ 절대 지우지 않는다 — 크론 선례와 같은
 * 「비어 있을 때만 쓰기」, 반대 검토 2026-10-08 BLOCKER 2).
 */
export function resolveLegacyInvoiceDate(input: {
  periodStart: Date;
  periodEnd: Date;
  rows: readonly CampaignInvoiceRow[];
  /** `summarizeInvoiceRows` 와 같은 값 — 한 번에 끊은 단위도 그 작성일로 롤업된다 */
  expectedTotalAmount?: number | null;
}): string | null {
  const summary = summarizeInvoiceRows(input);
  if (summary.total === 0 || summary.openMonths.length > 0) return null;
  const dates = input.rows
    .filter((row) => row.status === "RECORDED" && row.writtenAt)
    .map((row) => row.writtenAt as string)
    .sort();
  return dates.at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// 정산서 대조 · 자동 기록 판정 (T-242)
// ---------------------------------------------------------------------------

/**
 * 정산서가 이 단위·이 달에 예고한 계산서 — 화면은 「예상 금액」으로 미리 보이고, 자동 기록은
 * 메일 계산서의 금액이 이것과 맞을 때만 쓴다. ⛔ 기록의 근거는 아니다(근거는 발급 메일의 승인번호).
 */
export type StatementExpectation = {
  totalAmount: number;
  writtenDate: string;
  dueDate: string | null;
  promotionLabel: string | null;
  receivedAt: string;
};

/** 정산서 메일 한 통의 요약 — `/api/settlement/brand-statements` 응답의 `statements[]` 모양. */
export type StatementMailSummary = {
  promotionLabel: string | null;
  /** 정산서를 보낸 브랜드 표기(`brand-statement.ts`) — 못 읽었으면 null 이고 그 정산서는 대조하지 않는다 */
  counterpartyLabel: string | null;
  subject: string;
  receivedAt: string;
  invoices: ReadonlyArray<{
    direction: InvoiceDirection | null;
    writtenDate: string;
    yearMonth: string;
    totalAmount: number;
    dueDate: string | null;
  }>;
};

/**
 * 「정산 원 단위 절사」 허용오차(오너 확정 99원). 수취 판정과 같은 숫자를 쓴다 —
 * 정본은 `tax-invoice-mail/receipt-match.ts` 의 `SUB_HUNDRED_TRUNCATION_TOLERANCE_WON`.
 */
export const INVOICE_AMOUNT_TOLERANCE_WON = SUB_HUNDRED_TRUNCATION_TOLERANCE_WON;

/** 한글 이름은 두 글자부터, 그 밖(영문 핸들 등)은 세 글자부터 대조에 쓴다 — 짧으면 우연히 겹친다. */
function isUsableLabel(needle: string): boolean {
  return /[가-힣]/.test(needle) ? needle.length >= 2 : needle.length >= 3;
}

/**
 * 정산서가 이 셀러 것인가 — 프로모션명·제목에 단위의 셀러 이름(별칭)이 들어 있는가.
 * 브랜드는 프로모션(= 셀러 × 회차)마다 정산서를 따로 보내고 제목·프로모션명에 셀러 이름을 적는다
 * (메일함 실측 2026-10-08).
 */
export function statementMentionsUnit(statement: Pick<StatementMailSummary, "promotionLabel" | "subject">, labels: readonly string[]): boolean {
  const text = normalizeForCompare(`${statement.promotionLabel ?? ""} ${statement.subject}`);
  return labels.some((label) => {
    const needle = normalizeForCompare(label);
    return isUsableLabel(needle) && text.includes(needle);
  });
}

/**
 * 정산서를 보낸 브랜드가 이 단위의 거래처인가. 같은 셀러가 여러 브랜드와 공구하므로 셀러 이름만으로는
 * 남의 정산서가 붙는다(코드 리뷰 2026-10-09). 표기 차이(「(주)」 등)를 견디게 한쪽이 다른 쪽을 품으면
 * 같다고 본다. 어느 쪽이든 비면 같지 않다(모르는 브랜드를 이 거래처로 넘기지 않는다).
 */
export function statementFromCounterpart(statement: Pick<StatementMailSummary, "counterpartyLabel">, counterpartLabel: string): boolean {
  const brand = normalizeForCompare(statement.counterpartyLabel ?? "");
  const partner = normalizeForCompare(counterpartLabel);
  if (!brand || !partner) return false;
  return brand.includes(partner) || partner.includes(brand);
}

/**
 * 이 단위의 달별 예상 계산서. 같은 정산서가 두 번 와도(재발송) 한 번만 센다.
 * `otherUnitsLabels` 를 주면 **다른 단위에도 해당하는 정산서는 뺀다**(어느 쪽 것인지 모르므로).
 */
export function collectStatementExpectations(input: {
  statements: readonly StatementMailSummary[];
  direction: InvoiceDirection;
  labels: readonly string[];
  /** 이 단위의 거래처 이름 — 정산서를 보낸 브랜드와 같아야 한다 */
  counterpartLabel: string;
  otherUnitsLabels?: ReadonlyArray<readonly string[]>;
}): Map<string, StatementExpectation[]> {
  const byMonth = new Map<string, StatementExpectation[]>();
  const seen = new Set<string>();
  for (const statement of input.statements) {
    if (!statementFromCounterpart(statement, input.counterpartLabel)) continue;
    if (!statementMentionsUnit(statement, input.labels)) continue;
    if ((input.otherUnitsLabels ?? []).some((labels) => statementMentionsUnit(statement, labels))) continue;
    for (const invoice of statement.invoices) {
      if (invoice.direction !== input.direction || !isValidYearMonth(invoice.yearMonth)) continue;
      const key = `${invoice.yearMonth}|${invoice.writtenDate}|${invoice.totalAmount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const list = byMonth.get(invoice.yearMonth) ?? [];
      list.push({
        totalAmount: invoice.totalAmount,
        writtenDate: invoice.writtenDate,
        dueDate: invoice.dueDate,
        promotionLabel: statement.promotionLabel,
        receivedAt: statement.receivedAt,
      });
      byMonth.set(invoice.yearMonth, list);
    }
  }
  return byMonth;
}

/** 메일 계산서 금액이 정산서 예상 금액 중 하나와 허용오차 안에서 맞는가. */
export function matchesExpectedAmount(totalAmount: number | null, expected: readonly StatementExpectation[]): boolean {
  if (totalAmount === null) return false;
  return expected.some((item) => Math.abs(item.totalAmount - totalAmount) <= INVOICE_AMOUNT_TOLERANCE_WON);
}

/** 자동 기록 판정에 넣는 월정산 단위 하나(서버가 DB 에서 만든다). */
export type AutoRecordUnit = {
  /** 그룹 id 또는 캠페인 id */
  unitKey: string;
  /** 기록을 붙일 캠페인(그룹이면 id 오름차순 첫 멤버) */
  anchorCampaignId: string;
  direction: InvoiceDirection;
  counterpartBusinessNumber: string | null;
  /** 거래처 이름 — 정산서 브랜드 대조 키 */
  counterpartLabel: string;
  /** 아직 기록·「없음」이 없는 달 */
  openMonths: readonly string[];
  /** 셀러 별칭·이름 — 정산서 대조 키 */
  labels: readonly string[];
  /** 이 단위에서 「이 메일이 아님」으로 뺀 승인번호 */
  dismissedIssueIds: readonly string[];
  /** 단위 공급사 계산서 전액(`resolveSupplierInvoiceUnitTotal`). null = 모름 → 전액 판정 안 함 */
  expectedTotalAmount: number | null;
  /** 전액이 수동 입력값에서 계산됐는가 — 판정은 바꾸지 않고 오너 확인 건에 풀이만 붙인다 */
  expectedFromManual: boolean;
  /** 기록한 계산서 합계(`sumRecordedInvoiceTotal`). null = 금액 모르는 기록이 있다 */
  recordedTotalAmount: number | null;
  /** 캠페인(그룹 포락선) 기간의 달 — 달을 넘는가·받을 수 있는 달 판정 */
  periodMonths: readonly string[];
  /** 이미 기록·「없음」인 달 */
  closedMonths: readonly string[];
  /** 달은 다 끝났는데 기록한 합계가 전액과 어긋난다(`InvoiceProgress.review`) — 기록할 것은 없고 오너 확인만 */
  recordedMismatch: RecordedMismatchKind | null;
};

export type AutoRecordSkipReason =
  | "MULTIPLE_OPEN_SLOTS"
  | "NO_STATEMENT"
  | "MULTIPLE_STATEMENTS"
  | "AMENDMENT_PENDING"
  | "NO_AMOUNT_MATCH"
  | "AMBIGUOUS_AMOUNT"
  /** 정산서 없는 전액 판정 — 후보가 여러 장인데 합계가 안 맞거나, 같은 상대의 다른 단위가 같은 전액이거나, 한 달에 후보가 여러 장 */
  | "AMBIGUOUS_FULL_AMOUNT"
  /** 계산서 한 장이 전액과 조금 어긋난다 — 정산 오류 가능성 · 원인 확인 필요(오너) */
  | "MINOR_MISMATCH"
  /** 계산서가 전액보다 비율 이상 많다 — 다른 건 포함 또는 기대액 오류 가능(오너) */
  | "OVER_EXPECTED"
  /** 달을 넘는 캠페인의 계산서 한 장이 전액보다 많이 적다 — 분할 발행 가능성 · 정산 메일 미확인(오너) */
  | "POSSIBLE_SPLIT"
  /** 금액은 맞지만 작성일이 [기간 첫 달, 마지막 달 + 1] 밖이다(월말 마감 · 다음 달 초 발급 관례) */
  | "WRITTEN_DATE_IMPLAUSIBLE"
  /** 금액은 맞지만 품목명이 같은 상대의 다른 단위(셀러)를 지목한다 */
  | "LINE_ITEM_CONTRADICTS";

/** 오너가 봐야 하는 판정(자동 기록 안 함) — 크론 보고에 이유 코드만 싣는다 */
export type AutoRecordReviewReason = Extract<
  AutoRecordSkipReason,
  "MINOR_MISMATCH" | "OVER_EXPECTED" | "POSSIBLE_SPLIT" | "WRITTEN_DATE_IMPLAUSIBLE" | "LINE_ITEM_CONTRADICTS"
>;

const REVIEW_REASONS: ReadonlySet<AutoRecordSkipReason> = new Set<AutoRecordReviewReason>([
  "MINOR_MISMATCH",
  "OVER_EXPECTED",
  "POSSIBLE_SPLIT",
  "WRITTEN_DATE_IMPLAUSIBLE",
  "LINE_ITEM_CONTRADICTS",
]);

/** 오너 확인 이유 코드의 고정 낱말 — 크론 보고·봇 조회가 코드와 함께 이 낱말만 싣는다(금액·이름 없음). */
export const AUTO_RECORD_REVIEW_LABEL: Record<AutoRecordReviewReason, string> = {
  MINOR_MISMATCH: "정산 오류 가능성 · 원인 확인 필요",
  OVER_EXPECTED: "기대액 초과 · 다른 건 포함 또는 기대액 오류 가능",
  POSSIBLE_SPLIT: "분할 발행 가능성 · 정산 메일 미확인",
  WRITTEN_DATE_IMPLAUSIBLE: "작성일이 캠페인 기간과 맞지 않음",
  LINE_ITEM_CONTRADICTS: "품목명이 다른 셀러를 가리킴",
};

/**
 * 월정산 계산서 작성일의 그럴듯한 달 — [기간 첫 달, 마지막 달 + 1](월말 마감 · 다음 달 초 발급, 오너 확정
 * 2026-10-14). 자동 기록의 전액 판정에만 쓴다 — 오너 확인·직접 입력의 창(`isAcceptableInvoiceMonth`)은 그대로다.
 */
export function isPlausibleMonthlyWrittenMonth(periodMonths: readonly string[], yearMonth: string): boolean {
  if (periodMonths.length === 0) return false;
  return yearMonth >= periodMonths[0] && yearMonth <= nextYearMonth(periodMonths[periodMonths.length - 1]);
}

export type AutoRecordOp = {
  unitKey: string;
  campaignId: string;
  yearMonth: string;
  mail: InvoiceMailSummary;
  /** STATEMENT = 정산서 금액과 맞음(T-242) · FULL_AMOUNT = 정산서 없이 계산서 합계가 캠페인 전액과 맞음 */
  basis: "STATEMENT" | "FULL_AMOUNT";
  /** 대조 기준 금액 — 정산서 금액 또는 캠페인 전액 */
  expectedTotal: number;
  /** STATEMENT 면 그 정산서 예상, FULL_AMOUNT 면 null */
  expected: StatementExpectation | null;
  /** 메일 금액(전액 판정이면 기록+후보 합계) − 기준 금액(허용오차로 흡수한 차이). 0 이면 정확히 같다. */
  delta: number;
  /** 전액 판정이 여러 장의 합계로 맞았을 때 이 장의 순번(1부터)과 장수 — 한 장이면 null */
  split: { index: number; count: number } | null;
};

/**
 * **확인 없이 기록해도 되는가** — 발행(ISSUE) 방향만, 아래가 전부 성립할 때만 고른다(T-242,
 * 반대 검토 2026-10-08 3번 「자동 채움은 단일 칸 + 금액 ±99 만」).
 * ① 단일 칸: 같은 상대·같은 달에 비어 있는 월정산 칸이 이 단위 하나뿐이다.
 * ② 정산서: 이 단위에만 해당하는 정산서가 그 달 예상 금액을 정확히 한 개 말한다.
 * ③ 금액: 그 달 메일 계산서(일반 0101) 중 예상 금액 ±99원인 것이 정확히 한 장이다.
 * ④ 수정세금계산서(0201)가 그 달에 따라와 있지 않다.
 * 수취(RECEIVE)는 언제나 오너 1클릭이다(오너 확정 2026-08-12) — 여기서 고르지 않는다.
 * 같은 상대에게 같은 달 계산서가 여러 장 가는 것이 정상이라(프로모션마다 1장) ③이 핵심이다.
 *
 * 정산서가 이 단위에 하나도 없으면 계산서만으로 판정한다(`planFullAmount`, 오너 확정 2026-10-14) —
 * 계산서 합계가 캠페인 전액과 맞으면 기록하고(나머지 달은 COVERED 로 끝난다), 어긋나면 이유 코드로
 * 오너에게 넘긴다(`needsReview`).
 */
export function planAutoRecords(input: {
  units: readonly AutoRecordUnit[];
  mails: readonly InvoiceMailSummary[];
  statements: readonly StatementMailSummary[];
  ourBusinessNumber: string;
  /** 어느 캠페인에든 이미 기록된 승인번호 */
  recordedIssueIds: ReadonlySet<string>;
}): {
  ops: AutoRecordOp[];
  skipped: Array<{ unitKey: string; yearMonth: string; reason: AutoRecordSkipReason }>;
  /** 오너가 원인을 봐야 하는 건 — 이유 코드와 캠페인·달만(금액·이름 없음) */
  needsReview: AutoRecordReviewItem[];
} {
  const ops: AutoRecordOp[] = [];
  let skipped: Array<{ unitKey: string; yearMonth: string; reason: AutoRecordSkipReason }> = [];
  const needsReview: AutoRecordReviewItem[] = [];
  const issueUnits = input.units.filter((unit) => unit.direction === "ISSUE");

  for (const unit of issueUnits) {
    // 달은 다 끝났는데 기록한 합계가 어긋나는 단위 — 기록할 것은 없고 오너가 원인을 본다(R0).
    if (unit.recordedMismatch) {
      needsReview.push({
        unitKey: unit.unitKey,
        campaignId: unit.anchorCampaignId,
        yearMonth: [...unit.closedMonths].sort().at(-1) ?? unit.periodMonths[unit.periodMonths.length - 1],
        reason: unit.recordedMismatch,
        notes:
          unit.expectedFromManual && unit.recordedMismatch !== "POSSIBLE_SPLIT" ? ["EXPECTED_FROM_MANUAL"] : [],
      });
      continue;
    }
    const counterpart = digits(unit.counterpartBusinessNumber);
    const sameCounterpart = issueUnits.filter((other) => digits(other.counterpartBusinessNumber) === counterpart);
    const expectations = collectStatementExpectations({
      statements: input.statements,
      direction: "ISSUE",
      labels: unit.labels,
      counterpartLabel: unit.counterpartLabel,
      otherUnitsLabels: sameCounterpart.filter((other) => other.unitKey !== unit.unitKey).map((other) => other.labels),
    });
    const { candidatesByMonth, amendmentsByMonth } = findInvoiceCandidates({
      mails: input.mails,
      direction: "ISSUE",
      ourBusinessNumber: input.ourBusinessNumber,
      counterpartBusinessNumber: unit.counterpartBusinessNumber,
      excludedIssueIds: new Set([...input.recordedIssueIds, ...unit.dismissedIssueIds]),
    });

    for (const yearMonth of unit.openMonths) {
      const skip = (reason: AutoRecordSkipReason) => skipped.push({ unitKey: unit.unitKey, yearMonth, reason });
      if (sameCounterpart.filter((other) => other.openMonths.includes(yearMonth)).length !== 1) {
        skip("MULTIPLE_OPEN_SLOTS");
        continue;
      }
      const expected = expectations.get(yearMonth) ?? [];
      if (expected.length === 0) {
        skip("NO_STATEMENT");
        continue;
      }
      if (expected.length > 1) {
        skip("MULTIPLE_STATEMENTS");
        continue;
      }
      if ((amendmentsByMonth.get(yearMonth) ?? []).length > 0) {
        skip("AMENDMENT_PENDING");
        continue;
      }
      const matching = (candidatesByMonth.get(yearMonth) ?? []).filter(
        (mail) => mail.issueId && mail.writtenDate && matchesExpectedAmount(mail.totalAmount, expected),
      );
      if (matching.length === 0) {
        skip("NO_AMOUNT_MATCH");
        continue;
      }
      if (matching.length > 1) {
        skip("AMBIGUOUS_AMOUNT");
        continue;
      }
      const mail = matching[0];
      ops.push({
        unitKey: unit.unitKey,
        campaignId: unit.anchorCampaignId,
        yearMonth,
        mail,
        basis: "STATEMENT",
        expectedTotal: expected[0].totalAmount,
        expected: expected[0],
        delta: (mail.totalAmount as number) - expected[0].totalAmount,
        split: null,
      });
    }

    // 정산서가 이 단위에 하나라도 있으면 정산서 경로가 정본이다(오너 규칙 3). 전액 판정은 정산서가 없을 때만.
    if (expectations.size > 0 || ops.some((op) => op.unitKey === unit.unitKey)) continue;
    const fullAmount = planFullAmount({
      unit,
      sameCounterpart,
      candidatesByMonth,
      amendmentsByMonth,
    });
    if (fullAmount.kind === "none") continue;
    // 이 단위의 달별 「정산서 없음」 등은 전액 판정이 대신 답한다 — 같은 달을 두 이유로 세지 않는다.
    skipped = skipped.filter((item) => item.unitKey !== unit.unitKey);
    if (fullAmount.kind === "ops") {
      ops.push(...fullAmount.ops);
      continue;
    }
    skipped.push({ unitKey: unit.unitKey, yearMonth: fullAmount.yearMonth, reason: fullAmount.reason });
    if (REVIEW_REASONS.has(fullAmount.reason)) {
      const reason = fullAmount.reason as AutoRecordReviewReason;
      needsReview.push({
        unitKey: unit.unitKey,
        campaignId: unit.anchorCampaignId,
        yearMonth: fullAmount.yearMonth,
        reason,
        notes:
          unit.expectedFromManual && (reason === "MINOR_MISMATCH" || reason === "OVER_EXPECTED")
            ? ["EXPECTED_FROM_MANUAL"]
            : [],
      });
    }
  }
  const resolved = dropContestedOps(ops);
  skipped.push(...resolved.skipped);
  return { ops: resolved.ops, skipped, needsReview };
}

/**
 * 같은 승인번호를 두 단위가 집었으면 둘 다 놓는다 — 어느 쪽 것인지 모른다(계획 단계 충돌, M1).
 * 단위별 판정(쌍둥이 전액·남은 금액·품목명)이 대부분 먼저 거르지만, 그 판정은 단위 하나의 시야라
 * 계획 전체를 한 번 더 본다. 놓은 단위는 `AMBIGUOUS_FULL_AMOUNT` 로 센다.
 */
export function dropContestedOps(ops: readonly AutoRecordOp[]): {
  ops: AutoRecordOp[];
  skipped: Array<{ unitKey: string; yearMonth: string; reason: AutoRecordSkipReason }>;
} {
  const claimants = new Map<string, Set<string>>();
  for (const op of ops) {
    const key = op.mail.issueId as string;
    claimants.set(key, (claimants.get(key) ?? new Set()).add(op.unitKey));
  }
  const contested = new Set(ops.filter((op) => (claimants.get(op.mail.issueId as string)?.size ?? 0) > 1).map((op) => op.unitKey));
  const skipped: Array<{ unitKey: string; yearMonth: string; reason: AutoRecordSkipReason }> = [];
  for (const unitKey of contested) {
    const first = ops.find((op) => op.unitKey === unitKey) as AutoRecordOp;
    skipped.push({ unitKey, yearMonth: first.yearMonth, reason: "AMBIGUOUS_FULL_AMOUNT" });
  }
  return { ops: ops.filter((op) => !contested.has(op.unitKey)), skipped };
}

/** 오너 확인 건 한 줄 — 이유 코드·고정 풀이 코드와 캠페인·달만(금액·이름 없음). */
export type AutoRecordReviewItem = {
  unitKey: string;
  campaignId: string;
  yearMonth: string;
  reason: AutoRecordReviewReason;
  notes: InvoiceMonthNote[];
};

/** 메일 요약의 품목명(줄 이름을 「 · 」로 이은 것)을 대조 덩어리로 — 줄 경계를 살린다. */
function mailLineItemHaystack(mail: InvoiceMailSummary): string {
  return lineItemNamesHaystack((mail.itemName ?? "").split(" · "));
}

/**
 * 정산서 없는 단위의 전액 판정 → 자동 기록 계획(오너 확정 2026-10-14). `judgeFullAmount` 가 MATCH 여도
 * 아래가 전부 성립할 때만 쓴다(기존 안전 규칙과 같은 결):
 * ① 그 창(받을 수 있는 달)에 수정세금계산서가 없다 ② 작성일이 [기간 첫 달, 마지막 달 + 1] 안이다
 * ③ 품목명이 같은 상대의 다른 단위를 지목하지 않는다(발행 자동 확정과 같은 품목명 대조 —
 *    `line-item-label-match.ts`) ④ 같은 상대의 다른 단위가 같은 전액(±99원)이면 품목명이 이 단위를
 *    지목할 때만 ⑤ 후보가 있는 달마다 한 장뿐이다. 어긋남은 기록하지 않고 오너에게 넘긴다.
 */
function planFullAmount(input: {
  unit: AutoRecordUnit;
  sameCounterpart: readonly AutoRecordUnit[];
  candidatesByMonth: ReadonlyMap<string, readonly InvoiceMailSummary[]>;
  amendmentsByMonth: ReadonlyMap<string, readonly InvoiceMailSummary[]>;
}):
  | { kind: "none" }
  | { kind: "ops"; ops: AutoRecordOp[] }
  | { kind: "skip"; yearMonth: string; reason: AutoRecordSkipReason } {
  const { unit } = input;
  const closedMonths = new Set(unit.closedMonths);
  const verdict = judgeFullAmount({
    periodMonths: unit.periodMonths,
    closedMonths,
    expectedTotalAmount: unit.expectedTotalAmount,
    recordedTotalAmount: unit.recordedTotalAmount,
    candidatesByMonth: input.candidatesByMonth,
  });
  const firstOpen = unit.openMonths[0] ?? unit.periodMonths[0];
  if (verdict.kind === "NONE" || verdict.kind === "STATEMENT_EXPLAINED") return { kind: "none" };
  if (verdict.kind === "AMBIGUOUS") return { kind: "skip", yearMonth: firstOpen, reason: "AMBIGUOUS_FULL_AMOUNT" };
  if (verdict.kind !== "MATCH") {
    // MINOR_MISMATCH · OVER_EXPECTED · POSSIBLE_SPLIT — 기록하지 않고 오너에게(이유 코드 = 달 상태 이름)
    return { kind: "skip", yearMonth: (verdict.mail.writtenDate as string).slice(0, 7), reason: verdict.kind };
  }

  // 수정세금계산서는 **닫힌 달 것도** 본다 — 기록한 장을 고치는 수정분이 있으면 합계 자체가 바뀔 수 있다(M4).
  const amendmentPending = [...input.amendmentsByMonth].some(
    ([yearMonth, mails]) => mails.length > 0 && isAcceptableInvoiceMonth(unit.periodMonths, yearMonth),
  );
  if (amendmentPending) return { kind: "skip", yearMonth: firstOpen, reason: "AMENDMENT_PENDING" };
  const expected = unit.expectedTotalAmount as number;
  const months = verdict.mails.map((mail) => (mail.writtenDate as string).slice(0, 7));
  const implausible = months.find((yearMonth) => !isPlausibleMonthlyWrittenMonth(unit.periodMonths, yearMonth));
  if (implausible) return { kind: "skip", yearMonth: implausible, reason: "WRITTEN_DATE_IMPLAUSIBLE" };
  // 품목명이 지목한 단위(같은 상대 중 유일 최고 점수) — 다른 단위면 금액이 맞아도 기록하지 않는다.
  const picks = verdict.mails.map((mail) =>
    pickByLabelTokens(input.sameCounterpart, (other) => other.labels.join(" "), mailLineItemHaystack(mail)),
  );
  const contradicted = picks.findIndex((pick) => pick !== null && pick.unitKey !== unit.unitKey);
  if (contradicted >= 0) return { kind: "skip", yearMonth: months[contradicted], reason: "LINE_ITEM_CONTRADICTS" };
  // 같은 상대의 다른 단위가 같은 전액이거나, 그 단위의 **남은 금액**(전액 − 기록)이 이 계산서들의 합계와
  // 같으면 어느 쪽 것인지 모른다(M1) — 품목명이 이 단위를 지목할 때만 고른다.
  const poolTotal = verdict.mails.reduce((sum, mail) => sum + (mail.totalAmount as number), 0);
  const twin = input.sameCounterpart.some((other) => {
    if (other.unitKey === unit.unitKey || other.expectedTotalAmount === null) return false;
    const remaining = other.expectedTotalAmount - (other.recordedTotalAmount ?? 0);
    return (
      Math.abs(other.expectedTotalAmount - expected) <= INVOICE_AMOUNT_TOLERANCE_WON ||
      Math.abs(remaining - poolTotal) <= INVOICE_AMOUNT_TOLERANCE_WON
    );
  });
  const lineItemsNameThisUnit = picks.every((pick) => pick?.unitKey === unit.unitKey);
  if ((twin && !lineItemsNameThisUnit) || new Set(months).size !== months.length) {
    return { kind: "skip", yearMonth: months[0], reason: "AMBIGUOUS_FULL_AMOUNT" };
  }
  return {
    kind: "ops",
    ops: verdict.mails.map((mail, index) => ({
      unitKey: unit.unitKey,
      campaignId: unit.anchorCampaignId,
      yearMonth: months[index],
      mail,
      basis: "FULL_AMOUNT" as const,
      expectedTotal: expected,
      expected: null,
      delta: verdict.delta,
      split: verdict.mails.length > 1 ? { index: index + 1, count: verdict.mails.length } : null,
    })),
  };
}
