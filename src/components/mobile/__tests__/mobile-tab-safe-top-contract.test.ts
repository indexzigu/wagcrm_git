import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 모바일 탭 상단 safe-area 회귀 가드.
 *
 * 사고: 스탠드얼론 웹앱은 `viewportFit:"cover"` 라 콘텐츠가 상태바/다이내믹 아일랜드
 * **밑까지** 깔린다. 탭 본문 컨테이너들이 `pt-2`(8px) 또는 여백 없음으로 제각각이라
 * 인셋(~59px)을 못 덮었고, `MobileTopBar` 카드의 캡션이 시계와 겹쳐 보였다
 * (오너 실기기 확인 2026-07-16).
 *
 * 원인은 "한 곳을 빠뜨림"이 아니라 **7곳이 각자 정하고 있었다**는 것이다. 그래서 값만
 * 고치면 다음 탭이 추가될 때 또 빠진다 — 불변식으로 고정한다:
 *
 *   **`MobileTopBar` 를 렌더하는 파일은 `mobile-tab-safe-top` 을 가져야 한다.**
 *
 * 렌더 테스트로는 못 잡는다(jsdom 에 safe-area 인셋이 없고 `env()` 는 항상 0). 그래서
 * 소스 계약으로 둔다 — `mobile-breakpoint-contract` 가 같은 이유로 쓰는 방식이다.
 */

const MOBILE_DIR = join(process.cwd(), "src/components/mobile");
const SAFE_TOP = "mobile-tab-safe-top";
/** 화면을 꽉 채우는 탭 본문 컨테이너의 표식 — 최상위 탭인지 중첩 컴포넌트인지 가른다. */
const FULL_HEIGHT = "min-h-[calc(100dvh+1px)]";

const sourceFiles = readdirSync(MOBILE_DIR).filter(
  (f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"),
);

/**
 * 대상 = `<MobileTopBar` 를 렌더하면서 **자신이 full-height 탭 컨테이너를 가진** 파일.
 *
 * full-height 조건이 없으면 오탐한다 — `mobile-today-summary-bar.tsx` 는 MobileTopBar 를
 * 셸로 쓰지만 `mobile-calendar-home.tsx` **안에 중첩**돼 있어(부모가 이미 safe-top 보유)
 * 여기에 또 넣으면 인셋이 두 번 더해진다. (이 가드의 첫 판이 실제로 그렇게 오탐했다.)
 */
const tabContainers = sourceFiles.filter((f) => {
  const src = readFileSync(join(MOBILE_DIR, f), "utf8");
  return src.includes("<MobileTopBar") && src.includes(FULL_HEIGHT);
});

describe("모바일 탭 상단 safe-area 계약", () => {
  it("탭 컨테이너를 실제로 찾는다 (가드가 공회전하지 않는지)", () => {
    // 이 단언이 없으면 대상 0개일 때 아래 테스트가 조용히 통과한다.
    expect(tabContainers.length).toBeGreaterThanOrEqual(5);
  });

  it.each(tabContainers)("%s — 탭 컨테이너면 mobile-tab-safe-top 이 있다", (file) => {
    const src = readFileSync(join(MOBILE_DIR, file), "utf8");
    expect(
      src.includes(SAFE_TOP),
      `${file} 이 탭 컨테이너인데 ${SAFE_TOP} 이 없다 — 스탠드얼론에서 상단바가 상태바와 겹친다.`,
    ).toBe(true);
  });

  it("탭 컨테이너에 맨손 pt-2 가 되살아나지 않았다", () => {
    // 옛 형태(`min-h-[calc(100dvh+1px)] ... pt-2`)로 되돌리면 인셋을 다시 못 덮는다.
    for (const file of tabContainers) {
      const src = readFileSync(join(MOBILE_DIR, file), "utf8");
      for (const line of src.split("\n")) {
        if (!line.includes("min-h-[calc(100dvh+1px)]")) continue;
        if (line.includes(SAFE_TOP)) continue;
        expect(
          /\bpt-\d/.test(line),
          `${file}: safe-area 없이 원시 pt-* 를 쓰는 탭 컨테이너 — ${line.trim()}`,
        ).toBe(false);
      }
    }
  });
});

describe("globals.css — mobile-tab-safe-top 정의 계약", () => {
  const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("클래스가 정의돼 있다", () => {
    expect(CSS).toMatch(/\.mobile-tab-safe-top\s*\{/);
  });

  it("safe-area 인셋을 실제로 더한다 (값만 남고 env() 가 빠지는 회귀 방지)", () => {
    expect(CSS).toMatch(
      /\.mobile-tab-safe-top\s*\{[^}]*env\(safe-area-inset-top,\s*0px\)[^}]*\}/,
    );
  });

  it("죽은 .mobile-topbar 가 되살아나지 않았다", () => {
    // 소비처 0곳이던 orphan. 남겨두면 "safe-area 이미 처리됨"으로 오독된다(실제로 그랬다).
    expect(CSS).not.toMatch(/\.mobile-topbar\s*\{/);
  });
});
