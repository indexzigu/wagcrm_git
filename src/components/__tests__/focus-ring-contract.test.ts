import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 포커스 링 계약 (P8 Focus Ring Standard · 오너 위임 판정 2026-07-15).
 *
 * 정본은 `--focus-ring` 토큰(`ring-focus-ring`/`outline-focus-ring`, 3:1). 임의
 * 불투명도 포커스 링은 폐기됐다 — 실측 결과 전부 3:1에 크게 미달했다:
 *   ring-primary/45 ~2.4:1 · ring-primary/20 ~1.2:1 ·
 *   ring-destructive/20 ~1.31:1 · ring-destructive/40 ~1.75:1 ·
 *   ring-status-caution/40 ~1.77:1   (모두 흰 카드 기준)
 *
 * **왜 테스트가 필요한가:** 포커스 링은 키보드로 Tab 해야 보인다. 마우스로 화면을
 * 훑어서는 회귀를 절대 알아챌 수 없고, tsc·eslint 도 클래스 문자열의 대비를 모른다.
 * 실제로 앱 전역 Button 프리미티브가 폐기된 ring-primary/45 를 계속 쓰고 있었는데
 * 아무도 몰랐다(PR #162에서 발견).
 *
 * **aria-invalid 는 대상이 아니다** — 검증 오류 표시는 포커스 표시와 다른 의미축이라
 * 상태 hue(destructive)를 쓰는 게 맞다. 이 테스트는 `focus`/`focus-visible`/
 * `focus-within` 트리거만 본다.
 */

const SRC = join(process.cwd(), "src");

/** 포커스 트리거에 붙은 ring/outline 색 지정만 뽑는다(aria-invalid 등은 제외). */
const FOCUS_RING = /\b(focus|focus-visible|focus-within):(ring|outline)-((?!focus-ring\b)[a-z][\w-]*)(\/\d+)?/g;

/**
 * 색이 아닌 값은 제외 — `ring-2`(폭) · `outline-none`/`outline-hidden` ·
 * `ring-offset-*`(오프셋) 처럼 색 지정이 아닌 유틸.
 */
const NOT_A_COLOR = /^(\d+|none|hidden|offset|inset|dashed|solid|dotted)/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" || entry === "node_modules" ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * 면제 — 이유 없이 늘리지 말 것.
 *
 * 1) 셀러 포털은 CRM 과 다른 세계다(slate+blue 팔레트). 자기 hue 로 3:1을 확보하는 게
 *    정본이라 뺀다 — **cross-palette 예외이지 대비 면제가 아니다.** 컴포넌트
 *    (components/portal)뿐 아니라 라우트(`/<slug>`·`/p/[token]`)도 포털 표면이다.
 * 2) `ui/tabs.tsx` 의 `outline-ring` 은 같은 요소에 준수 링(`ring-focus-ring`)이
 *    공존하는 1px 보조선이다 — 링이 유일 단서가 아니므로 SC 1.4.11 평가 대상이 아니다
 *    (design-system.md 의 border-ring 보존 논리와 동일).
 */
const EXEMPT_PREFIXES = [
  join(SRC, "components", "portal"),
  join(SRC, "app", "[slug]"),
  join(SRC, "app", "p"),
];
const EXEMPT_FILES = [join(SRC, "components", "ui", "tabs.tsx")];

describe("포커스 링 — 정본 토큰만 (임의 불투명도 금지)", () => {
  it("focus 계열 ring/outline 이 상태색·임의 불투명도를 쓰지 않는다", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      if (EXEMPT_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
      if (EXEMPT_FILES.includes(file)) continue;
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");

      lines.forEach((line, index) => {
        for (const [match, , , color] of line.matchAll(FOCUS_RING)) {
          if (NOT_A_COLOR.test(color)) continue;
          offenders.push(
            `${file.replace(process.cwd() + "/", "")}:${index + 1} — ${match} — ` +
              `포커스 지표는 --focus-ring 토큰(3:1)만 쓴다. 위험·경고 의미는 텍스트·배경이 ` +
              `전담하므로 링에서 hue 를 이중 인코딩하지 않는다(aria-invalid 는 별개).`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
