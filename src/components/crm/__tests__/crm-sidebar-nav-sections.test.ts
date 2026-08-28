import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import * as lucide from "lucide-react";
import { navSections } from "../crm-sidebar";

/**
 * 사이드바 섹션 구조 계약.
 *
 * 재배치는 앞으로도 계속 일어난다(페이지가 늘 때마다). 그때 항목을 옮기다
 * 링크가 두 섹션에 남거나 섹션이 비는 사고를 막는 것이 이 파일의 목적이다.
 * **순서와 소속은 제품 판단이라 고정하지 않는다** — 구조 불변식만 본다.
 */
describe("CrmSidebar 섹션 구조 계약", () => {
  const allItems = navSections.flatMap((section) => section.items);

  it("같은 링크가 두 곳에 노출되지 않는다", () => {
    const hrefs = allItems.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("빈 섹션을 두지 않는다", () => {
    for (const section of navSections) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it("섹션 라벨이 서로 다르다 — 접힘 모드에서 구분선만 남아도 순서가 의미를 가져야 한다", () => {
    const labels = navSections.filter((s) => s.label).map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("모든 항목이 라벨·설명·아이콘을 갖는다 (설명은 접힘 모드 툴팁의 유일 단서다)", () => {
    for (const item of allItems) {
      expect(item.label.trim()).not.toBe("");
      expect(item.description.trim()).not.toBe("");
      expect(item.icon).toBeTruthy();
    }
  });

  it("UI 문구에 em-dash 를 쓰지 않는다 (StyleSeed 기계 점검 1)", () => {
    for (const section of navSections) {
      if (section.label) expect(section.label).not.toMatch(/—/);
      for (const item of section.items) {
        expect(item.label).not.toMatch(/—/);
      }
    }
  });

  /**
   * 접힘(collapsible="icon") 모드에서는 라벨이 사라지고 아이콘만 남는다.
   * 같은 아이콘을 두 항목이 쓰면 그 상태에서 둘은 **식별 불가**가 된다
   * (hover 툴팁 전에는 구분할 단서가 없다) — 접힘 모드의 존재 이유를 깬다.
   * 실제로 거래처/셀러·주문/정산·판매관리/영업관리 3쌍이 겹쳐 있었다.
   */
  it("같은 아이콘을 두 항목이 쓰지 않는다 — 접힘 모드에서 아이콘이 유일 단서다", () => {
    const icons = allItems.map((item) => item.icon);
    const duplicated = icons.filter((icon, i) => icons.indexOf(icon) !== i);
    const names = duplicated.map(
      (icon) => allItems.find((item) => item.icon === icon)?.label ?? "?",
    );
    expect(names).toEqual([]);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("무라벨 섹션은 최대 1개이고, 있으면 첫 번째다 (접힘 모드 그룹 경계 보존)", () => {
    const unlabeled = navSections.filter((section) => !section.label);
    expect(unlabeled.length).toBeLessThanOrEqual(1);
    if (unlabeled.length === 1) {
      expect(navSections[0]?.label).toBeUndefined();
    }
  });

  it("링크는 앱 내부 절대경로다", () => {
    for (const item of allItems) {
      expect(item.href.startsWith("/")).toBe(true);
    }
  });
});

/**
 * 접힘 모드의 아이콘은 **lucide 의 정본 이름으로만** import 한다.
 *
 * lucide 는 개명된 아이콘의 옛 이름을 alias 로 남긴다(`BarChart3Icon` → `ChartColumn`).
 * 지금은 동작하지만 메이저 업그레이드에서 제거되면 **빌드가 깨지고**, 그때까지는 소스에
 * 적힌 이름과 실제로 그려지는 그림이 어긋나 있어 아이콘 검토가 헛돈다 — 2026-08-18
 * 재점검에서 실제로 "대시보드는 BarChart3"라고 읽고 시작했는데 렌더는 `ChartColumn`
 * 이었다.
 *
 * 판정은 **컴포넌트의 `displayName`**(= 정본 이름의 PascalCase)과 import 식별자를
 * 대조한다. `node_modules` 내부 파일 구조를 뒤지지 않으므로 lucide 버전이 올라가도
 * 그대로 산다. 소스 파싱은 정규식이 아니라 **TypeScript AST** 다(주석·문자열에 적힌
 * 아이콘 이름을 import 로 오인하지 않는다 — `ui-copy-em-dash.contract.test.ts` 와 같은 이유).
 */
describe("CrmSidebar 아이콘 이름 계약", () => {
  const SIDEBAR_PATH = join(__dirname, "..", "crm-sidebar.tsx");

  /** lucide 컴포넌트의 `displayName` = 정본 이름. alias 로 부르면 import 식별자와 어긋난다. */
  function canonicalNameOf(importedName: string): string | undefined {
    const component = (lucide as Record<string, { displayName?: string } | undefined>)[importedName];
    return component?.displayName;
  }

  function lucideImportNames(source: string): string[] {
    const sourceFile = ts.createSourceFile(
      "crm-sidebar.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const names: string[] = [];
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (statement.moduleSpecifier.text !== "lucide-react") continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        names.push((element.propertyName ?? element.name).text);
      }
    }
    return names;
  }

  const importedNames = lucideImportNames(readFileSync(SIDEBAR_PATH, "utf8"));

  it("사이드바가 lucide 아이콘을 실제로 import 한다 (스캐너 양성 대조군)", () => {
    // 파서가 고장 나 빈 배열을 돌려주면 아래 계약이 조용히 무력화된다.
    expect(importedNames.length).toBeGreaterThanOrEqual(14);
  });

  it("deprecated alias 로 import 하지 않는다 — 소스의 이름과 렌더되는 그림이 같아야 한다", () => {
    const mismatched = importedNames
      .map((name) => ({ name, canonical: canonicalNameOf(name) }))
      .filter(({ name, canonical }) => canonical !== undefined && canonical !== name.replace(/Icon$/, ""))
      .map(({ name, canonical }) => `${name} → ${canonical}`);
    expect(mismatched).toEqual([]);
  });

  it("alias 판정기가 실제로 alias 를 잡는다 (반례 프로브)", () => {
    // 이 프로브가 없으면 "전부 통과"가 판정기 고장인지 진짜 통과인지 구분되지 않는다.
    // BarChart3Icon 은 lucide 1.x 가 남긴 실제 alias 다(정본 = ChartColumn).
    expect(canonicalNameOf("BarChart3Icon")).toBe("ChartColumn");
    expect(canonicalNameOf("GaugeIcon")).toBe("Gauge");
  });
});
