import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * 사이드바 아이콘 크기의 소유권 계약.
 *
 * 실사고(2026-08-18): `crm-sidebar.tsx` 가 아이콘마다 `size-[18px]` 를 선언했는데
 * 실제 렌더는 16px 였다. 미방출이 아니라 **특이성 경합 패배**다 —
 * `sidebarMenuButtonVariants` 의 `[&_svg]:size-4` 는 `.\[\&_svg\]\:size-4 svg`
 * 로 컴파일돼 (0,1,1) 이고, 소비처가 <svg> 자체에 붙인 `.size-\[18px\]` 는 (0,1,0)
 * 이라 소스 순서와 무관하게 항상 진다(Tailwind v4 는 둘을 같은 @layer utilities
 * 에 넣어 레이어로도 갈리지 않는다).
 *
 * 이 계열의 세 번째 사고였다: `no-scrollbar`(정의처 없음, PR #409) →
 * `uppercase`(순한글에 무효) → `size-[18px]`(특이성 패배). 셋 다 tsc·eslint·테스트를
 * 전부 통과하고 화면도 그럴듯하다 — 선언이 남아 있으면 다음 사람이 "크기 설계가
 * 끝났다"고 읽는 **거짓 흔적**이 된다.
 *
 * ⛔ 이 버그를 재도입할 사람은 프리미티브가 아니라 **소비처**를 편집한다.
 * 그래서 그물도 소비처를 겨눈다.
 */

const SRC = join(process.cwd(), "src");
const PRIMITIVE = join(SRC, "components", "ui", "sidebar.tsx");

/** 프리미티브가 소유하는 아이콘 크기 유틸(정본). */
const OWNED_ICON_SIZE = "[&_svg]:size-[18px]";

/** `size-4` · `size-[18px]` · `!size-5` 처럼 **요소 자신의** 크기를 정하는 유틸. */
const BARE_SIZE_UTILITY = /(?:^|\s)!?size-(?:\d|\[)/;

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** JSX 여는 태그의 이름(`<Foo.Bar>` 는 `Foo.Bar`). */
function tagNameOf(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return tag.getText();
}

/** className 속성 안에 등장하는 모든 문자열 리터럴(cn("a", "b") 안쪽 포함). */
function classNameLiterals(node: ts.JsxElement | ts.JsxSelfClosingElement): string[] {
  const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
  const literals: string[] = [];
  for (const attribute of attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== "className") continue;
    const collect = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) literals.push(n.text);
      else if (ts.isTemplateExpression(n)) {
        literals.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
      }
      n.forEachChild(collect);
    };
    if (attribute.initializer) collect(attribute.initializer);
  }
  return literals;
}

type Violation = { file: string; line: number; tag: string; className: string };

/**
 * `<SidebarMenuButton>` **자손**이 자기 크기를 직접 선언하는 곳을 찾는다.
 * 버튼 자신의 className 은 제외한다 — 거기에 `[&_svg]:size-*` 로 넘기는 것이
 * 유일하게 작동하는 오버라이드 경로다(같은 요소·같은 변형 접두사라야 cn() 의
 * tailwind-merge 가 base 를 정상 대체한다).
 */
function findViolations(fileLabel: string, source: string): Violation[] {
  const sourceFile = parse(fileLabel, source);
  const violations: Violation[] = [];

  const scanDescendants = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      for (const className of classNameLiterals(node)) {
        if (!BARE_SIZE_UTILITY.test(className)) continue;
        violations.push({
          file: fileLabel,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          tag: tagNameOf(node),
          className,
        });
      }
    }
    node.forEachChild(scanDescendants);
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && tagNameOf(node) === "SidebarMenuButton") {
      // 여는 태그(=버튼 자신의 className)는 건너뛰고 children 만 훑는다.
      for (const child of node.children) scanDescendants(child);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return violations;
}

/** src 아래 제품 소스(.ts/.tsx, 테스트 제외). */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" || entry === "node_modules" ? [] : walk(full);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** `sidebarMenuButtonVariants = cva("<base>", …)` 의 base 문자열. 주석은 AST 가 걸러준다. */
function menuButtonVariantsBase(): string {
  const sourceFile = parse("sidebar.tsx", readFileSync(PRIMITIVE, "utf8"));
  let base: string | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText() === "sidebarMenuButtonVariants" &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const [first] = node.initializer.arguments;
      if (first && ts.isStringLiteral(first)) base = first.text;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  if (base === undefined) throw new Error("sidebarMenuButtonVariants 의 cva base 문자열을 찾지 못했다");
  return base;
}

describe("사이드바 아이콘 크기 — 프리미티브가 소유하고 소비처는 선언하지 않는다", () => {
  it("프리미티브가 아이콘 크기를 정확히 한 번 선언한다", () => {
    const base = menuButtonVariantsBase();
    const occurrences = base.split(OWNED_ICON_SIZE).length - 1;
    expect(occurrences).toBe(1);
    // 종전 값이 남아 있으면 둘 다 방출돼 어느 쪽이 이기는지가 소스 순서에 걸린다.
    expect(base).not.toMatch(/\[&_svg\]:size-4(?![\w[-])/);
    // shrink-0 도 같은 자리에서 상속된다 — 소비처가 다시 선언할 이유가 없어야 한다.
    expect(base).toContain("[&_svg]:shrink-0");
  });

  it("SidebarMenuButton 자손이 자기 크기를 직접 선언하지 않는다", () => {
    const consumers = walk(SRC).filter(
      (file) => file !== PRIMITIVE && /<SidebarMenuButton\b/.test(readFileSync(file, "utf8")),
    );

    // 양성 대조군 — 스캐너가 실제로 소비처를 집었는가. 빈 목록이면 아래 단언이
    // 공허하게 통과한다(예: 태그가 별칭으로 렌더되도록 바뀐 경우).
    expect(consumers.length).toBeGreaterThan(0);

    const violations = consumers.flatMap((file) =>
      findViolations(relative(process.cwd(), file), readFileSync(file, "utf8")),
    );
    expect(violations).toEqual([]);
  });

  it("음성 대조군 — 판정기가 실제 위반을 잡고, 정상 오버라이드는 통과시킨다", () => {
    const offending = `
      const A = () => (
        <SidebarMenuButton className="h-10">
          <Link href="/"><Icon className="size-[18px] shrink-0" /><span>라벨</span></Link>
        </SidebarMenuButton>
      );`;
    expect(findViolations("offending.tsx", offending)).toHaveLength(1);

    // 작동하는 오버라이드 경로는 버튼 자신의 className 이다 — 잡으면 안 된다.
    const compliant = `
      const B = () => (
        <SidebarMenuButton className={cn("h-10", "[&_svg]:size-[20px]")}>
          <Link href="/"><Icon /><span className="w-0 truncate">라벨</span></Link>
        </SidebarMenuButton>
      );`;
    expect(findViolations("compliant.tsx", compliant)).toEqual([]);

    // SidebarMenuButton 밖의 size-* 는 이 계약의 대상이 아니다(헤더 브랜드 마크 등).
    const outside = `const C = () => (<button><BrandMark className="size-9" /></button>);`;
    expect(findViolations("outside.tsx", outside)).toEqual([]);
  });
});
