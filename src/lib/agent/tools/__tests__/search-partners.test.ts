import { describe, expect, it, vi, beforeEach } from "vitest";

const findManyMock = vi.fn();

vi.mock("@/repositories/partnerRepository", () => ({
  PartnerRepository: {
    findMany: (...args: unknown[]) => findManyMock(...args),
  },
}));

import { searchPartnersTool } from "../search-partners";

describe("search_partners 도구", () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it("결과 항목에 거래처 id가 담긴다 — create_deal의 partnerId로 넘어갈 값이다", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "partner1",
        name: "위엄식품",
        type: "BRAND",
        businessNumber: "1234567890",
        updatedAt: new Date("2026-09-01T00:00:00Z"),
      },
    ]);

    const result = await searchPartnersTool.execute({ name: "위엄" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.items[0]).toMatchObject({
      id: "partner1",
      name: "위엄식품",
      type: "BRAND",
      businessNumber: "1234567890",
    });
    expect(result.data.truncated).toBe(false);
  });

  it("NOT_FOUND: 결과가 없으면 NOT_FOUND를 반환한다", async () => {
    findManyMock.mockResolvedValue([]);
    const result = await searchPartnersTool.execute({ name: "존재하지않음" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("QUERY_FAILED: repository 예외 시 QUERY_FAILED를 반환한다", async () => {
    findManyMock.mockRejectedValue(new Error("DB 오류"));
    const result = await searchPartnersTool.execute({ name: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("QUERY_FAILED");
  });
});
