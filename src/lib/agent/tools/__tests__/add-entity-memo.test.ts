/**
 * add_entity_memo 도구 테스트 (청사진 §0-1, §2).
 *
 * 핵심 계약: 이 도구는 실제 쓰기도, ActionProposal 기안 생성도 하지 않는다.
 * execute(input)에는 userId가 없으므로(AgentTool 계약), 구조화된 writeIntent만
 * ToolResult.data에 실어 반환한다. assistant route(userId 보유)가 이 intent를 보고
 * 단일 지점에서 WRITE 기안을 생성한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordActivityMemoMock = vi.fn();
const getPrismaMock = vi.fn();

// 이 도구가 쓰기 관련 모듈을 절대 import/호출하지 않는지 확인하기 위해 모킹해두고
// 호출되지 않았음을 단언한다.
vi.mock("@/lib/activity-log", () => ({
  recordActivityMemo: (...args: unknown[]) => recordActivityMemoMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: (...args: unknown[]) => getPrismaMock(...args),
}));

const { addEntityMemoTool } = await import("../add-entity-memo");

describe("add_entity_memo 도구 — intent만 반환, 쓰기 없음", () => {
  beforeEach(() => {
    recordActivityMemoMock.mockReset();
    getPrismaMock.mockReset();
  });

  it("정상 입력이면 ok:true와 writeIntent를 반환하고, 실제 쓰기 함수는 호출하지 않는다", async () => {
    const result = await addEntityMemoTool.execute({
      entityType: "DEAL",
      entityId: "deal-1",
      content: "재입고 확인 요청",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.data.writeIntent).toMatchObject({
      action: "add_entity_memo",
      args: { entityType: "DEAL", entityId: "deal-1", content: "재입고 확인 요청" },
      targetEntityType: "DEAL",
      targetEntityId: "deal-1",
    });
    expect(typeof result.data.writeIntent.summary).toBe("string");
    expect(result.data.writeIntent.summary.length).toBeGreaterThan(0);

    expect(recordActivityMemoMock).not.toHaveBeenCalled();
    expect(getPrismaMock).not.toHaveBeenCalled();
  });

  it("entityId 누락 시 MISSING_PARAM을 반환한다", async () => {
    const result = await addEntityMemoTool.execute({
      entityType: "DEAL",
      entityId: "",
      content: "메모",
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("MISSING_PARAM");
    expect(recordActivityMemoMock).not.toHaveBeenCalled();
  });

  it("content 누락 시 MISSING_PARAM을 반환한다", async () => {
    const result = await addEntityMemoTool.execute({
      entityType: "DEAL",
      entityId: "deal-1",
      content: "",
    } as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("MISSING_PARAM");
  });

  it("결과에는 writeIntent가 있을 뿐 evidence.dataSources는 실제 조회를 하지 않았음을 반영한다", async () => {
    const result = await addEntityMemoTool.execute({
      entityType: "CAMPAIGN",
      entityId: "camp-1",
      content: "메모",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.evidence.dataSources).toEqual([]);
  });
});
