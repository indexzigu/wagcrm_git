import { describe, it, expect } from "vitest";
import {
  parsePostNote,
  computeCampaignPerformance,
  aggregateErByFormat,
  dedupePostsByContent,
  type PerfPostInput,
  type PerfPost,
} from "../campaign-performance-report";
import { buildAutoNote } from "../reference-enrich";

function perfPost(id: string, url: string, er: number | null, likes: number | null): PerfPost {
  return {
    id,
    fileName: id,
    externalUrl: url,
    thumbnailUrl: null,
    caption: null,
    likes,
    comments: null,
    likesHidden: false,
    mediaType: null,
    er,
  };
}

function post(id: string, notes: string | null, extra?: Partial<PerfPostInput>): PerfPostInput {
  return { id, fileName: `${id}.post`, externalUrl: `https://x/${id}`, notes, ...extra };
}

describe("parsePostNote", () => {
  it("notes가 없으면 caption·likes 모두 null", () => {
    expect(parsePostNote(null)).toEqual({ caption: null, likes: null });
    expect(parsePostNote(undefined)).toEqual({ caption: null, likes: null });
    expect(parsePostNote("")).toEqual({ caption: null, likes: null });
  });

  it("자동수집 접두어가 없으면 수동 메모로 보고 원문을 caption, likes=null", () => {
    expect(parsePostNote("정산 확인 필요")).toEqual({ caption: "정산 확인 필요", likes: null });
  });

  it("자동수집 + 좋아요 suffix를 caption·likes로 분리", () => {
    expect(parsePostNote("[자동수집] 여름 세일 · 좋아요 1234")).toEqual({
      caption: "여름 세일",
      likes: 1234,
    });
  });

  it("자동수집이지만 좋아요 suffix가 없으면 body 전체가 caption, likes=null", () => {
    expect(parsePostNote("[자동수집] 오픈 임박")).toEqual({ caption: "오픈 임박", likes: null });
  });

  // buildAutoNote(SSOT)의 출력을 parsePostNote가 그대로 역파싱하는 왕복 계약 —
  // 포맷이 드리프트하면 이 테스트가 깨진다.
  it("buildAutoNote 왕복: 좋아요 있음", () => {
    const note = buildAutoNote("가을 신상 공구", 875);
    expect(parsePostNote(note)).toEqual({ caption: "가을 신상 공구", likes: 875 });
  });

  it("buildAutoNote 왕복: 좋아요 null이면 likes=null", () => {
    const note = buildAutoNote("좋아요 비공개 게시물", null);
    expect(parsePostNote(note)).toEqual({ caption: "좋아요 비공개 게시물", likes: null });
  });

  it("좋아요 0도 정상 파싱(0과 null 구분)", () => {
    expect(parsePostNote(buildAutoNote("반응 저조", 0))).toEqual({ caption: "반응 저조", likes: 0 });
  });
});

