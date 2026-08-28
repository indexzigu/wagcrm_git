// POST /api/settlement/tax-invoice-receipts/decision — 신뢰 경계·거부 계약.
//
// 이 라우트가 지키는 것은 「클라이언트가 보낸 대상을 그대로 믿지 않는다」다. 승인은 실제로
// 정산 필드를 쓰는 유일한 경로이므로, 화면이 낡았거나(409) 그 필드가 발행 의무인 조합(422)
// 이면 **쓰기 전에** 거부해야 한다.
//
// ⛔ 특히 고정하는 것: **성립하지 않는 승인에 200 을 주지 않는다.** 200 을 주면 호출부의
// `res.ok` 가드가 통과해 화면이 「승인됨」을 그리는데 수취일시는 비어 있고, 다음 스캔은
// 「결정된 건」이라 제안조차 띄우지 않아 되돌아올 길이 없다(교차 검증 적발 2026-08-12).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-auth", () => ({
  requireAuth: async () => ({ authenticated: true }),
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));

/** 라우트가 검증 기준으로 삼는 기대 건 집합. 스캔과 같은 SSOT 를 쓰는지가 요점이다. */
const EXPECTED = [
  {
    key: "campAnchor:SELLER_COMMISSION",
    campaignId: "campAnchor",
    campaignLabel: "여름기획 3차 외 2건",
    slot: "SELLER_COMMISSION",
    channel: "BRAND_MALL",
    counterpartBusinessNumber: "1112233333",
    counterpartLabel: "블루버드컴퍼니",
    expectedTotalAmount: 5500000,
    amountBasis: "셀러 수수료",
    amountIsManual: false,
    amountIsEstimate: false,
    trackingField: "sellerInvoiceIssuedAt" as const,
    alreadyMarkedAt: null,
    validWrittenDateFrom: null,
    validWrittenDateTo: null,
  },
];

vi.mock("@/lib/tax-invoice-mail/campaign-facts", () => ({
  loadCampaignSettlementFacts: async () => ({ solo: [{}], byGroup: new Map(), all: [{}] }),
}));

vi.mock("@/lib/tax-invoice-mail/expected-receivables", () => ({
  buildGroupExpectedReceivables: () => EXPECTED,
}));

const applyMock = vi.fn();
const revertMock = vi.fn();

vi.mock("@/services/taxInvoiceReceiptDecisionService", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/taxInvoiceReceiptDecisionService")
  >("@/services/taxInvoiceReceiptDecisionService");
  return {
    ...actual,
    applyReceiptDecision: (...args: unknown[]) => applyMock(...args),
    revertReceiptDecision: (...args: unknown[]) => revertMock(...args),
  };
});

import { POST } from "../route";
import { ReceiptDecisionRejected } from "@/services/taxInvoiceReceiptDecisionService";

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/settlement/tax-invoice-receipts/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const APPROVE = {
  issueId: "9".repeat(24),
  action: "approve" as const,
  targetKeys: ["campAnchor:SELLER_COMMISSION"],
  writtenDate: "2026-07-31",
  observedTotal: 5489000,
  expectedTotal: 5500000,
};

beforeEach(() => {
  applyMock.mockReset();
  revertMock.mockReset();
  applyMock.mockResolvedValue({ applied: [] });
});

describe("POST .../tax-invoice-receipts/decision", () => {
  it("정상 승인은 대상 key 와 작성일자를 서비스로 넘긴다", async () => {
    const res = await post(APPROVE);

    expect(res.status).toBe(200);
    const [, input] = applyMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.decision).toBe("APPROVED");
    expect(input.matchedKeys).toEqual(["campAnchor:SELLER_COMMISSION"]);
    // 수취일시에는 오늘이 아니라 계산서 작성일자가 실린다.
    expect((input.appliedDate as Date).toISOString()).toBe("2026-07-31T00:00:00.000Z");
  });

  it("현재 기대 건에 없는 key 는 409 로 거부하고 아무것도 쓰지 않는다", async () => {
    const res = await post({ ...APPROVE, targetKeys: ["사라진캠페인:SELLER_COMMISSION"] });

    expect(res.status).toBe(409);
    // ⛔ 부분 승인으로 넘어가면 오너는 전부 처리된 줄 안다.
    expect(applyMock).not.toHaveBeenCalled();
    expect((await res.json()).unknownKeys).toEqual(["사라진캠페인:SELLER_COMMISSION"]);
  });

  it("승인 대상이 비면 400 이다", async () => {
    const res = await post({ ...APPROVE, targetKeys: [] });
    expect(res.status).toBe(400);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("서비스가 승인을 거부하면 200 이 아니라 오류로 응답한다", async () => {
    applyMock.mockRejectedValue(new ReceiptDecisionRejected("MISSING_WRITTEN_DATE"));

    const res = await post({ ...APPROVE, writtenDate: null });

    // 422 여야 호출부의 `res.ok` 가드가 발동해 화면이 「승인됨」을 그리지 않는다.
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("MISSING_WRITTEN_DATE");
  });

  it("무관 처리는 대상 검증 없이 결정만 기록한다", async () => {
    const res = await post({ issueId: "9".repeat(24), action: "dismiss" });

    expect(res.status).toBe(200);
    const [, input] = applyMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.decision).toBe("DISMISSED");
    expect(input.matchedKeys).toEqual([]);
    expect(input.appliedDate).toBeNull();
  });

  it("되돌릴 결정이 없으면 404 다", async () => {
    revertMock.mockResolvedValue({ found: false, cleared: [], skipped: [] });

    const res = await post({ issueId: "9".repeat(24), action: "revert" });

    expect(res.status).toBe(404);
  });

  it("되돌리기가 건드리지 않은 건은 응답에 실어 알린다", async () => {
    revertMock.mockResolvedValue({
      found: true,
      cleared: [],
      skipped: [{ campaignId: "campAnchor", field: "sellerInvoiceIssuedAt" }],
    });

    const res = await post({ issueId: "9".repeat(24), action: "revert" });

    expect(res.status).toBe(200);
    // 조용히 넘기면 오너는 되돌려진 줄 안다(P0).
    expect((await res.json()).skipped).toHaveLength(1);
  });

  it("형식이 틀린 요청은 400 이다", async () => {
    expect((await post({ action: "approve" })).status).toBe(400);
    expect((await post({ issueId: "x", action: "무슨동작" })).status).toBe(400);
  });
});
