import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// 수동 인제스트(북마클릿·로컬 러너) 경로의 storiesig v2 회귀.
//
// 왜 이 테스트가 있나: 뷰어가 2026-10-03 API 를 v2 로 바꾸면서 스토리 항목에서 작성자가 빠지고
// 응답의 `result.owner` 로 옮겨갔다. 자동 수집 경로(story-viewer-fetch)는 #155 에서 owner 를 붙이게
// 고쳤지만 이 경로는 호출자가 보낸 items 를 그대로 파싱해, v2 항목은 작성자 불명으로 전부 버려진다.
// 파서·저장부(storeStorySnapshots 의 핸들 귀속 필터)는 실물을 태우고 DB·인증만 가짜로 둔다.

const createMock = vi.fn();

vi.mock("@/lib/kakao/ingest-auth", () => ({ verifyIngestAuth: () => true }));
vi.mock("@/lib/kakao/ingest-lane", () => ({ ingestLaneGuard: () => ({ rejection: null, envelope: {} }) }));
vi.mock("@/lib/seller-analysis/seller-media-storage", () => ({
  isSellerMediaStorageConfigured: () => false,
  extFromContentType: () => "jpg",
  publicMediaUrl: () => "",
  uploadBytes: async () => {},
}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    seller: { findFirst: async () => ({ id: "seller-1" }) },
    sellerStorySnapshot: {
      findUnique: async () => null,
      create: (...args: unknown[]) => createMock(...args),
    },
  }),
}));

const v2Item = (id: string) => ({
  id,
  type: "image",
  url: "https://cdn.example.com/a.jpg",
  thumbnailUrl: "https://cdn.example.com/a-thumb.jpg",
  takenAt: 1791205766,
});

function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/stories/ingest", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/stories/ingest — storiesig v2 항목", () => {
  beforeEach(() => createMock.mockReset());

  it("v2 응답의 owner 를 함께 보내면 작성자 없는 항목에 붙여 저장한다", async () => {
    const res = await POST(post({ handle: "someone", owner: { username: "someone" }, items: [v2Item("s-1")] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.storiesSeen).toBe(1);
    expect(body.storiesNew).toBe(1);
    expect(createMock).toHaveBeenCalledOnce();
  });

  it("owner 없이 v2 항목만 보내면 요청한 핸들을 작성자로 삼는다", async () => {
    const res = await POST(post({ handle: "@Someone", items: [v2Item("s-1"), v2Item("s-2")] }));
    const body = await res.json();

    expect(body.storiesSeen).toBe(2);
    expect(body.storiesNew).toBe(2);
  });

  it("owner 가 다른 계정이면 저장하지 않는다(요청 외 계정 귀속 방지선 유지)", async () => {
    const res = await POST(post({ handle: "someone", owner: { username: "other" }, items: [v2Item("s-1")] }));
    const body = await res.json();

    expect(body.storiesNew).toBe(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("v1 항목(user.username 보유)은 종전대로 그 작성자로 판정한다", async () => {
    const v1 = { pk: "p-1", taken_at: 1791205766, user: { username: "other" } };
    const res = await POST(post({ handle: "someone", items: [v1] }));
    const body = await res.json();

    // 작성자가 이미 있는 항목에는 핸들을 덮어쓰지 않는다 — 남의 스토리가 섞여 오면 걸러져야 한다.
    expect(body.storiesSeen).toBe(1);
    expect(body.storiesNew).toBe(0);
  });
});
