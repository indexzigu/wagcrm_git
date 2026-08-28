import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * CSS 토큰 관용구 계약 — 무효 CSS가 조용히 사라지는 것을 막는다.
 *
 * 실사고 2건(2026-07-15, 둘 다 무증상으로 살아있었다):
 *   - mobile-schedule-gap-bars: `hsl(var(--status-urgent))`  → 경고 점 배경 미렌더
 *   - mobile-campaign-detail-sheet: `rgba(var(--primary),0.3)` → 오늘 막대 글로우 미렌더
 *
 * 뿌리: `hsl(var(--x))` / `rgba(var(--x), a)` 는 토큰이 **성분값**일 때만 성립하는
 * 관용구다(예: `--cal-primary: 207 89% 21%`). 이 레포의 --primary·--status-* 는
 * **hex**라 같은 관용구를 쓰면 `hsl(#BF5050)` 처럼 파싱 불가능한 값이 되고, 브라우저는
 * 그 선언을 통째로 버린다 — 에러도 경고도 없다. tsc·eslint 는 문자열 안의 CSS 를
 * 보지 못하므로 이 테스트가 유일한 그물이다.
 *
 * 알파가 필요하면 Tailwind 컬러 유틸(`shadow-primary/30`·`ring-focus-ring`)이나
 * 전용 토큰(`--status-urgent-bg` 같은 tint 쌍)을 쓴다.
 */

const SRC = join(process.cwd(), "src");

/** globals.css 에서 성분값(component-value) 형식으로 정의된 토큰만 추린다. */
function componentValueTokens(): Set<string> {
  const css = readFileSync(join(SRC, "app", "globals.css"), "utf8");
  const tokens = new Set<string>();
  // 예: `--cal-primary: 207 89% 21%;` — hex 도 함수도 아닌 숫자/퍼센트 나열
  for (const [, name, value] of css.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    if (/^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(value.trim())) tokens.add(name);
  }
  return tokens;
}

/**
 * 주석을 같은 길이의 공백으로 치환한다 — 줄 수·줄번호를 보존해 오프너 위치가 어긋나지
 * 않게 하면서, 주석 안의 예시 코드(`hsl(var(--x))` 같은 설명)가 오탐으로 잡히는 것을
 * 막는다. 실제로 이 함수 없이 돌렸을 때 위 실사고를 설명하는 주석 자체가 잡혔다.
 */
function stripComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
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

describe("CSS 토큰 관용구 — hsl()/rgba() 로 감싼 토큰은 성분값 토큰이어야 한다", () => {
  it("hex 토큰을 hsl()/rgba() 로 감싼 곳이 없다 (무효 CSS = 무렌더)", () => {
    const componentTokens = componentValueTokens();
    // 계약이 의미를 가지려면 성분값 토큰이 실제로 존재해야 한다(회귀 방지 자체 점검)
    expect(componentTokens.size).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const source = stripComments(readFileSync(file, "utf8"));
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        const where = `${file.replace(process.cwd() + "/", "")}:${index + 1}`;

        // ① 직접 형태 — hsl(var(--token)). 토큰 이름이 보이므로 형식을 바로 대조한다.
        for (const [, fn, token] of line.matchAll(
          /\b(hsl|hsla|rgb|rgba)\(\s*var\((--[\w-]+)\)/g,
        )) {
          if (!componentTokens.has(token)) {
            offenders.push(
              `${where} — ${fn}(var(${token})) — ${token} 은 성분값 토큰이 아니다(hex). ` +
                `이 선언은 브라우저가 버린다.`,
            );
          }
        }

        // ② 간접 형태 — hsl(${expr}) 처럼 JS 값을 통째로 감싼 경우. 변수에 무엇이 담겼는지
        //    정적으로 알 수 없지만, 괄호 안이 표현식 하나뿐이라면 그 값이 "H S% L%" 성분
        //    문자열이어야만 성립한다 — 이 레포에서 그런 변수는 사실상 없고, 실제 사고
        //    (mobile-schedule-gap-bars)가 바로 이 형태였다. 성분을 직접 조립하는
        //    `hsl(${h} ${s}% ${l}%)` 는 괄호 안에 다른 토막이 남으므로 걸리지 않는다.
        for (const [, fn] of line.matchAll(
          /\b(hsl|hsla|rgb|rgba)\(\s*\$\{[^{}]*\}\s*\)/g,
        )) {
          offenders.push(
            `${where} — ${fn}(\${…}) — 변수를 통째로 감쌌다. 그 변수가 "var(--x)" 같은 ` +
              `색 문자열이면 무효 CSS 가 되어 선언이 통째로 사라진다(실사고 형태). ` +
              `알파가 필요하면 Tailwind 컬러 유틸이나 전용 tint 토큰을 써라.`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
