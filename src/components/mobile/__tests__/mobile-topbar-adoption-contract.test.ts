import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 모바일 탭 헤더 계약 — 모든 모바일 뷰는 MobileTopBar 셸을 공유한다
 * (오너 확정 2026-07-15).
 *
 * 배경: 홈·캠페인·일정은 MobileTopBar(글래스 카드)로 갔는데 정산·셀러·영업 세
 * 화면만 구 `.crm-topbar`(풀블리드 sticky 바)에 남아, 탭을 오갈 때 헤더 인상이
 * 튀었다. 세 화면을 전환하면서 이 계약으로 고정한다.
 *
 * `.crm-topbar` 는 **데스크톱과 공유하는 클래스**다(globals.css). 클래스 자체를
 * 고치면 데스크톱이 함께 바뀌므로(P5 — 모바일 조정이 데스크톱을 훼손하지 않을 것),
 * 모바일에서는 **사용만 걷어낸다**. 그래서 이 테스트는 globals.css 의 정의가 아니라
 * `src/components/mobile/` 안의 **사용처**만 검사한다.
 */

const MOBILE_DIR = join(process.cwd(), "src", "components", "mobile");

function mobileViewFiles(): string[] {
  return readdirSync(MOBILE_DIR)
    .filter((name) => /^mobile-.*-view\.tsx$/.test(name))
    .map((name) => join(MOBILE_DIR, name));
}

describe("모바일 헤더 — MobileTopBar 단일 셸", () => {
  it("모바일 뷰가 구 .crm-topbar 를 쓰지 않는다", () => {
    // 뷰 파일이 실제로 잡히는지 자체 점검(파일명 규칙이 바뀌면 이 테스트가 무력해진다)
    const files = mobileViewFiles();
    expect(files.length).toBeGreaterThan(3);

    const offenders = files
      .filter((file) => /\bcrm-topbar\b/.test(readFileSync(file, "utf8")))
      .map((file) => file.replace(process.cwd() + "/", ""));

    expect(offenders).toEqual([]);
  });

  it("헤더를 가진 모바일 뷰는 MobileTopBar 를 쓴다", () => {
    const offenders: string[] = [];
    for (const file of mobileViewFiles()) {
      const source = readFileSync(file, "utf8");
      // 상단 제목(h1)을 직접 그리는 뷰는 자체 헤더를 만든 것이다 — 셸을 써야 한다.
      const hasOwnHeading = /<h1[\s>]/.test(source);
      const usesShell = /MobileTopBar/.test(source);
      if (hasOwnHeading && !usesShell) {
        offenders.push(
          `${file.replace(process.cwd() + "/", "")} — <h1> 을 직접 그리면서 MobileTopBar 를 쓰지 않는다`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
