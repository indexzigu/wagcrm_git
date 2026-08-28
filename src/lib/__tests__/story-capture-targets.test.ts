import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  captureActiveCampaignStories,
  listCaptureWindowSellers,
} from "../story-capture";
import { fetchStoriesForHandles } from "../story-viewer-fetch";

// 대상 산정(listCaptureWindowSellers)과 셀러별 수동 수집(sellerIds 교집합 필터)의 계약을 고정한다.
// 브라우저 조작(fetchStoriesForHandles)은 mock — 이 테스트는 대상 선정·저장 로직만 본다.
vi.mock("../story-viewer-fetch", () => ({
  fetchStoriesForHandles: vi.fn(async (handles: string[]) =>
    handles.map((handle) => ({
      handle,
      // storiesig 뷰어 포맷(pk·image_versions2 없음도 허용) — parseStoryItems 최소 필수 필드만
      items: [
        {
          pk: `pk-${handle}`,
          taken_at: 1_783_990_800,
          user: { username: handle },
        },
      ],
    })),
  ),
}));

const NOW = new Date("2026-07-13T00:00:00Z");

// 수집창 판정용 캠페인 행 — 창 안(진행 중)·창 밖(과거)·비인스타·중복 셀러를 섞는다.
function campaignRows() {
  const inWindow = { startDate: new Date("2026-07-10T00:00:00Z"), endDate: new Date("2026-07-20T00:00:00Z") };
  const past = { startDate: new Date("2026-05-01T00:00:00Z"), endDate: new Date("2026-05-10T00:00:00Z") };
  const sellerA = { id: "seller-a", name: "셀러A", alias: "에이", snsType: "INSTAGRAM", snsHandle: "@Handle_A" };
  const sellerB = { id: "seller-b", name: "셀러B", alias: null, snsType: "INSTAGRAM", snsHandle: "handle_b" };
  const sellerC = { id: "seller-c", name: "셀러C", alias: null, snsType: "YOUTUBE", snsHandle: "handle_c" };
  const sellerD = { id: "seller-d", name: "셀러D", alias: null, snsType: "INSTAGRAM", snsHandle: "handle_d" };
  return [
    { ...inWindow, seller: sellerA },
    { ...inWindow, seller: sellerA }, // 같은 셀러의 2번째 캠페인 — dedup 대상
    { ...inWindow, seller: sellerB },
    { ...inWindow, seller: sellerC }, // 비인스타 — 제외
    { ...past, seller: sellerD }, // 창 밖 — 제외
  ];
}

function mockPrisma() {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    salesCampaign: { findMany: vi.fn(async () => campaignRows()) },
    sellerStorySnapshot: {
      findMany: vi.fn(async () => []), // 일일 게이트 조회(force=false 경로)
      findUnique: vi.fn(async () => null), // dedup — 전부 신규 취급
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, created };
}

beforeEach(() => {
  vi.mocked(fetchStoriesForHandles).mockClear();
});

describe("listCaptureWindowSellers", () => {
  it("창 안 인스타 셀러만 셀러 id로 dedup해 반환하고 핸들을 정규화한다", async () => {
    const { prisma } = mockPrisma();
    const sellers = await listCaptureWindowSellers(prisma, NOW);
    expect(sellers.map((s) => s.id).sort()).toEqual(["seller-a", "seller-b"]);
    const a = sellers.find((s) => s.id === "seller-a");
    expect(a?.handle).toBe("handle_a"); // @ 제거·소문자
    expect(a?.alias).toBe("에이");
  });
});

describe("captureActiveCampaignStories — sellerIds 교집합 필터", () => {
  it("sellerIds 미지정이면 창 안 전 셀러를 수집한다(기존 동작 보존)", async () => {
    const { prisma, created } = mockPrisma();
    const result = await captureActiveCampaignStories(prisma, NOW, true);
    expect(result.activeSellers).toBe(2);
    expect(vi.mocked(fetchStoriesForHandles)).toHaveBeenCalledWith(
      expect.arrayContaining(["handle_a", "handle_b"]),
    );
    expect(created).toHaveLength(2);
    expect(result.storiesNew).toBe(2);
  });

  it("sellerIds를 주면 창 안 셀러와의 교집합만 수집한다", async () => {
    const { prisma, created } = mockPrisma();
    const result = await captureActiveCampaignStories(prisma, NOW, true, ["seller-a"]);
    expect(result.activeSellers).toBe(1);
    expect(result.handles).toEqual(["handle_a"]);
    expect(vi.mocked(fetchStoriesForHandles)).toHaveBeenCalledWith(["handle_a"]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ sellerId: "seller-a", storyPk: "pk-handle_a" });
  });

  it("창 밖 셀러만 지정하면 브라우저를 띄우지 않고 대상 0으로 끝난다(창 판정 비우회)", async () => {
    const { prisma, created } = mockPrisma();
    const result = await captureActiveCampaignStories(prisma, NOW, true, ["seller-d"]);
    expect(result.activeSellers).toBe(0);
    expect(result.storiesNew).toBe(0);
    expect(vi.mocked(fetchStoriesForHandles)).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});
