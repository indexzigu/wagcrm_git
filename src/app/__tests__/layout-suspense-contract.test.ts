import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 앱 전역 화이트스크린 회귀 가드.
 *
 * 사고: `<Suspense fallback={<SidebarLayoutFallback>{children}</SidebarLayoutFallback>}>`
 * 처럼 같은 서브트리를 fallback 과 본문 양쪽에 두면, React 가 스트리밍된 본문으로
 * fallback 을 교체할 때 insertBefore 가 "이미 DOM 에 있는 자기 조상"을 삽입하려다
 * HierarchyRequestError 를 던지고 앱 전역이 빈 화면이 된다.
 *
 * 이 사고는 **타입·빌드·기존 테스트가 전부 통과**한다(런타임 DOM 문제라서). 실기기에서만
 * 드러나고, 그래서 `c50271a`(빌드 통과용 Suspense 추가) 이후 오래 살아남았다.
 * 렌더 테스트로는 스트리밍 reveal 을 재현할 수 없으므로 소스 계약으로 고정한다.
 */

const LAYOUT_RAW = readFileSync(join(process.cwd(), "src/app/layout.tsx"), "utf8");
const FALLBACK_RAW = readFileSync(
  join(process.cwd(), "src/components/crm/sidebar-layout-fallback.tsx"),
  "utf8",
);

/**
 * 주석을 제거하고 실제 코드만 남긴다 — 두 파일 모두 "children 을 되살리지 말 것"이라는
 * 경고를 주석으로 달고 있고, 그 경고문 자체에 `{children}` 이 들어간다. 주석까지 검사하면
 * 가드가 자기 경고문에 걸려 오탐한다(실제로 처음에 그랬다).
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const LAYOUT = stripComments(LAYOUT_RAW);
const FALLBACK = stripComments(FALLBACK_RAW);

describe("루트 레이아웃 Suspense 계약 — 화이트스크린 회귀 가드", () => {
  it("Suspense fallback 에 {children} 을 넘기지 않는다", () => {
    // fallback={...} 안에 children 참조가 있으면 사고 재발.
    const fallbacks = [...LAYOUT.matchAll(/fallback=\{([\s\S]*?)\}\s*>/g)].map((m) => m[1]);
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const f of fallbacks) {
      expect(f, `fallback 에 children 이 들어갔다: ${f.trim()}`).not.toContain("children");
    }
  });

  it("SidebarLayoutFallback 은 children prop 을 받지 않는다", () => {
    expect(FALLBACK).not.toMatch(/SidebarLayoutFallback\s*\(\s*\{\s*children/);
    expect(FALLBACK).not.toContain("{children}");
  });

  /**
   * 2026-08-25: 사이드바 상태 지속을 넣으며 Suspense 본문이
   * `PersistentSidebarLayout` → `SidebarStateBoundary`(쿠키를 읽는 서버 경계)로 한 겹
   * 깊어졌다. 이 계약이 지키는 것은 컴포넌트 **이름**이 아니라 "children 이 fallback 이
   * 아니라 본문 쪽 한 곳에서만 렌더된다"는 성질이므로, 앵커를 새 본문으로 옮기고
   * **사슬이 끊기지 않았는지**(경계가 children 을 실제 레이아웃으로 흘려보내는지)를
   * 한 홉 따라가 함께 확인한다.
   */
  it("children 은 Suspense 본문 한 곳에서만 렌더된다", () => {
    // 주석 제거 후 남은 `{children}` 이 둘 이상이면 fallback·본문 이중 렌더를 의심한다.
    expect([...LAYOUT.matchAll(/\{children\}/g)]).toHaveLength(1);
    // 2026-08-28: 사슬이 한 홉 짧아졌다 — 쿠키를 읽던 서버 경계(`SidebarStateBoundary`)가
    // 사라져 Suspense 본문이 곧 실제 레이아웃이다(설계서 §4). 지키는 성질은 그대로
    // "children 이 fallback 이 아니라 본문 한 곳에서만 렌더된다"이다.
    expect(LAYOUT).toContain("<PersistentSidebarLayout>{children}</PersistentSidebarLayout>");
  });

  it("가드의 근거가 주석에 남아 있다 (다음 사람이 되돌리지 않도록)", () => {
    // 원본을 본다 — 근거는 주석에 있다.
    expect(FALLBACK_RAW).toContain("HierarchyRequestError");
    expect(LAYOUT_RAW).toContain("HierarchyRequestError");
  });
});
