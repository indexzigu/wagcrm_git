// @vitest-environment jsdom
// 내 콘텐츠 성과 출력 규약 계약 테스트 (오너 결정 2026-07-11).
// ① 캠페인 게시물은 "전체" 노출된다(베스트 1건 축약 금지 — 접힘(<details>)은 허용, 누락은 금지).
// ② 좋아요를 숨긴 게시물은 임의 숫자 없이 "비공개"로 표기한다(숫자·0 센티널 렌더 금지).
// ③ 미집계는 "집계 전"으로 구분한다(숨김≠미집계≠0의 3-state).
// 표기 문자열의 SSOT는 postMetricsLine — 여기서 규약이 깨지면 이 테스트가 먼저 깨진다.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import {
  ContentPerformanceSection,
  postMetricsLine,
} from "../content-performance";
import {
  computeCampaignPerformance,
  type PerfPost,
  type PerfPostInput,
} from "@/lib/campaign-performance-report";

function post(id: string, extra?: Partial<PerfPostInput>): PerfPostInput {
  return {
    id,
    fileName: `${id}.post`,
    externalUrl: `https://www.instagram.com/p/${id}/`,
    ...extra,
  };
}

function perf(posts: PerfPostInput[], followers = 10_000) {
  return computeCampaignPerformance(posts, { followers });
}

describe("postMetricsLine 표기 규약(SSOT)", () => {
  const base: PerfPost = {
    id: "p",
    fileName: "p",
    externalUrl: null,
    thumbnailUrl: null,
    caption: null,
    likes: null,
    comments: null,
    likesHidden: false,
    mediaType: null,
    er: null,
  };

  it("집계값: 좋아요 · 댓글 · ER을 천단위 구분으로 표기", () => {
    expect(postMetricsLine({ ...base, likes: 1234, comments: 56, er: 1.23 })).toBe(
      "좋아요 1,234 · 댓글 56 · ER 1.2%",
    );
  });

  it("좋아요 숨김: 숫자 대신 '비공개' — 어떤 숫자도 좋아요 자리에 오지 않는다", () => {
    const line = postMetricsLine({ ...base, likesHidden: true, comments: 7 });
    expect(line).toBe("좋아요 비공개 · 댓글 7");
    expect(line).not.toMatch(/좋아요 [\d,]+/);
  });

  it("좋아요 0은 집계된 저조값 — 숨김·미집계와 구분해 그대로 표기", () => {
    expect(postMetricsLine({ ...base, likes: 0 })).toBe("좋아요 0");
  });

  it("전부 미집계면 '집계 전'", () => {
    expect(postMetricsLine(base)).toBe("집계 전");
  });

  // 부분 집계(좋아요 미집계·숨김 아님·댓글만 존재)는 수집기가 like+comment를 항상 함께 쓰므로
  // 정상 경로에선 도달하지 않는다 — 도달 시 댓글만 표기(침묵 생략)가 의도된 동작임을 문서화(ss 검토 M-3).
  it("부분 집계(댓글만): 댓글만 표기", () => {
    expect(postMetricsLine({ ...base, comments: 9 })).toBe("댓글 9");
  });
});

describe("ContentPerformanceSection 전체 노출 계약", () => {
  it("게시물이 몇 건이든 전부 렌더된다(접힘 포함 누락 0) — 1건 축약 회귀 방지", () => {
    const posts = ["AAA111", "BBB222", "CCC333", "DDD444", "EEE555"].map((sc, i) =>
      post(sc, { likeCount: 100 - i, commentCount: i, likesHidden: false }),
    );
    const { container } = render(<ContentPerformanceSection contentPerf={perf(posts)} />);

    // 전 게시물이 원본 링크로 존재
    for (const sc of ["AAA111", "BBB222", "CCC333", "DDD444", "EEE555"]) {
      expect(
        container.querySelector(`a[href="https://www.instagram.com/p/${sc}/"]`),
        sc,
      ).toBeTruthy();
    }
    // 헤더 건수 = 전체 건수
    expect(screen.getByText(/게시물 5건/)).toBeTruthy();
    // 4건째부터는 <details>로 접힌다(전체 노출은 유지하되 화면 밀도 보호)
    expect(container.querySelector("details")).toBeTruthy();
    expect(screen.getByText("나머지 2건 보기")).toBeTruthy();
  });

  it("좋아요 숨김 게시물은 '좋아요 비공개'로 렌더되고 좋아요 숫자가 없다", () => {
    const { container } = render(
      <ContentPerformanceSection
        contentPerf={perf([post("HID111", { likesHidden: true, commentCount: 14 })])}
      />,
    );
    expect(screen.getByText(/좋아요 비공개/)).toBeTruthy();
    expect(screen.getByText(/댓글 14/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/좋아요 [\d,]+/);
  });

  it("숨김 게시물이 있을 때만 원인 각주가 렌더된다", () => {
    const withHidden = render(
      <ContentPerformanceSection
        contentPerf={perf([post("HID222", { likesHidden: true, commentCount: 1 })])}
      />,
    );
    expect(withHidden.container.textContent).toContain("좋아요 수를 숨긴 게시물");

    const withoutHidden = render(
      <ContentPerformanceSection
        contentPerf={perf([post("VIS111", { likeCount: 10, likesHidden: false })])}
      />,
    );
    expect(withoutHidden.container.textContent).not.toContain("좋아요 수를 숨긴 게시물");
  });

  it("미집계 게시물은 '집계 전'으로 구분 표기된다", () => {
    render(<ContentPerformanceSection contentPerf={perf([post("NEW111")])} />);
    expect(screen.getByText("집계 전")).toBeTruthy();
  });

  it("릴스/캐러셀은 썸네일 유형 배지로 식별되고, 일반 이미지는 배지가 없다", () => {
    const { container } = render(
      <ContentPerformanceSection
        contentPerf={perf([
          post("REEL11", { likeCount: 3, mediaType: "reel" }),
          post("CARO11", { likeCount: 2, mediaType: "carousel" }),
          post("IMG111", { likeCount: 1, mediaType: "image" }),
        ])}
      />,
    );
    expect(screen.getByRole("img", { name: "릴스" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "캐러셀" })).toBeTruthy();
    // 이미지 게시물엔 유형 배지 없음(기본형이라 표시 불요)
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(2);
  });

  it("구조화 likeCount가 있으면 ER과 함께 표기된다(notes 의존 제거)", () => {
    render(
      <ContentPerformanceSection
        contentPerf={perf([post("ERP111", { likeCount: 500, commentCount: 20 })], 10_000)}
      />,
    );
    // ER = 500/10000*100 = 5.0%
    expect(screen.getByText("좋아요 500 · 댓글 20 · ER 5.0%")).toBeTruthy();
  });
});
