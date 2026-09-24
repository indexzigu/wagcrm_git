import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// interfaces 점검 묶음 G1(2026-09-24)의 재발 방지 계약. 소스 문자열이 아니라 컴파일러 AST 로
// 판정한다(주석·문자열 속 낱말에 속지 않게).
//
// 1) 주문 관리 모달은 createPortal 로 직접 그리지 않는다 — 직접 그리면 대화상자 역할·Esc·포커스
//    가두기·복귀가 다시 사라진다. `ShippingDialogFrame`(ui/dialog) 을 쓴다.
// 2) 칸반은 `pointerWithin` 과 `KeyboardSensor` 를 같이 쓰지 않는다 — 포인터 좌표가 없는 키보드
//    드래그는 놓을 칸을 못 찾아, 조작법 안내만 있고 실제로는 아무 데도 못 놓는 가짜 경로가 된다.
// 3) 칸반 DndContext 는 한국어 `accessibility` 를 넘긴다 — 빼면 dnd-kit 영어 기본 안내(스페이스로
//    집어 옮기라는, 이 앱에서는 거짓인 조작법)가 다시 읽힌다.

const ROOT = path.resolve(__dirname, "../../../..");
const MODAL_DIR = path.join(ROOT, "src/components/crm/shipping/modals");
const KANBAN_FILES = ["src/components/crm/execution-kanban-board.tsx", "src/app/outreach/page.tsx"];

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function namedImports(sf: ts.SourceFile, moduleName: string): string[] {
  const names: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier) || stmt.moduleSpecifier.text !== moduleName) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map((el) => el.name.text));
  }
  return names;
}

function dndContextAttributeNames(sf: ts.SourceFile): string[][] {
  const found: string[][] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(sf) === "DndContext") {
      found.push(
        node.attributes.properties.filter(ts.isJsxAttribute).map((attr) => attr.name.getText(sf)),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("G1 계약 — 주문 관리 모달은 ui/dialog 위에 선다", () => {
  const modalFiles = readdirSync(MODAL_DIR).filter((f) => f.endsWith("Modal.tsx"));

  it("모달 파일을 실제로 찾았다(빈 목록이면 이 계약이 아무것도 안 본다)", () => {
    expect(modalFiles.length).toBeGreaterThanOrEqual(7);
  });

  it.each(modalFiles)("%s 는 react-dom createPortal 을 import 하지 않는다", (file) => {
    expect(namedImports(parse(path.join(MODAL_DIR, file)), "react-dom")).not.toContain("createPortal");
  });

  it("판정기 자체가 createPortal import 를 잡는다(반증 프로브)", () => {
    const probe = ts.createSourceFile(
      "probe.tsx",
      "// createPortal 는 주석이라 무시\nimport { createPortal } from 'react-dom';",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    expect(namedImports(probe, "react-dom")).toEqual(["createPortal"]);
  });
});

describe("G1 계약 — 칸반 키보드 경로", () => {
  it.each(KANBAN_FILES)("%s: pointerWithin 과 KeyboardSensor 를 함께 쓰지 않는다", (rel) => {
    const names = namedImports(parse(path.join(ROOT, rel)), "@dnd-kit/core");
    expect(names).toContain("pointerWithin");
    expect(names).not.toContain("KeyboardSensor");
  });

  it.each(KANBAN_FILES)("%s: DndContext 에 한국어 accessibility 를 넘긴다", (rel) => {
    const contexts = dndContextAttributeNames(parse(path.join(ROOT, rel)));
    expect(contexts.length).toBeGreaterThan(0);
    for (const attrs of contexts) expect(attrs).toContain("accessibility");
  });
});