describe("computeCampaignPerformance — 구조화 반응 지표(3-state)", () => {
  it("구조화 likeCount가 notes 역파싱보다 우선한다", () => {
    const r = computeCampaignPerformance(
      [post("p1", buildAutoNote("캡션", 10), { likeCount: 999 })],
      { followers: 10000 },
    );
    expect(r.posts[0].likes).toBe(999);
    expect(r.posts[0].er).toBeCloseTo(9.99);
    expect(r.posts[0].caption).toBe("캡션"); // 캡션은 여전히 notes에서
  });

  it("구조화 필드가 없으면 notes 역파싱으로 폴백(레거시 자산 호환)", () => {
    const r = computeCampaignPerformance([post("p1", buildAutoNote("캡션", 10))], {
      followers: 10000,
    });
    expect(r.posts[0].likes).toBe(10);
  });

  it("likesHidden=true면 likes=null·er=null — notes에 좋아요가 있어도 숫자를 쓰지 않는다", () => {
    const r = computeCampaignPerformance(
      [post("p1", buildAutoNote("캡션", 10), { likeCount: 999, likesHidden: true, commentCount: 7 })],
      { followers: 10000 },
    );
    expect(r.posts[0].likesHidden).toBe(true);
    expect(r.posts[0].likes).toBeNull();
    expect(r.posts[0].er).toBeNull();
    expect(r.posts[0].comments).toBe(7);
    // 숨김 게시물은 좋아요 합계·평균(enriched)에 들어가지 않는다
    expect(r.enrichedCount).toBe(0);
    expect(r.totalLikes).toBeNull();
  });

  it("commentCount는 독립 필드 — 미집계면 null", () => {
    const r = computeCampaignPerformance(
      [post("p1", null, { likeCount: 5, commentCount: 0 }), post("p2", null)],
      { followers: 10000 },
    );
    expect(r.posts.find((x) => x.id === "p1")?.comments).toBe(0);
    expect(r.posts.find((x) => x.id === "p2")?.comments).toBeNull();
  });

  it("구조화 mediaType이 shortcode 맵보다 우선해 포맷별로 집계된다", () => {
    const r = computeCampaignPerformance(
      [post("p1", null, { likeCount: 10, mediaType: "reel", externalUrl: "https://x/p1" })],
      { followers: 1000 },
    );
    // shortcode 맵이 비어 있어도(비분석 셀러) 구조화 유형으로 릴스 그룹에 들어간다
    const stats = aggregateErByFormat(r.posts, {});
    expect(stats[0]).toMatchObject({ format: "reel", label: "릴스", count: 1 });
  });

  it("정렬: ER·좋아요 동률/부재 시 댓글 내림차순(숨김 게시물의 유일 지표)", () => {
    const r = computeCampaignPerformance(
      [
        post("h1", null, { likesHidden: true, commentCount: 3 }),
        post("h2", null, { likesHidden: true, commentCount: 30 }),
      ],
      { followers: 10000 },
    );
    expect(r.posts.map((x) => x.id)).toEqual(["h2", "h1"]);
  });
});

