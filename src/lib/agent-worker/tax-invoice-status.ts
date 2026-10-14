/**
 * 봇(agent worker)의 `get_tax_invoice_status` 가 **밖으로 내보내는 모양**만 정하는 순수 모듈
 * (2026-10-14). DB 를 읽는 쪽은 `executor.ts` 와 `@/lib/tax-invoice-board-data`(오너 화면과 같은
 * 쿼리)이고, 여기는 받은 값을 허용 칸만 담은 **새 객체**로 옮긴다.
 *
 * 세 부분이다:
 *   1. lastRun — 발행 자동 확정 크론(`tax-invoice-issue-confirm`)의 마지막 실행(`SystemTaskLog`).
 *   2. pending — 정산 「세무 처리」 보드의 남은 의무(`buildTaxInvoiceWorkBoard` 의 행).
 *   3. autoConfirmed — 보드가 함께 보여 주는 최근 자동 확정(`buildAutoConfirmedEntries`).
 *
 * ⛔ 행을 펼쳐(`...row`) 넘기지 말 것 — 원본에 칸이 늘면 검토 없이 슬랙·클라우드 모델로 따라간다.
 * ⛔ 싣지 않는 것: 사업자등록번호·대표자명·이메일·주소·연락처·계좌(캠페인 행에 있어도), 계산서
 *    승인번호와 금액이 든 문장(크론 사유 `message` · 자동 확정 `detail`), 크론의 오류 문구
 *    (`SystemTaskLog.message` · `failureReason` — 접속 대상이 섞일 수 있다). 사유는 **코드와 고정 라벨**만.
 * ✅ 「확인 필요」 건의 `observed` 에서는 **금액 숫자 셋**(계산서 합계·정산 기대액·차이)만 옮긴다 — 그 객체는
 *    `issuance-match.ts` 의 `IssuanceVerdict.observed` 로 숫자와 작성일자뿐이고 승인번호가 없다. 금액 불일치
 *    건을 봇이 "○원 차이"까지 말하게 하려는 오너 승인(2026-10-14). 작성일자 등 다른 칸은 옮기지 않는다.
 */
import { AUTO_RECORD_REVIEW_LABEL } from "@/lib/campaign-invoices";
import type { CampaignRow } from "@/lib/crm-types";
import type { AutoConfirmedEntry } from "@/lib/tax-filing-auto-confirm";
import type { TaxInvoiceBoard, TaxInvoiceBoardRow } from "@/lib/tax-filing-board";
import type { IssuanceMismatchCode } from "@/lib/tax-invoice-mail/issuance-match";
import { MAX_TAX_INVOICE_AUTO_CONFIRMED_ROWS, MAX_TAX_INVOICE_PENDING_ROWS } from "./contracts";
import { buildBoundedSummary, flattenLineBreaks } from "./read-projections";

/** 크론의 `withSystemTaskStatus` 잡 이름 — 라우트(`api/cron/tax-invoice-issue-confirm`)와 같은 값. */
export const ISSUE_CONFIRM_JOB_KEY = "tax-invoice-issue-confirm";
/** 하루 한 번 도는 크론이다 — 하루 반이 지나도록 새 실행이 없으면 「낡았다」고 말한다. */
export const ISSUE_CONFIRM_STALE_HOURS = 36;
/** 크론이 상세를 싣는 「확인 필요」 건의 상한(크론 쪽 예산은 ~6건이지만 방어로 한 번 더 묶는다). */
const MAX_NEEDS_REVIEW_ITEMS = 20;
const MAX_LABEL_CHARS = 120;
const MAX_BLOCKING_REASONS = 10;
const MAX_CAMPAIGN_LABELS = 10;
const MAX_WARNINGS = 5;
const HOUR_MS = 60 * 60 * 1000;

/**
 * 발행 대조 사유 코드의 고정 라벨. 크론이 남기는 사유 **문장**은 승인번호·금액을 담을 수 있어
 * 싣지 않고, 코드를 이 라벨로 옮긴다. `Record<IssuanceMismatchCode, …>` 라 코드가 늘면 컴파일이 깨진다.
 */
