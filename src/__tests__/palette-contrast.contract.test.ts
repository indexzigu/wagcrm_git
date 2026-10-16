import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 청록 팔레트 대비·@theme 노출 계약 (P8 색 사용 원칙 §5 표면 종속 · §6 노출 프로브).
const CSS_PATH = path.join(process.cwd(), "src/app/globals.css");

/** `:root { ... }` 블록의 hex 토큰만 파싱한다(HSL 삼중항·rgba·var() 는 건너뜀). */
export function readRootTokens(css: string): Record<string, string> {
  const start = css.indexOf(":root {");
  if (start < 0) throw new Error(":root 블록 없음");
  const end = css.indexOf("\n}", start);
  const block = css.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2];
  return out;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const tokens = readRootTokens(readFileSync(CSS_PATH, "utf8"));

const PAIRS: Array<[fg: string, bg: string, min: number, why: string]> = [
  ["--primary-foreground", "--primary", 4.5, "앵커 버튼 흰 글자"],
  ["--primary", "--sidebar", 4.5, "밝은 사이드바 위 현재 메뉴 글자"],
  ["--sidebar-foreground", "--sidebar", 4.5, "사이드바 기본 글자"],
  ["--primary", "--primary-tint", 4.5, "틴트 배지 글자"],
  ["--accent-achieve", "--hero-deep", 4.5, "달성 밴드 글자"],
  ["--accent-achieve-soft", "--hero-deep", 4.5, "달성 soft 글자"],
  ["--brand-mark", "--primary", 4.5, "타일 위 마크"],
  ["--brand-mark", "--hero-deep", 4.5, "히어로 위 마크"],
  ["--goal-miss", "--hero-deep", 4.5, "히어로 미달 숫자"],
  ["--status-urgent", "--card", 4.5, "흰 카드 위 경고(회귀 방지)"],
  ["--money-out", "--card", 4.5, "흰 카드 위 지급 금액"],
];

describe("palette contrast contract", () => {
  it.each(PAIRS)("%s on %s >= %s (%s)", (fg, bg, min) => {
    expect(tokens[fg], `${fg} 토큰 없음`).toBeTruthy();
    expect(tokens[bg], `${bg} 토큰 없음`).toBeTruthy();
    expect(contrast(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(min);
  });

  it("면색 fill-teal-1 은 흰 카드 위 3:1 미만 — 면 전용(글자 금지) 사실을 고정", () => {
    expect(contrast(tokens["--fill-teal-1"], tokens["--card"])).toBeLessThan(3);
  });

  // 알려진 한계: 밝은 사이드바 위 --status-urgent 는 4.5 미달 — 비텍스트 3:1 까지만 보장.
  it("알려진 한계: status-urgent on sidebar 는 비텍스트 3:1 이상(텍스트 4.5 미달)", () => {
    const c = contrast(tokens["--status-urgent"], tokens["--sidebar"]);
    expect(c).toBeGreaterThanOrEqual(3);
  });
});

describe("@theme 노출 프로브 (Tailwind compile)", () => {
  it("새 토큰 유틸이 생성되고, 존재하지 않는 토큰(음성 대조군)은 생성되지 않는다", async () => {
    const { compile } = await import("@tailwindcss/node");
    const compiler = await compile(readFileSync(CSS_PATH, "utf8"), {
      base: path.dirname(CSS_PATH),
      onDependency: () => {},
    });
    const names = ["bg-accent-achieve", "bg-fill-teal-1", "bg-hero-deep", "bg-primary-tint", "bg-brand-mark", "text-brand-mark", "bg-not-a-token"];
    const out = compiler.build(names);
    const hits = names.filter((n) => out.includes(`.${n}`));
    expect(hits).toEqual(["bg-accent-achieve", "bg-fill-teal-1", "bg-hero-deep", "bg-primary-tint", "bg-brand-mark", "text-brand-mark"]);
  });
});
