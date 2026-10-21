/**
 * `create_campaign_round` WRITE 액션 — [캘린더수집] 캘린더에서 들어온 새 회차를 만든다(가짜 tx).
 *
 * 고정하는 것:
 *  ⓪ 등록·정책 — WRITE_ACTIONS 에 있고 requestType 은 crm_mutation(언제나 수동 승인).
 *  ① 사람 승인만 — 시스템 실행자(`SYSTEM_*`)는 DB 를 읽기 전에 거부.
 *  ② 본체는 모바일 예비 캠페인과 같은 tx 주입형 함수(`createDraftCampaignInTx`) — 상태는 PREPARATION
 *     (오너 결정 ③: PROPOSAL 이면 동기화가 넘겨받은 원본 일정을 지운다). 회차는 같은 tx 에서 재부여.
 *  ③ 승인 tx 밖으로 나가지 않는다 — `getPrisma().$transaction` 을 열지 않는다.
 *  ④ 후속 처리 — 캠페인 태그 무효화 + 새 캠페인 캘린더 동기화.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const recalculateCampaignRoundsMock = vi.fn();
const recordActivityCreateMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => {
    throw new Error("이 테스트는 주입한 tx 만 써야 한다");
  },
}));
vi.mock("@/services/campaignService", () => ({
  recalculateCampaignRounds: (...args: unknown[]) => recalculateCampaignRoundsMock(...args),
}));
vi.mock("@/lib/activity-log", () => ({
  recordActivityCreate: (...args: unknown[]) => recordActivityCreateMock(...args),
  recordActivityMemo: vi.fn(),
  recordActivityChange: vi.fn(),
}));

const { executeWriteAction, resolveWriteActionEffects, WRITE_ACTIONS } = await import("../write-executor");
const { REQUEST_TYPE_BY_ACTION, getRequestTypeForAction, isAutoApprovable } = await import("../approval-policy");
const { createDraftCampaignInTx } = await import("@/lib/mobile-draft-campaign");
const { CAMPAIGN_INVALIDATION_TAGS } = await import("@/lib/cache-tags");

const dealFindUniqueMock = vi.fn();
const sellerFindUniqueMock = vi.fn();
const campaignCreateMock = vi.fn();
const campaignFindUniqueMock = vi.fn();

const tx = {
  deal: { findUnique: dealFindUniqueMock },
  seller: { findUnique: sellerFindUniqueMock },
  salesCampaign: { create: campaignCreateMock, findUnique: campaignFindUniqueMock },
} as never;

const ARGS = { dealId: "deal-1", sellerId: "seller-1", startDate: "2026-11-03", endDate: "2026-11-09" };
const APPROVER = "owner@example.com";

function primeHappyPath(status = "PREPARATION") {
  dealFindUniqueMock.mockResolvedValue({
    id: "deal-1",
    dealName: "테스트브랜드 앰플",
    dealType: "MAIN",
    status: "CONFIRMED",
    baseMarginPolicy: JSON.stringify({ byChannel: { OWN_MALL_NAVER: { totalMarginRate: 30, sellerMarginRate: 10 } } }),
  });
  sellerFindUniqueMock.mockResolvedValue({ id: "seller-1", name: "샘플셀러", alias: null });
  campaignCreateMock.mockResolvedValue({ id: "camp-new" });
  campaignFindUniqueMock.mockResolvedValue({
    id: "camp-new",
    campaignName: "테스트브랜드 앰플 - 샘플셀러 2차",
    roundNumber: 2,
    startDate: new Date("2026-11-03"),
    endDate: new Date("2026-11-09"),
    status,
    salesChannel: "OWN_MALL_NAVER",
  });
}

beforeEach(() => {
  dealFindUniqueMock.mockReset();
  sellerFindUniqueMock.mockReset();
  campaignCreateMock.mockReset();
  campaignFindUniqueMock.mockReset();
  recalculateCampaignRoundsMock.mockReset();
  recordActivityCreateMock.mockReset();
});

describe("create_campaign_round — 등록·정책", () => {
  it("WRITE_ACTIONS 에 등록돼 있다", () => {
    expect(Object.hasOwn(WRITE_ACTIONS, "create_campaign_round")).toBe(true);
  });

  it("requestType 은 crm_mutation 으로 명시 등재돼 자동승인되지 않는다", () => {
    expect(REQUEST_TYPE_BY_ACTION.create_campaign_round).toBe("crm_mutation");
    expect(getRequestTypeForAction("create_campaign_round")).toBe("crm_mutation");
    expect(isAutoApprovable("crm_mutation", "WRITE")).toBe(false);
  });

  it("argsSchema: 날짜 형식·순서·모르는 키를 거부한다", () => {
    const schema = WRITE_ACTIONS.create_campaign_round.argsSchema;
    expect(schema.safeParse(ARGS).success).toBe(true);
    expect(schema.safeParse({ ...ARGS, endDate: "2026-11-02" }).success).toBe(false);
    expect(schema.safeParse({ ...ARGS, startDate: "2026/11/03" }).success).toBe(false);
    expect(schema.safeParse({ ...ARGS, endDate: "2026-11-31" }).success).toBe(false);
    expect(schema.safeParse({ ...ARGS, status: "ACTIVE" }).success).toBe(false);
    expect(schema.safeParse({ ...ARGS, dealId: "" }).success).toBe(false);
  });
});

describe("create_campaign_round — 실행", () => {
  it("시스템 실행자는 DB 를 읽기 전에 거부한다", async () => {
    await expect(executeWriteAction("create_campaign_round", ARGS, "SYSTEM_AUTO", tx)).rejects.toThrow(/사람이/);
    expect(dealFindUniqueMock).not.toHaveBeenCalled();
    expect(campaignCreateMock).not.toHaveBeenCalled();
  });

  it("PREPARATION 상태로 만들고 같은 tx 에서 회차를 재부여한다", async () => {
    primeHappyPath();

    const result = await executeWriteAction("create_campaign_round", ARGS, APPROVER, tx);

    expect(campaignCreateMock).toHaveBeenCalledTimes(1);
    const data = campaignCreateMock.mock.calls[0][0].data;
    expect(data).toMatchObject({
      dealId: "deal-1",
      sellerId: "seller-1",
      status: "PREPARATION",
      salesChannel: "OWN_MALL_NAVER",
      baseNaverLink: "",
      generatedTrackingLink: "",
    });
    expect(recalculateCampaignRoundsMock).toHaveBeenCalledWith("deal-1", "seller-1", tx);
    expect(recordActivityCreateMock).toHaveBeenCalledWith("CAMPAIGN", "camp-new", APPROVER, tx);
    expect(result).toMatchObject({ refType: "CAMPAIGN", refId: "camp-new" });
    expect(result.summary).toContain("테스트브랜드 앰플 - 샘플셀러 2차");
    expect(result.summary).toContain("세팅대기"); // 캠페인 상태 라벨 표(campaignStatusLabels.PREPARATION)
  });

  it("없는 판매 조건이면 실패한다(승인 tx 롤백 → 기안 FAILED)", async () => {
    primeHappyPath();
    dealFindUniqueMock.mockResolvedValue(null);

    await expect(executeWriteAction("create_campaign_round", ARGS, APPROVER, tx)).rejects.toThrow(/판매 조건/);
    expect(campaignCreateMock).not.toHaveBeenCalled();
  });

  it("후속 처리: 캠페인 태그 무효화 + 새 캠페인 캘린더 동기화", () => {
    const spec = resolveWriteActionEffects("create_campaign_round", {
      refType: "CAMPAIGN",
      refId: "camp-new",
      summary: "x",
    });
    expect(spec.revalidate).toEqual(CAMPAIGN_INVALIDATION_TAGS);
    expect(spec.calendarCampaignId).toBe("camp-new");
  });
});

describe("createDraftCampaignInTx — 상태는 호출부가 정한다", () => {
  it("주입한 tx 와 status 인자대로 만든다(모바일 래퍼는 PROPOSAL, 캘린더 기안은 PREPARATION)", async () => {
    primeHappyPath("PROPOSAL");
    const proposal = await createDraftCampaignInTx(tx, { ...ARGS, status: "PROPOSAL" });
    expect(campaignCreateMock.mock.calls[0][0].data.status).toBe("PROPOSAL");
    expect(proposal).toMatchObject({ id: "camp-new", roundNumber: 2, sellerName: "샘플셀러" });

    primeHappyPath("PREPARATION");
    await createDraftCampaignInTx(tx, { ...ARGS, status: "PREPARATION" });
    expect(campaignCreateMock.mock.calls[1][0].data.status).toBe("PREPARATION");
  });

  it("날짜 순서가 틀리면 tx 를 건드리기 전에 거부한다", async () => {
    await expect(
      createDraftCampaignInTx(tx, { ...ARGS, endDate: "2026-11-01", status: "PREPARATION" }),
    ).rejects.toThrow(/종료일/);
    expect(dealFindUniqueMock).not.toHaveBeenCalled();
  });
});
