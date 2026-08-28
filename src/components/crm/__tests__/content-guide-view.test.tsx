// 콘텐츠 가이드 초안의 **표시 계층** 렌더 검증.
//
// 이 컴포넌트의 유일한 계약은 "원문을 한 글자도 잃지 않으면서 마크다운 기호만
// 걷어낸다"이다. 운영자가 셀러에게 보내기 전 검수하는 초안이라, 안 보이는 구간이
// 생기는 것이 마크다운 기호가 보이는 것보다 훨씬 나쁘다.
//
// 색 계약(P8 §4)은 `deals-panel-ai-affordance-color.test.ts` 가 소스 그렙으로 지킨다 —
// 여기서 중복하지 않는다.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContentGuideView } from "../content-guide-view";
import type { SketchFailure } from "@/lib/guide-sketch";
import { parseGuideSections } from "@/lib/content-guide";
import { cutSketchKey } from "@/lib/guide-sketch";

const GUIDE = [
  "## 상품 요약",
  "- 유산균 20종을 담은 분말 스틱",
  "- 아침 공복에 물 없이 먹는 사람에게",
  "",
  "## 훅 아이디어 3종",
  "- **문제 제기** 아침마다 챙기는 게 일이라면",
  "",
  "## 주의사항",
  "- 효능·효과 단정 금지",
  "",
  "## 근거 카드",
  "- 유산균 20종 → 시험성적서 A-2026-1 [브랜드 제공]",
].join("\n");

