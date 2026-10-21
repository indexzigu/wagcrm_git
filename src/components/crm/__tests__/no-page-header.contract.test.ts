import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { navSections } from "../crm-sidebar";

/**
 * 데스크톱 페이지에는 페이지 머리(제목·설명 줄)가 없다 — 오너 디자인 방침(2026-10-21 재확인).
 *
 * 애플 UI 묶음 1(#207)이 모든 메뉴 화면 위에 `CrmShell` 머리(큰 제목 + 설명, 84px)를 넣어 요약띠·목록이
 * 아래로 밀렸고, 오너 지시로 머리를 없앴다. 분할 버튼·주요 버튼은 각 화면의 카드 도구줄이 소유한다.
 * (이 파일은 그 전의 「메뉴 이름 = 페이지 제목」 계약을 대체한다 — 판정할 페이지 제목이 더는 없다.)
 *
 * 판정은 TypeScript AST 다 — 주석을 잘못 집지 않도록 JSX 노드만 본다.
 * ① `<CrmShell>` 에 `variant` 외 속성이 없다 ② 메뉴 화면 파일에 `<h1>` 이 없다(카드 안 페이지 제목 재발명 방지).
 * 한 건을 여는 상세 화면의 그 건 이름은 내용이라 이 계약 대상이 아니다(카드 안 h2 로 둔다).
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

type Hit = { kind: "shell-attr" | "h1"; detail: string };

export function findPageHeaderHits(source: string, fileName = "probe.tsx"): Hit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      if (tag === "CrmShell") {
        for (const attr of node.attributes.properties) {
          const name = ts.isJsxAttribute(attr) ? attr.name.getText(sf) : "{...spread}";
          if (name !== "variant") hits.push({ kind: "shell-attr", detail: name });
        }
      }
      if (tag === "h1") hits.push({ kind: "h1", detail: "h1" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const navItems = navSections.flatMap((section) =>
  section.items.flatMap((item) => [
    { href: item.href, label: item.label },
    ...(item.children ?? []).map((c) => ({ href: c.href, label: c.label })),
  ]),
);

describe("데스크톱 페이지 머리 없음", () => {
  it("모든 메뉴 항목이 검사 표에 있거나 예외로 등재돼 있다", () => {
    const missing = navItems.filter((i) => !EXEMPT.has(i.href) && !PAGE_FILES[i.href]).map((i) => i.href);
    expect(missing).toEqual([]);
  });

  it.each(navItems.filter((i) => !EXEMPT.has(i.href)))("$href 「$label」 — CrmShell 머리 속성·h1 페이지 제목 없음", ({ href }) => {
    const path = join(SRC, PAGE_FILES[href]);
    expect(findPageHeaderHits(readFileSync(path, "utf8"), path)).toEqual([]);
  });

  it("반증 프로브 — 머리 속성·spread·h1 은 잡고, 주석·variant·h2 는 잡지 않는다", () => {
    const bad = `const a = <CrmShell title="정산 관리" actions={<b />}><h1>제목</h1></CrmShell>;
const b = <CrmShell {...p}><div /></CrmShell>;`;
    expect(findPageHeaderHits(bad).map((h) => h.detail).sort()).toEqual(["actions", "h1", "title", "{...spread}"]);
    const ok = `// <CrmShell title="옛 제목"> 는 더 이상 쓰지 않는다
const c = <CrmShell variant="focus"><h2>그 건 이름</h2></CrmShell>;`;
    expect(findPageHeaderHits(ok)).toEqual([]);
  });
});
