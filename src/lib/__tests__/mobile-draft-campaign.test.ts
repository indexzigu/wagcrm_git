import { describe, it, expect, vi, beforeEach } from "vitest";

// prisma·campaignService 는 모킹 — createDraftCampaign 의 tx 오케스트레이션만 검증
vi.mock("@/lib/prisma", () => ({
  getPrisma: vi.fn(),
}));
vi.mock("@/services/campaignService", () => ({
  recalculateCampaignRounds: vi.fn(),
}));

import { getPrisma } from "@/lib/prisma";
import { recalculateCampaignRounds } from "@/services/campaignService";
import {
  createDraftCampaign,
  DraftCampaignError,
} from "@/lib/mobile-draft-campaign";

/**
 * 예비 캠페인 경량 생성(MOBILE_UX_PLAN §4 · Phase 4) 로직 검증:
 * PROPOSAL 저장, recalculateCampaignRounds 동일 tx 호출, 존재하지 않는
 * 딜/셀러 명시 에러, endDate<startDate 거부, bulk 동일 마진 유도.
 */

const mockTx = {
  deal: { findUnique: vi.fn() },
  seller: { findUnique: vi.fn() },
  salesCampaign: { create: vi.fn(), findUnique: vi.fn() },
};

const mockPrisma = {
  $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
};

const INPUT = {
  dealId: "deal-1",
  sellerId: "seller-1",
  startDate: "2026-07-10",
  endDate: "2026-07-20",
};

const DEAL = {
  id: "deal-1",
  dealName: "비타민C 앰플",
  dealType: "MAIN",
  status: "CONFIRMED",
  baseMarginPolicy: JSON.stringify({
    byChannel: { OWN_MALL_NAVER: { totalMarginRate: 30, sellerMarginRate: 10 } },
  }),
};

const SELLER = { id: "seller-1", name: "김하늘", alias: "하늘맘" };

function primeHappyPath() {
  mockTx.deal.findUnique.mockResolvedValue(DEAL);
  mockTx.seller.findUnique.mockResolvedValue(SELLER);
  mockTx.salesCampaign.create.mockResolvedValue({ id: "camp-new" });
  // recalculateCampaignRounds 후 tx 내 재조회 결과 — 이름·차수가 부여된 상태
  mockTx.salesCampaign.findUnique.mockResolvedValue({
    id: "camp-new",
    campaignName: "비타민C 앰플 - 하늘맘 2차",
    roundNumber: 2,
    startDate: new Date("2026-07-10"),
    endDate: new Date("2026-07-20"),
    status: "PROPOSAL",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPrisma).mockReturnValue(mockPrisma as never);
});

describe("createDraftCampaign — 저장 값", () => {
  it("status PROPOSAL·링크 빈값·딜 정책 첫 채널 마진으로 저장한다", async () => {
    primeHappyPath();

    await createDraftCampaign(INPUT);

    expect(mockTx.salesCampaign.create).toHaveBeenCalledTimes(1);
    const data = mockTx.salesCampaign.create.mock.calls[0][0].data;
    expect(data.status).toBe("PROPOSAL");
    expect(data.baseNaverLink).toBe("");
    expect(data.generatedTrackingLink).toBe("");
    expect(data.salesChannel).toBe("OWN_MALL_NAVER");
    expect(data.totalMarginRate).toBe(30);
    expect(data.sellerMarginRate).toBe(10);
    expect(data.netMarginRate).toBe(20);
    expect(data.startDate).toEqual(new Date("2026-07-10"));
    expect(data.endDate).toEqual(new Date("2026-07-20"));
    // 캠페인명·차수는 직접 저장하지 않는다 — recalculateCampaignRounds 소관
    expect(data.campaignName).toBeUndefined();
    expect(data.roundNumber).toBeUndefined();
  });

  it("recalculateCampaignRounds 를 같은 tx 로 호출한다(이름·차수 자동 부여)", async () => {
    primeHappyPath();

    await createDraftCampaign(INPUT);

    expect(recalculateCampaignRounds).toHaveBeenCalledTimes(1);
    const [dealId, sellerId, tx] = vi.mocked(recalculateCampaignRounds).mock.calls[0];
    expect(dealId).toBe("deal-1");
    expect(sellerId).toBe("seller-1");
    // 캠페인을 만든 바로 그 트랜잭션 클라이언트여야 원자성이 보장된다
    expect(tx).toBe(mockTx);
  });

  it("재계산 결과의 캠페인명·차수·alias 우선 셀러명을 반환한다", async () => {
    primeHappyPath();

    const result = await createDraftCampaign(INPUT);

    expect(result).toMatchObject({
      id: "camp-new",
      dealId: "deal-1",
      sellerId: "seller-1",
      campaignName: "비타민C 앰플 - 하늘맘 2차",
      roundNumber: 2,
      status: "PROPOSAL",
      dealName: "비타민C 앰플",
      sellerName: "하늘맘", // alias 우선 (P2)
    });
    expect(result.startDate).toBe(new Date("2026-07-10").toISOString());
    expect(result.endDate).toBe(new Date("2026-07-20").toISOString());
  });

  it("alias 가 없으면 셀러 실명을 반환한다", async () => {
    primeHappyPath();
    mockTx.seller.findUnique.mockResolvedValue({ ...SELLER, alias: null });

    const result = await createDraftCampaign(INPUT);

    expect(result.sellerName).toBe("김하늘");
  });
});

describe("createDraftCampaign — 검증·에러", () => {
  it("존재하지 않는 딜이면 404 DraftCampaignError, 캠페인 생성 없음", async () => {
    mockTx.deal.findUnique.mockResolvedValue(null);

    const promise = createDraftCampaign(INPUT);

    await expect(promise).rejects.toBeInstanceOf(DraftCampaignError);
    await expect(promise).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("딜"),
    });
    expect(mockTx.salesCampaign.create).not.toHaveBeenCalled();
    expect(recalculateCampaignRounds).not.toHaveBeenCalled();
  });

  it("존재하지 않는 셀러면 404 DraftCampaignError, 캠페인 생성 없음", async () => {
    mockTx.deal.findUnique.mockResolvedValue(DEAL);
    mockTx.seller.findUnique.mockResolvedValue(null);

    const promise = createDraftCampaign(INPUT);

    await expect(promise).rejects.toBeInstanceOf(DraftCampaignError);
    await expect(promise).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("셀러"),
    });
    expect(mockTx.salesCampaign.create).not.toHaveBeenCalled();
  });

  it("endDate < startDate 는 트랜잭션 진입 전에 400 으로 거부한다", async () => {
    const promise = createDraftCampaign({
      ...INPUT,
      startDate: "2026-07-20",
      endDate: "2026-07-10",
    });

    await expect(promise).rejects.toBeInstanceOf(DraftCampaignError);
    await expect(promise).rejects.toMatchObject({ status: 400 });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("YYYY-MM-DD 형식이 아니면 400 으로 거부한다", async () => {
    await expect(
      createDraftCampaign({ ...INPUT, startDate: "07/10/2026" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("시작일 = 종료일(하루짜리 예비 일정)은 허용한다", async () => {
    primeHappyPath();

    await expect(
      createDraftCampaign({ ...INPUT, endDate: INPUT.startDate }),
    ).resolves.toBeTruthy();
  });
});
