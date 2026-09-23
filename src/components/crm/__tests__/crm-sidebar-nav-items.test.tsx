import { describe, expect, it } from "vitest";
import { navSections } from "../crm-sidebar";

/**
 * 「도구」 섹션의 어시스턴트 → 결재함 교체 계약.
 *
 * `crm-sidebar-nav-sections.test.ts` 는 구조 불변식(중복 없음·빈 섹션 없음 등)만
 * 보고 특정 항목의 라벨·href 는 의도적으로 고정하지 않는다. 이 파일은 그 반대 —
 * "도구" 섹션에 결재함이 있고 옛 어시스턴트 항목은 완전히 빠졌는지를 순수하게
 * (렌더 없이) 단언한다. `/assistant` 라우트는 결재함으로 리다이렉트만 하므로
 * (`src/app/assistant/page.tsx`) 이 파일은 사이드바 항목 배열만 본다.
 */
describe("CrmSidebar 도구 섹션 — 결재함 교체", () => {
  const allItems = navSections.flatMap((section) => section.items);
  const toolsSection = navSections.find((section) => section.label === "도구");

  it("도구 섹션에 결재함 항목이 있다", () => {
    const approvals = toolsSection?.items.find((item) => item.href === "/approvals");
    expect(approvals?.label).toBe("결재함");
  });

  it("어시스턴트 항목은 더 이상 없다", () => {
    expect(allItems.find((item) => item.href === "/assistant")).toBeUndefined();
    expect(allItems.find((item) => item.label === "AI 어시스턴트")).toBeUndefined();
  });
});
