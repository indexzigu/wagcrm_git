import { beforeEach, describe, expect, it, vi } from "vitest";

const campaignFindUnique = vi.fn();
const campaignFindMany = vi.fn();
const profileFindUnique = vi.fn();
const assetFindMany = vi.fn();
const classificationFindMany = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({ authenticated: true }),
}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findUnique: campaignFindUnique, findMany: campaignFindMany },
    sellerAiProfile: { findUnique: profileFindUnique },
    asset: { findMany: assetFindMany },
    sellerPostClassification: { findMany: classificationFindMany },
  }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

async function callGet(query = "") {
  const { GET } = await import("./route");
  return GET(new Request(`http://test.local/api/campaigns/camp-1/suggested-posts${query}`), {
    params: Promise.resolve({ id: "camp-1" }),
  });
}

/**
 * 캠페인 기간을 now 기준 상대일로 세팅한다(마감이 며칠 전인지가 검토 종료 판정의 전부).
 * 프리뷰 게시물은 **캠페인 마감 이틀 전**에 놓는다 — 후보 창(시작−7일~마감+1일)은 캠페인 날짜에
 * 상대적이라, now 기준 고정 오프셋으로 두면 캠페인을 옮길 때 게시물이 조용히 창 밖으로 나간다.
 */
function setCampaign(endDaysAgo: number) {
  const end = new Date(Date.now() - endDaysAgo * DAY_MS);
  campaignFindUnique.mockResolvedValue({
    id: "camp-1",
    sellerId: "seller-1",
    startDate: new Date(end.getTime() - 14 * DAY_MS),
    endDate: end,
    groupId: null,
  });
  profileFindUnique.mockResolvedValue({
    aiTags: {
      postsCollectedAt: "2030-03-20T15:00:00.000Z",
      postsPreview: [
        {
          permalink: "https://www.instagram.com/p/AAA111/",
          taken_at: new Date(end.getTime() - 2 * DAY_MS).toISOString(),
          likes: 10,
          comments: 2,
          is_gongu: true,
        },
      ],
    },
    analyzedAt: null,
  });
  return end;
}

beforeEach(() => {
  vi.clearAllMocks();
  assetFindMany.mockResolvedValue([]);
  classificationFindMany.mockResolvedValue([]);
});

describe("GET /api/campaigns/[id]/suggested-posts — 검토 기간 종료 처리", () => {
  it("검토 기간이 지나면 후보를 접고, 등록·분류 조회를 아예 건너뛴다", async () => {
    setCampaign(30);

    const res = await callGet();
    const body = await res.json();

    expect(body.reviewClosed).toBe(true);
    expect(body.suggestions).toEqual([]);
    // 쿼리 생략이 이 변경의 실제 절감분이다 — 접기만 하고 조회는 그대로면 의미가 없다.
    expect(assetFindMany).not.toHaveBeenCalled();
    expect(classificationFindMany).not.toHaveBeenCalled();
  });

  it("접혀도 수집시각·그룹 스코프는 계속 내려준다(헤더 표시·등록 목록 필터가 의존)", async () => {
    setCampaign(30);

    const body = await (await callGet()).json();

    expect(body.lastCollectedAt).toBe("2030-03-20T15:00:00.000Z");
    expect(body.sharedCampaignIds).toEqual(["camp-1"]);
  });

  it("includeClosed=1 이면 접힌 후보를 되살린다 — 뒤늦은 홍보 게시물 등록 경로", async () => {
    setCampaign(30);

    const body = await (await callGet("?includeClosed=1")).json();

    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0].permalink).toBe("https://www.instagram.com/p/AAA111/");
    expect(assetFindMany).toHaveBeenCalled();
  });

  it("펼쳐 본 동안에도 reviewClosed 는 창의 사실을 그대로 보고한다(접기로 돌아갈 근거)", async () => {
    setCampaign(30);

    const body = await (await callGet("?includeClosed=1")).json();

    expect(body.reviewClosed).toBe(true);
  });

  it("검토 기간 안이면 평소대로 후보를 계산한다", async () => {
    setCampaign(2);

    const body = await (await callGet()).json();

    expect(body.reviewClosed).toBe(false);
    expect(body.suggestions).toHaveLength(1);
  });
});
