/**
 * 봇 상품 매핑 작업 2종(`get_store_product_options` · `apply_product_mappings`, 2026-10-16) — 실행기 배선.
 * 실행 주체는 CRM 앱 창구라 여기서는 창구 클라이언트(`callAgentInternalApi`)만 가짜로 둔다. 고정하는 것:
 *  ① 창구 결과 데이터가 그대로 structuredData 가 된다(봇이 표·결과를 그것으로 만든다)
 *  ② 창구 실패 코드·문구가 결과 요약의 실패 코드·괄호 문장으로 옮겨진다
 *  ③ 연결 실패도 재시도 대상이 아니라 최종 실패다(쓰기 — 앱이 저장했는지 모른다)
 *  ④ 저장 요청에 슬랙 위치를 싣고, 결재함 기록 id 를 actionProposalId 로 돌려준다
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload } from "../contracts";

const callMock = vi.fn();
vi.mock("../internal-api-client", () => ({ callAgentInternalApi: (...args: unknown[]) => callMock(...args) }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({}) }));
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => false }));

const { executeAgentJob } = await import("../executor");

const SLACK = {
  channelId: "C0TESTCHAN1",
  threadTs: "1800000000.000100",
  messageTs: "1800000000.000200",
  rid: "01M4E4P6Z4QJ5A7X1178QJ7Y01",
};
const CAMPAIGN = { id: "cmtestordercampaign000000001", name: "[샘플 공구] 테스트" };

function job(operation: AgentJobPayload["operation"], input: AgentJobPayload["input"]): AgentJobRecord {
  return {
    id: "job-1",
    idempotencyKey: "key-1",
    payload: {
      schemaVersion: 1,
      taskType: "deterministic",
      skill: "wag-crm-product-mapping",
      operation,
      input,
      origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t", slack: SLACK },
    },
    status: "RUNNING",
    workerId: "worker-1",
    leaseExpiresAt: new Date("2026-10-16T00:02:00.000Z"),
    heartbeatAt: new Date("2026-10-16T00:00:00.000Z"),
    attempt: 0,
    result: null,
    failureCode: null,
    createdAt: new Date("2026-10-16T00:00:00.000Z"),
    updatedAt: new Date("2026-10-16T00:00:00.000Z"),
  };
}

const deps = {
  decideRoute: vi.fn(async () => ({ status: "ACCEPTED" as const, route: "python" as const, model: "python", reason: "deterministic" })),
  now: () => new Date("2026-10-16T00:00:00.000Z"),
};

const optionsData = {
  kind: "store_product_options" as const,
  version: 1 as const,
  orderCampaign: CAMPAIGN,
  channelProductNo: "211",
  productName: "샘플 상품",
  options: [
    { optionName: "구성: 1박스", price: 10000, currentBrandCode: "A-1", currentPrice: 10000, duplicateMappings: false },
    { optionName: "구성: 2박스", price: 19000, currentBrandCode: null, currentPrice: null, duplicateMappings: false },
  ],
  mappingsNotInStore: 0,
};

const appliedData = {
  kind: "product_mappings_applied" as const,
  version: 1 as const,
  orderCampaign: CAMPAIGN,
  proposalId: "prop-1",
  created: 1,
  updated: 1,
  unchanged: 0,
  rejected: [{ optionName: "샘플 1BOX", code: "NOT_A_STORE_OPTION" as const }],
};

beforeEach(() => {
  callMock.mockReset();
});

describe("get_store_product_options", () => {
  it("창구 표를 그대로 structuredData 로 싣는다", async () => {
    callMock.mockResolvedValue({ ok: true, body: { ok: true, data: optionsData } });
    const outcome = await executeAgentJob(job("get_store_product_options", { orderCampaignId: CAMPAIGN.id }), deps);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("SUCCEEDED");
    expect(outcome.result.structuredData).toEqual(optionsData);
    expect(outcome.result.resultSummary).toContain("스토어 옵션 2줄");
    expect(callMock.mock.calls[0][0]).toBe("/api/internal/agent/store-product-options");
    expect(callMock.mock.calls[0][1]).toEqual({ orderCampaignId: CAMPAIGN.id });
  });

  it("창구 실패 코드와 문구를 실패 요약으로 옮긴다", async () => {
    callMock.mockResolvedValue({
      ok: true,
      body: { ok: false, code: "NO_STORE_OPTIONS", message: "CRM 캠페인 설정 창에서 상품을 먼저 연결해 주세요." },
    });
    const outcome = await executeAgentJob(job("get_store_product_options", { orderCampaignId: CAMPAIGN.id }), deps);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(outcome.result.resultSummary).toBe(
      "get_store_product_options failed: NO_STORE_OPTIONS (CRM 캠페인 설정 창에서 상품을 먼저 연결해 주세요.)",
    );
  });
});

describe("apply_product_mappings", () => {
  const input = {
    orderCampaignId: CAMPAIGN.id,
    mappings: [{ optionName: "구성: 1박스", brandCode: "TC-001", price: 10000 }],
  };

  it("슬랙 위치를 실어 저장을 부탁하고, 결과·결재함 기록 id 를 돌려준다", async () => {
    callMock.mockResolvedValue({ ok: true, body: { ok: true, data: appliedData } });
    const outcome = await executeAgentJob(job("apply_product_mappings", input), deps);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("SUCCEEDED");
    expect(outcome.result.actionProposalId).toBe("prop-1");
    expect(outcome.result.structuredData).toEqual(appliedData);
    expect(outcome.result.resultSummary).toContain("저장 2줄");
    expect(outcome.result.resultSummary).toContain("저장 안 함 1줄");
    expect(callMock.mock.calls[0][0]).toBe("/api/internal/agent/apply-product-mappings");
    expect(callMock.mock.calls[0][1]).toEqual({ ...input, slack: SLACK });
  });

  it("앱에 닿지 못해도 재시도하지 않고 최종 실패로 끝낸다", async () => {
    callMock.mockResolvedValue({
      ok: false,
      errorClass: "INTERNAL_API_UNREACHABLE",
      detail: "CRM 앱에 닿지 못했습니다: TypeError",
    });
    const outcome = await executeAgentJob(job("apply_product_mappings", input), deps);
    expect(outcome.kind).toBe("terminal");
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(outcome.errorClass).toBe("INTERNAL_API_UNREACHABLE");
  });
});
