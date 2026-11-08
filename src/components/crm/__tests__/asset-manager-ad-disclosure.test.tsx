// @vitest-environment jsdom
// 게시 후 광고 표기 점검 — 등록(홍보) 카드에 「광고표기미흡」이 붙고, 정상·오너 메모·본문 미수집 카드에는
// 안 붙는지, 피드 머리 건수가 맞는지를 실렌더로 고정한다(판정 자체는 ad-disclosure.test.ts).
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AssetManager } from "../asset-manager";
import type { AssetRow, CampaignRow, StorageSummary } from "@/lib/crm-types";
import { AUTO_NOTE_PREFIX } from "@/lib/reference-enrich";

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
  status: "ACTIVE",
  currentFollowers: 10000,
  actualSales: null,
  quantity: null,
  itemCount: null,
  notes: [],
  followerHistory: [],
  activityHistory: [],
} as unknown as CampaignRow;

const storage = { totalBytes: 0, byProvider: {} } as unknown as StorageSummary;

function postAsset(id: string, notes: string | null, mediaType: string | null = "image"): AssetRow {
  return {
    id,
    provider: "EXTERNAL_LINK",
    section: "SNS_CREATIVE",
    entityType: "CAMPAIGN",
    entityId: "camp-1",
    campaignId: "camp-1",
    fileName: id,
    sizeBytes: 0,
    externalUrl: `https://www.instagram.com/p/${id.toUpperCase()}/`,
    thumbnailUrl: null,
    notes,
    likeCount: 10,
    commentCount: 1,
    likesHidden: false,
    mediaType,
    postedAt: "2030-03-01T00:00:00.000Z",
    createdAt: "2030-03-01T00:00:00.000Z",
    archivedAt: null,
  } as unknown as AssetRow;
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ suggestions: [], stories: [], lastCollectedAt: null, reviewClosed: false }),
    })),
  );
}

describe("AssetManager — 게시 후 광고 표기 점검", () => {
  it("미흡 카드에만 배지가 붙고 머리에 건수가 뜬다", async () => {
    installFetch();
    const assets = [
      postAsset("ok1", `${AUTO_NOTE_PREFIX}#광고 겨울 앰플 공구`),
      postAsset("missing1", `${AUTO_NOTE_PREFIX}겨울 앰플 공구 오픈`),
      postAsset("late1", `${AUTO_NOTE_PREFIX}겨울 앰플 공구\n#광고`, "reel"),
      postAsset("memo1", "셀러에게 재촬영 요청함"),
      postAsset("empty1", null),
    ];
    render(<AssetManager campaign={campaign} initialAssets={assets} storage={storage} />);

    expect(await screen.findByTestId("ad-disclosure-summary")).toHaveTextContent("광고표기미흡 2건");
    expect(screen.getAllByTestId("ad-disclosure-badge")).toHaveLength(2);
  });

  it("전부 정상이고 미수집이 없으면 아무것도 그리지 않는다", async () => {
    installFetch();
    render(
      <AssetManager
        campaign={campaign}
        initialAssets={[postAsset("ok1", `${AUTO_NOTE_PREFIX}#광고 앰플`)]}
        storage={storage}
      />,
    );
    await screen.findAllByText(/좋아요/);
    expect(screen.queryByTestId("ad-disclosure-summary")).toBeNull();
    expect(screen.queryByTestId("ad-disclosure-badge")).toBeNull();
  });

  it("본문 미수집만 있으면 「미점검」을 낮은 톤으로 센다(침묵이 통과로 읽히지 않게)", async () => {
    installFetch();
    render(
      <AssetManager
        campaign={campaign}
        initialAssets={[postAsset("ok1", `${AUTO_NOTE_PREFIX}#광고 앰플`), postAsset("memo1", "메모")]}
        storage={storage}
      />,
    );
    expect(await screen.findByTestId("ad-disclosure-summary")).toHaveTextContent("광고표기미점검 1건");
    expect(screen.queryByTestId("ad-disclosure-badge")).toBeNull();
  });
});