describe("ContentGuideView", () => {
  it("마크다운 기호(`##`·`-`·`**`)를 화면에서 걷어낸다", () => {
    const { container } = render(<ContentGuideView guide={GUIDE} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("##");
    expect(text).not.toContain("**");
    expect(text).not.toContain("- 유산균");
  });

  it("섹션 제목과 항목이 모두 화면에 남는다 — 내용 유실 금지", () => {
    render(<ContentGuideView guide={GUIDE} />);
    for (const title of [
      "상품 요약",
      "훅 아이디어 3종",
      "주의사항",
      "근거 카드",
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByText(/유산균 20종을 담은 분말 스틱/)).toBeTruthy();
    expect(screen.getByText(/시험성적서 A-2026-1/)).toBeTruthy();
    expect(screen.getByText(/효능·효과 단정 금지/)).toBeTruthy();
  });

  it("`**강조**`는 기호 없이 강조 요소로 렌더된다", () => {
    const { container } = render(<ContentGuideView guide={GUIDE} />);
    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("문제 제기");
  });

  it("헤더가 없는 생성물도 통째로 보여준다 — 폴백이 침묵하지 않는다", () => {
    const { container } = render(
      <ContentGuideView guide="헤더 없이 온 초안 한 줄" />,
    );
    expect(container.textContent).toContain("헤더 없이 온 초안 한 줄");
  });

  it("산문 줄은 `<li>` 가 아니다 — 목록이 아닌 것을 목록으로 안내하지 않는다", () => {
    // WCAG 1.3.1. 한 `<ul>` 안에 `list-none` 로 산문을 섞으면 스크린리더가
    // "목록 N개 항목"으로 안내하고 산문까지 항목으로 읽는다.
    const { container } = render(
      <ContentGuideView guide={"## 포맷 추천\n앞선 산문 한 줄\n- 불릿 항목"} />,
    );
    const items = [...container.querySelectorAll("li")].map((el) => el.textContent);
    expect(items).toEqual(["불릿 항목"]);
    expect(container.querySelector("ul")?.children).toHaveLength(1);
    expect([...container.querySelectorAll("p")].map((el) => el.textContent)).toContain(
      "앞선 산문 한 줄",
    );
  });

  it("촬영 컷은 프레임(ol/li)으로 세우고 파이프 기호를 화면에서 걷어낸다", () => {
    const { container } = render(
      <ContentGuideView
        guide={[
          "## 포맷 추천",
          "- C1 · 0~3초 | 알약 여섯 알을 쏟는다 | 문제 제시",
          "- C2 · 3~12초 | 스틱을 뜯어 털어넣는다 | 해결 장면",
        ].join("\n")}
      />,
    );
    const frames = container.querySelectorAll("ol > li");
    expect(frames).toHaveLength(2);
    expect(container.textContent).not.toContain("|");
    expect(screen.getByText("알약 여섯 알을 쏟는다")).toBeTruthy();
    expect(screen.getByText(/C1 · 0~3초/)).toBeTruthy();
  });

  it("컷 형식이 아닌 항목은 같은 섹션에서도 일반 목록으로 남는다", () => {
    const { container } = render(
      <ContentGuideView
        guide={[
          "## 포맷 추천",
          "- C1 · 0~3초 | 알약을 쏟는다 | 문제 제시",
          "- 캡션 첫 3줄은 아침 루틴으로 연다",
        ].join("\n")}
      />,
    );
    expect(container.querySelectorAll("ol > li")).toHaveLength(1);
    expect(container.querySelectorAll("ul > li")).toHaveLength(1);
    expect(screen.getByText("캡션 첫 3줄은 아침 루틴으로 연다")).toBeTruthy();
  });

  it("프레임은 빈 상자다 — 생성 이미지를 넣지 않는다", () => {
    const { container } = render(
      <ContentGuideView guide={"## 포맷 추천\n- C1 · 0~3초 | 알약을 쏟는다 | 문제"} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("시안이 있으면 프레임을 그림으로 채운다", () => {
    const guide = "## 포맷 추천\n- C1 · 0~3초 | 알약을 쏟는다 | 문제 제시";
    const key = cutSketchKey({ no: "1", slot: "0~3초", subject: "알약을 쏟는다", why: "문제 제시" });
    const { container } = render(
      <ContentGuideView guide={guide} sketches={[{ key, url: "https://x/a.jpg" }]} />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://x/a.jpg");
    // 그림 위 글자는 스크림 없이 읽히지 않는다 — 흰 선화라 밝은 면이 많다.
    expect(container.innerHTML).toContain("from-black/55");
    // 컷 정보는 그림 위에서도 그대로 읽혀야 한다.
    expect(screen.getByText("알약을 쏟는다")).toBeTruthy();
  });

  it("시안이 없으면 지금까지의 빈 프레임 그대로다 — 점진적 향상", () => {
    const guide = "## 포맷 추천\n- C1 · 0~3초 | 알약을 쏟는다 | 문제 제시";
    const { container } = render(<ContentGuideView guide={guide} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelectorAll("ol > li")).toHaveLength(1);
    expect(screen.getByText("알약을 쏟는다")).toBeTruthy();
  });

  it("키가 안 맞는 시안은 붙지 않는다 — 남의 컷 그림을 걸지 않는다", () => {
    const guide = "## 포맷 추천\n- C1 · 0~3초 | 알약을 쏟는다 | 문제 제시";
    const { container } = render(
      <ContentGuideView guide={guide} sketches={[{ key: "다른키", url: "https://x/b.jpg" }]} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("빈 생성물이면 원문 폴백으로 떨어진다 — 빈 화면을 그리지 않는다", () => {
    const { container } = render(<ContentGuideView guide="   " />);
    expect(container.querySelector("p")).toBeTruthy();
  });
});

describe("컷 프레임 상태 표시 — 빈 프레임의 세 가지 의미", () => {
  // 오너 지적(2026-08-01): 빈 프레임이 "그리는 중"·"실패"·"기능 오프"를 전부 뜻했다.
  const GUIDE = [
    "## 포맷 추천",
    "- C1 · 0~3초 | 알약을 쏟는다 | 문제 제시",
    "- C2 · 3~12초 | 스틱을 뜯는다 | 해결 장면",
  ].join("\n");
  const progress = (over = {}) => ({
    loading: false,
    failures: [] as SketchFailure[],
    skippedKeys: [] as string[],
    requestError: null as null | "UNAVAILABLE" | "FAILED",
    ...over,
  });

  it("생성 중이면 스켈레톤이 뜬다 — 스피너가 아니다", () => {
    const { container } = render(
      <ContentGuideView guide={GUIDE} sketchProgress={progress({ loading: true })} />,
    );
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2);
  });

  it("실패는 글자로 말한다 — 무음으로 빈 프레임을 남기지 않는다", () => {
    render(
      <ContentGuideView
        guide={GUIDE}
        sketchProgress={progress({ requestError: "FAILED" })}
      />,
    );
    expect(screen.getAllByText("시안 생성 실패")).toHaveLength(2);
  });

  it("저장소 미설정은 실패와 다른 문구다 — 운영자가 할 일이 다르다", () => {
    render(
      <ContentGuideView
        guide={GUIDE}
        sketchProgress={progress({ requestError: "UNAVAILABLE" })}
      />,
    );
    expect(screen.getAllByText(/저장소가 설정되지 않았습니다/)).toHaveLength(2);
    expect(screen.queryByText("시안 생성 실패")).toBeNull();
  });

  it("실패 이유를 알면 처방까지 화면에 쓴다 — 디버깅 가능해야 한다", () => {
    // 컷 키를 계산해 넣는다(화면이 쓰는 것과 같은 함수).
    const cuts = parseGuideSections(GUIDE)[0].lines.map((l) => l.cut!).filter(Boolean);
    render(
      <ContentGuideView
        guide={GUIDE}
        sketchProgress={progress({
          failures: [{ key: cutSketchKey(cuts[0]), reason: "SPEND_CAP" }],
        })}
      />,
    );
    expect(screen.getByText(/지출 상한 초과/)).toBeTruthy();
  });

  it("진행 정보가 없으면 지금까지의 빈 프레임 그대로다", () => {
    const { container } = render(<ContentGuideView guide={GUIDE} />);
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
    expect(screen.queryByText("시안 생성 실패")).toBeNull();
  });

  it("컷 글자는 어느 상태에서도 남는다 — 무엇을 그리는 중인지 읽혀야 한다", () => {
    render(
      <ContentGuideView guide={GUIDE} sketchProgress={progress({ loading: true })} />,
    );
    expect(screen.getByText("알약을 쏟는다")).toBeTruthy();
  });
});