const REASON_LABEL: Record<IssuanceMismatchCode, string> = {
  ALREADY_MARKED: "이미 발행 완료로 기록됨",
  GROUP_FELL_BACK: "정산 그룹이 캠페인별로 나뉨(수동 확인)",
  EXPECTED_AMOUNT_UNKNOWN: "기대 금액을 계산할 수 없음",
  INVOICE_AMOUNT_MISSING: "계산서 합계를 읽지 못함",
  AMOUNT_MISMATCH: "금액 불일치",
  AMOUNT_TOLERATED: "허용오차 안 금액 차이(흡수)",
  CORRECTIVE_DOCUMENT: "수정세금계산서(자동 대조 안 함)",
  UNVERIFIED_DOCUMENT_TYPE: "확인되지 않은 계산서 종류",
  WRITTEN_DATE_MISSING: "작성일자를 읽지 못함",
  WRITTEN_DATE_OUT_OF_RANGE: "작성일자가 타당 구간 밖",
  DUPLICATE_ISSUE: "같은 승인번호 중복 관측",
  ENCODING_UNTRUSTED: "인코딩 불신(품목명 신뢰 불가)",
};

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function label(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flat = flattenLineBreaks(value);
  return flat ? clip(flat, MAX_LABEL_CHARS) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function code(value: unknown): string | null {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : null;
}

// ---------------------------------------------------------------------------
// 1. lastRun
// ---------------------------------------------------------------------------

export type IssueConfirmRunRow = { status: string; details: unknown; createdAt: Date };

export type NeedsReviewView = {
  campaignLabel: string | null;
  counterpartLabel: string | null;
  channel: string | null;
  reasons: Array<{ code: string; label: string | null }>;
  /** 크론 `observed` 의 금액 숫자만. 셋 중 하나라도 숫자가 아니면 그 칸은 null. */
  amount: { invoiceTotal: number | null; expectedTotal: number | null; delta: number | null };
};

export type IssueConfirmRunView = {
  ranAt: string;
  /** SUCCESS → OK · ERROR → FAIL. 그 밖의 값은 UNKNOWN(지어내지 않는다). */
  status: "OK" | "FAIL" | "UNKNOWN";
  stale: boolean;
  ageHours: number;
  dryRun: boolean | null;
  /** REQUESTED(사람이 예행으로 부름) · TAX_INVOICE_AUTO_CONFIRM_NOT_SET(쓰기 스위치 꺼짐) · null */
  dryRunReason: string | null;
  scan: { parsedInvoices: number | null; truncated: number | null; windowFrom: string | null };
  counts: {
    expectedTotal: number | null;
    confirmed: number | null;
    needsReview: number | null;
    /** 메일과 맞고 이미 발행일이 찍힌 건(할 일 없음). 이 칸이 생기기 전 실행 기록에는 없다. */
    alreadyMatched: number | null;
    unseen: number | null;
    unmatchable: number | null;
    outOfScanRange: number | null;
    planned: number | null;
    applied: number | null;
    noop: number | null;
    droppedByCap: number | null;
  };
  /** 발행 확정 쓰기 실패 건수(`failures` 배열 길이). 기록에 없으면 null. */
  failuresCount: number | null;
  /** 크론이 실질 실패를 선언했는가(월정산 자동 기록 실패 포함). */
  failed: boolean;
  needsReviewDetail: NeedsReviewView[];
  /** 「확인 필요」 상세가 일부만 실렸다(크론 예산 · 저장 상한 · 이 투영의 상한 중 하나). */
  needsReviewDetailCapped: boolean;
  /** 저장부(`capDetailsForLog`)가 기록을 줄였다 — 빠진 칸이 있을 수 있다. */
  detailsTrimmed: boolean;
  /**
   * 월정산 계산서 자동 기록이 오너 확인으로 넘긴 건(2026-10-14) — 이유 코드별 개수와 고정 라벨만
   * (크론 `monthlyAutoRecord.needsReviewDetail`). 캠페인 id·금액은 옮기지 않는다.
   */
  monthlyReview: Array<{ code: string; label: string; count: number }>;
  /** 기록에 없어서 null 로 둔 칸 — 0 으로 지어내지 않는다. */
  missingFields: string[];
};

function parseMonthlyReview(value: unknown): IssueConfirmRunView["monthlyReview"] {
  const detail = asRecord(value)?.needsReviewDetail;
  if (!Array.isArray(detail)) return [];
  const counts = new Map<string, number>();
  for (const raw of detail) {
    const reason = code(asRecord(raw)?.reason);
    if (!reason || !(reason in AUTO_RECORD_REVIEW_LABEL)) continue;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts].map(([reason, count]) => ({
    code: reason,
    label: AUTO_RECORD_REVIEW_LABEL[reason as keyof typeof AUTO_RECORD_REVIEW_LABEL],
    count,
  }));
}

const COUNT_KEYS = [
  "expectedTotal",
  "confirmed",
  "needsReview",
  "alreadyMatched",
  "unseen",
  "unmatchable",
  "outOfScanRange",
  "planned",
  "applied",
  "noop",
  "droppedByCap",
] as const;

function toStatus(raw: string): IssueConfirmRunView["status"] {
  if (raw === "SUCCESS") return "OK";
  if (raw === "ERROR") return "FAIL";
  return "UNKNOWN";
}

function parseNeedsReview(value: unknown): { items: NeedsReviewView[]; overflow: boolean } {
  if (!Array.isArray(value)) return { items: [], overflow: false };
  const items: NeedsReviewView[] = [];
  for (const raw of value) {
    const row = asRecord(raw);
    if (!row) continue;
    const reasons = (Array.isArray(row.reasons) ? row.reasons : []).flatMap((reason) => {
      const reasonCode = code(asRecord(reason)?.code);
      if (!reasonCode) return [];
      return [{ code: reasonCode, label: (REASON_LABEL as Record<string, string>)[reasonCode] ?? null }];
    });
    const observed = asRecord(row.observed);
    const won = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    items.push({
      campaignLabel: label(row.campaignLabel),
      counterpartLabel: label(row.counterpartLabel),
      channel: code(row.channel),
      reasons,
      amount: {
        invoiceTotal: won(observed?.totalAmount),
        expectedTotal: won(observed?.expectedTotalAmount),
        delta: won(observed?.amountDelta),
      },
    });
  }
  return { items: items.slice(0, MAX_NEEDS_REVIEW_ITEMS), overflow: items.length > MAX_NEEDS_REVIEW_ITEMS };
}

/** `SystemTaskLog` 한 줄을 허용 칸만으로 옮긴다. 기록이 없으면 null(「돈 적이 없다」 또는 「권한 밖」). */
export function toIssueConfirmRunView(row: IssueConfirmRunRow | null, now: Date): IssueConfirmRunView | null {
  if (!row) return null;
  const details = asRecord(row.details) ?? {};
  const missingFields: string[] = [];
  const missing = <T>(name: string): T | null => {
    missingFields.push(name);
    return null;
  };
  const num = (value: unknown, name: string): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : missing<number>(name);
  const scan = asRecord(details.scan);
  if (!scan) missingFields.push("scan");
  const counts = Object.fromEntries(COUNT_KEYS.map((key) => [key, num(details[key], key)])) as IssueConfirmRunView["counts"];
  const failuresCount = Array.isArray(details.failures) ? details.failures.length : missing<number>("failures");
  const dryRun = typeof details.dryRun === "boolean" ? details.dryRun : missing<boolean>("dryRun");
  const review = parseNeedsReview(details.needsReviewDetail);
  const ageHours = Math.max(0, (now.getTime() - row.createdAt.getTime()) / HOUR_MS);
  return {
    ranAt: row.createdAt.toISOString(),
    status: toStatus(row.status),
    stale: ageHours > ISSUE_CONFIRM_STALE_HOURS,
    ageHours: Math.round(ageHours * 10) / 10,
    dryRun,
    dryRunReason: code(details.dryRunReason),
    scan: scan
      ? {
          parsedInvoices: num(scan.parsedInvoices, "scan.parsedInvoices"),
          truncated: num(scan.truncated, "scan.truncated"),
          windowFrom:
            typeof scan.windowFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(scan.windowFrom)
              ? scan.windowFrom
              : missing<string>("scan.windowFrom"),
        }
      : { parsedInvoices: null, truncated: null, windowFrom: null },
    counts,
    failuresCount,
    failed: details.failed === true,
    needsReviewDetail: review.items,
    needsReviewDetailCapped: details.needsReviewDetailCapped === true || review.overflow,
    detailsTrimmed: details.detailsTrimmed != null,
    monthlyReview: parseMonthlyReview(details.monthlyAutoRecord),
    missingFields,
  };
}

// ---------------------------------------------------------------------------
// 2. pending
// ---------------------------------------------------------------------------

export type TaxInvoicePendingView = {
  /** ISSUE = 우리가 발행 · RECEIVE = 상대가 발행(우리는 수취를 추적). */
  direction: TaxInvoiceBoardRow["direction"];
  directionLabel: "발행" | "수취";
  counterpart: TaxInvoiceBoardRow["counterpart"];
  section: TaxInvoiceBoardRow["section"];
  campaignLabel: string | null;
  dealName: string | null;
  sellerName: string | null;
  partnerName: string | null;
  amount: { supply: number; vat: number; total: number };
  /** false 면 결번(사업자 정보·금액 누락 등)이라 일괄 처리에서 빠진다 — 이유는 `blockingReasons`. */
  selectable: boolean;
  blockingReasons: string[];
  /** 월정산 공급사 행의 달별 기록 진행(n/m). 아니면 null. */
  monthlyInvoice: { done: number; total: number; review: { code: string; label: string } | null } | null;
  /** 참이면 금액이 캠페인 총액이라 실제 달별 계산서와 다르다(보드 합계에서도 뺀다). */
  monthlyInvoiceManaged: boolean;
  campaignId: string;
  campaignIds: string[];
  groupId: string | null;
};

const SECTION_ORDER: Record<TaxInvoiceBoardRow["section"], number> = { IN_PROGRESS: 0, BACKLOG: 1 };

export function toTaxInvoicePendingViews(
  rows: readonly TaxInvoiceBoardRow[],
  campaignRows: readonly CampaignRow[],
): TaxInvoicePendingView[] {
  const byId = new Map(campaignRows.map((row) => [row.id, row]));
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => SECTION_ORDER[left.row.section] - SECTION_ORDER[right.row.section] || left.index - right.index)
    .map(({ row }) => {
      const campaign = byId.get(row.campaignId);
      return {
        direction: row.direction,
        directionLabel: row.direction === "ISSUE" ? ("발행" as const) : ("수취" as const),
        counterpart: row.counterpart,
        section: row.section,
        campaignLabel: label(row.campaignLabel),
        dealName: label(campaign?.dealName),
        sellerName: label(campaign?.sellerName),
        partnerName: label(campaign?.partnerName),
        amount: {
          supply: row.amount.supplyAmount,
          vat: row.amount.taxAmount,
          total: row.amount.supplyAmount + row.amount.taxAmount,
        },
        selectable: row.selectable,
        blockingReasons: row.blockingReasons
          .slice(0, MAX_BLOCKING_REASONS)
          .flatMap((reason) => label(reason) ?? []),
        monthlyInvoice: row.monthlyInvoice
          ? {
              done: row.monthlyInvoice.done,
              total: row.monthlyInvoice.total,
              // 코드와 고정 라벨만 — 금액·승인번호는 없다(라벨 정본 `AUTO_RECORD_REVIEW_LABEL`).
              review: row.monthlyInvoice.review
                ? { code: row.monthlyInvoice.review.reason, label: row.monthlyInvoice.review.label }
                : null,
            }
          : null,
        monthlyInvoiceManaged: row.monthlyInvoiceManaged,
        campaignId: row.campaignId,
        campaignIds: [...row.campaignIds],
        groupId: row.groupId,
      };
    });
}

