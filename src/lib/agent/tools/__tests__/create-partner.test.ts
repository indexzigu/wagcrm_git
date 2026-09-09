/**
 * create_partner 도구 테스트 (청사진 §0-1 — add_entity_memo와 동일 패턴).
 *
 * 핵심 계약: 이 도구는 실제 거래처 생성도, ActionProposal 기안 생성도 하지 않는다.
 * 다른 WRITE 도구와 다른 점은 **대상이 없다는 것**이다 — 아직 존재하지 않는 거래처를
 * 만드는 기안이므로 targetEntityType/targetEntityId가 둘 다 null이다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordActivityCreateMock = vi.fn();
const getPrismaMock = vi.fn();

// 이 도구가 쓰기/조회 관련 모듈을 절대 호출하지 않는지 확인하기 위해 모킹해두고
// 호출되지 않았음을 단언한다.
vi.mock("@/lib/activity-log", () => ({
  recordActivityCreate: (...args: unknown[]) => recordActivityCreateMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: (...args: unknown[]) => getPrismaMock(...args),
}));

const { createPartnerTool } = await import("../create-partner");

describe("create_partner 도구 — intent만 반환, 쓰기 없음", () => {
  beforeEach(() => {
    recordActivityCreateMock.mockReset();
    getPrismaMock.mockReset();
  });

  it("정상 입력이면 대상 없는(null/null) writeIntent를 반환하고 실제 쓰기 함수는 호출하지 않는다", async () => {
    const result = await createPartnerTool.execute({
      partner: { name: "위엄식품", type: "BRAND" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.data.writeIntent).toMatchObject({
      action: "create_partner",
      args: { partner: { name: "위엄식품", type: "BRAND" } },
      targetEntityType: null,
      targetEntityId: null,
    });
    expect(result.data.writeIntent.summary).toBe('거래처 "위엄식품"(BRAND) 등록');

    expect(recordActivityCreateMock).not.toHaveBeenCalled();
    expect(getPrismaMock).not.toHaveBeenCalled();
  });

  it("담당자를 함께 받으면 args와 승인 카드 요약에 인원 수가 드러난다", async () => {
    const result = await createPartnerTool.execute({
      partner: { name: "위엄식품", type: "VENDOR" },
      contacts: [{ name: "김담당", role: "MD" }, { name: "이담당" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.writeIntent.summary).toBe('거래처 "위엄식품"(VENDOR) 등록, 담당자 2명');
    expect(result.data.writeIntent.args).toMatchObject({ contacts: [{ name: "김담당" }, { name: "이담당" }] });
  });

  it("상호가 비면 MISSING_PARAM을 반환한다", async () => {
    const result = await createPartnerTool.execute({ partner: { name: "  ", type: "BRAND" } } as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("MISSING_PARAM");
    expect(recordActivityCreateMock).not.toHaveBeenCalled();
  });

  it("결과의 evidence.dataSources는 실제 조회를 하지 않았음을 반영한다(빈 배열)", async () => {
    const result = await createPartnerTool.execute({ partner: { name: "위엄식품", type: "AGENCY" } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.evidence.dataSources).toEqual([]);
  });
});
