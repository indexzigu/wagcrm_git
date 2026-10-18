import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { navSections } from "../crm-sidebar";

/**
 * 메뉴 이름 = 페이지 제목(오너 결정 2026-10-16·17, 메뉴 기준).
 *
 * 사이드바 `navSections` 의 각 항목(하위 항목 포함)이 가리키는 화면은 `CrmShell` 의
 * `title` 에 **메뉴 라벨과 같은 문자열 리터럴**을 넘긴다. 화면 안 카드 머리에 제목을 따로
 * 그리던 옛 방식은 메뉴와 제목이 갈라지는 원인이었다(「거래처 목록」 vs 메뉴 「거래처」 등).
 *
 * 판정은 TypeScript AST 다 — 주석·다른 컴포넌트의 `title=` 을 잘못 집지 않도록
 * `<CrmShell ...>` 여는 태그의 `title` 속성만 본다.
 *
 * 예외: `/`(대시보드)는 제목 없는 화면, `/assets` 는 하위 항목을 묶는 그룹 라벨(자기 화면 없음).
 */
const SRC = join(__dirname, "..", "..", "..");

const PAGE_FILES: Record<string, string> = {
  "/calendar": "app/calendar/calendar-page-client.tsx",
  "/outreach": "app/outreach/page.tsx",
  "/pipeline": "components/crm/crm-dashboard.tsx",
  "/order-converter": "components/crm/order-dashboard.tsx",
  "/settlement": "app/settlement/settlement-page-client.tsx",
  "/reports/pnl": "components/crm/pnl-report-client.tsx",
  "/reports/inflow": "components/crm/inflow-report-client.tsx",
  "/partners": "components/crm/partners-management.tsx",
  "/sellers": "components/crm/sellers-management.tsx",
  "/deals": "app/deals/deals-page-client.tsx",
  "/assets/archive": "components/crm/asset-library.tsx",
  "/assets/price-sheets": "components/crm/price-sheet/price-sheet-list.tsx",
  "/assets/katalk": "components/crm/katalk/katalk-page.tsx",
  "/assets/inbox": "components/crm/reference-inbox/reference-inbox-client.tsx",
  "/admin/stories": "app/admin/stories/page.tsx",
  "/approvals": "app/approvals/page.tsx",
  "/claim-check": "app/claim-check/page.tsx",
};

const EXEMPT = new Set(["/", "/assets"]);

function crmShellTitles(relPath: string): string[] {
  const path = join(SRC, relPath);
  const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const titles: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(sf) === "CrmShell"
    ) {
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== "title" || !attr.initializer) continue;
        const init = attr.initializer;
        if (ts.isStringLiteral(init)) titles.push(init.text);
        else if (ts.isJsxExpression(init) && init.expression) {
          // 모바일 분기를 함께 그리는 화면은 `isMobile ? undefined : "제목"` 꼴로 넘긴다 — 갈래의 리터럴도 센다.
          const branches = ts.isConditionalExpression(init.expression)
            ? [init.expression.whenTrue, init.expression.whenFalse]
            : [init.expression];
          for (const e of branches) {
            if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) titles.push(e.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return titles;
}

const navItems = navSections.flatMap((section) =>
  section.items.flatMap((item) => [
    { href: item.href, label: item.label },
    ...(item.children ?? []).map((c) => ({ href: c.href, label: c.label })),
  ]),
);

describe("메뉴 이름 = 페이지 제목", () => {
  it("모든 메뉴 항목이 매핑 표에 있거나 예외로 등재돼 있다", () => {
    const missing = navItems.filter((i) => !EXEMPT.has(i.href) && !PAGE_FILES[i.href]).map((i) => i.href);
    expect(missing).toEqual([]);
  });

  it.each(navItems.filter((i) => !EXEMPT.has(i.href)))("$href → CrmShell title 「$label」", ({ href, label }) => {
    expect(crmShellTitles(PAGE_FILES[href])).toContain(label);
  });

  it("반증 프로브 — 스캐너가 다른 컴포넌트의 title 은 집지 않는다", () => {
    // price-sheet-detail 은 메뉴에 없는 CrmShell title 「가격표 상세」를 쓴다(양성 대조) —
    // 메뉴 라벨 「가격표」와 다르므로 스캐너가 부분 일치로 뭉개지 않는지도 함께 본다.
    expect([...new Set(crmShellTitles("components/crm/price-sheet/price-sheet-detail.tsx"))]).toEqual(["가격표 상세"]);
  });
});
