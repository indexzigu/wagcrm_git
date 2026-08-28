import { describe, it, expect } from "vitest";
import {
  createPartnerSchema,
  updatePartnerSchema,
  createSellerSchema,
  createDealSchema,
  updateDealSchema,
  isValidDealStatusTransition,
  createMemoSchema,
  createTemplateSchema,
  baseMarginPolicySchema,
} from "./index";

describe("Partner validation schemas", () => {
  it("accepts valid partner creation data", () => {
    const result = createPartnerSchema.safeParse({
      name: "테스트 브랜드",
      type: "BRAND",
      contactInfo: "010-1234-5678",
      bankAccount: "국민 123-456",
    });
    expect(result.success).toBe(true);
  });

  it("rejects partner without name", () => {
    const result = createPartnerSchema.safeParse({
      type: "BRAND",
    });
    expect(result.success).toBe(false);
  });

  it("rejects partner without type", () => {
    const result = createPartnerSchema.safeParse({
      name: "테스트",
    });
    expect(result.success).toBe(false);
  });

  it("rejects partner with invalid type", () => {
    const result = createPartnerSchema.safeParse({
      name: "테스트",
      type: "INVALID",
    });
    expect(result.success).toBe(false);
  });

  it("accepts partial update with nullable fields", () => {
    const result = updatePartnerSchema.safeParse({
      contactInfo: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("Seller validation schemas", () => {
  it("accepts valid seller creation data", () => {
    const result = createSellerSchema.safeParse({
      name: "인플루언서A",
      snsType: "INSTAGRAM",
      snsHandle: "@influencer_a",
      currentFollowers: 50000,
    });
    expect(result.success).toBe(true);
  });

  it("defaults currentFollowers to 0", () => {
    const result = createSellerSchema.safeParse({
      name: "인플루언서B",
      snsType: "YOUTUBE",
      snsHandle: "channel_b",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.currentFollowers).toBe(0);
    }
  });

  it("rejects seller without snsHandle", () => {
    const result = createSellerSchema.safeParse({
      name: "인플루언서",
      snsType: "INSTAGRAM",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative followers", () => {
    const result = createSellerSchema.safeParse({
      name: "인플루언서",
      snsType: "INSTAGRAM",
      snsHandle: "@test",
      currentFollowers: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe("Deal validation schemas", () => {
  const validMarginPolicy = {
    byChannel: {
      naver: { totalMarginRate: 30, sellerMarginRate: 15 },
    },
  };

  it("accepts valid deal creation data", () => {
    const result = createDealSchema.safeParse({
      dealName: "테스트 딜",
      partnerId: "partner-123",
      costPrice: 10000,
      sellingPrice: 15000,
      supplyPrice: 9000,
      baseMarginPolicy: validMarginPolicy,
    });
    expect(result.success).toBe(true);
  });

  it("defaults costPrice and sellingPrice to 0 when omitted", () => {
    const result = createDealSchema.safeParse({
      dealName: "테스트 딜",
      partnerId: "partner-123",
      baseMarginPolicy: validMarginPolicy,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.costPrice).toBe(0);
      expect(result.data.sellingPrice).toBe(0);
    }
  });

  it("accepts supplyPrice when updating a deal", () => {
    const result = updateDealSchema.safeParse({
      supplyPrice: 9000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects deal without dealName", () => {
    const result = createDealSchema.safeParse({
      partnerId: "partner-123",
      baseMarginPolicy: validMarginPolicy,
    });
    expect(result.success).toBe(false);
  });

  it("rejects deal without partnerId", () => {
    const result = createDealSchema.safeParse({
      dealName: "테스트",
      baseMarginPolicy: validMarginPolicy,
    });
    expect(result.success).toBe(false);
  });

  it("validates margin policy with slides", () => {
    const result = baseMarginPolicySchema.safeParse({
      byChannel: {
        naver: { totalMarginRate: 30, sellerMarginRate: 15 },
      },
      slides: [
        { minActualSales: 1000000, totalMarginAddRate: 5 },
        { minActualSales: 5000000, totalMarginAddRate: 10, sellerMarginAddRate: 3 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid margin policy structure", () => {
    const result = baseMarginPolicySchema.safeParse({
      byChannel: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("Deal status transitions", () => {
  it("allows forward transitions", () => {
    expect(isValidDealStatusTransition("SOURCING", "NEGOTIATING")).toBe(true);
    expect(isValidDealStatusTransition("NEGOTIATING", "SAMPLE_TESTING")).toBe(true);
    expect(isValidDealStatusTransition("SAMPLE_TESTING", "CONFIRMED")).toBe(true);
    expect(isValidDealStatusTransition("CONFIRMED", "ARCHIVED")).toBe(true);
  });

  it("allows DROPPED from any status", () => {
    expect(isValidDealStatusTransition("SOURCING", "DROPPED")).toBe(true);
    expect(isValidDealStatusTransition("NEGOTIATING", "DROPPED")).toBe(true);
    expect(isValidDealStatusTransition("SAMPLE_TESTING", "DROPPED")).toBe(true);
    expect(isValidDealStatusTransition("ARCHIVED", "DROPPED")).toBe(true);
  });

  it("rejects reverse transitions", () => {
    expect(isValidDealStatusTransition("ARCHIVED", "SOURCING")).toBe(false);
    expect(isValidDealStatusTransition("NEGOTIATING", "SOURCING")).toBe(false);
    expect(isValidDealStatusTransition("SAMPLE_TESTING", "NEGOTIATING")).toBe(false);
  });

  it("allows same-status (no-op)", () => {
    expect(isValidDealStatusTransition("SOURCING", "SOURCING")).toBe(true);
  });

  it("rejects transitions from DROPPED", () => {
    expect(isValidDealStatusTransition("DROPPED", "SOURCING")).toBe(false);
    expect(isValidDealStatusTransition("DROPPED", "NEGOTIATING")).toBe(false);
  });
});

describe("Activity log memo schema", () => {
  it("accepts valid memo data", () => {
    const result = createMemoSchema.safeParse({
      entityType: "PARTNER",
      entityId: "partner-123",
      content: "미팅 결과 메모",
      actor: "user-1",
    });
    expect(result.success).toBe(true);
  });

  it("defaults actor to SYSTEM", () => {
    const result = createMemoSchema.safeParse({
      entityType: "DEAL",
      entityId: "deal-456",
      content: "자동 메모",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actor).toBe("SYSTEM");
    }
  });

  it("rejects empty content", () => {
    const result = createMemoSchema.safeParse({
      entityType: "SELLER",
      entityId: "seller-789",
      content: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("Campaign template schema", () => {
  it("accepts valid template data", () => {
    const result = createTemplateSchema.safeParse({
      name: "네이버 기본 템플릿",
      dealId: "deal-123",
      salesChannel: "naver",
      marginSettings: JSON.stringify({ totalMarginRate: 30 }),
      trackingPattern: "nt_source=naver&nt_medium={seller}",
    });
    expect(result.success).toBe(true);
  });

  it("rejects template without name", () => {
    const result = createTemplateSchema.safeParse({
      dealId: "deal-123",
    });
    expect(result.success).toBe(false);
  });

  it("accepts template with only name", () => {
    const result = createTemplateSchema.safeParse({
      name: "최소 템플릿",
    });
    expect(result.success).toBe(true);
  });
});
