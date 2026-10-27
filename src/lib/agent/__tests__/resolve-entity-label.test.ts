/**
 * resolveEntityLabel — 승인 카드가 entityId 대신 사람이 읽을 수 있는 엔티티명을
 * 보여주기 위한 서버측 해석 헬퍼 (청사진 §0-6).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dealFindUniqueMock = vi.fn();
const campaignFindUniqueMock = vi.fn();
const partnerFindUniqueMock = vi.fn();
const sellerFindUniqueMock = vi.fn();
const dealFindManyMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    deal: { findUnique: dealFindUniqueMock, findMany: dealFindManyMock },
    salesCampaign: { findUnique: campaignFindUniqueMock },
    partner: { findUnique: partnerFindUniqueMock },
    seller: { findUnique: sellerFindUniqueMock },
  }),
}));

const { resolveEntityLabel, resolveProposalArgLabels } = await import("../resolve-entity-label");

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

  it("SELLER는 별칭이 없으면 name을 반환한다", async () => {
    sellerFindUniqueMock.mockResolvedValue({ name: "최가명", alias: null });
    const label = await resolveEntityLabel("SELLER", "seller-1");
    expect(label).toBe("최가명");
  });

  it("SELLER는 별칭이 있으면 별칭을 먼저 쓴다(P2 Seller Alias Priority), 공백 별칭은 없는 것으로", async () => {
    sellerFindUniqueMock.mockResolvedValue({ name: "최가명", alias: "가명별칭" });
    expect(await resolveEntityLabel("SELLER", "seller-1")).toBe("가명별칭");
    sellerFindUniqueMock.mockResolvedValue({ name: "최가명", alias: "  " });
    expect(await resolveEntityLabel("SELLER", "seller-1")).toBe("최가명");
  });

  it("CAMPAIGN 조합명도 셀러 별칭을 먼저 쓴다", async () => {
    campaignFindUniqueMock.mockResolvedValue({
      campaignName: null,
      deal: { dealName: "락토핏 골드" },
      seller: { name: "최가명", alias: "가명별칭" },
    });
    expect(await resolveEntityLabel("CAMPAIGN", "camp-1")).toBe("락토핏 골드 - 가명별칭");
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

describe("resolveProposalArgLabels — [캘린더수집] 새 회차 기안의 셀러·판매 조건 이름", () => {
  beforeEach(() => {
    dealFindUniqueMock.mockReset();
    sellerFindUniqueMock.mockReset();
  });

  it("셀러는 별칭을 먼저(P2 Seller Alias Priority), 판매 조건은 이름", async () => {
    sellerFindUniqueMock.mockResolvedValue({ name: "샘플셀러", alias: "샘플" });
    dealFindUniqueMock.mockResolvedValue({ dealName: "테스트브랜드 봄딜" });
    const labels = await resolveProposalArgLabels({
      action: "create_campaign_round",
      args: { dealId: "d1", sellerId: "s1", startDate: "2026-12-01", endDate: "2026-12-07" },
    });
    expect(labels).toEqual({ seller: "샘플", deal: "테스트브랜드 봄딜" });
  });

  it("별칭이 비면 실명, 대상이 없으면 null 칸", async () => {
    sellerFindUniqueMock.mockResolvedValue({ name: "샘플셀러", alias: " " });
    dealFindUniqueMock.mockResolvedValue(null);
    const labels = await resolveProposalArgLabels({ action: "create_campaign_round", args: { dealId: "d9", sellerId: "s1" } });
    expect(labels).toEqual({ seller: "샘플셀러", deal: null });
  });

  it("다른 액션·모양이 깨진 내용은 조회 없이 null", async () => {
    expect(await resolveProposalArgLabels({ action: "update_record", args: {} })).toBeNull();
    expect(await resolveProposalArgLabels({ action: "create_campaign_round", args: { dealId: 1 } })).toBeNull();
    expect(await resolveProposalArgLabels(null)).toBeNull();
    expect(dealFindUniqueMock).not.toHaveBeenCalled();
    expect(sellerFindUniqueMock).not.toHaveBeenCalled();
  });
});

describe("resolveProposalArgLabels — 판매캠페인 품목 추가(T-271)의 판매 조건·연결 하위품목 이름·판매가", () => {
  beforeEach(() => {
    dealFindManyMock.mockReset();
  });

  it("상위 판매 조건 이름과 연결 줄 하위품목 이름을 한 번의 조회로 푼다(새로 만들 줄은 조회하지 않는다)", async () => {
    dealFindManyMock.mockResolvedValue([
      { id: "main-1", dealName: "샘플 상품", unit: "개", sellingPrice: 10_000, totalCommissionRate: 20 },
      { id: "opt-2", dealName: "샘플 상품 2개입", sellingPrice: 19_000, totalCommissionRate: null },
    ]);
    const labels = await resolveProposalArgLabels({
      action: "add_campaign_items",
      args: { campaignId: "sc-1", mainDealId: "main-1", items: [{ dealId: "opt-2" }, { dealName: "새 구성", sellingPrice: 1 }] },
    });
    expect(dealFindManyMock).toHaveBeenCalledTimes(1);
    expect(dealFindManyMock.mock.calls[0][0]).toMatchObject({ where: { id: { in: ["main-1", "opt-2"] } } });
    expect(labels).toEqual({
      seller: null,
      deal: "샘플 상품",
      linkedDeals: { "opt-2": { name: "샘플 상품 2개입", sellingPrice: 19_000, totalCommissionRate: null } },
      dealUnit: "개",
    });
  });

  it("지워진 하위품목은 이름 표에서 빠진다(미리보기가 「이름 확인 불가」로 그린다)", async () => {
    dealFindManyMock.mockResolvedValue([{ id: "main-1", dealName: "샘플 상품", sellingPrice: 10_000, totalCommissionRate: null }]);
    const labels = await resolveProposalArgLabels({
      action: "add_campaign_items",
      args: { mainDealId: "main-1", items: [{ dealId: "gone" }] },
    });
    expect(labels).toEqual({ seller: null, deal: "샘플 상품", linkedDeals: {}, dealUnit: null });
  });

  it("모양이 깨진 내용은 조회 없이 null", async () => {
    expect(await resolveProposalArgLabels({ action: "add_campaign_items", args: { mainDealId: 1, items: [] } })).toBeNull();
    expect(await resolveProposalArgLabels({ action: "add_campaign_items", args: { mainDealId: "m", items: "x" } })).toBeNull();
    expect(dealFindManyMock).not.toHaveBeenCalled();
  });
});
