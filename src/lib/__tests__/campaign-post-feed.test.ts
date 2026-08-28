import { describe, it, expect } from "vitest";
import { mergeSellerPostFeed, dedupeSellerPostsByUrl } from "../campaign-post-feed";
import { postIdentityKey } from "../reference-url";
import type { PerfPost } from "../campaign-performance-report";
import type { SuggestedPost } from "../campaign-suggested-posts";
import type { AssetRow } from "../crm-types";

function suggestion(permalink: string, takenAt: string | null): SuggestedPost {
  return {
    permalink,
    takenAt,
    likes: 10,
    likesHidden: false,
    comments: null,
    thumb: null,
    mediaType: null,
    videoUrl: null,
    recommended: false,
  };
}

function perfPost(id: string): PerfPost {
  return {
    id,
    fileName: id,
    externalUrl: `https://insta/p/${id}`,
    thumbnailUrl: null,
    caption: null,
    likes: 5,
    comments: null,
    likesHidden: false,
    mediaType: null,
    er: null,
  };
}

function asset(id: string, postedAt: string | null, createdAt: string): AssetRow {
  return {
    id,
    provider: "EXTERNAL_LINK",
    section: "SNS_CREATIVE",
    entityType: "CAMPAIGN",
    entityId: "camp-1",
    fileName: id,
    sizeBytes: 0,
    postedAt,
    createdAt,
  } as AssetRow;
}

function registered(id: string, postedAt: string | null, createdAt = "2026-01-01T00:00:00Z") {
  return { post: perfPost(id), asset: asset(id, postedAt, createdAt) };
}

describe("mergeSellerPostFeed", () => {
  it("후보와 등록을 게시시각 내림차순(최신순)으로 하나의 목록에 병합한다", () => {
    const feed = mergeSellerPostFeed(
      [suggestion("https://insta/p/cand", "2026-07-03T00:00:00Z")],
      [
        registered("reg-old", "2026-07-01T00:00:00Z"),
        registered("reg-new", "2026-07-05T00:00:00Z"),
      ],
    );
    expect(feed.map((c) => c.key)).toEqual([
      "registered:reg-new", // 07-05
      "candidate:https://insta/p/cand", // 07-03
      "registered:reg-old", // 07-01
    ]);
  });

  it("등록 게시시각은 postedAt 우선, 없으면 createdAt으로 폴백한다", () => {
    const feed = mergeSellerPostFeed(
      [],
      [
        registered("has-posted", "2026-07-10T00:00:00Z", "2026-01-01T00:00:00Z"),
        // postedAt null → createdAt(07-20)이 정렬에 쓰여 앞선다
        registered("manual", null, "2026-07-20T00:00:00Z"),
      ],
    );
    expect(feed.map((c) => c.key)).toEqual(["registered:manual", "registered:has-posted"]);
  });

  it("게시시각 미상(epoch 0)은 뒤로, 동률·미상은 입력 순서를 유지한다(안정 정렬)", () => {
    const feed = mergeSellerPostFeed(
      [suggestion("https://insta/p/no-date", null)],
      [registered("dated", "2026-07-01T00:00:00Z")],
    );
    // 날짜 있는 등록이 먼저, 날짜 미상 후보가 뒤
    expect(feed.map((c) => c.key)).toEqual([
      "registered:dated",
      "candidate:https://insta/p/no-date",
    ]);
  });

  it("status로 후보/등록을 구분하고 원본 참조를 실어 나른다", () => {
    const feed = mergeSellerPostFeed(
      [suggestion("https://insta/p/c", "2026-07-03T00:00:00Z")],
      [registered("r", "2026-07-01T00:00:00Z")],
    );
    const cand = feed.find((c) => c.status === "candidate");
    const reg = feed.find((c) => c.status === "registered");
    expect(cand?.status === "candidate" && cand.suggestion.permalink).toBe("https://insta/p/c");
    expect(reg?.status === "registered" && reg.asset.id).toBe("r");
  });
});

describe("dedupeSellerPostsByUrl (그룹 공유 중복 제거)", () => {
  type A = { id: string; externalUrl?: string | null; entityId: string };
  const a = (id: string, url: string | null, entityId: string): A => ({ id, externalUrl: url, entityId });

  it("같은 URL이 여러 회차에 등록되면 대표 1장만 남기고 byPermalink에 전 회차를 모은다", () => {
    const posts = [
      a("a1", "https://www.instagram.com/p/X/", "camp-1"),
      a("a2", "https://www.instagram.com/p/X/", "camp-2"),
      a("a3", "https://www.instagram.com/p/X/", "camp-3"),
      a("b1", "https://www.instagram.com/p/Y/", "camp-2"),
    ];
    const { deduped, byPermalink } = dedupeSellerPostsByUrl(posts, "camp-1");
    // 게시물 신원(shortcode) 기준 2장(X, Y)만
    expect(deduped).toHaveLength(2);
    // 제외 시 전 회차를 함께 보관하기 위한 역인덱스 — 키는 postIdentityKey(ig:{shortcode}), X는 3회차 전부
    const xKey = postIdentityKey("https://www.instagram.com/p/X/")!;
    expect(xKey).toBe("ig:X");
    expect(byPermalink.get(xKey)?.map((x) => x.id).sort()).toEqual(["a1", "a2", "a3"]);
    expect(
      byPermalink.get(postIdentityKey("https://www.instagram.com/p/Y/")!)?.map((x) => x.id),
    ).toEqual(["b1"]);
  });

  it("같은 게시물이 /p/와 /reel/ 두 형태로 등록돼도 하나로 판정한다(shortcode 신원)", () => {
    const posts = [
      a("p-form", "https://www.instagram.com/p/SAME/", "camp-1"),
      a("reel-form", "https://www.instagram.com/reel/SAME/", "camp-2"),
    ];
    const { deduped, byPermalink } = dedupeSellerPostsByUrl(posts, "camp-1");
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("p-form"); // 현재 캠페인 소속 우선
    expect(byPermalink.get("ig:SAME")?.map((x) => x.id).sort()).toEqual(["p-form", "reel-form"]);
  });

  it("대표는 현재 캠페인 소속 asset을 우선한다(복사·임베드가 현재 맥락에서 동작)", () => {
    const posts = [
      a("other", "https://www.instagram.com/p/X/", "camp-2"),
      a("mine", "https://www.instagram.com/p/X/", "camp-1"),
    ];
    const { deduped } = dedupeSellerPostsByUrl(posts, "camp-1");
    expect(deduped).toHaveLength(1);
    expect(deduped[0].id).toBe("mine");
  });

  it("URL이 없는 자산은 id로 고유 취급하고 byPermalink에 넣지 않는다", () => {
    const posts = [a("f1", null, "camp-1"), a("f2", null, "camp-1")];
    const { deduped, byPermalink } = dedupeSellerPostsByUrl(posts, "camp-1");
    expect(deduped.map((x) => x.id)).toEqual(["f1", "f2"]);
    expect(byPermalink.size).toBe(0);
  });
});
