import { beforeEach, describe, expect, it, vi } from "vitest";

const campaignFindUnique = vi.fn();
const profileFindUnique = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({ authenticated: true }),
}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findUnique: campaignFindUnique },
    sellerAiProfile: { findUnique: profileFindUnique },
  }),
}));

async function callGet() {
  const { GET } = await import("./route");
  return GET(new Request("http://test.local/api/campaigns/camp-1/post-formats"), {
    params: Promise.resolve({ id: "camp-1" }),
  });
}

describe("GET /api/campaigns/[id]/post-formats", () => {
  beforeEach(() => {
    campaignFindUnique.mockReset();
    profileFindUnique.mockReset();
    campaignFindUnique.mockResolvedValue({ sellerId: "seller-1" });
  });

  it("returns formats and a slim baseline sample from the same aiTags read", async () => {
    profileFindUnique.mockResolvedValue({
      aiTags: {
        postsPreview: [
          { permalink: "https://www.instagram.com/p/AAA/", media_type: "reel", likes: 120, comments: 4, thumb: "t", taken_at: "2030-01-02T00:00:00.000Z" },
          { permalink: "https://www.instagram.com/p/BBB/", media_type: "image", likes: 0, likes_hidden: true },
        ],
      },
    });
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.formats).toEqual({ AAA: "reel", BBB: "image" });
    expect(body.baselineSample).toEqual({
      analyzed: true,
      posts: [
        { shortcode: "AAA", likes: 120, hidden: false, takenAt: "2030-01-02T00:00:00.000Z" },
        { shortcode: "BBB", likes: null, hidden: true, takenAt: null },
      ],
    });
    // 슬림 계약 — 썸네일·댓글 등 표본 밖 필드는 내리지 않는다.
    expect(Object.keys(body.baselineSample.posts[0]).sort()).toEqual(["hidden", "likes", "shortcode", "takenAt"]);
    expect(profileFindUnique).toHaveBeenCalledTimes(1);
  });

  it("marks the sample as not analyzed when the seller has no profile", async () => {
    profileFindUnique.mockResolvedValue(null);
    const body = await (await callGet()).json();
    expect(body.baselineSample).toEqual({ analyzed: false, posts: [] });
  });

  it("404s for an unknown campaign", async () => {
    campaignFindUnique.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(404);
  });
});
