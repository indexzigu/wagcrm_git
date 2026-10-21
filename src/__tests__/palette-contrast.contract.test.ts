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
  ["--sidebar-foreground", "--sidebar", 4.5, "사이드바 기본 글자(비활성 메뉴 라벨)"],
  ["--sidebar-muted-foreground", "--sidebar", 4.5, "사이드바 그룹 라벨·보조 글자"],
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

/** rgba(r, g, b, a) 토큰을 파싱한다. */
function readRgba(css: string, name: string): [number, number, number, number] {
  const m = css.match(new RegExp(`${name}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`));
  if (!m) throw new Error(`${name} rgba 토큰 없음`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}
function blendOver([r, g, b, a]: [number, number, number, number], bgHex: string): string {
  const h = bgHex.replace("#", "");
  const out = [r, g, b].map((v, i) => {
    const bg = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return Math.round(v * a + bg * (1 - a)).toString(16).padStart(2, "0");
  });
  return `#${out.join("")}`;
}

describe("--focus-ring 합성 대비 (WCAG 1.4.11, 알파를 표면에 블렌드한 뒤 3:1)", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  it.each(["--card", "--background", "--muted", "--sidebar"])("focus-ring over %s >= 3", (surface) => {
    const bg = tokens[surface];
    expect(bg, `${surface} 토큰 없음`).toBeTruthy();
    const ring = blendOver(readRgba(css, "--focus-ring"), bg);
    expect(contrast(ring, bg)).toBeGreaterThanOrEqual(3);
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

/** `:root` 의 `--x: var(--y)` 별칭을 hex 까지 따라간다(분포바 토큰은 다른 토큰의 별칭이다). */
function resolveRootToken(css: string, name: string, depth = 0): string {
  if (depth > 5) throw new Error(`${name} 별칭이 너무 깊다`);
  if (tokens[name]) return tokens[name];
  const start = css.indexOf(":root {");
  const block = css.slice(start, css.indexOf("\n}", start));
  const m = block.match(new RegExp(`${name}:\\s*var\\((--[\\w-]+)\\)`));
  if (!m) throw new Error(`${name} 토큰 없음`);
  return resolveRootToken(css, m[1], depth + 1);
}

describe("주문 분포바 4구간 — 청록 램프 → 달성 모래색 (묶음 2)", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const ramp = ["--pipeline-confirm", "--pipeline-pending", "--pipeline-shipping", "--pipeline-completed"];
  const hexes = ramp.map((n) => resolveRootToken(css, n));

  it("파란 계열 옛 값이 남지 않는다", () => {
    expect(hexes.map((h) => h.toUpperCase())).not.toContain("#276B9B");
    expect(hexes.map((h) => h.toUpperCase())).not.toContain("#649CC4");
  });

  it("상대 휘도가 주문확인 → 배송대기 → 배송중 → 배송완료로 단조 증가(어두움 → 밝음 → 모래색)", () => {
    const lum = hexes.map((h) => luminance(h));
    for (let i = 1; i < lum.length; i++) expect(lum[i]).toBeGreaterThan(lum[i - 1]);
  });

  it("이웃 구간끼리 대비 ≥ 1.3 — 구간 경계가 색 이름 없이도 갈린다", () => {
    for (let i = 1; i < hexes.length; i++) {
      expect(contrast(hexes[i], hexes[i - 1]), `${ramp[i - 1]} | ${ramp[i]}`).toBeGreaterThanOrEqual(1.3);
    }
  });
});
