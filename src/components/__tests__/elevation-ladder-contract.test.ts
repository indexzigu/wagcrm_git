import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Elevation 사다리 계약 (오너 확정 2026-07-15 · docs/agents/design-system.md).
 *
 * 그림자 사다리(ambient/lg/md/sm/hover)는 유지하고 **사다리를 벗어난 임의값**만
 * 막는다. 전부 같은 높이로 통일하자는 안은 기각됐다 — 부양감은 상대적이라 다 띄우면
 * 아무것도 안 뜬다.
 *
 * 이 테스트가 없으면 정리가 유지되지 않는다: 실제로 정리 전 21곳이 각자 값을 찍고
 * 있었고, 그중 19곳은 같은 값을 복붙하면서도 이름이 없었다(→ `--shadow-ambient` 등록).
 */

const SRC = join(process.cwd(), "src");

/**
 * 그림자로 보이지만 elevation 이 아닌 것들 — 검사에서 제외한다.
 *   - `0 0 0 Npx ...` : 링/테두리 대용(사이드바 등). 높이 표현이 아니다.
 *   - 색만 지정(`shadow-[#RRGGBB]`)·형태만 지정(`shadow-[0_0_10px]`) : Tailwind 컬러
 *     섀도우 유틸과 짝지어 쓰는 조각이라 그 자체로 임의 elevation 이 아니다.
 */
function isElevation(value: string): boolean {
  const inner = value.slice("shadow-[".length, -1);
  if (/^0_0_0_/.test(inner)) return false;
  if (/^#/.test(inner)) return false;
  if (!/rgba?\(/.test(inner)) return false;
  return true;
}

/**
 * 사다리 밖에 남기기로 확정한 예외 — 이유 없이 늘리지 말 것.
 *
 * 현재 비어 있다. assets 허브 카드가 유일한 후보였으나 카드 4장 = md 행의 "소수
 * (1~6개) 패널" 구간이라 `ui/Card` 와 같은 계보로 편입됐다(ss-ux-designer 판정,
 * 오너 위임 확정). **예외를 추가하려면 판정 근거를 여기 남길 것.**
 */
const ALLOWED: { file: string; why: string }[] = [];

/**
 * 주석을 같은 길이의 공백으로 치환한다(줄번호 보존) — 주석 안의 설명용 예시가 코드로
 * 잡히는 오탐을 막는다. css-token-idiom-contract 에서 실제로 자기 주석이 잡혔던 전례가 있다.
 */
function stripComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" || entry === "node_modules" ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("Elevation 사다리 — 임의 섀도우 금지", () => {
  it("컴포넌트가 사다리 밖 임의 그림자를 쓰지 않는다", () => {
    const allowed = new Set(ALLOWED.map((entry) => entry.file));
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = file.replace(process.cwd() + "/", "");
      if (allowed.has(rel)) continue;

      const source = readFileSync(file, "utf8");
      for (const [value] of source.matchAll(/shadow-\[[^\]]*\]/g)) {
        if (!isElevation(value)) continue;
        offenders.push(
          `${rel} — ${value} — 사다리 밖 임의값이다. ` +
            `docs/agents/design-system.md 의 Elevation Ladder 표에서 층을 고르고 ` +
            `shadow-ambient / shadow-soft-lg / -md / -sm / -hover 중 하나를 써라.`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * Tailwind 원시 섀도우 유틸(shadow-sm/md/lg/xl/2xl) 재유입 금지.
   *
   * 원시와 토큰은 **다른 물리**다 — 원시 sm 은 검정 10% 의 타이트한 접촉 그림자,
   * 토큰은 네이비 2층 소프트. 정리 전 원시가 233곳 vs 토큰 25곳이라 같은 역할(카드
   * rest)에 강도 5배 차이의 두 언어가 공존했다. 토큰 값을 원시 세기에 맞춰 수렴시킨
   * 뒤이므로, 원시를 다시 쓰면 그 이중화가 되살아난다.
   */
  it("Tailwind 원시 섀도우 유틸을 쓰지 않는다", () => {
    // shadow-none(무-그림자 선언) · shadow-inner(오목, elevation 축 아님) ·
    // shadow-2xs/xs(로딩 스켈레톤 — sm 보다 의도적으로 조용해야 함)는 대상 아님.
    const RAW = /(^|[\s"'`])((?:hover|focus|focus-visible|active|group-hover|md|lg|dark):)*shadow-(sm|md|lg|xl|2xl)\b/g;
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = file.replace(process.cwd() + "/", "");
      const source = stripComments(readFileSync(file, "utf8"));
      const lines = source.split("\n");

      lines.forEach((line, index) => {
        for (const match of line.matchAll(RAW)) {
          // 컬러 섀도우 글로우(`shadow-lg shadow-primary/20`)는 elevation 이 아니라
          // "이게 주요 액션이다"를 브랜드색으로 알리는 장식이다 — 중성 네이비 그림자로
          // 흡수하면 CTA 식별력이 떨어진다(ss-ux-designer 판정). 같은 줄에 컬러
          // 섀도우 유틸이 짝지어 있으면 통과시킨다.
          if (/\bshadow-(primary|slate|blue|destructive|status)[-/][\w/]*/.test(line)) continue;
          offenders.push(
            `${rel}:${index + 1} — ${match[0].trim()} — Tailwind 원시 유틸이다. ` +
              `docs/agents/design-system.md 의 Elevation Ladder 표에서 층을 고르고 ` +
              `shadow-soft-* / shadow-overlay / shadow-ambient 를 써라.`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("사다리 토큰이 전부 정의·노출돼 있고 소비처가 있다", () => {
    const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
    // 정의(값) + @theme 노출(유틸 생성) 둘 다 있어야 클래스가 나온다. 노출을 빼먹으면
    // 유틸이 생성되지 않아 그림자가 **조용히 사라진다** — 골드가 리터럴 hex 로 박혀
    // 있던 근본 원인이 정확히 이것이었다.
    for (const token of ["soft-sm", "soft-md", "soft-lg", "soft-hover", "ambient", "overlay"]) {
      expect(css, `--shadow-${token} 정의 누락`).toMatch(
        new RegExp(`--shadow-${token}:\\s*0 `),
      );
      expect(css, `--shadow-${token} @theme 노출 누락 — 유틸이 생성되지 않는다`).toMatch(
        new RegExp(`--shadow-${token}:\\s*var\\(--shadow-${token}\\)`),
      );
    }
    // 앰비언트는 웜그레이 틴트가 의도다(순색 네이비를 80px 블러에 얹으면 무겁게 깔림)
    expect(css).toMatch(/--shadow-ambient:\s*0 24px 80px rgba\(66, 82, 110, 0\.08\)/);

    const sources = walk(SRC).map((file) => readFileSync(file, "utf8"));
    for (const token of ["soft-sm", "soft-md", "soft-lg", "soft-hover", "ambient", "overlay"]) {
      const consumers = sources.filter((source) =>
        new RegExp(`\\bshadow-${token}\\b`).test(source),
      );
      expect(consumers.length, `shadow-${token} 소비처 없음 — 죽은 토큰`).toBeGreaterThan(0);
    }
  });
});
