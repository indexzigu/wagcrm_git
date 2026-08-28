// @vitest-environment jsdom
// 종료된 캠페인의 미검토 후보·스토리 접힘 — 실렌더 회귀(오너 2026-07-31).
// 서버(suggested-posts·stories 라우트)가 reviewClosed 를 내려주면 화면이 ①미검토 항목을 감추고
// ②되살리는 길을 남기는지, 그리고 ③펼침이 실제로 includeClosed 를 붙여 재조회하는지를 고정한다.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AssetManager } from "../asset-manager";
import type { AssetRow, CampaignRow, StorageSummary } from "@/lib/crm-types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
// 인스타 임베드는 외부 스크립트를 로드한다 — 접힘 판정과 무관하므로 스텁.
vi.mock("../instagram-embed", () => ({ InstagramEmbed: () => null }));

const campaign = {
  id: "camp-1",
  dealId: "deal-1",
  sellerId: "seller-1",
  campaignName: "테스트 딜 테스트 셀러",
  dealName: "테스트 딜",
  sellerName: "테스트 셀러",
  snsType: "INSTAGRAM",
  snsHandle: "@test_seller",
  startDate: "2030-02-24",
  endDate: "2030-03-10",
  status: "SETTLEMENT_WAIT",
  currentFollowers: 10000,
  actualSales: null,
  quantity: null,
  itemCount: null,
  notes: [],
  followerHistory: [],
  activityHistory: [],
} as unknown as CampaignRow;

const storage = { totalBytes: 0, byProvider: {} } as unknown as StorageSummary;
const initialAssets: AssetRow[] = [];

const CANDIDATE = {
  permalink: "https://www.instagram.com/p/AAA111/",
  takenAt: "2030-03-08T00:00:00.000Z",
  likes: 10,
  likesHidden: false,
  comments: 2,
  thumb: null,
  mediaType: "IMAGE",
  videoUrl: null,
  recommended: true,
};

const UNREVIEWED_STORY = {
  id: "story-1",
  storyPk: "pk-1",
  takenAt: "2030-03-08T00:00:00.000Z",
  capturedAt: "2030-03-08T01:00:00.000Z",
  mediaType: 1,
  thumbnailUrl: null,
  sourceImageUrl: null,
  caption: null,
  classification: "UNREVIEWED",
};

/** 라우트별 응답을 URL 로 가른다 — includeClosed 유무에 따라 서버가 주는 것이 달라지는 걸 흉내낸다. */
function installFetch() {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const expanded = url.includes("includeClosed=1");
    if (url.includes("/suggested-posts")) {
      return jsonResponse({
        // 서버는 접힘 상태에서 후보를 아예 계산하지 않는다(빈 배열).
        suggestions: expanded ? [CANDIDATE] : [],
        lastCollectedAt: "2030-03-20T15:00:00.000Z",
        sharedCampaignIds: ["camp-1"],
        // 창의 사실이라 펼쳐도 true 로 유지된다 — "다시 접기"의 근거.
        reviewClosed: true,
      });
    }
    if (url.includes("/stories")) {
      return jsonResponse({
        stories: expanded ? [UNREVIEWED_STORY] : [],
        lastCapturedAt: null,
        reviewClosed: true,
      });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AssetManager — 종료된 캠페인의 미검토 항목 접힘", () => {
  it("접혔다는 사실과 되살리는 길을 함께 보여준다(무음으로 사라지지 않는다)", async () => {
    installFetch();
    render(
      <AssetManager campaign={campaign} initialAssets={initialAssets} storage={storage} />,
    );

    expect(await screen.findByText(/종료된 캠페인/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "미검토 항목 보기" })).toBeInTheDocument();
  });

  it("빈 피드의 문구가 '정말 없다'로 오해되지 않게 펼치는 길을 안내한다", async () => {
    installFetch();
    render(
      <AssetManager campaign={campaign} initialAssets={initialAssets} storage={storage} />,
    );

    // 등록 0건 + 후보 접힘이 이 기능이 겨냥하는 바로 그 상태다 — 여기서 "없습니다"만 말하면
    // 숨겨둔 후보를 영영 못 찾는다.
    expect(await screen.findByText(/미검토 후보는 위에서 펼쳐 볼 수 있습니다/)).toBeInTheDocument();
  });

  it("접힌 동안 후보 카드도 미분류 스토리도 렌더되지 않는다", async () => {
    installFetch();
    render(
      <AssetManager campaign={campaign} initialAssets={initialAssets} storage={storage} />,
    );

    await screen.findByText(/종료된 캠페인/);
    // 후보 카드의 등록 액션("홍보")·스토리 분류 버튼이 하나도 없어야 한다.
    expect(screen.queryByRole("button", { name: "홍보" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "무관" })).not.toBeInTheDocument();
  });

  it("펼치면 includeClosed=1 로 두 라우트를 다시 조회한다", async () => {
    const calls = installFetch();
    render(
      <AssetManager campaign={campaign} initialAssets={initialAssets} storage={storage} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "미검토 항목 보기" }));

    await waitFor(() => {
      expect(calls.some((u) => u.includes("/suggested-posts?includeClosed=1"))).toBe(true);
      expect(calls.some((u) => u.includes("/stories?includeClosed=1"))).toBe(true);
    });
  });

  it("펼치면 미검토 항목이 실제로 돌아오고, 다시 접을 수 있다", async () => {
    installFetch();
    render(
      <AssetManager campaign={campaign} initialAssets={initialAssets} storage={storage} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "미검토 항목 보기" }));

    // 후보·스토리가 되살아난다(뒤늦은 홍보 게시물 등록 경로가 살아 있다는 증거).
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "홍보" }).length).toBeGreaterThan(0);
    });
    // reviewClosed 가 계속 true 라 되돌아갈 버튼이 남는다.
    expect(screen.getByRole("button", { name: "다시 접기" })).toBeInTheDocument();
  });
});

describe("AssetManager — 진행 중 캠페인은 종전대로", () => {
  it("reviewClosed=false 면 알림 줄 없이 후보를 그대로 노출한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/suggested-posts")) {
          return jsonResponse({
            suggestions: [CANDIDATE],
            lastCollectedAt: null,
            sharedCampaignIds: ["camp-1"],
            reviewClosed: false,
          });
        }
        if (url.includes("/stories")) {
          return jsonResponse({ stories: [], lastCapturedAt: null, reviewClosed: false });
        }
        return jsonResponse({});
      }),
    );

    render(
      <AssetManager campaign={campaign} initialAssets={initialAssets} storage={storage} />,
    );

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "홍보" }).length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/종료된 캠페인/)).not.toBeInTheDocument();
  });
});
