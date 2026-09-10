/**
 * create_deal 도구 테스트 (청사진 §0-1 — add_entity_memo와 동일 패턴).
 *
 * 핵심 계약: 실제 딜 생성도, 기안 생성도, 거래처 조회도 하지 않는다. 대상(target)은
 * **이미 등록된 거래처를 지목했을 때만** 붙는다 — 그래야 없는 거래처 id가 승인까지
 * 끌려가지 않고 기안 시점에 걸린다. 거래처까지 새로 만드는 딜은 대상이 없다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordActivityCreateMock = vi.fn();
const getPrismaMock = vi.fn();

vi.mock("@/lib/activity-log", () => ({
  recordActivityCreate: (...args: unknown[]) => recordActivityCreateMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: (...args: unknown[]) => getPrismaMock(...args),
}));

const { createDealTool } = await import("../create-deal");

const mainDeal = { dealName: "샤인머스캣 1kg" };

describe("create_deal 도구 — intent만 반환, 쓰기 없음", () => {
  beforeEach(() => {
    recordActivityCreateMock.mockReset();
    getPrismaMock.mockReset();
  });

  it("이미 등록된 거래처(partnerId)를 지목하면 대상이 PARTNER로 붙는다", async () => {
    const result = await createDealTool.execute({ partnerId: "partner-1", mainDeal });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.writeIntent).toMatchObject({
      action: "create_deal",
      args: { partnerId: "partner-1", mainDeal },
      targetEntityType: "PARTNER",
      targetEntityId: "partner-1",
    });
    expect(result.data.writeIntent.summary).toBe('딜 "샤인머스캣 1kg" 등록 (기존 거래처 partner-1)');

    expect(recordActivityCreateMock).not.toHaveBeenCalled();
    expect(getPrismaMock).not.toHaveBeenCalled();
  });

  it("거래처를 동봉하면(partner) 대상 없이(null/null) 기안된다", async () => {
    const result = await createDealTool.execute({
      partner: { name: "위엄식품", type: "BRAND" },
      mainDeal,
      optionDeals: [{ dealName: "2kg" }, { dealName: "3kg" }, { dealName: "5kg" }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.writeIntent).toMatchObject({ targetEntityType: null, targetEntityId: null });
    expect(result.data.writeIntent.summary).toBe(
      '딜 "샤인머스캣 1kg" 등록 (거래처 "위엄식품" 신규 등록), 옵션 3건'
    );
  });

  it("거래처가 둘 다 없거나 둘 다 오면 MISSING_PARAM으로 되묻는다", async () => {
    const none = await createDealTool.execute({ mainDeal });
    expect(none.ok).toBe(false);
    if (none.ok) throw new Error("expected error");
    expect(none.error.code).toBe("MISSING_PARAM");

    const both = await createDealTool.execute({
      partnerId: "partner-1",
      partner: { name: "위엄식품", type: "BRAND" },
      mainDeal,
    });
    expect(both.ok).toBe(false);
    if (both.ok) throw new Error("expected error");
    expect(both.error.code).toBe("MISSING_PARAM");
  });

  it("딜 이름이 비면 MISSING_PARAM을 반환한다", async () => {
    const result = await createDealTool.execute({ partnerId: "partner-1", mainDeal: { dealName: " " } } as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("MISSING_PARAM");
  });

  it("결과의 evidence.dataSources는 실제 조회를 하지 않았음을 반영한다(빈 배열)", async () => {
    const result = await createDealTool.execute({ partnerId: "partner-1", mainDeal });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.evidence.dataSources).toEqual([]);
  });
});
