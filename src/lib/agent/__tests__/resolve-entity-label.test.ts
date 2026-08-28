/**
 * resolveEntityLabel — 승인 카드가 entityId 대신 사람이 읽을 수 있는 엔티티명을
 * 보여주기 위한 서버측 해석 헬퍼 (청사진 §0-6).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dealFindUniqueMock = vi.fn();
const campaignFindUniqueMock = vi.fn();
const partnerFindUniqueMock = vi.fn();
const sellerFindUniqueMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    deal: { findUnique: dealFindUniqueMock },
    salesCampaign: { findUnique: campaignFindUniqueMock },
    partner: { findUnique: partnerFindUniqueMock },
    seller: { findUnique: sellerFindUniqueMock },
  }),
}));

const { resolveEntityLabel } = await import("../resolve-entity-label");

describe("resolveEntityLabel", () => {
  beforeEach(() => {
    dealFindUniqueMock.mockReset();
    campaignFindUniqueMock.mockReset();
    partnerFindUniqueMock.mockReset();
    sellerFindUniqueMock.mockReset();
  });

  it("DEAL은 dealName을 반환한다", async () => {
    dealFindUniqueMock.mockResolvedValue({ dealName: "락토핏 골드" });
    const label = await resolveEntityLabel("DEAL", "deal-1");
    expect(label).toBe("락토핏 골드");
  });

  it("PARTNER는 name을 반환한다", async () => {
    partnerFindUniqueMock.mockResolvedValue({ name: "종근당 벤더사" });
    const label = await resolveEntityLabel("PARTNER", "partner-1");
    expect(label).toBe("종근당 벤더사");
  });

  it("SELLER는 name을 반환한다", async () => {
    sellerFindUniqueMock.mockResolvedValue({ name: "최가명" });
    const label = await resolveEntityLabel("SELLER", "seller-1");
    expect(label).toBe("최가명");
  });

  it("CAMPAIGN은 campaignName이 있으면 그대로, 없으면 dealName 기반 조합명을 반환한다", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      campaignName: "여름 프로모션",
      deal: { dealName: "락토핏 골드" },
      seller: { name: "최가명" },
    });
    const label = await resolveEntityLabel("CAMPAIGN", "camp-1");
    expect(label).toBe("여름 프로모션");
  });

  it("CAMPAIGN이 campaignName 없으면 dealName + sellerName으로 조합한다", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      campaignName: null,
      deal: { dealName: "락토핏 골드" },
      seller: { name: "최가명" },
    });
    const label = await resolveEntityLabel("CAMPAIGN", "camp-1");
    expect(label).toContain("락토핏 골드");
    expect(label).toContain("최가명");
  });

  it("대상 엔티티가 존재하지 않으면 null을 반환한다 (throw하지 않음 — 목록/상세 조회 자체를 막지 않기 위함)", async () => {
    dealFindUniqueMock.mockResolvedValue(null);
    const label = await resolveEntityLabel("DEAL", "deal-ghost");
    expect(label).toBeNull();
  });

  it("entityId가 null/undefined면 null을 반환한다", async () => {
    expect(await resolveEntityLabel("DEAL", null)).toBeNull();
    expect(await resolveEntityLabel(null, "deal-1")).toBeNull();
  });
});
