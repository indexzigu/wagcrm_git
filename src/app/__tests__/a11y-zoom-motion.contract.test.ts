import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * 확대·모션 접근성 계약 (2026-09-24 interfaces 점검 묶음 A).
 *
 * 1. 루트 viewport 가 확대를 막으면 셀러 포털·모바일 전부에서 핀치 확대가 사라진다(WCAG 1.4.4).
 *    iOS 입력 자동 확대는 입력 글자 16px 로 막는다 — viewport 로 막지 않는다.
 * 2. tw-animate-css 의 animate-in/out 과 Tailwind 기본 무한 루프는 자체 reduce 가드가 없다.
 *    globals.css 의 reduced-motion 블록이 **레이어 밖**에서 그것을 눌러야 한다 — 레이어 안에
 *    들어가면 @layer utilities 의 zoom-in-95·slide-in-* 에 진다.
 */

const ROOT = process.cwd();

/** viewport 객체 리터럴의 속성 이름 — 주석의 설명 문구에 속지 않도록 AST 로 읽는다. */
function viewportKeys(source: string): string[] {
  const file = ts.createSourceFile("layout.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const keys: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "viewport" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (prop.name) keys.push(prop.name.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return keys;
}

function reducedMotionBlock(css: string): { text: string; depthAtStart: number } {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (const ch of css.slice(0, start)) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  const open = css.indexOf("{", start);
  let d = 0;
  let end = open;
  for (; end < css.length; end += 1) {
    if (css[end] === "{") d += 1;
    else if (css[end] === "}" && --d === 0) break;
  }
  return { text: css.slice(open, end + 1), depthAtStart: depth };
}

describe("확대·모션 접근성 계약", () => {
  it("루트 viewport 가 확대를 막지 않는다", () => {
    const keys = viewportKeys(readFileSync(join(ROOT, "src/app/layout.tsx"), "utf8"));
    expect(keys).toContain("width"); // 스캐너가 실제로 viewport 를 찾았다는 양성 확인
    expect(keys).not.toContain("maximumScale");
    expect(keys).not.toContain("userScalable");
  });

  it("스캐너는 확대 차단 속성을 잡는다(반례 프로브)", () => {
    const probe = `export const viewport = { width: "device-width", maximumScale: 1, userScalable: false };`;
    expect(viewportKeys(probe)).toEqual(["width", "maximumScale", "userScalable"]);
  });

  it("reduced-motion 블록이 레이어 밖에서 tw-animate 확대·슬라이드와 무한 루프를 누른다", () => {
    const { text, depthAtStart } = reducedMotionBlock(
      readFileSync(join(ROOT, "src/app/globals.css"), "utf8"),
    );
    expect(depthAtStart).toBe(0);
    expect(text).toContain('[class*="animate-in"]');
    expect(text).toContain('[class*="animate-out"]');
    for (const v of ["--tw-enter-scale: 1", "--tw-enter-translate-y: 0", "--tw-exit-scale: 1", "--tw-exit-translate-x: 0"]) {
      expect(text).toContain(v);
    }
    expect(text).toMatch(/\[class\*="animate-ping"\][^{]*\{\s*animation:\s*none/);
  });
});
