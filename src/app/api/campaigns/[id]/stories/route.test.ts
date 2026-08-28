import { beforeEach, describe, expect, it, vi } from "vitest";

const campaignFindUnique = vi.fn();
const campaignFindMany = vi.fn();
const storyFindMany = vi.fn();
const storyAggregate = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({ authenticated: true }),
}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findUnique: campaignFindUnique, findMany: campaignFindMany },
    sellerStorySnapshot: { findMany: storyFindMany, aggregate: storyAggregate },
  }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

async function callGet(query = "") {
  const { GET } = await import("./route");
  return GET(new Request(`http://test.local/api/campaigns/camp-1/stories${query}`), {
    params: Promise.resolve({ id: "camp-1" }),
  });
}

function setCampaign(endDaysAgo: number) {
  const end = new Date(Date.now() - endDaysAgo * DAY_MS);
  campaignFindUnique.mockResolvedValue({
    id: "camp-1",
    sellerId: "seller-1",
    startDate: new Date(end.getTime() - 14 * DAY_MS),
    endDate: end,
    groupId: null,
  });
}

/** 라우트가 prisma 에 넘긴 where.classification — 접힘 여부가 여기로 드러난다. */
function classificationFilter() {
  return storyFindMany.mock.calls[0]?.[0]?.where?.classification;
}

const CAPTURED_CAMPAIGN = new Date("2030-03-05T00:00:00.000Z");
const CAPTURED_LATEST = new Date("2030-03-09T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  storyFindMany.mockResolvedValue([]);
  storyAggregate.mockResolvedValue({ _max: { capturedAt: CAPTURED_LATEST } });
});

describe("GET /api/campaigns/[id]/stories — 검토 기간 종료 처리", () => {
  it("검토 기간이 지나면 확정된 홍보 스토리만 조회한다(미분류는 접힘)", async () => {
    setCampaign(30);

    const body = await (await callGet()).json();

    expect(classificationFilter()).toBe("CAMPAIGN");
    expect(body.reviewClosed).toBe(true);
  });

  it("includeClosed=1 이면 미분류 스토리를 되살린다", async () => {
    setCampaign(30);

    const body = await (await callGet("?includeClosed=1")).json();

    // 무관(OTHER)은 되살려도 계속 숨김 — 영구 숨김 계약(오너 결정4)은 이 변경과 무관하다.
    expect(classificationFilter()).toEqual({ not: "OTHER" });
    // 창의 사실은 그대로 보고해야 클라이언트가 "접기"로 돌아갈 수 있다.
    expect(body.reviewClosed).toBe(true);
  });

  it("검토 기간 안이면 미분류를 평소대로 노출한다", async () => {
    setCampaign(2);

    const body = await (await callGet()).json();

    expect(classificationFilter()).toEqual({ not: "OTHER" });
    expect(body.reviewClosed).toBe(false);
  });

  it("마지막 수집시각은 접힘 여부와 무관하게 같다 — 표시 토글이 수집 사실을 바꾸지 않는다", async () => {
    // 접힘 상태에서 조회되는 것은 CAMPAIGN 분류(더 오래 전 수집)뿐이지만, "마지막 수집"은
    // 창 전체의 사실이라 미분류를 포함한 최신값이어야 한다.
    setCampaign(30);
    storyFindMany.mockResolvedValue([
      {
        id: "s1",
        storyPk: "pk1",
        takenAt: CAPTURED_CAMPAIGN,
        capturedAt: CAPTURED_CAMPAIGN,
        mediaType: 1,
        thumbnailUrl: null,
        sourceImageUrl: null,
        caption: null,
        classification: "CAMPAIGN",
      },
    ]);

    const collapsed = await (await callGet()).json();

    expect(collapsed.lastCapturedAt).toBe(CAPTURED_LATEST.toISOString());
    expect(collapsed.lastCapturedAt).not.toBe(CAPTURED_CAMPAIGN.toISOString());
  });
});
