/**
 * 슬랙 버튼 승인·반려 본체 — 무엇을 슬랙에서 결정해도 되는지(봇 기안·허용 액션)와 결과 코드 옮기기.
 * 누가 눌렀는지는 hermes 버튼 처리기 몫이라 여기서 다루지 않는다.
 */
import { describe, expect, it, vi } from "vitest";
import { WRITE_ACTIONS } from "@/lib/agent/write-actions";
import {
  SLACK_DECIDABLE_ACTIONS,
  SLACK_EXCLUDED_ACTIONS,
  decideProposalFromSlack,
  type SlackDecisionDeps,
} from "../slack-decision";
import { SLACK_OWNER_APPROVAL_ACTOR } from "../actors";

type Approve = SlackDecisionDeps["approve"];
type Reject = SlackDecisionDeps["reject"];

function deps(
  proposal: { createdBy: string; status: string; payload: unknown } | null,
  overrides: Partial<SlackDecisionDeps> = {},
): SlackDecisionDeps {
  return {
    findProposal: vi.fn(async () => proposal),
    approve: vi.fn(async () => ({ ok: true }) as unknown as Awaited<ReturnType<Approve>>) as unknown as Approve,
    reject: vi.fn(async () => ({ ok: true }) as unknown as Awaited<ReturnType<Reject>>) as unknown as Reject,
    ...overrides,
  };
}

const botProposal = (action: string, status = "PENDING_APPROVAL") => ({
  createdBy: "AGENT_WORKER",
  status,
  payload: { action, args: {} },
});

function approveFailing(code: string): Approve {
  return vi.fn(async () => ({ ok: false, code, httpStatus: 409, error: "x", status: "PENDING_APPROVAL" })) as unknown as Approve;
}

describe("슬랙 버튼 허용 액션 분류", () => {
  it("모든 쓰기 액션이 허용·제외 중 정확히 한쪽에 있다 — 새 액션은 분류를 강제한다", () => {
    for (const name of Object.keys(WRITE_ACTIONS)) {
      const inAllow = SLACK_DECIDABLE_ACTIONS.has(name as never);
      const inDeny = SLACK_EXCLUDED_ACTIONS.has(name as never);
      expect([name, inAllow !== inDeny]).toEqual([name, true]);
    }
    expect(SLACK_DECIDABLE_ACTIONS.size + SLACK_EXCLUDED_ACTIONS.size).toBe(Object.keys(WRITE_ACTIONS).length);
  });

  it("돈·정산 칸·계산서 보강이 걸린 액션은 제외다", () => {
    for (const name of ["confirm_settlement", "update_settlement_amount", "update_record", "create_partner"]) {
      expect(SLACK_EXCLUDED_ACTIONS.has(name as never)).toBe(true);
    }
  });
});

describe("decideProposalFromSlack", () => {
  it("승인: 슬랙 승인자로 PENDING_APPROVAL 에서만 승인하고 EXECUTED 를 돌려준다", async () => {
    const d = deps(botProposal("create_order_campaign"));
    await expect(decideProposalFromSlack({ proposalId: "p1", decision: "approve" }, d)).resolves.toEqual({
      ok: true,
      status: "EXECUTED",
    });
    expect(d.approve).toHaveBeenCalledWith("p1", SLACK_OWNER_APPROVAL_ACTOR, { expectedStatus: "PENDING_APPROVAL" });
  });

  it("반려: 슬랙 승인자·「슬랙에서 반려」 메모로 반려한다", async () => {
    const d = deps(botProposal("create_deal"));
    await expect(decideProposalFromSlack({ proposalId: "p1", decision: "reject" }, d)).resolves.toEqual({
      ok: true,
      status: "REJECTED",
    });
    expect(d.reject).toHaveBeenCalledWith("p1", SLACK_OWNER_APPROVAL_ACTOR, "슬랙에서 반려");
    expect(d.approve).not.toHaveBeenCalled();
  });

  it("봇이 올리지 않은 기안·제외 액션은 승인도 반려도 부르지 않는다(NOT_ELIGIBLE)", async () => {
    const human = deps({ createdBy: "user-1", status: "PENDING_APPROVAL", payload: { action: "create_deal" } });
    const settlement = deps(botProposal("update_record"));
    const stringPayload = deps({ ...botProposal("confirm_settlement"), payload: JSON.stringify({ action: "confirm_settlement" }) });
    for (const d of [human, settlement, stringPayload]) {
      for (const decision of ["approve", "reject"] as const) {
        const result = await decideProposalFromSlack({ proposalId: "p1", decision }, d);
        expect(result).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
      }
      expect(d.approve).not.toHaveBeenCalled();
      expect(d.reject).not.toHaveBeenCalled();
    }
  });

  it("SQLite 레인의 문자열 payload 도 액션을 읽는다", async () => {
    const d = deps({ ...botProposal("create_deal"), payload: JSON.stringify({ action: "create_deal", args: {} }) });
    await expect(decideProposalFromSlack({ proposalId: "p1", decision: "approve" }, d)).resolves.toEqual({
      ok: true,
      status: "EXECUTED",
    });
  });

  it("없는 기안은 NOT_FOUND", async () => {
    await expect(decideProposalFromSlack({ proposalId: "p1", decision: "approve" }, deps(null))).resolves.toEqual({
      ok: false,
      code: "NOT_FOUND",
      status: null,
    });
  });

  it("이미 처리된 기안은 현재 상태를 다시 읽어 ALREADY_DECIDED 로 돌려준다(CONFLICT 의 낡은 상태를 쓰지 않는다)", async () => {
    const findProposal = vi
      .fn()
      .mockResolvedValueOnce(botProposal("create_deal"))
      .mockResolvedValueOnce(botProposal("create_deal", "EXECUTED"));
    const d = deps(null, { findProposal, approve: approveFailing("CONFLICT") });
    await expect(decideProposalFromSlack({ proposalId: "p1", decision: "approve" }, d)).resolves.toEqual({
      ok: false,
      code: "ALREADY_DECIDED",
      status: "EXECUTED",
    });
  });

  it("반려가 동시 처리에 지면 ALREADY_DECIDED", async () => {
    const reject = vi.fn(async () => ({ ok: false, code: "CONFLICT" })) as unknown as Reject;
    const d = deps(botProposal("create_deal", "PENDING_APPROVAL"), { reject });
    await expect(decideProposalFromSlack({ proposalId: "p1", decision: "reject" }, d)).resolves.toMatchObject({
      ok: false,
      code: "ALREADY_DECIDED",
    });
  });

  it("실행 실패는 EXECUTION_FAILED, 그 밖의 승인 오류는 INTERNAL", async () => {
    const failed = deps(botProposal("create_deal", "FAILED"), { approve: approveFailing("EXECUTION_FAILED") });
    const other = deps(botProposal("create_deal"), { approve: approveFailing("APPROVE_ERROR") });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(decideProposalFromSlack({ proposalId: "p1", decision: "approve" }, failed)).resolves.toEqual({
      ok: false,
      code: "EXECUTION_FAILED",
      status: "FAILED",
    });
    await expect(decideProposalFromSlack({ proposalId: "p1", decision: "approve" }, other)).resolves.toMatchObject({
      ok: false,
      code: "INTERNAL",
    });
    spy.mockRestore();
  });
});
