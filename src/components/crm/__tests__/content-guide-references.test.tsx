// @vitest-environment jsdom
// 가이드가 참고한 레퍼런스 스트립.
//
// 이 컴포넌트의 계약은 "모델에 들어간 것과 화면이 어긋나지 않는다" 하나다.
// 그래서 검증의 초점은 예쁘게 나오는지가 아니라 **빠지는 것이 없는지**다 —
// 썸네일이 없는 건도 자리를 지켜야 하고, 얕은 입력은 얕다고 말해야 한다.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ContentGuideReferences,
  type GuideReferenceCard,
} from "../content-guide-references";

const ref = (over: Partial<GuideReferenceCard> = {}): GuideReferenceCard => ({
  name: "레퍼런스",
  likes: 1200,
  thumbnailUrl: "https://cdn.example/t.jpg",
  externalUrl: "https://www.instagram.com/p/abc/",
  mediaType: "image",
  ...over,
});

describe("ContentGuideReferences", () => {
  it("0건이면 딜 정보만으로 썼다는 사실을 말한다 — 빈 입력을 숨기지 않는다", () => {
    render(<ContentGuideReferences references={[]} />);
    expect(screen.getByText(/딜 정보만으로 작성/)).toBeTruthy();
  });

  it("건수가 얕으면 방향이 딜 정보에 기댔다고 알린다", () => {
    render(<ContentGuideReferences references={[ref(), ref()]} />);
    expect(screen.getByText(/2건뿐/)).toBeTruthy();
  });

  it("충분하면 얕음 안내를 띄우지 않는다", () => {
    render(
      <ContentGuideReferences references={[ref(), ref(), ref(), ref()]} />,
    );
    expect(screen.queryByText(/뿐이라/)).toBeNull();
  });

  it("썸네일이 없는 건도 목록에서 빠지지 않는다 — 빠지면 '안 쓰였다'로 오해된다", () => {
    const { container } = render(
      <ContentGuideReferences
        references={[
          ref({ name: "썸네일 있음" }),
          ref({ name: "썸네일 없음", thumbnailUrl: null }),
          ref({ name: "셋째" }),
        ]}
      />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByText("썸네일 없음")).toBeTruthy();
  });

  it("좋아요 수는 접근 가능한 라벨에 실린다 — 사진 위 저대비 텍스트를 쓰지 않는다", () => {
    const { container } = render(
      <ContentGuideReferences references={[ref({ name: "릴스 A" })]} />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("alt")).toBe("릴스 A · 좋아요 1,200");
  });

  it("좋아요가 미집계(null)면 숫자를 지어내지 않는다", () => {
    const { container } = render(
      <ContentGuideReferences references={[ref({ likes: null })]} />,
    );
    expect(container.querySelector("img")?.getAttribute("alt")).toBe(
      "레퍼런스",
    );
  });

  it("외부 링크가 없으면 앵커를 만들지 않는다", () => {
    const { container } = render(
      <ContentGuideReferences references={[ref({ externalUrl: null })]} />,
    );
    expect(container.querySelector("a")).toBeNull();
  });

  it("외부 링크는 새 탭 + noopener 로 연다", () => {
    const { container } = render(<ContentGuideReferences references={[ref()]} />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toContain("noopener");
  });
});
