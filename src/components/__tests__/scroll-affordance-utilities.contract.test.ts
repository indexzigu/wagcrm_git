import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 스크롤 신호 유틸 계약 — 붙어 있는 클래스에 정의처가 있는지 강제한다.
 *
 * 실사고(2026-08-15, PR #408 리뷰 중 발견): `SidebarContent` 에 `no-scrollbar`
 * 가 붙어 있었으나 레포 어디에도 정의가 없었다. Tailwind v4 이고 플러그인이
 * 0개라 그냥 죽은 클래스였다. 피해는 "스크롤바가 안 숨겨진 것"이 아니라
 * **거짓 흔적**이다 — 코드를 읽는 사람이 "신호 설계가 끝났다"고 착각해서,
 * 사이드바가 67px 넘치는데 '아래 더 있음' 신호가 0개인 상태가 유지됐다.
 *
 * tsc·eslint 는 문자열 안의 클래스명을 보지 못하고 렌더도 통과한다 —
 * 이 테스트가 유일한 그물이다(P8 §6 "@theme 노출 누락"과 같은 종류의 조용한 사망).
 */

const SRC = join(process.cwd(), "src");
const GLOBALS = join(SRC, "app", "globals.css");

/** CSS 주석을 같은 길이의 공백으로 치환한다(줄번호 보존, 주석 속 예시의 오탐 방지). */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** globals.css 가 해당 클래스 선택자를 실제로 정의하는가. */
function definesUtility(css: string, className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escaped}(?![\\w-])`).test(css);
}

/** src 아래 모든 .ts/.tsx 소스(테스트 제외)를 모은다. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" || entry === "node_modules" ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** TS/TSX 주석을 공백으로 치환한다(설명 주석이 자기 자신을 위반으로 잡는 것 방지). */
function stripTsComments(source: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
}

describe("스크롤 신호 유틸 — 붙어 있는 클래스에는 정의처가 있어야 한다", () => {
  const css = stripCssComments(readFileSync(GLOBALS, "utf8"));

  it("no-scrollbar 가 globals.css 에 정의돼 있다", () => {
    expect(definesUtility(css, "no-scrollbar")).toBe(true);
    // 스크롤바를 실제로 숨기는 두 갈래가 모두 있어야 한다(Firefox / WebKit·Blink).
    expect(css).toMatch(/scrollbar-width:\s*none/);
    expect(css).toMatch(/\.no-scrollbar::-webkit-scrollbar/);
  });

  it("scroll-fade-y 가 정의돼 있고 두 엣지 속성에 반응한다", () => {
    expect(definesUtility(css, "scroll-fade-y")).toBe(true);
    expect(css).toMatch(/\.scroll-fade-y\[data-fade-top="true"\]/);
    expect(css).toMatch(/\.scroll-fade-y\[data-fade-bottom="true"\]/);
    expect(css).toMatch(/mask-image:/);
  });

  it("음성 대조군 — 정의되지 않은 이름은 false 로 나온다(헬퍼 고장 탐지)", () => {
    // 이 대조군이 없으면 definesUtility 가 항상 true 를 반환하도록 고장나도
    // 위 두 테스트가 초록으로 통과한다.
    expect(definesUtility(css, "no-scrollbar-does-not-exist")).toBe(false);
    expect(definesUtility(css, "scroll-fade-z")).toBe(false);
  });

  it("죽은 별칭 scrollbar-hide 를 쓰는 곳이 없다", () => {
    const offenders = walk(SRC).filter((file) =>
      /\bscrollbar-hide\b/.test(stripTsComments(readFileSync(file, "utf8"))),
    );
    expect(offenders.map((f) => f.replace(SRC, "src"))).toEqual([]);
  });
});
