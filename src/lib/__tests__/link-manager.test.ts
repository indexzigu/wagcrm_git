import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the prisma module
vi.mock("../prisma", () => ({
  getPrisma: vi.fn(),
}));

import { getPrisma } from "../prisma";
import {
  linkDealToPartner,
  linkCampaignToDeal,
  changeDealPartner,
  changeCampaignDeal,
} from "../link-manager";
import type { LinkResult } from "../link-manager";

type MockedPrisma = {
  deal: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  salesCampaign: {
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

type PartnerLinkData = {
  id: string;
  dealName: string;
  partnerId: string;
  partner: { id: string; name: string };
};

const mockPrisma: MockedPrisma = {
  deal: {
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
  salesCampaign: {
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPrisma).mockReturnValue(mockPrisma as never);
});

describe("linkDealToPartner", () => {
  it("updates deal partnerId and returns updated data", async () => {
    mockPrisma.deal.update.mockResolvedValue({
      id: "deal-1",
      dealName: "Test Deal",
      partnerId: "partner-new",
      partner: { id: "partner-new", name: "New Partner" },
    });

    const result = await linkDealToPartner("deal-1", "partner-new", "user@test.com");

    expect(result.data.partnerId).toBe("partner-new");
    expect(result.data.partner!.name).toBe("New Partner");
    expect(result.logWarning).toBeNull();
    expect(mockPrisma.deal.update).toHaveBeenCalledWith({
      where: { id: "deal-1" },
      data: { partnerId: "partner-new" },
      include: { partner: { select: { id: true, name: true } } },
    });
  });

  it("returns null logWarning on successful operation", async () => {
    mockPrisma.deal.update.mockResolvedValue({
      id: "deal-1",
      dealName: "Test Deal",
      partnerId: "partner-new",
      partner: { id: "partner-new", name: "New Partner" },
    });

    const result = await linkDealToPartner("deal-1", "partner-new", "user@test.com");

    expect(result.data.partnerId).toBe("partner-new");
    expect(result.logWarning).toBeNull();
  });
});

describe("linkCampaignToDeal", () => {
  it("updates campaign dealId and returns updated data with regenerated name", async () => {
    mockPrisma.salesCampaign.update.mockResolvedValue({
      id: "campaign-1",
      dealId: "deal-new",
      roundNumber: null,
      campaignName: null,
      deal: { id: "deal-new", dealName: "New Deal" },
      seller: { name: "Test Seller" },
    });

    const result = await linkCampaignToDeal("campaign-1", "deal-new", "user@test.com");

    expect(result.data.dealId).toBe("deal-new");
    expect(result.data.deal.dealName).toBe("New Deal");
    expect(result.data.campaignName).toBe("New Deal - Test Seller");
    expect(result.logWarning).toBeNull();
  });

  it("generates name with round number when present", async () => {
    mockPrisma.salesCampaign.update.mockResolvedValue({
      id: "campaign-1",
      dealId: "deal-new",
      roundNumber: 3,
      campaignName: null,
      deal: { id: "deal-new", dealName: "새 딜" },
      seller: { name: "셀러" },
    });

    const result = await linkCampaignToDeal("campaign-1", "deal-new", "user@test.com");

    expect(result.data.campaignName).toBe("새 딜 - 셀러 3차");
  });

  it("returns null campaignName when seller is not linked", async () => {
    mockPrisma.salesCampaign.update.mockResolvedValue({
      id: "campaign-1",
      dealId: "deal-new",
      roundNumber: null,
      campaignName: null,
      deal: { id: "deal-new", dealName: "New Deal" },
      seller: null,
    });

    const result = await linkCampaignToDeal("campaign-1", "deal-new");

    expect(result.data.dealId).toBe("deal-new");
    expect(result.data.campaignName).toBeNull();
    expect(result.logWarning).toBeNull();
  });
});

describe("changeDealPartner", () => {
  it("changes deal partner and returns updated data", async () => {
    mockPrisma.deal.update.mockResolvedValue({
      id: "deal-1",
      dealName: "Test Deal",
      partnerId: "partner-new",
      partner: { id: "partner-new", name: "파트너B" },
    });

    const result = await changeDealPartner("deal-1", "partner-new", "admin");

    expect(result.data.partnerId).toBe("partner-new");
    expect(result.data.partner!.name).toBe("파트너B");
    expect(result.logWarning).toBeNull();
  });

  it("returns the updated partner payload for a completed reassignment flow", async () => {
    mockPrisma.deal.update.mockResolvedValue({
      id: "deal-99",
      dealName: "Glow Serum",
      partnerId: "partner-b",
      partner: { id: "partner-b", name: "Partner B" },
    });

    const result = (await changeDealPartner(
      "deal-99",
      "partner-b",
      "operator@test.com",
    )) as unknown as LinkResult<PartnerLinkData>;

    expect(result.data.partnerId).toBe("partner-b");
    expect(result.data.partner.name).toBe("Partner B");
    expect(result.logWarning).toBeNull();
  });
});

describe("changeCampaignDeal", () => {
  it("changes campaign deal and regenerates campaign name", async () => {
    mockPrisma.salesCampaign.update.mockResolvedValue({
      id: "campaign-1",
      dealId: "deal-new",
      roundNumber: null,
      campaignName: null,
      deal: { id: "deal-new", dealName: "딜B" },
      seller: { name: "셀러" },
    });

    const result = await changeCampaignDeal("campaign-1", "deal-new", "admin");

    expect(result.data.dealId).toBe("deal-new");
    expect(result.data.campaignName).toBe("딜B - 셀러");
    expect(result.logWarning).toBeNull();
  });

  it("returns the updated deal payload with campaign name including round number", async () => {
    mockPrisma.salesCampaign.update.mockResolvedValue({
      id: "campaign-99",
      dealId: "deal-b",
      roundNumber: 2,
      campaignName: null,
      deal: { id: "deal-b", dealName: "Deal B" },
      seller: { name: "Seller X" },
    });

    const result = await changeCampaignDeal(
      "campaign-99",
      "deal-b",
      "operator@test.com",
    );

    expect(result.data.dealId).toBe("deal-b");
    expect(result.data.deal.dealName).toBe("Deal B");
    expect(result.data.campaignName).toBe("Deal B - Seller X 2차");
    expect(result.logWarning).toBeNull();
  });

  it("propagates prisma not-found errors", async () => {
    const prismaError = Object.assign(new Error("not found"), { code: "P2025" });
    mockPrisma.salesCampaign.update.mockRejectedValue(prismaError);

    await expect(changeCampaignDeal("campaign-1", "deal-new", "admin")).rejects.toMatchObject({
      code: "P2025",
    });
  });

  it("returns null campaignName when seller is not linked", async () => {
    mockPrisma.salesCampaign.update.mockResolvedValue({
      id: "campaign-1",
      dealId: "deal-new",
      roundNumber: null,
      campaignName: null,
      deal: { id: "deal-new", dealName: "딜B" },
      seller: null,
    });

    const result = await changeCampaignDeal("campaign-1", "deal-new", "admin");

    expect(result.data.campaignName).toBeNull();
  });
});
