/**
 * 계약: **한글만 담은 요소에 `uppercase` 를 걸지 않는다.**
 *
 * `text-transform: uppercase` 는 한글에 아무 일도 하지 않는다. 남겨 두면 죽은 선언일 뿐
 * 아니라, 라틴 키커 관용구(`uppercase tracking-wider`)를 따라 넓은 자간이 함께 붙어
 * 한글 낱말 응집을 깨는 경로가 된다(2026-11 정리에서 그 짝을 걷어냈다).
 * 라틴 글자가 섞인 라벨(예: 영문 머리말, `ID` 가 든 라벨)은 대문자 변환이 실제로 일하므로 대상이 아니다.
 *
 * 범위: 화면 글자는 소스에 **리터럴로 적힌 것**(JsxText·{"…"})만 본다. `{col.label}` 처럼 값으로
 * 채워지는 라벨은 판정하지 않는다(오탐 0 을 택한 보수적 선택 — 그런 곳은 이 계약이 못 지킨다).
 *
 * 판정은 **AST** 로 한다 — 정규식은 JSX 가 여러 줄에 걸치면 라벨 글자를 못 보고,
 * 주석 속 `uppercase` 낱말을 위반으로 잡는다.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HANGUL = /[가-힣]/;
const LATIN = /[A-Za-z]/;
/** 변형 접두(`md:`·`hover:`)와 중요도 표시(`!`)가 붙은 형태도 같은 선언이다. */
const UPPERCASE_TOKEN = /(^|[\s:!])uppercase(\s|$)/;

/** className 속성 안의 모든 문자열 조각(리터럴·템플릿·cn() 인자)을 모은다. */
function classNameStrings(attr: ts.JsxAttribute): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(node, visit);
  };
  if (attr.initializer) visit(attr.initializer);
  return out;
}

/** 요소 아래의 화면 글자(JsxText 와 {"…"} 문자열 리터럴)를 모은다. */
function renderedText(node: ts.JsxElement): string {
  let text = "";
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) text += n.text;
    else if (ts.isJsxExpression(n) && n.expression && ts.isStringLiteral(n.expression)) {
      text += n.expression.text;
    }
    ts.forEachChild(n, visit);
  };
  node.children.forEach(visit);
  return text;
}

/** 한글만 담은 요소에 uppercase 가 걸린 곳을 `파일:줄` 로 돌려준다. */
export function findHangulUppercase(fileName: string, code: string): string[] {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const attr = node.openingElement.attributes.properties.find(
        (p): p is ts.JsxAttribute =>
          ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === "className",
      );
      if (attr && classNameStrings(attr).some((s) => UPPERCASE_TOKEN.test(s))) {
        const text = renderedText(node);
        if (HANGUL.test(text) && !LATIN.test(text)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          hits.push(`${fileName}:${line + 1}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function tsxFilesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".tsx") && !f.includes("__tests__"))
    .map((f) => join(dir, f));
}

describe("한글 라벨 — uppercase 금지", () => {
  it("src 의 모든 .tsx 에 한글 전용 uppercase 요소가 없다", () => {
    const root = resolve(process.cwd(), "src");
    const hits = tsxFilesUnder(root).flatMap((file) =>
      findHangulUppercase(file.slice(root.length + 1), readFileSync(file, "utf8")),
    );
    expect(hits).toEqual([]);
  });

  // 대조군 — 판정 함수가 고장 나 항상 빈 배열을 돌려줘도 위 테스트는 초록이 된다.
  it("여러 줄 JSX·cn() 인자·표 머리줄의 한글 라벨을 잡는다", () => {
    const code = [
      'const a = <div className="text-xs uppercase">누적 매출</div>;',
      'const b = <span className={cn("text-[10px]", "uppercase")}>',
      "  연동 계정",
      "</span>;",
      'const c = <thead className="text-xs uppercase"><tr><th>상품명</th><th>단가</th></tr></thead>;',
      'const d = <p className="md:uppercase">오늘 매출</p>;',
    ].join("\n");
    expect(findHangulUppercase("probe.tsx", code)).toEqual(["probe.tsx:1", "probe.tsx:2", "probe.tsx:5", "probe.tsx:6"]);
  });

  it("라틴 글자가 섞인 라벨·주석 속 낱말·uppercase 없는 요소는 잡지 않는다", () => {
    const code = [
      'const a = <p className="uppercase tracking-widest">WAG Campaign Report</p>;',
      'const b = <span className="uppercase">루트 폴더 ID</span>;',
      "// uppercase 를 되살리지 말 것 — 한글",
      'const c = <div className="text-xs normal-case">누적 매출</div>;',
    ].join("\n");
    expect(findHangulUppercase("probe.tsx", code)).toEqual([]);
  });
});