// ---------------------------------------------------------------------------
// 3. autoConfirmed
// ---------------------------------------------------------------------------

export type TaxInvoiceAutoConfirmedView = {
  confirmedAt: string;
  /** 기계가 찍은 계산서 작성일자(`YYYY-MM-DD`). 로그에 없으면 null. */
  writtenDate: string | null;
  field: AutoConfirmedEntry["sourceField"];
  fieldLabel: string;
  campaignLabels: string[];
  /** 허용오차(100원 미만 절삭)를 흡수해 확정한 건 — 완전 일치보다 오너가 볼 이유가 크다. */
  tolerated: boolean;
};

/** ⛔ `detail`(승인번호·장수·합계 문장)은 옮기지 않는다. */
export function toTaxInvoiceAutoConfirmedViews(entries: readonly AutoConfirmedEntry[]): TaxInvoiceAutoConfirmedView[] {
  return entries.map((entry) => ({
    confirmedAt: entry.confirmedAt,
    writtenDate: entry.writtenDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(entry.writtenDate) ? entry.writtenDate : null,
    field: entry.sourceField,
    fieldLabel: entry.fieldLabel,
    campaignLabels: entry.campaignLabels.slice(0, MAX_CAMPAIGN_LABELS).flatMap((name) => label(name) ?? []),
    tolerated: entry.tolerated,
  }));
}

