import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * 사이드바 행 형태의 **단일 정본** 계약.
 *
 * 2026-08-25 오너 지적: 하단 「숨김모드」 라벨만 다른 행보다 4px 왼쪽에서 시작했다
 * (실측 x=41 vs 45). 원인은 값이 아니라 **구조**였다 — 행마다 같은 클래스 문자열을
 * 손으로 복제해 4벌을 두었는데, `asChild` 행은 안쪽 Link/button 의 `gap-3` 을 얻는
 * 반면 `asChild` 가 아닌 숨김모드 행만 프리미티브 기본값 `gap-2` 로 떨어졌다.
 * 복제가 남아 있는 한 같은 사고가 다른 축(높이·좌패딩·전환)으로 재발한다.
 *
 * 판정은 정규식이 아니라 **TypeScript AST** 다 — 이 파일의 설명 주석 자체가 `gap-2`·
 * `gap-3` 을 언급하므로, 원문 grep 은 주석을 위반으로 잡거나(자기 참조) 반대로
 * 주석 덕에 통과해 버린다(같은 레포의 `source-scan-contracts-must-strip-comments` 교훈).
 */
const SIDEBAR = join(__dirname, "..", "crm-sidebar.tsx");
const LAYOUT = join(__dirname, "..", "persistent-sidebar-layout.tsx");
const FALLBACK = join(__dirname, "..", "sidebar-layout-fallback.tsx");
const WRITER = join(__dirname, "..", "..", "ui", "sidebar.tsx");
const ROOT_LAYOUT = join(__dirname, "..", "..", "..", "app", "layout.tsx");

function parse(path: string) {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** 소스에 실제로 적힌 문자열 리터럴만 모은다(주석·식별자 제외). */
function stringLiterals(source: ts.SourceFile): string[] {
  const literals: string[] = [];
  walk(source, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
  });
  return literals;
}

/** `src/components` 아래 `.tsx` 를 전부 모은다(테스트 파일 제외). */
function collectTsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      collectTsxFiles(path, out);
    } else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) {
      out.push(path);
    }
  }
  return out;
}

function jsxElementsNamed(source: ts.SourceFile, tagName: string) {
  const found: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  walk(source, (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === tagName) {
      found.push(node);
    }
  });
  return found;
}

describe("CrmSidebar 행 형태 계약 — 클래스 정본은 한 곳뿐이다", () => {
  const source = parse(SIDEBAR);
  const buttons = jsxElementsNamed(source, "SidebarMenuButton");

  it("사이드바가 SidebarMenuButton 을 실제로 렌더한다 (스캐너 양성 대조군)", () => {
    // 파서가 고장 나 빈 배열을 돌려주면 아래 계약이 전부 조용히 통과한다.
    expect(buttons.length).toBeGreaterThanOrEqual(3);
  });

  it("모든 행이 SIDEBAR_ROW_CLASS 를 거쳐 형태를 받는다 — 클래스 문자열 복제 금지", () => {
    const offenders = buttons
      .filter((element) => {
        const className = element.attributes.properties.find(
          (property): property is ts.JsxAttribute =>
            ts.isJsxAttribute(property) && property.name.getText() === "className",
        );
        return !className?.getText().includes("SIDEBAR_ROW_CLASS");
      })
      .map((element) => element.getText().slice(0, 80));
    expect(offenders).toEqual([]);
  });

  it("행 클래스·라벨 클래스가 각각 한 번만 선언된다", () => {
    const literals = stringLiterals(source);
    const rowShape = literals.filter((text) => text.includes("rounded-lg pl-[15px]"));
    // 헤더 브랜드명·섹션 라벨도 접힘 시 opacity-0 이 되지만 전환 목록이 다른 별개 요소다 —
    // 메뉴 라벨만 고르려면 그 요소 고유의 전환 선언으로 좁혀야 한다.
    const labelShape = literals.filter((text) => text.includes("transition-[opacity,width,height] duration-200"));
    expect(rowShape).toHaveLength(1);
    expect(labelShape).toHaveLength(1);
  });

  it("아이콘↔라벨 간격이 행 클래스에 명시된다 — 프리미티브 기본값(gap-2)으로 떨어지지 않는다", () => {
    // `asChild` 가 아닌 행(숨김모드)은 버튼 자신이 flex 컨테이너라, 여기 없으면
    // sidebarMenuButtonVariants 의 gap-2 가 그대로 렌더된다(= 라벨 4px 어긋남).
    const rowShape = stringLiterals(source).find((text) => text.includes("rounded-lg pl-[15px]"));
    expect(rowShape).toContain("gap-3");
  });
});

