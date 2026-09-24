import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * **빨강 틴트 배경 위에 기본 빨강 글자(`text-destructive`)를 두지 않는다** — 앱 전역 계약.
 *
 * `--destructive`(#BF5050)는 흰 바탕에서 4.69:1 로 겨우 넘지만, 자기 틴트(`bg-destructive/10`)
 * 위에서는 4.11:1 로 본문 기준(4.5:1)에 못 미친다. 틴트가 진할수록 더 떨어진다. 이 조합은
 * 오류 문구 박스에 반복해서 쓰였다 — 공용 부품(`button`·`badge`)은 묶음 B 에서
 * `text-status-urgent-text`(#8F3C3C, 같은 틴트 위 6.39:1)로 바꿨고 그 계약은
 * `primitive-a11y.contract.test.ts` 가 지킨다. 이 파일은 **소비처**에 남은 사본을 막는다
 * (interfaces 점검 #4 후속, 2026-09-24 — 카톡 업로드 오류 박스 2곳이 마지막 잔존).
 *
 * 판정 범위(둘 다 **변형 접두사 없는** 토큰끼리만):
 * ① 한 클래스 문자열 안에 `bg-destructive/<N>` 과 `text-destructive` 가 함께 있는 경우.
 * ② JSX 요소의 className 이 `bg-destructive/<N>` 인데, 그 **안쪽 요소**가 자기 배경(`bg-*`) 없이
 *    `text-destructive` 를 쓰는 경우(틴트 상자 안의 오류 문구 — 리뷰가 ①만으로는 못 잡는다고 짚었다).
 * `hover:bg-destructive/10 hover:text-destructive` 같은 상태 변형은 잠깐 나타나는 강조라 대상이
 * 아니다(별도 판단). 주석은 AST 노드가 아니라 잡히지 않는다.
 *
 * ⚠️ 이 계약이 **못 보는 것**: 틴트가 다른 컴포넌트 파일에 있거나 prop 으로 전달돼 부모·자식이
 * 한 파일 JSX 트리로 이어지지 않는 경우. 그리고 틴트 없는 연한 표면(#FAF9F6·slate-50) 위의
 * `text-destructive`(4.45~4.48:1)도 미달이지만 배경을 정적으로 알 수 없어 여기서 판정하지 않는다.
 */

const SRC = join(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name === "generated") continue;
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

/** 한 클래스 문자열이 금지 조합을 담는가(변형 접두사 없는 토큰끼리만). */
function hasLowContrastPair(classes: string): boolean {
  const tokens = classes.split(/\s+/);
  const tintBg = tokens.some((token) => /^bg-destructive\/\d+$/.test(token));
  const plainText = tokens.includes("text-destructive");
  return tintBg && plainText;
}

const isTintBg = (token: string) => /^bg-destructive\/\d+$/.test(token);
/** 변형 접두사 없는 배경 토큰 — 안쪽 요소가 자기 표면을 깔면 바깥 틴트는 그 글자의 배경이 아니다. */
const isOwnSurface = (token: string) => token.startsWith("bg-") && !token.includes(":");

/** JSX 요소의 className 에 들어 있는 모든 문자열 조각(`cn(...)`·삼항 포함)을 토큰으로. */
function classNameTokens(element: ts.JsxElement | ts.JsxSelfClosingElement): string[] {
  const attributes = ts.isJsxElement(element) ? element.openingElement.attributes : element.attributes;
  const attribute = attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === "className",
  );
  if (!attribute?.initializer) return [];
  const pieces: string[] = [];
  const collect = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      pieces.push(node.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(attribute.initializer);
  return pieces.join(" ").split(/\s+/).filter(Boolean);
}

/** ② 틴트 상자 안쪽에서 자기 배경 없이 기본 빨강 글자를 쓰는 요소의 className. */
function nestedOffenses(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const isElement = (node: ts.Node): node is ts.JsxElement | ts.JsxSelfClosingElement =>
    ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
  // 틴트 상자 안쪽을 내려가며 본다 — 자기 배경을 깐 요소를 만나면 그 아래는 이 틴트와 무관하다.
  const inspect = (node: ts.Node) => {
    if (isElement(node)) {
      const tokens = classNameTokens(node);
      if (tokens.some(isOwnSurface)) return;
      if (tokens.includes("text-destructive")) found.push(tokens.join(" "));
    }
    ts.forEachChild(node, inspect);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && classNameTokens(node).some(isTintBg)) {
      node.children.forEach(inspect);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** 파일의 문자열·템플릿 조각 가운데 금지 조합을 담은 것(①) + 틴트 상자 안쪽 위반(②). */
function offendingLiterals(fileName: string, text: string): string[] {
  // 싼 거르기 — 이스케이프(`\u`)로 쓴 클래스는 원문에 이름이 안 보이므로 그 파일도 통과시킨다.
  if (!text.includes("bg-destructive/") && !text.includes("\\u")) return [];
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [...nestedOffenses(source)];
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      hasLowContrastPair(node.text)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("판정기 자체 — 반증 프로브", () => {
  it("변형 없는 틴트 배경 + 기본 빨강 글자를 잡는다", () => {
    expect(hasLowContrastPair("rounded-lg bg-destructive/10 px-3 text-xs text-destructive")).toBe(true);
    expect(hasLowContrastPair("bg-destructive/5 text-destructive")).toBe(true);
  });

  it("안전한 토큰·상태 변형·흰 바탕 빨강 글자는 잡지 않는다", () => {
    expect(hasLowContrastPair("bg-destructive/10 text-status-urgent-text")).toBe(false);
    expect(hasLowContrastPair("hover:bg-destructive/10 hover:text-destructive")).toBe(false);
    expect(hasLowContrastPair("text-destructive")).toBe(false);
  });

  it("AST 로 문자열만 읽는다 — 주석은 잡지 않고 이스케이프 문자열은 잡는다", () => {
    const probe = [
      '// "bg-destructive/10 text-destructive"',
      'const a = "bg-destructive/10 text-destructive";',
      "const b = `x ${y} bg-destructive/10 text-destructive`;",
      'const c = "bg-\\u0064estructive/10 text-destructive";',
    ].join("\n");
    expect(offendingLiterals("probe.tsx", probe)).toHaveLength(3);
  });

  it("틴트 상자 안쪽의 기본 빨강 글자를 잡고, 자기 배경을 깐 요소 아래는 건너뛴다", () => {
    const nested = [
      'const A = () => <div className="bg-destructive/5"><span className="text-destructive">x</span></div>;',
      'const B = () => <div className="bg-destructive/5"><div className="bg-white"><span className="text-destructive">x</span></div></div>;',
      'const C = () => <div className={cn("rounded bg-destructive/10", x)}>{ok ? <p className="text-destructive">y</p> : null}</div>;',
      'const D = () => <div className="bg-destructive/5"><span className="text-status-urgent-text">x</span></div>;',
      'const E = () => <div className="hover:bg-destructive/10"><span className="text-destructive">x</span></div>;',
    ];
    expect(nested.map((line, index) => offendingLiterals(`n${index}.tsx`, line).length)).toEqual([1, 0, 1, 0, 0]);
  });

  it("싼 거르기가 이스케이프만 쓴 파일을 놓치지 않는다(AST 판정과 등가)", () => {
    expect(offendingLiterals("escaped.tsx", 'const c = "bg-\\u0064estructive/10 text-destructive";')).toHaveLength(1);
  });
});

describe("앱 전역 — 빨강 틴트 위 기본 빨강 글자 금지", () => {
  const files = sourceFiles(SRC).map((full) => ({
    rel: relative(SRC, full).split("\\").join("/"),
    text: readFileSync(full, "utf8"),
  }));

  it("스캔 대상이 실제로 앱 소스다(빈 목록으로 초록이 되지 않게)", () => {
    expect(files.filter(({ text }) => text.includes("bg-destructive/")).length).toBeGreaterThan(5);
  });

  it("금지 조합이 없다", () => {
    const offenders = files.flatMap(({ rel, text }) =>
      offendingLiterals(rel, text).map((literal) => `${rel}: ${literal.trim().slice(0, 80)}`),
    );
    expect(offenders).toEqual([]);
  });
});