describe("computeCampaignPerformance", () => {
  it("게시물이 없으면 집계는 null, 실적 컨텍스트는 통과", () => {
    const r = computeCampaignPerformance([], {
      followers: 10000,
      actualSales: 1_000_000,
      itemCount: 50,
      orderCount: 40,
    });
    expect(r.postCount).toBe(0);
    expect(r.enrichedCount).toBe(0);
    expect(r.totalLikes).toBeNull();
    expect(r.avgLikes).toBeNull();
    expect(r.avgEr).toBeNull();
    expect(r.revenue).toBe(1_000_000);
    expect(r.quantity).toBe(50);
    expect(r.orders).toBe(40);
    expect(r.aov).toBe(25_000);
  });

  it("ER = 좋아요/팔로워×100, 평균 ER은 계산 가능한 것만", () => {
    const r = computeCampaignPerformance(
      [post("a", buildAutoNote("A", 1000)), post("b", buildAutoNote("B", 500))],
      { followers: 10000 },
    );
    const a = r.posts.find((p) => p.id === "a")!;
    const b = r.posts.find((p) => p.id === "b")!;
    expect(a.er).toBeCloseTo(10);
    expect(b.er).toBeCloseTo(5);
    expect(r.avgEr).toBeCloseTo(7.5);
    expect(r.totalLikes).toBe(1500);
    expect(r.avgLikes).toBe(750);
    expect(r.enrichedCount).toBe(2);
  });

  it("팔로워가 없으면 ER은 전부 null, 정렬은 좋아요 내림차순으로 폴백", () => {
    const r = computeCampaignPerformance(
      [post("low", buildAutoNote("low", 100)), post("high", buildAutoNote("high", 900))],
      { followers: null },
    );
    expect(r.posts.every((p) => p.er === null)).toBe(true);
    expect(r.avgEr).toBeNull();
    expect(r.posts.map((p) => p.id)).toEqual(["high", "low"]);
    expect(r.totalLikes).toBe(1000);
  });

  it("팔로워 0/음수는 ER null(0 나눗셈 가드)", () => {
    const r = computeCampaignPerformance([post("a", buildAutoNote("A", 100))], { followers: 0 });
    expect(r.posts[0].er).toBeNull();
  });

  it("좋아요 0은 집계에 포함(er=0), 미집계(null)와 구분", () => {
    const r = computeCampaignPerformance(
      [post("zero", buildAutoNote("z", 0)), post("manual", "수동 메모")],
      { followers: 1000 },
    );
    const zero = r.posts.find((p) => p.id === "zero")!;
    const manual = r.posts.find((p) => p.id === "manual")!;
    expect(zero.likes).toBe(0);
    expect(zero.er).toBe(0);
    expect(manual.likes).toBeNull();
    expect(manual.er).toBeNull();
    expect(r.enrichedCount).toBe(1); // zero만 집계됨
    expect(r.totalLikes).toBe(0);
    expect(r.avgLikes).toBe(0);
  });

  it("정렬: ER 내림차순 → 좋아요 내림차순 → 안정(원래 순서)", () => {
    const r = computeCampaignPerformance(
      [
        post("mid", buildAutoNote("mid", 500)), // er 5
        post("noer", "수동"), // er null
        post("top", buildAutoNote("top", 900)), // er 9
      ],
      { followers: 10000 },
    );
    expect(r.posts.map((p) => p.id)).toEqual(["top", "mid", "noer"]);
  });

  it("AOV: 주문수 0 또는 null이면 null", () => {
    expect(
      computeCampaignPerformance([], { actualSales: 100000, orderCount: 0 }).aov,
    ).toBeNull();
    expect(
      computeCampaignPerformance([], { actualSales: 100000, orderCount: null }).aov,
    ).toBeNull();
  });

  it("비유한(NaN)·undefined 컨텍스트는 null로 방어", () => {
    const r = computeCampaignPerformance([], {
      followers: NaN,
      actualSales: undefined,
      itemCount: NaN,
      orderCount: undefined,
    });
    expect(r.followers).toBeNull();
    expect(r.revenue).toBeNull();
    expect(r.quantity).toBeNull();
    expect(r.orders).toBeNull();
    expect(r.aov).toBeNull();
  });
});

