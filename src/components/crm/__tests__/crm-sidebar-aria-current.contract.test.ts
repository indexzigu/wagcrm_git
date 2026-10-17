import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * 사이드바 활성 링크는 색만이 아니라 `aria-current` 로도 「지금 화면」을 알린다(WCAG 1.3.1·4.1.2).
 *
 * `isActive` 를 받는 메뉴 버튼(`SidebarMenuButton`·`SidebarMenuSubButton`) 안의 `Link` 는
 * 모두 `aria-current` 속성을 가져야 한다 — 상위 항목·하위 항목·설정 행 전부. 색 클래스만
 * 바뀌고 스크린리더는 현재 위치를 모르던 상태로 되돌아가는 것을 막는다.
 * 판정은 TypeScript AST(주석이 이 규칙을 언급해도 오판하지 않는다).
 */
const SIDEBAR = join(__dirname, "..", "crm-sidebar.tsx");
const BUTTONS = new Set(["SidebarMenuButton", "SidebarMenuSubButton"]);

function linksUnderActiveButtons() {
  const sf = ts.createSourceFile(SIDEBAR, readFileSync(SIDEBAR, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { line: number; hasAriaCurrent: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && BUTTONS.has(node.openingElement.tagName.getText(sf))) {
      const hasIsActive = node.openingElement.attributes.properties.some(
        (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "isActive",
      );
      if (hasIsActive) {
        for (const child of node.children) {
          if (ts.isJsxElement(child) && child.openingElement.tagName.getText(sf) === "Link") {
            found.push({
              line: sf.getLineAndCharacterOfPosition(child.getStart(sf)).line + 1,
              hasAriaCurrent: child.openingElement.attributes.properties.some(
                (a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "aria-current",
              ),
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("사이드바 활성 링크 aria-current", () => {
  const links = linksUnderActiveButtons();

  it("상위·하위·설정 행 링크를 모두 찾는다(스캐너 자체 점검)", () => {
    expect(links.length).toBeGreaterThanOrEqual(3);
  });

  it("isActive 메뉴 버튼 안의 Link 는 전부 aria-current 를 가진다", () => {
    const missing = links.filter((l) => !l.hasAriaCurrent).map((l) => `crm-sidebar.tsx:${l.line}`);
    expect(missing).toEqual([]);
  });
});
