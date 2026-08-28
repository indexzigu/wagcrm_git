import { beforeEach, describe, expect, it, vi } from "vitest";
import { portalSlugExists } from "./portal-slug-existence";

const findUniqueMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    seller: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
  }),
}));

describe("portalSlugExists", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
  });

  it("등록된 슬러그면 true, portalSlug 로 정확히 조회한다", async () => {
    findUniqueMock.mockResolvedValue({ id: "seller-1" });

    await expect(portalSlugExists("gaon")).resolves.toBe(true);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { portalSlug: "gaon" },
      select: { id: true },
    });
  });

  it("등록되지 않은 슬러그면 false", async () => {
    findUniqueMock.mockResolvedValue(null);

    await expect(portalSlugExists("wp-admin")).resolves.toBe(false);
  });

  it("DB 조회 실패 시 던지지 않고 null 을 돌려준다 — 호출부가 fail-open 판단에 쓴다", async () => {
    findUniqueMock.mockRejectedValue(new Error("connection reset"));

    await expect(portalSlugExists("gaon")).resolves.toBeNull();
  });
});
