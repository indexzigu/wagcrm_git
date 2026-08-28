import { describe, expect, it, vi, beforeEach } from "vitest";

const findManyMock = vi.fn();

vi.mock("@/repositories/dealRepository", () => ({
  dealRepository: {
    findMany: (...args: unknown[]) => findManyMock(...args),
  },
}));

import { searchDealsTool } from "../search-deals";

describe("search_deals 도구", () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it("검색 결과가 화면과 동일한 필드로 매핑된다", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "deal1",
        dealName: "락토핏 골드",
        brandName: "종근당",
        status: "NEGOTIATING",
        sellingPrice: 29900,
        costPrice: 15000,
        partner: { name: "종근당 벤더사" },
        updatedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]);

    const result = await searchDealsTool.execute({ keyword: "락토핏" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]).toMatchObject({
      id: "deal1",
      dealName: "락토핏 골드",
      partnerName: "종근당 벤더사",
    });
    expect(result.data.truncated).toBe(false);
  });

  it("20건 초과 시 truncated=true, 최대 20건만 반환한다", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: `deal${i}`,
      dealName: `딜${i}`,
      brandName: null,
      status: "SOURCING",
      sellingPrice: 1000,
      costPrice: 500,
      partner: null,
      updatedAt: new Date(),
    }));
    findManyMock.mockResolvedValue(many);

    const result = await searchDealsTool.execute({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.items).toHaveLength(20);
    expect(result.data.truncated).toBe(true);
  });

  it("NOT_FOUND: 결과가 없으면 NOT_FOUND를 반환한다", async () => {
    findManyMock.mockResolvedValue([]);
    const result = await searchDealsTool.execute({ keyword: "존재하지않음" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("QUERY_FAILED: repository 예외 시 QUERY_FAILED를 반환한다", async () => {
    findManyMock.mockRejectedValue(new Error("DB 오류"));
    const result = await searchDealsTool.execute({ keyword: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("QUERY_FAILED");
  });
});