// ---------------------------------------------------------------------------
// 요약 글 + 결재함 기록
// ---------------------------------------------------------------------------

export type TaxInvoiceStatusInput = {
  month: string;
  lastRun: IssueConfirmRunView | null;
  board: TaxInvoiceBoard;
  pending: readonly TaxInvoicePendingView[];
  autoConfirmed: readonly TaxInvoiceAutoConfirmedView[];
  autoConfirmWindowDays: number;
};

const n = (value: number | null) => (value === null ? "?" : String(value));

function formatReviewLine(item: NeedsReviewView): string {
  const reasons = item.reasons.map((reason) => (reason.label ? `${reason.code}(${reason.label})` : reason.code)).join(",");
  const { invoiceTotal, expectedTotal, delta } = item.amount;
  const amount =
    delta !== null ? ` invoiceTotal=${n(invoiceTotal)} expectedTotal=${n(expectedTotal)} delta=${delta}` : "";
  return `REVIEW ${item.campaignLabel ?? "(이름 없음)"} / ${item.counterpartLabel ?? "?"} [${item.channel ?? "?"}] reasons=${reasons || "none"}${amount}`;
}

function formatPendingLine(row: TaxInvoicePendingView): string {
  const blocked = row.selectable ? "" : ` blocked=${row.blockingReasons.join("·") || "?"}`;
  const monthly = row.monthlyInvoice
    ? ` monthly=${row.monthlyInvoice.done}/${row.monthlyInvoice.total}${row.monthlyInvoice.review ? ` monthlyReview=${row.monthlyInvoice.review.code}` : ""}`
    : row.monthlyInvoiceManaged
      ? " monthly=managed"
      : "";
  return `PENDING ${row.directionLabel} ${row.counterpart} [${row.section}] ${row.campaignLabel ?? "(이름 없음)"} deal=${row.dealName ?? "?"} seller=${row.sellerName ?? "?"} partner=${row.partnerName ?? "?"} supply=${row.amount.supply} vat=${row.amount.vat} total=${row.amount.total} selectable=${row.selectable ? "yes" : "no"}${blocked}${monthly}`;
}

