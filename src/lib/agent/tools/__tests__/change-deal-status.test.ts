/**
 * change_deal_status 도구 테스트 (청사진 §0-1, §2 — add_entity_memo와 동일 패턴).
 *
 * 핵심 계약: 이 도구는 실제 쓰기도, ActionProposal 기안 생성도, 딜 조회도 하지 않는다.
 * execute(input)에는 userId가 없으므로(AgentTool 계약), 구조화된 writeIntent만
 * ToolResult.data에 실어 반환한다. 딜 상태기계 검증(isValidTransition)은 승인 시점에
 * write-executor에서 수행되며, 이 도구는 args 형식 검증만 한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordActivityChangeMock = vi.fn();
const getPrismaMock = vi.fn();

// 이 도구가 쓰기/조회 관련 모듈을 절대 import/호출하지 않는지 확인하기 위해 모킹해두고
// 호출되지 않았음을 단언한다.
vi.mock("@/lib/activity-log", () => ({
  recordActivityChange: (...args: unknown[]) => recordActivityChangeMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: (...args: unknown[]) => getPrismaMock(...args),
}));

const { changeDealStatusTool } = await import("../change-deal-status");

describe("change_deal_status 도구 — intent만 반환, 쓰기 없음", () => {
  beforeEach(() => {
    recordActivityChangeMock.mockReset();
    getPrismaMock.mockReset();
  });

  it("정상 입력이면 ok:true와 writeIntent를 반환하고, 실제 쓰기 함수는 호출하지 않는다", async () => {
    const result = await changeDealStatusTool.execute({
      dealId: "deal-1",
      newStatus: "NEGOTIATING",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.data.writeIntent).toMatchObject({
      action: "change_deal_status",
      args: { dealId: "deal-1", newStatus: "NEGOTIATING" },
      targetEntityType: "DEAL",
      targetEntityId: "deal-1",
    });
    expect(typeof result.data.writeIntent.summary).toBe("string");
    expect(result.data.writeIntent.summary.length).toBeGreaterThan(0);

    expect(recordActivityChangeMock).not.toHaveBeenCalled();
    expect(getPrismaMock).not.toHaveBeenCalled();
  });

  it("dealId 누락 시 MISSING_PARAM을 반환한다", async () => {
    const result = await changeDealStatusTool.execute({
      dealId: "",
      newStatus: "NEGOTIATING",
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("MISSING_PARAM");
    expect(recordActivityChangeMock).not.toHaveBeenCalled();
  });

  it("결과의 evidence.dataSources는 실제 조회를 하지 않았음을 반영한다(빈 배열)", async () => {
    const result = await changeDealStatusTool.execute({
      dealId: "deal-1",
      newStatus: "DROPPED",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.evidence.dataSources).toEqual([]);
  });

  it("모든 DEAL_STATUSES 값을 newStatus로 허용한다(zod enum 스키마 형식 검증만)", async () => {
    const statuses = ["SOURCING", "NEGOTIATING", "SAMPLE_TESTING", "CONFIRMED", "ARCHIVED", "DROPPED"];
    for (const status of statuses) {
      const result = await changeDealStatusTool.execute({ dealId: "deal-1", newStatus: status } as never);
      expect(result.ok).toBe(true);
    }
  });
});
