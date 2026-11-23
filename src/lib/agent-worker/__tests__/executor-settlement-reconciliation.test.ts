/**
 * 봇 정산 메일 대조(`get_settlement_reconciliation`, 2026-11-23 v1) — 실행기 배선. 실행 주체는 CRM 앱 창구라
 * 창구 클라이언트와 DB 클라이언트만 가짜로 둔다. 고정하는 것:
 *  ① 결과 요약 첫 줄 = `formatReconFirstLine`(봇이 받는 전부), 둘째 줄부터 사람용
 *  ② 결재함 READ 기록(진짜 `recordReadResult`, DB 행 생성만 가짜) = 창구 데이터(화이트리스트) 그대로 — 가짜 구매자 정보 같은 낯선 칸이 끼면 창구 응답 검사에서 막힌다
 *  ③ 창구 실패 코드·문구가 실패 요약으로 옮겨진다
 *  ④ 봇용 구조화 결과(structuredData)는 싣지 않는다(hermes 가 읽는 종류가 아니다)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload } from "../contracts";
import { settlementReconciliationResponseSchema } from "@/lib/agent-internal/api-contract";

const callMock = vi.fn();
// READ 기록은 진짜 `recordReadResult` 가 쓴다 — 가짜는 DB 클라이언트(행 생성)뿐.
const { proposalCreate, eventCreate, fakeClient } = vi.hoisted(() => {
  const proposalCreate = vi.fn(async () => ({ id: "read-record-1" }));
  const eventCreate = vi.fn(async () => ({}));
  const fakeClient = {
    actionProposal: { create: proposalCreate },
    actionProposalEvent: { create: eventCreate },
  };
  return { proposalCreate, eventCreate, fakeClient };
});
vi.mock("../internal-api-client", () => ({ callAgentInternalApi: (...args: unknown[]) => callMock(...args) }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ ...fakeClient, $transaction: (callback: (tx: unknown) => Promise<unknown>) => callback(fakeClient) }),
}));
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => false }));

const { executeAgentJob } = await import("../executor");

function job(input: AgentJobPayload["input"]): AgentJobRecord {
  return {
    id: "job-1",
    idempotencyKey: "key-1",
    payload: {
      schemaVersion: 1,
      taskType: "deterministic",
      skill: "none",
      operation: "get_settlement_reconciliation",
      input,
      origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t" },
    },
    status: "RUNNING",
    workerId: "worker-1",
    leaseExpiresAt: new Date("2026-11-23T00:02:00.000Z"),
    heartbeatAt: new Date("2026-11-23T00:00:00.000Z"),
    attempt: 0,
    result: null,
    failureCode: null,
    createdAt: new Date("2026-11-23T00:00:00.000Z"),
    updatedAt: new Date("2026-11-23T00:00:00.000Z"),
  };
}

const deps = {
  decideRoute: vi.fn(async () => ({ status: "ACCEPTED" as const, route: "python" as const, model: "python", reason: "deterministic" })),
  now: () => new Date("2026-11-23T00:00:00.000Z"),
};

const data = {
  kind: "settlement_reconciliation" as const,
  version: 1 as const,
  campaignId: "sc-1",
  partial: true,
  mailsRead: 1,
  lastMailMonth: "2026-10",
  truncated: 0,
  unreadable: 0,
  withoutSheet: 0,
  ambiguous: 0,
  dropped: 0,
  overlappingRounds: 0,
  timedOut: false,
  conflictMonths: ["2026-09"],
  mails: [{ yearMonth: "2026-10", receivedDate: "2026-11-05", source: "XLS" as const }],
  counts: { options: 2, MATCH: 1, MAIL_LESS: 0, MAIL_MORE: 0, LINE_MISSING: 1, MAPPING_MISSING: 0, MAPPING_WRONG_LINE: 0, OPTION_UNKNOWN: 0 },
  options: [
    { optionName: "구성: 6박스", status: "LINE_MISSING" as const, mailQty: 2, crmQty: null },
    { optionName: "구성: 3박스", status: "MATCH" as const, mailQty: 4, crmQty: 4 },
  ],
  optionsOmitted: 0,
};

beforeEach(() => {
  callMock.mockReset();
  proposalCreate.mockClear();
  eventCreate.mockClear();
});

describe("get_settlement_reconciliation through the executor", () => {
  it("첫 줄은 대조 칸, 둘째 줄부터 사람용, READ 기록은 창구 데이터 그대로", async () => {
    callMock.mockResolvedValue({ ok: true, body: { ok: true, data } });
    const outcome = await executeAgentJob(job({ campaignId: "sc-1" }), deps);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("SUCCEEDED");
    const lines = outcome.result.resultSummary.split("\n");
    expect(lines[0]).toBe(
      "recon campaign=sc-1 partial=1 mails=1 옵션=2 일치=1 메일적음=0 메일많음=0 줄누락=1 매핑누락=0 연결오류=0 미상=0 충돌=1 버림=0",
    );
    expect(lines).toContain("옵션「구성: 6박스」 메일 2 · CRM - · 품목 줄 없음");
    expect(lines).toContain("충돌 2026-09: 같은 달 정산 메일 내용이 서로 다름(합산하지 않음)");
    expect(outcome.result.structuredData).toBeUndefined();
    expect(outcome.result.evidenceRefs).toEqual(["sc-1"]);
    expect(callMock.mock.calls[0][0]).toBe("/api/internal/agent/settlement-reconciliation");
    expect(callMock.mock.calls[0][1]).toEqual({ campaignId: "sc-1" });

    const created = (proposalCreate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(created).toMatchObject({
      kind: "READ",
      status: "EXECUTED",
      title: "정산 메일 대조 · 메일 1통 · 옵션 2개 · 일부만 확인",
      dataSources: ["Mail", "SalesCampaign", "CampaignDeal", "Deal", "ProductMapping"],
      structuredResult: {
        operation: "get_settlement_reconciliation",
        jobId: "job-1",
        query: { campaignId: "sc-1" },
        truncated: false,
        data,
      },
    });
    expect(created.resultSummary).toBe(outcome.result.resultSummary);
    expect(eventCreate).toHaveBeenCalledTimes(1);
    // 구매자 정보가 READ 기록에 못 들어오는 장치는 창구 응답 스키마(strict)다 — 이 파일은 창구 클라이언트를 가짜로 두므로
    // 그 검사는 아래 테스트가 스키마에 직접 고정한다(여기서 「없음」을 단언하면 넣지도 않은 값을 찾는 빈 단언이 된다).
  });

  it("창구 응답 검사(화이트리스트)가 낯선 칸을 막는다 — 가짜 구매자 칸이 끼면 계약 위반", () => {
    const withPii = { ok: true, data: { ...data, buyer: "테스트구매자" } };
    expect(settlementReconciliationResponseSchema.safeParse(withPii).success).toBe(false);
    const optionWithPhone = { ok: true, data: { ...data, options: [{ ...data.options[0], phone: "010-0000-0000" }] } };
    expect(settlementReconciliationResponseSchema.safeParse(optionWithPhone).success).toBe(false);
    expect(settlementReconciliationResponseSchema.safeParse({ ok: true, data }).success).toBe(true);
  });

  it("창구 실패 코드와 문구를 실패 요약으로 옮긴다", async () => {
    callMock.mockResolvedValue({
      ok: true,
      body: { ok: false, code: "SHEET_LAYOUT_CHANGED", message: "정산 메일 첨부의 피벗 표 양식이 바뀌어 읽지 않았습니다." },
    });
    const outcome = await executeAgentJob(job({ campaignId: "sc-1" }), deps);
    if (outcome.kind !== "terminal") throw new Error("expected terminal");
    expect(outcome.toStatus).toBe("FAILED_FINAL");
    expect(outcome.result.resultSummary).toBe(
      "get_settlement_reconciliation failed: SHEET_LAYOUT_CHANGED (정산 메일 첨부의 피벗 표 양식이 바뀌어 읽지 않았습니다.)",
    );
    expect(proposalCreate).not.toHaveBeenCalled();
  });
});
