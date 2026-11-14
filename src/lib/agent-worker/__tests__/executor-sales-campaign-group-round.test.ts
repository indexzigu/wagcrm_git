/**
 * 판매캠페인 그룹 다음 회차 기안(`create_sales_campaign_group_round`, 2026-11-14) — 실행기 배선. 고정하는 것:
 *  ① 봇 입력(지난 회차 캠페인·상품 지목·날짜)에서 메모를 뺀 것만 그룹 창구에 보내고, 창구 초안 + 메모가 저장 args 가 된다
 *  ② 창구 실패(지난 그룹 없음 등)는 기안을 만들지 않고 실패 코드·문구로 돌아간다
 *  ③ 지난 회차 근거(캠페인·상품)가 하나도 없으면 창구를 부르지 않는다
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload } from "../contracts";

const callMock = vi.fn();
const insertMock = vi.fn();
vi.mock("../internal-api-client", () => ({ callAgentInternalApi: (...args: unknown[]) => callMock(...args) }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ $transaction: async (cb: (tx: unknown) => unknown) => cb({}) }),
}));
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => false }));
vi.mock("@/lib/agent/agent-worker-proposal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/agent-worker-proposal")>()),
  insertAgentWorkerProposal: (...args: unknown[]) => insertMock(...args),
}));

const { executeAgentJob } = await import("../executor");

function job(input: AgentJobPayload["input"]): AgentJobRecord {
  return {
    id: "job-1",
    idempotencyKey: "key-1",
    payload: {
      schemaVersion: 1,
      taskType: "deterministic",
      skill: "wag-crm-sales-group-round",
      operation: "create_action_proposal",
      input,
      origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t" },
    },
    status: "RUNNING",
    workerId: "worker-1",
    leaseExpiresAt: new Date("2026-11-13T00:02:00.000Z"),
    heartbeatAt: new Date("2026-11-13T00:00:00.000Z"),
    attempt: 0,
    result: null,
    failureCode: null,
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    updatedAt: new Date("2026-11-13T00:00:00.000Z"),
  };
}

const deps = {
  decideRoute: vi.fn(async () => ({ status: "ACCEPTED" as const, route: "python" as const, model: "python", reason: "deterministic" })),
  now: () => new Date("2026-11-13T00:00:00.000Z"),
};

const member = (dealId: string, dealName: string) => ({
  previousCampaignId: `prev-${dealId}`,
  previousCampaignName: `${dealName} - 샘플셀러`,
  dealId,
  dealName,
  salesChannel: "OWN_MALL_NAVER",
  isManualMargin: false,
  totalMarginRate: 0,
  sellerMarginRate: 0,
  campaignItems: [],
  expectedRoundNumber: 2,
  expectedCampaignName: `${dealName} - 샘플셀러 2차`,
});

const draft = {
  previousGroupId: "group-1",
  previousGroupName: "[샘플셀러] 딜A 외 1건",
  sellerId: "seller-1",
  sellerName: "샘플셀러",
  members: [member("deal-a", "딜A"), member("deal-b", "딜B")],
  product: {
    productId: "101",
    channelProductNo: "201",
    name: "[샘플셀러 X 샘플브랜드] 조합 2차",
    productStatus: "SALE",
    salePeriod: "2026.12.01 ~ 2026.12.07",
    source: "INPUT",
  },
  baseNaverLink: "https://smartstore.naver.com/ygrd/products/201",
  startDate: "2026-12-01",
  endDate: "2026-12-07",
  dateSource: "STORE",
  status: "PREPARATION",
  linkOrderCampaign: { id: "oc-2", name: "조합 2차 주문" },
  otherLinkedCampaigns: [{ id: "placeholder", name: "딜A - 샘플셀러 2차", startDate: "2026-11-30", endDate: "2026-12-06" }],
};

beforeEach(() => {
  callMock.mockReset();
  insertMock.mockReset();
  insertMock.mockResolvedValue("prop-1");
});

describe("create_action_proposal — create_sales_campaign_group_round", () => {
  it("그룹 창구 초안 + 메모를 저장 args 로 기안을 만든다(메모는 창구에 보내지 않는다)", async () => {
    callMock.mockResolvedValue({ ok: true, body: { ok: true, data: draft } });
    const outcome = await executeAgentJob(
      job({ action: "create_sales_campaign_group_round", productQuery: "조합 2차", memo: "12월 회차" }),
      deps,
    );
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("NEEDS_APPROVAL");
    expect(callMock.mock.calls[0][0]).toBe("/api/internal/agent/sales-campaign-group-round-draft");
    expect(callMock.mock.calls[0][1]).toEqual({ productQuery: "조합 2차" });
    const inserted = insertMock.mock.calls[0][1] as { intent: { action: string; summary: string }; storedArgs: unknown };
    expect(inserted.storedArgs).toEqual({ ...draft, memo: "12월 회차" });
    expect(inserted.intent.action).toBe("create_sales_campaign_group_round");
    expect(inserted.intent.summary).toContain("캠페인 2개");
  });

  it("지난 그룹을 못 찾으면 기안 없이 실패 코드·문구를 돌려준다", async () => {
    callMock.mockResolvedValue({
      ok: true,
      body: { ok: false, code: "PREVIOUS_GROUP_NOT_FOUND", message: "지난 캠페인 그룹이 없습니다." },
    });
    const outcome = await executeAgentJob(job({ action: "create_sales_campaign_group_round", productId: "101" }), deps);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(outcome.result.resultSummary).toContain("PREVIOUS_GROUP_NOT_FOUND");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("지난 회차 근거(캠페인·상품)가 하나도 없으면 창구를 부르지 않는다", async () => {
    const outcome = await executeAgentJob(
      job({ action: "create_sales_campaign_group_round", startDate: "2026-12-01", endDate: "2026-12-07" }),
      deps,
    );
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(callMock).not.toHaveBeenCalled();
  });

  it("창구 초안이 저장 스키마에 안 맞으면(그룹 캠페인 1개) 기안을 만들지 않는다", async () => {
    callMock.mockResolvedValue({ ok: true, body: { ok: true, data: { ...draft, members: [draft.members[0]] } } });
    const outcome = await executeAgentJob(job({ action: "create_sales_campaign_group_round", productId: "101" }), deps);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(insertMock).not.toHaveBeenCalled();
  });
});
