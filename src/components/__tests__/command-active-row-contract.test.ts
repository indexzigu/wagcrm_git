import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * cmdk 활성 행 표시 계약 (P8 §3 「색은 캐리어에 탄다」 · ss-ux 판정 2026-08-13).
 *
 * **왜 별도 계약인가:** `focus-ring-contract` 는 스코프를 `focus`/`focus-visible`/
 * `focus-within` 트리거로 **명시적으로 좁혀** 두었다. cmdk 는 실제 DOM 포커스를
 * 옮기지 않고 `aria-activedescendant` + `data-[selected=true]` 로 활성 행을
 * 표시하므로 그 정규식에 애초에 걸리지 않는다 — 그래서 이 축은 감시선이 없었다.
 *
 * **무엇이 문제였나:** 종전 활성 표시는 `data-[selected=true]:bg-accent` 하나였다.
 * `--accent` #F8FAFC 는 `--popover` #FFFFFF 대비 **1.03:1**, 짝 토큰
 * `--accent-foreground` 는 `--foreground` 와 **같은 값**이라 글자도 안 바뀐다.
 * 즉 ↑↓ 로 목록을 훑어도 지금 어디에 있는지 화면에 나오지 않았다
 * (WCAG 2.2 SC 2.4.7 Focus Visible · SC 1.4.11 Non-text Contrast 실패).
 * `bg-muted` 로 바꿔도 **1.10:1** 이라 배경은 근거가 되지 못한다 — 실제 지표는
 * `--primary` #0A3D62 좌측 바(흰 팝오버 대비 **11.31:1**)다.
 *
 * **왜 테스트인가:** 이 회귀는 마우스로 화면을 훑어서는 절대 안 보인다(키보드로만
 * 드러난다). tsc·eslint 는 클래스 문자열의 대비를 모르고, 소비처 3곳
 * (global-search · inline-edit-field · searchable-dropdown)이 전부 이 기본값에
 * 의존한다. 「투명 테두리 정리」 한 줄이면 조용히 되돌아간다.
 */

const COMMAND = join(process.cwd(), "src/components/ui/command.tsx");

/**
 * 🪤 **주석을 걷어내고 스캔한다.** 위 설명 주석이 금지 문자열(`bg-accent` 등)을
 * 인용하고 있어, 원문 그대로 검사하면 계약이 **자기 자신을 위반으로 잡는다.**
 * (이 레포에서 실제로 두 번 난 사고 — settlement-statement · encryption-audit.)
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** `className={cn("…"` 의 첫 문자열 리터럴 = 그 컴포넌트의 기본 클래스. */
function baseClassOf(source: string, dataSlot: string): string {
  const slotIndex = source.indexOf(`data-slot="${dataSlot}"`);
  expect(slotIndex, `${dataSlot} 를 찾지 못했다`).toBeGreaterThan(-1);
  const after = source.slice(slotIndex);
  const match = after.match(/className=\{cn\(\s*"((?:[^"\\]|\\.)*)"/);
  expect(match, `${dataSlot} 의 기본 클래스 문자열을 찾지 못했다`).not.toBeNull();
  return match![1];
}

describe("cmdk 활성 행 — 배경 하나로 끝내지 않는다", () => {
  const source = stripComments(readFileSync(COMMAND, "utf8"));

  it("활성 행에 배경 말고 대비를 감당하는 캐리어가 하나 더 있다", () => {
    const base = baseClassOf(source, "command-item");

    // 배경만 바꾸는 구성은 1.03~1.10:1 이라 지표가 못 된다.
    const hasBackground = /data-\[selected=true\]:bg-/.test(base);
    // ⚠️ `text-` 를 캐리어로 세지 말 것 — 초판이 그렇게 썼다가 **양성 프로브에서
    // 뚫렸다**: 종전의 죽은 짝 `text-accent-foreground` 가 유효 캐리어로 잡혀,
    // 되돌린 구성이 이 단언을 통과했다. 글자색 교체는 짝 토큰이 base 와 같은
    // 값이면 아무것도 안 바꾸는데 테스트가 그 사실을 알 수 없다. 그래서 값과
    // 무관하게 반드시 보이는 **기하 캐리어**만 인정한다.
    const hasNonBackgroundCarrier =
      /data-\[selected=true\]:(border|ring|outline|shadow)-/.test(base);

    expect(
      hasBackground && !hasNonBackgroundCarrier,
      "활성 행 표시가 배경 단독이다 — 흰 팝오버에서 1.1:1 대라 키보드 위치가 보이지 않는다",
    ).toBe(false);
    expect(hasNonBackgroundCarrier).toBe(true);
  });

  it("좌측 바는 프라이머리이고, 자리를 상시 예약해 선택 시 레이아웃이 밀리지 않는다", () => {
    const base = baseClassOf(source, "command-item");

    expect(base).toContain("data-[selected=true]:border-primary");
    // 투명 테두리를 지우면 활성화 순간 글자가 2px 튄다.
    expect(base).toMatch(/\bborder-l-2\b/);
    expect(base).toMatch(/\bborder-transparent\b/);
  });

  it("죽은 짝(accent-foreground = foreground)에 의존하지 않는다", () => {
    const base = baseClassOf(source, "command-item");
    expect(base).not.toContain("data-[selected=true]:text-accent-foreground");
  });
});

describe("cmdk 목록 — 스크롤바 등장으로 행 폭이 흔들리지 않는다", () => {
  const source = stripComments(readFileSync(COMMAND, "utf8"));

  it("CommandList 가 스크롤바 자리를 예약한다 (P8 Layout Stability ①)", () => {
    const base = baseClassOf(source, "command-list");
    expect(base).toContain("[scrollbar-gutter:stable]");
  });
});
