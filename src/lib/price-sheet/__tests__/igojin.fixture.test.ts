/**
 * 픽스처 회귀: igojin_climber_proposal.pptx — zip+<a:t> regex 텍스트 추출이 5개 슬라이드
 * 전체에서 핵심 키워드(공구가/정산/원천징수/99,000/28,200 등)를 빠짐없이 뽑는지 검증한다
 * (청사진 §4, 렌더링 불필요 — 텍스트 추출만으로 충분함을 실증).
 * LLM 호출 없이 pptx-text.ts의 결정적 추출만 검증한다.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractPptxSlideTexts, slidesToPromptText } from "../pptx-text";
import { FIXTURES, fixturesAvailable } from "./fixtures";

describe.skipIf(!fixturesAvailable())("픽스처: igojin_climber_proposal.pptx", () => {
  it("5개 슬라이드를 순서대로(1~5) 전부 추출한다", async () => {
    const buffer = readFileSync(FIXTURES.igojin);
    const slides = await extractPptxSlideTexts(buffer);
    expect(slides).toHaveLength(5);
    expect(slides.map((s) => s.slideIndex)).toEqual([1, 2, 3, 4, 5]);
  });

  it("슬라이드3(코어 마운틴 클라이머)에서 공구가/정산금액/수수료율 숫자를 전부 복원한다", async () => {
    const buffer = readFileSync(FIXTURES.igojin);
    const slides = await extractPptxSlideTexts(buffer);
    const slide3 = slides.find((s) => s.slideIndex === 3)!;
    expect(slide3.text).toContain("99,000");
    expect(slide3.text).toContain("28,200");
    expect(slide3.text).toContain("30%");
    expect(slide3.text).toContain("코어 마운틴");
  });

  it("슬라이드4(비타 마운틴 클라이머)에서 149,000 / 28,400 / 20% 값도 전부 존재한다", async () => {
    const buffer = readFileSync(FIXTURES.igojin);
    const slides = await extractPptxSlideTexts(buffer);
    const slide4 = slides.find((s) => s.slideIndex === 4)!;
    expect(slide4.text).toContain("149,000");
    expect(slide4.text).toContain("28,400");
    expect(slide4.text).toContain("20%");
  });

  it("슬라이드2(공동구매 안내사항)에서 정산일/원천징수 등 정책 키워드를 추출한다", async () => {
    const buffer = readFileSync(FIXTURES.igojin);
    const slides = await extractPptxSlideTexts(buffer);
    const slide2 = slides.find((s) => s.slideIndex === 2)!;
    expect(slide2.text).toContain("정산일");
    expect(slide2.text).toContain("21");
    expect(slide2.text).toContain("원천징수");
    expect(slide2.text).toContain("3.3%");
  });

  it("slidesToPromptText는 슬라이드 번호 마커와 함께 전체 텍스트를 합친다", async () => {
    const buffer = readFileSync(FIXTURES.igojin);
    const slides = await extractPptxSlideTexts(buffer);
    const promptText = slidesToPromptText(slides);
    expect(promptText).toContain("[슬라이드 1]");
    expect(promptText).toContain("[슬라이드 5]");
    expect(promptText).toContain("이고진");
  });
});