function formatAutoLine(entry: TaxInvoiceAutoConfirmedView): string {
  return `AUTO ${entry.writtenDate ?? "?"} ${entry.fieldLabel} ${entry.campaignLabels.join(", ") || "?"} tolerated=${entry.tolerated ? "yes" : "no"} at=${entry.confirmedAt}`;
}

function formatRunHeader(run: IssueConfirmRunView | null): string {
  if (!run) return "lastRun=none";
  const c = run.counts;
  return [
    `lastRun=${run.ranAt}`,
    `runStatus=${run.status}`,
    `stale=${run.stale}`,
    `ageHours=${run.ageHours}`,
    `dryRun=${run.dryRun === null ? "?" : run.dryRun}`,
    `dryRunReason=${run.dryRunReason ?? "none"}`,
    `scanParsed=${n(run.scan.parsedInvoices)}`,
    `scanTruncated=${n(run.scan.truncated)}`,
    `scanFrom=${run.scan.windowFrom ?? "?"}`,
    `expected=${n(c.expectedTotal)}`,
    `confirmed=${n(c.confirmed)}`,
    `needsReview=${n(c.needsReview)}`,
    `alreadyMatched=${n(c.alreadyMatched)}`,
    `unseen=${n(c.unseen)}`,
    `unmatchable=${n(c.unmatchable)}`,
    `outOfScanRange=${n(c.outOfScanRange)}`,
    `applied=${n(c.applied)}`,
    `noop=${n(c.noop)}`,
    `failures=${n(run.failuresCount)}`,
    `failed=${run.failed}`,
    `detailsTrimmed=${run.detailsTrimmed}`,
    `monthlyReview=${run.monthlyReview.length > 0 ? run.monthlyReview.map((item) => `${item.code}:${item.count}`).join(",") : "none"}`,
    `missing=${run.missingFields.length > 0 ? run.missingFields.join(",") : "none"}`,
  ].join(" ");
}

