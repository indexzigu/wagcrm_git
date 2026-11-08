// @vitest-environment jsdom
// [셀러분석] 캠페인 성과 리포트의 「평소 대비 N배」 — 실렌더 회귀.
// ① 평소 표본이 있으면 요약 카드 초점에 배수 + 근거 줄, 게시물 줄에 게시물별 배수
// ② 이 캠페인 게시물 자신은 평소 표본에서 빠진다
// ③ 계산 불가·조회 실패면 숫자 대신 사유(가짜 숫자 금지)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AssetManager } from "../asset-manager";
import type { AssetRow, CampaignRow, StorageSummary } from "@/lib/crm-types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
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

function sellerPost(id: string, shortcode: string, likeCount: number | null): AssetRow {
  return {
    id,
    provider: "EXTERNAL_LINK",
    section: "SELLER_POST",
    entityType: "CAMPAIGN",
    entityId: "camp-1",
    campaignId: "camp-1",
    fileName: id,
    sizeBytes: 0,
    externalUrl: `https://www.instagram.com/p/${shortcode}/`,
    likeCount,
    commentCount: 3,
    likesHidden: false,
    createdAt: "2030-03-01T00:00:00.000Z",
  } as unknown as AssetRow;
}

/** 평소 표본: 100 좋아요 5건 + 이 캠페인 게시물 자신(MINE, 9000 — 섞이면 기준이 올라간다). */
const SAMPLE = {
  analyzed: true,
  posts: [
    ...["a", "b", "c", "d", "e"].map((sc) => ({ shortcode: sc, likes: 100, hidden: false, takenAt: null })),
    { shortcode: "MINE", likes: 9000, hidden: false, takenAt: null },
  ],
};

function installFetch(postFormats: () => Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/post-formats")) return postFormats();
      if (url.includes("/suggested-posts")) {
        return json({ suggestions: [], lastCollectedAt: null, sharedCampaignIds: ["camp-1"], reviewClosed: false });
      }
      if (url.includes("/stories")) return json({ stories: [], lastCapturedAt: null, reviewClosed: false });
      return json({});
    }),
  );
}

function json(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("AssetManager — 평소 대비 N배", () => {
  it("shows the campaign multiple as the focal number and per-post multiples", async () => {
    installFetch(async () => json({ formats: {}, baselineSample: SAMPLE }));
    render(
      <AssetManager
        campaign={campaign}
        initialAssets={[sellerPost("p1", "MINE", 180)]}
        storage={storage}
      />,
    );
    // 게시물 좋아요 180 ÷ 평소 100(자기 9000 제외 — 제외가 빠지면 「게시물 6개」) = 1.8배
    await waitFor(() => expect(screen.getByText("1.8배")).toBeTruthy());
    expect(screen.getByText("평소 좋아요 100 · 게시물 5개")).toBeTruthy();
    expect(screen.getByText("평소 대비 1.8배")).toBeTruthy();
  });

  it("speaks the reason instead of a number when the sample is too small", async () => {
    installFetch(async () =>
      json({ formats: {}, baselineSample: { analyzed: true, posts: SAMPLE.posts.slice(0, 3) } }),
    );
    render(<AssetManager campaign={campaign} initialAssets={[sellerPost("p1", "MINE", 180)]} storage={storage} />);
    await waitFor(() => expect(screen.getByText("평소 게시물 3개 · 5개부터 계산")).toBeTruthy());
    expect(screen.queryByText(/평소 대비 \d/)).toBeNull();
  });

  it("says it is loading instead of showing a dash", async () => {
    installFetch(() => new Promise<Response>(() => {}));
    render(<AssetManager campaign={campaign} initialAssets={[sellerPost("p1", "MINE", 180)]} storage={storage} />);
    expect(await screen.findByText("불러오는 중")).toBeTruthy();
  });

  it("surfaces a load failure as a reason, not silence", async () => {
    installFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response);
    render(<AssetManager campaign={campaign} initialAssets={[sellerPost("p1", "MINE", 180)]} storage={storage} />);
    await waitFor(() => expect(screen.getByText("평소 수치를 불러오지 못함")).toBeTruthy());
  });
});