// 그룹 캠페인에서 동일 게시물이 여러 SalesCampaign으로 들어와 중복되는 §2 버그 회귀.
describe("dedupePostsByContent (그룹 캠페인 콘텐츠 중복 제거)", () => {
  const IG = (sc: string) => `https://www.instagram.com/p/${sc}/`;

  it("같은 IG shortcode는 하나로 합친다 — 쿼리 파라미터·트래킹 꼬리가 달라도 동일", () => {
    const r = dedupePostsByContent([
      post("a", null, { externalUrl: IG("ABC") }),
      post("b", null, { externalUrl: `${IG("ABC")}?utm_source=kakao` }),
    ]);
    expect(r).toHaveLength(1);
  });

  it("충돌 시 지표가 더 풍부한 행을 남긴다(non-null 좋아요·댓글·썸네일 개수)", () => {
    const r = dedupePostsByContent([
      post("poor", null, { externalUrl: IG("ABC") }),
      post("rich", null, { externalUrl: IG("ABC"), likeCount: 10, commentCount: 2, thumbnailUrl: "t" }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("rich");
  });

  it("동률이면 먼저 온 행을 유지(안정)하고 원래 자리를 보존한다", () => {
    const r = dedupePostsByContent([
      post("first", null, { externalUrl: IG("ABC"), likeCount: 5 }),
      post("keep", null, { externalUrl: IG("XYZ") }),
      post("second", null, { externalUrl: IG("ABC"), likeCount: 9 }), // 동일 richness(1)
    ]);
    expect(r.map((p) => p.id)).toEqual(["first", "keep"]);
  });

  it("externalUrl이 없으면(합칠 근거 없음) 각 행을 고유로 통과시킨다", () => {
    const r = dedupePostsByContent([
      post("n1", null, { externalUrl: null }),
      post("n2", null, { externalUrl: null }),
    ]);
    expect(r).toHaveLength(2);
  });

  it("IG가 아닌 동일 URL도 원문 기준으로 합친다", () => {
    const r = dedupePostsByContent([
      post("a", null, { externalUrl: "https://blog.naver.com/x/1" }),
      post("b", null, { externalUrl: "https://blog.naver.com/x/1" }),
    ]);
    expect(r).toHaveLength(1);
  });

  it("computeCampaignPerformance가 중복 제거 후 postCount·평균을 계산한다", () => {
    // 같은 게시물이 그룹의 두 SalesCampaign으로 들어옴 → 게시물 1건, 좋아요 2배 계산 금지
    const r = computeCampaignPerformance(
      [
        post("dup1", null, { externalUrl: IG("ABC"), likeCount: 100 }),
        post("dup2", null, { externalUrl: IG("ABC"), likeCount: 100 }),
        post("solo", null, { externalUrl: IG("XYZ"), likeCount: 200 }),
      ],
      { followers: 10000 },
    );
    expect(r.postCount).toBe(2); // 3건 중 1건은 중복
    expect(r.totalLikes).toBe(300); // 100 + 200 (중복 100 미가산)
    expect(r.enrichedCount).toBe(2);
  });
});

describe("aggregateErByFormat", () => {
  it("shortcode로 media_type 매칭해 포맷별 집계 + avgEr 내림차순", () => {
    const posts = [
      perfPost("a", "https://www.instagram.com/p/AAA/", 5, 100), // reel
      perfPost("b", "https://www.instagram.com/reel/BBB/", 3, 50), // reel(reel 폼도 shortcode 매칭)
      perfPost("c", "https://www.instagram.com/p/CCC/", 8, 200), // image
    ];
    const map = { AAA: "reel", BBB: "reel", CCC: "image" };
    const r = aggregateErByFormat(posts, map);
    expect(r.map((s) => s.format)).toEqual(["image", "reel"]); // image 8 > reel 평균 4
    const reel = r.find((s) => s.format === "reel")!;
    expect(reel.count).toBe(2);
    expect(reel.avgEr).toBeCloseTo(4);
    expect(reel.label).toBe("릴스");
    expect(r.find((s) => s.format === "image")!.label).toBe("피드");
  });

  it("shortcode 미매칭(비IG·프리뷰 밖)은 기타(unknown)", () => {
    const r = aggregateErByFormat(
      [perfPost("a", "https://youtube.com/watch?v=x", 5, 100)],
      {},
    );
    expect(r[0].format).toBe("unknown");
    expect(r[0].label).toBe("기타");
  });

  it("알 수 없는 media_type 값도 기타로 분류", () => {
    const r = aggregateErByFormat(
      [perfPost("a", "https://www.instagram.com/p/AAA/", 5, 100)],
      { AAA: "sidecar_weird" },
    );
    expect(r[0].format).toBe("unknown");
  });

  it("er 없으면 avgEr null, 정렬은 count 내림차순 폴백", () => {
    const posts = [
      perfPost("a", "https://www.instagram.com/p/AAA/", null, 100), // reel
      perfPost("b", "https://www.instagram.com/p/BBB/", null, 50), // reel
      perfPost("c", "https://www.instagram.com/p/CCC/", null, 10), // image
    ];
    const r = aggregateErByFormat(posts, { AAA: "reel", BBB: "reel", CCC: "image" });
    expect(r.every((s) => s.avgEr === null)).toBe(true);
    expect(r.map((s) => s.format)).toEqual(["reel", "image"]); // count 2 > 1
  });

  it("빈 입력 → []", () => {
    expect(aggregateErByFormat([], {})).toEqual([]);
  });
});
