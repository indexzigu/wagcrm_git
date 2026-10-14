/**
 * get_tax_invoice_status(2026-10-14) — 세금계산서 발행 대조 현황 읽기.
 *
 * 픽스처에 가짜 사업자등록번호·대표자명·주소·이메일·계산서 승인번호·크론 오류 문구를 심고, 봇에게
 * 가는 글(resultSummary)과 결재함에 남는 기록(ActionProposal.create 의 data) **양쪽 모두에** 그 값이
 * 없는지 센다. 이름은 전부 가짜다(공개 레포).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload } from "../contracts";

const m = vi.hoisted(() => ({
  campaignFindMany: vi.fn(),
  taskLogFindFirst: vi.fn(),
  activityFindMany: vi.fn(),
  loadInvoiceProgress: vi.fn(),
  proposalCreate: vi.fn(),
  proposalEventCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        actionProposal: { create: (args: unknown) => m.proposalCreate(args) },
        actionProposalEvent: { create: (args: unknown) => m.proposalEventCreate(args) },
      }),
    salesCampaign: { findMany: (args: unknown) => m.campaignFindMany(args) },
    systemTaskLog: { findFirst: (args: unknown) => m.taskLogFindFirst(args) },
    activityLog: { findMany: (args: unknown) => m.activityFindMany(args) },
  }),
}));
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => false }));
vi.mock("@/services/campaignInvoiceService", () => ({
  campaignInvoiceService: { loadInvoiceProgress: (...args: unknown[]) => m.loadInvoiceProgress(...args) },
}));

import { executeAgentJob, type ExecutionDeps } from "../executor";
import { MAX_RESULT_SUMMARY_CHARS, MAX_TAX_INVOICE_PENDING_ROWS } from "../contracts";
import { toIssueConfirmRunView } from "../tax-invoice-status";

// 2026-10-13T16:00Z = KST 2026-10-14 01:00 — UTC 달력으로 계산하면 같은 달이라 KST 판정을 못 가른다.
// 그래서 달 기본값 검사는 아래 별도 시각(KST 로 이미 다음 달)을 쓴다.
const NOW = new Date("2026-10-13T16:00:00.000Z");

function job(input: AgentJobPayload["input"]): AgentJobRecord {
  return {
    id: "job-tax",
    idempotencyKey: "key-tax",
    payload: {
      schemaVersion: 1,
      taskType: "deterministic",
      skill: "none",
      operation: "get_tax_invoice_status",
      input,
      origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t" },
    },
    status: "RUNNING",
    workerId: "worker-1",
    leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    heartbeatAt: NOW,
    attempt: 0,
    result: null,
    failureCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function depsAt(now: Date): ExecutionDeps {
  return {
    decideRoute: async () => ({ status: "ACCEPTED", route: "python", model: "python", reason: "deterministic" }),
    now: () => now,
  };
}

async function run(input: AgentJobPayload["input"], now: Date = NOW) {
  const outcome = await executeAgentJob(job(input), depsAt(now));
  if (outcome.kind !== "terminal") throw new Error(`expected terminal, got ${outcome.kind}`);
  return outcome;
}

function recordedJson(): string {
  expect(m.proposalCreate).toHaveBeenCalledTimes(1);
  return JSON.stringify(m.proposalCreate.mock.calls[0][0]);
}

// ---------------------------------------------------------------------------
// 가짜 민감값 — 어디에도 나오면 안 된다.
// ---------------------------------------------------------------------------
const PARTNER_BIZ = "9998887776";
const PARTNER_CEO = "대표가공일";
const SELLER_BIZ = "5554443332";
const SELLER_CEO = "대표가공이";
const APPROVAL_IN_REASON = "20261005-APPROVAL-SECRET-1";
const APPROVAL_IN_LOG = "20261005-APPROVAL-SECRET-2";
const CRON_ERROR = "imap.secret-host.example 접속 실패";
const NEEDLES = [PARTNER_BIZ, PARTNER_CEO, SELLER_BIZ, SELLER_CEO, APPROVAL_IN_REASON, APPROVAL_IN_LOG, CRON_ERROR, "1,234,567원"];

function campaign(overrides: Record<string, unknown>) {
  return {
    id: "c1",
    dealId: "d1",
    sellerId: "s1",
    groupId: null,
    group: null,
    campaignName: "가짜크림 - 가짜셀러 1차",
    updatedAt: new Date("2026-10-01T00:00:00Z"),
    startDate: new Date("2026-09-01T00:00:00Z"),
    endDate: new Date("2026-09-10T00:00:00Z"),
    salesChannel: "BRAND_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 11_000_000,
    sellerExpense: 2_200_000,
    settlementSales: 5_500_000,
    totalMarginRate: 0,
    sellerMarginRate: 0,
    netMarginRate: 0,
    status: "SETTLEMENT_IN_PROGRESS",
    isManualMargin: false,
    sellerTaxType: "BUSINESS",
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    settlementItems: [],
    deal: {
      dealName: "가짜크림",
      costPrice: 0,
      sellingPrice: 0,
      partner: { id: "p1", name: "가짜공급사", businessNumber: PARTNER_BIZ, ceoName: PARTNER_CEO, monthlySettlement: false },
    },
    seller: {
      name: "가짜셀러",
      alias: null,
      snsType: "INSTAGRAM",
      snsHandle: "fake_handle",
      agency: { name: "가짜셀러상사", type: "SELLER", businessNumber: SELLER_BIZ, ceoName: SELLER_CEO },
    },
    ...overrides,
  };
}

const ACTIVE = campaign({});
// 끝난(COMPLETED) 캠페인 · 사업자 정보 없음 → BACKLOG + 결번.
const BACKLOG = campaign({
  id: "c2",
  campaignName: "가짜세럼 - 가짜셀러B 2차",
  status: "COMPLETED",
  salesChannel: "SELLER_MALL",
  deal: { dealName: "가짜세럼", costPrice: 0, sellingPrice: 0, partner: { id: "p2", name: "가짜공급사B", businessNumber: null, ceoName: null, monthlySettlement: false } },
  seller: { name: "가짜셀러B", alias: "가짜별칭B", snsType: "INSTAGRAM", snsHandle: "fake_b", agency: null },
});

const RUN_DETAILS = {
  dryRun: true,
  dryRunReason: "TAX_INVOICE_AUTO_CONFIRM_NOT_SET",
  scan: { box: "INBOX", parsedInvoices: 12, truncated: 0, windowFrom: "2026-07-15", sinceDays: 90 },
  expectedTotal: 5,
  confirmed: 2,
  needsReview: 1,
  alreadyMatched: 3,
  unseen: 1,
  unmatchable: 0,
  outOfScanRange: 1,
  planned: 2,
  applied: 0,
  noop: 0,
  droppedByCap: 0,
  failures: [],
  needsReviewDetail: [
    {
      key: "k1",
      campaignLabel: "가짜크림 - 가짜셀러 1차",
      counterpartLabel: "가짜공급사",
      channel: "BRAND_MALL",
      trackingField: "supplierInvoiceIssuedAt",
      reasons: [
        { code: "AMOUNT_MISMATCH", message: `금액이 다릅니다. 계산서 합계 1,234,567원 승인번호 ${APPROVAL_IN_REASON}` },
        { code: "NOT_A_KNOWN_CODE", message: "x" },
      ],
      observed: { totalAmount: 1_234_567, expectedTotalAmount: 1_234_000, amountDelta: 567, writtenDate: "2026-10-05" },
    },
  ],
  needsReviewDetailCapped: false,
  failureReason: CRON_ERROR,
};

const AUTO_LOG = {
  entityId: "c1",
  type: "TAX_INVOICE_AUTO_CONFIRM_TOLERATED",
  fieldName: "sellerInvoiceIssuedAt",
  newValue: "2026-10-05",
  content: `메일 자동 확정: 셀러 계산서 발행일을 2026-10-05로 기록했습니다(계산서 1장 · 합계 1,234,567원 · 승인번호 ${APPROVAL_IN_LOG}).`,
  createdAt: new Date("2026-10-06T00:00:00Z"),
};

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.campaignFindMany.mockResolvedValue([ACTIVE, BACKLOG]);
  m.taskLogFindFirst.mockResolvedValue({ status: "SUCCESS", details: RUN_DETAILS, createdAt: new Date("2026-10-13T00:00:00Z") });
  m.activityFindMany.mockResolvedValue([AUTO_LOG]);
  m.loadInvoiceProgress.mockResolvedValue(new Map());
  m.proposalCreate.mockResolvedValue({ id: "read-1" });
  m.proposalEventCreate.mockResolvedValue({});
});

describe("get_tax_invoice_status", () => {
  it("reports last run, pending obligations and auto-confirmed entries in one bounded summary", async () => {
    const outcome = await run({ month: "2026-10" });
    expect(outcome.toStatus).toBe("SUCCEEDED");
    const summary = outcome.result.resultSummary;
    expect(summary.length).toBeLessThanOrEqual(MAX_RESULT_SUMMARY_CHARS);
    const [header, ...lines] = summary.split("\n");
    expect(header).toMatch(/^get_tax_invoice_status month=2026-10 lastRun=2026-10-13T00:00:00.000Z runStatus=OK stale=false /);
    expect(header).toContain("dryRun=true dryRunReason=TAX_INVOICE_AUTO_CONFIRM_NOT_SET");
    expect(header).toContain("scanParsed=12 scanTruncated=0 scanFrom=2026-07-15 expected=5 confirmed=2 needsReview=1 alreadyMatched=3 unseen=1 unmatchable=0 outOfScanRange=1 applied=0 noop=0 failures=0 failed=false");
    // 금액 불일치 건은 차이 금액까지 싣는다(숫자만 — 사유 문장의 승인번호는 아래 개인정보 테스트가 막는다).
    expect(outcome.result.resultSummary).toContain("invoiceTotal=1234567 expectedTotal=1234000 delta=567");
    expect(header).toContain("missing=none");
    expect(header).toContain("pending=4 inProgress=2 backlog=2 blocked=2 pendingListed=4/4 autoConfirmed=1 autoListed=1/1 autoWindowDays=90");

    expect(lines[0]).toBe("REVIEW 가짜크림 - 가짜셀러 1차 / 가짜공급사 [BRAND_MALL] reasons=AMOUNT_MISMATCH(금액 불일치),NOT_A_KNOWN_CODE invoiceTotal=1234567 expectedTotal=1234000 delta=567");
    // 진행 중이 먼저, 밀린 정리가 뒤.
    const pending = lines.filter((line) => line.startsWith("PENDING"));
    expect(pending).toHaveLength(4);
    expect(pending[0]).toContain("[IN_PROGRESS]");
    expect(pending[3]).toContain("[BACKLOG]");
    expect(pending.find((line) => line.includes("발행 SUPPLIER"))).toBe(
      "PENDING 발행 SUPPLIER [IN_PROGRESS] 가짜크림 - 가짜셀러 1차 deal=가짜크림 seller=가짜셀러 partner=가짜공급사 supply=5000000 vat=500000 total=5500000 selectable=yes",
    );
    expect(pending.some((line) => line.includes("seller=가짜별칭B") && line.includes("selectable=no blocked="))).toBe(true);
    expect(lines.at(-1)).toBe("AUTO 2026-10-05 셀러 계산서 발행일 가짜크림 - 가짜셀러 1차 tolerated=yes at=2026-10-06T00:00:00.000Z");
    expect(outcome.result.evidenceRefs).toEqual(["c1", "c2"]);
  });

  it("never exports business numbers, representative names, approval numbers or cron error text", async () => {
    const outcome = await run({});
    const recorded = recordedJson();
    for (const needle of NEEDLES) {
      expect(outcome.result.resultSummary, needle).not.toContain(needle);
      expect(recorded, needle).not.toContain(needle);
    }
    expect(recorded).not.toContain("observed");
    expect(recorded).not.toContain('"detail"');
  });

  it("reads the board through the shared loader: settlement-stage campaigns only, without relations the board does not use", async () => {
    await run({});
    const [args] = m.campaignFindMany.mock.calls[0] as [{ where: unknown; include: Record<string, unknown> }];
    expect(args.where).toEqual({ status: { in: ["SETTLEMENT_IN_PROGRESS", "COMPLETED"] } });
    expect(Object.keys(args.include).sort()).toEqual(["deal", "group", "seller", "settlementItems"]);
    const include = JSON.stringify(args.include);
    for (const relation of ["campaignDeals", "histories", "contacts", "residentNumber", "accountNumber", "address", "representativeEmail", "bankAccount"]) {
      expect(include, relation).not.toContain(relation);
    }
    // 로그는 이 잡의 줄만, 오류 문구 칸(message) 없이.
    expect(m.taskLogFindFirst).toHaveBeenCalledWith({
      where: { jobKey: "tax-invoice-issue-confirm" },
      orderBy: { createdAt: "desc" },
      select: { status: true, details: true, createdAt: true },
    });
    for (const [call] of m.activityFindMany.mock.calls as Array<[{ where: { type: unknown }; select: Record<string, boolean> }]>) {
      expect(call.where.type).toEqual({ startsWith: "TAX_INVOICE_AUTO_CONFIRM" });
      expect(Object.keys(call.select).sort()).toEqual(["content", "createdAt", "entityId", "fieldName", "newValue", "type"]);
    }
  });

  it("defaults month to the KST month, not the UTC one", async () => {
    const outcome = await run({}, new Date("2026-09-30T16:00:00.000Z")); // KST 2026-10-01 01:00
    expect(outcome.result.resultSummary).toMatch(/^get_tax_invoice_status month=2026-10 /);
  });

  it("says stale when the last run is older than 36h, and lastRun=none when the job never logged", async () => {
    m.taskLogFindFirst.mockResolvedValueOnce({ status: "ERROR", details: RUN_DETAILS, createdAt: new Date("2026-10-11T00:00:00Z") });
    const old = await run({});
    expect(old.result.resultSummary).toContain("runStatus=FAIL stale=true ageHours=64");

    m.proposalCreate.mockClear();
    m.taskLogFindFirst.mockResolvedValueOnce(null);
    const none = await run({});
    expect(none.result.resultSummary).toMatch(/^get_tax_invoice_status month=2026-10 lastRun=none pending=4 /);
  });

  it("caps pending rows and reports how many were left out", async () => {
    m.campaignFindMany.mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, index) => campaign({ id: `c${String(index).padStart(2, "0")}` })),
    );
    const outcome = await run({});
    expect(outcome.result.resultSummary).toContain(`pending=40 inProgress=40 backlog=0 blocked=0 pendingListed=${MAX_TAX_INVOICE_PENDING_ROWS}/40`);
    expect(recordedJson()).toContain(`"truncated":${40 - MAX_TAX_INVOICE_PENDING_ROWS},"warnings"`);
  });
});

describe("toIssueConfirmRunView — missing or trimmed details are reported, not zero-filled", () => {
  it("lists missing fields as null and flags a trimmed record", () => {
    const view = toIssueConfirmRunView(
      { status: "SUCCESS", details: { dryRun: false, confirmed: 3, detailsTrimmed: { needsReviewDetail: 4 } }, createdAt: NOW },
      NOW,
    );
    expect(view).not.toBeNull();
    expect(view!.counts.confirmed).toBe(3);
    expect(view!.counts.needsReview).toBeNull();
    expect(view!.scan).toEqual({ parsedInvoices: null, truncated: null, windowFrom: null });
    expect(view!.failuresCount).toBeNull();
    expect(view!.detailsTrimmed).toBe(true);
    expect(view!.missingFields).toEqual(expect.arrayContaining(["scan", "needsReview", "expectedTotal", "failures"]));
    expect(view!.missingFields).not.toContain("confirmed");
    expect(view!.missingFields).not.toContain("dryRun");
  });

  it("maps unknown statuses to UNKNOWN and drops malformed reason codes and line breaks in labels", () => {
    const view = toIssueConfirmRunView(
      {
        status: "RUNNING",
        details: {
          needsReviewDetail: [
            { campaignLabel: "가짜\n캠페인", counterpartLabel: null, channel: "brand mall", reasons: [{ code: "bad code" }, { code: "DUPLICATE_ISSUE" }] },
          ],
        },
        createdAt: NOW,
      },
      NOW,
    );
    expect(view!.status).toBe("UNKNOWN");
    expect(view!.needsReviewDetail).toEqual([
      {
        campaignLabel: "가짜 캠페인",
        counterpartLabel: null,
        channel: null,
        reasons: [{ code: "DUPLICATE_ISSUE", label: "같은 승인번호 중복 관측" }],
        amount: { invoiceTotal: null, expectedTotal: null, delta: null },
      },
    ]);
  });
});

describe("toIssueConfirmRunView — 월정산 자동 기록의 오너 확인 건은 코드·고정 라벨·개수만", () => {
  it("monthlyAutoRecord.needsReviewDetail 을 이유 코드별로 세고, 모르는 코드와 캠페인 id 는 옮기지 않는다", () => {
    const view = toIssueConfirmRunView(
      {
        status: "SUCCESS",
        details: {
          monthlyAutoRecord: {
            needsReviewDetail: [
              { campaignId: "c1", yearMonth: "2026-09", reason: "MINOR_MISMATCH", label: "x", notes: ["EXPECTED_FROM_MANUAL"] },
              { campaignId: "c2", yearMonth: "2026-09", reason: "MINOR_MISMATCH", label: "x", notes: [] },
              { campaignId: "c3", yearMonth: "2026-10", reason: "POSSIBLE_SPLIT", label: "x", notes: [] },
              { campaignId: "c4", yearMonth: "2026-10", reason: "NOT_A_CODE", label: "x", notes: [] },
            ],
          },
        },
        createdAt: NOW,
      },
      NOW,
    );
    expect(view!.monthlyReview).toEqual([
      { code: "MINOR_MISMATCH", label: "정산 오류 가능성 · 원인 확인 필요", count: 2 },
      { code: "POSSIBLE_SPLIT", label: "분할 발행 가능성 · 정산 메일 미확인", count: 1 },
    ]);
    expect(JSON.stringify(view!.monthlyReview)).not.toContain("c1");
  });
});