/**
 * **호버 오버레이 불변식** 계약(2026-08-28).
 *
 * 종전 이 자리에는 「쿠키 상수 1개 ↔ 소비자 3종(writer·서버 리더·프리페인트)」 짝
 * 계약이 있었다. 사이드바가 상태를 저장하지 않게 되면서 그 세 소비자가 전부
 * 삭제됐고, 지켜야 하는 성질이 바뀌었다 — **호버가 본문을 밀 수 없다**는 것이다.
 *
 * 판정은 정규식이 아니라 **TypeScript AST** 다 — 이 파일의 설명 주석 자체가 금지
 * 대상 이름(`cookies` 등)을 언급하므로 원문 grep 은 자기 자신을 위반으로 잡는다
 * (이 레포의 `source-scan-contracts-must-strip-comments` 교훈).
 *
 * 설계 정본: `docs/private/specs/2026-08-28-sidebar-hover-overlay-design.md`
 */
describe("사이드바 호버 오버레이 계약 — 호버는 본문을 밀 수 없다", () => {
  const fallbackTokens = stringLiterals(parse(FALLBACK))
    .flatMap((text) => text.split(/\s+/))
    .filter((token) => token.includes("--sidebar-width"));

  it("판정 대상이 실제로 존재한다 (스캐너 양성 대조군)", () => {
    expect(fallbackTokens.length).toBeGreaterThan(0);
    expect(jsxElementsNamed(parse(LAYOUT), "SidebarProvider")).toHaveLength(1);
    expect(jsxElementsNamed(parse(SIDEBAR), "Sidebar").length).toBeGreaterThan(0);
  });

  it("정적 셸 폭은 레일 하나뿐이다 — 펼침 폭이 섞이면 셸↔본문 교체에서 점프한다", () => {
    expect(fallbackTokens.every((token) => token.includes("--sidebar-width-icon"))).toBe(true);
  });

  it("초기 상태를 주입하지 않는다 — 저장된 사이드바 상태가 없다", () => {
    const provider = jsxElementsNamed(parse(LAYOUT), "SidebarProvider")[0];
    const attribute = provider.attributes.properties.find(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) && property.name.getText() === "defaultOpen",
    );
    expect(attribute).toBeUndefined();
  });

  it("CrmSidebar 가 peek 모드로 사이드바를 연다 — 이게 빠지면 본문이 밀린다", () => {
    const sidebarEl = jsxElementsNamed(parse(SIDEBAR), "Sidebar")[0];
    const names = sidebarEl.attributes.properties
      .filter((property): property is ts.JsxAttribute => ts.isJsxAttribute(property))
      .map((property) => property.name.getText());
    expect(names).toContain("peek");
  });

  /**
   * ⛔ `peek` 은 `collapsible="icon"` 과 **짝이다.** 기본값 `"offcanvas"` 로 두면 접힘
   * 상태에서 패널이 `left: -10rem` 으로 화면 밖에 나가는데 빈 칸은 레일 폭을 그대로
   * 예약해, 화면엔 빈 띠만 남고 마우스·포커스를 받을 패널은 밖에 있어 **아무 반응도
   * 하지 않는다.** 타입은 두 prop 이 독립이라 이 조합을 막지 못한다(교차 검증 P1).
   */
  it("⛔ peek 을 쓰는 모든 자리가 collapsible=icon 을 함께 준다 (전수 스캔)", () => {
    const consumers = collectTsxFiles(join(__dirname, "..", ".."));
    expect(consumers.length).toBeGreaterThan(20); // 스캐너 양성 대조군

    const offenders: string[] = [];
    for (const path of consumers) {
      for (const element of jsxElementsNamed(parse(path), "Sidebar")) {
        const attrs = element.attributes.properties.filter(
          (property): property is ts.JsxAttribute => ts.isJsxAttribute(property),
        );
        const hasPeek = attrs.some((attribute) => attribute.name.getText() === "peek");
        if (!hasPeek) continue;
        const collapsible = attrs.find((attribute) => attribute.name.getText() === "collapsible");
        const value = collapsible?.initializer;
        const isIcon = value !== undefined && ts.isStringLiteral(value) && value.text === "icon";
        if (!isIcon) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("⛔ 어느 소비처도 쿠키를 다시 읽거나 쓰지 않는다 — 되살리면 T-052 가 그대로 돌아온다", () => {
    for (const path of [WRITER, LAYOUT, FALLBACK, SIDEBAR, ROOT_LAYOUT]) {
      const names = new Set<string>();
      walk(parse(path), (node) => {
        if (ts.isIdentifier(node)) names.add(node.text);
      });
      expect(names.has("cookies")).toBe(false);
      expect(names.has("serializeSidebarCookie")).toBe(false);
      expect(names.has("isSidebarOpenFromCookie")).toBe(false);
    }
  });

  it("루트 레이아웃에 삭제된 쿠키 소비자가 남아 있지 않다", () => {
    const root = parse(ROOT_LAYOUT);
    expect(jsxElementsNamed(root, "SidebarStateBoundary")).toHaveLength(0);
    expect(jsxElementsNamed(root, "SidebarPrepaintScript")).toHaveLength(0);
  });
});