export function buildTaxInvoiceStatus(input: TaxInvoiceStatusInput): {
  summary: string;
  structuredResult: Record<string, unknown>;
  evidenceCampaignIds: string[];
} {
  const pendingListed = input.pending.slice(0, MAX_TAX_INVOICE_PENDING_ROWS);
  const autoListed = input.autoConfirmed.slice(0, MAX_TAX_INVOICE_AUTO_CONFIRMED_ROWS);
  const review = input.lastRun?.needsReviewDetail ?? [];
  const lines = [...review.map(formatReviewLine), ...pendingListed.map(formatPendingLine), ...autoListed.map(formatAutoLine)];
  const board = input.board;
  const warnings = board.warnings.slice(0, MAX_WARNINGS).flatMap((warning) => label(warning) ?? []);
  const { summary } = buildBoundedSummary(
    (shown) =>
      `get_tax_invoice_status month=${input.month} ${formatRunHeader(input.lastRun)} pending=${input.pending.length} inProgress=${board.pendingCount} backlog=${board.backlogCount} blocked=${board.blockedCount} pendingListed=${pendingListed.length}/${input.pending.length} autoConfirmed=${input.autoConfirmed.length} autoListed=${autoListed.length}/${input.autoConfirmed.length} autoWindowDays=${input.autoConfirmWindowDays} warnings=${board.warnings.length} shownLines=${shown}/${lines.length}`,
    lines,
  );
  return {
    summary,
    structuredResult: {
      month: input.month,
      lastRun: input.lastRun,
      pending: {
        total: input.pending.length,
        inProgress: board.pendingCount,
        backlog: board.backlogCount,
        blocked: board.blockedCount,
        totalsByDirection: board.totalsByDirection,
        monthlyExcludedCount: board.monthlyExcludedCount,
        rows: pendingListed,
        truncated: input.pending.length - pendingListed.length,
        warnings,
        warningsTotal: board.warnings.length,
      },
      autoConfirmed: {
        windowDays: input.autoConfirmWindowDays,
        total: input.autoConfirmed.length,
        rows: autoListed,
        truncated: input.autoConfirmed.length - autoListed.length,
      },
    },
    // 한 캠페인이 공급사·셀러 두 의무로 두 줄이 될 수 있다 — 겹치면 10칸 상한을 헛되이 먹는다.
    evidenceCampaignIds: [...new Set(pendingListed.map((row) => row.campaignId))],
  };
}
