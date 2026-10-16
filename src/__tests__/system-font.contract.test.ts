import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 시스템 글꼴 계약 (Apple UI 갱신 번들 0, Task 5). Inter(next/font/google) 재도입을 막고
// --font-sans 를 애플 시스템 스택으로 고정한다. 크기 토큰 값은 바꾸지 않는다.
const ROOT = process.cwd();
const LAYOUT = path.join(ROOT, "src/app/layout.tsx");
const CSS = path.join(ROOT, "src/app/globals.css");

const NEXT_FONT_GOOGLE = /next\/font\/google/;

export function findNextFontGoogleHits(source: string): string[] {
  const hits: string[] = [];
  source.split("\n").forEach((line, i) => {
    if (NEXT_FONT_GOOGLE.test(line)) hits.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

export function readFontSans(css: string): string | undefined {
  const m = css.match(/--font-sans:\s*([^;]+);/);
  return m?.[1].trim();
}

describe("system font contract", () => {
  it("스캐너 양성 프로브: next/font/google import 를 잡는다", () => {
    const planted = 'import { Inter } from "next/font/google";\nconst x = 1;';
    expect(findNextFontGoogleHits(planted)).toHaveLength(1);
  });
  it("스캐너 음성 프로브: 일반 import 는 잡지 않는다", () => {
    expect(findNextFontGoogleHits('import { Providers } from "./providers";')).toHaveLength(0);
  });
  it("src/app/layout.tsx 에 next/font/google 이 없다", () => {
    const hits = findNextFontGoogleHits(readFileSync(LAYOUT, "utf8"));
    expect(hits, `발견 ${hits.length}건\n${hits.join("\n")}`).toEqual([]);
  });
  it("--font-sans 는 -apple-system 시스템 스택으로 시작하고 Inter 를 참조하지 않는다", () => {
    const sans = readFontSans(readFileSync(CSS, "utf8"));
    expect(sans).toBeDefined();
    expect(sans).toMatch(/^-apple-system,/);
    expect(sans).not.toMatch(/Inter|--font-inter/);
  });
  it("크기별 자간 규칙이 @layer base 에 있다 (h1·.text-display, .text-caption)", () => {
    const css = readFileSync(CSS, "utf8").replace(/\s+/g, " ");
    expect(css).toMatch(/h1, \.text-display \{ letter-spacing: -0\.02em; line-height: 1\.1; \}/);
    expect(css).toMatch(/\.text-caption \{ letter-spacing: 0\.01em; \}/);
  });
  it("크기 토큰 값은 그대로다 (display 44 · heading 28 · caption 11)", () => {
    const css = readFileSync(CSS, "utf8");
    expect(css).toMatch(/--font-size-display: 44px;/);
    expect(css).toMatch(/--font-size-heading: 28px;/);
    expect(css).toMatch(/--font-size-caption: 11px;/);
  });
});
