/**
 * 정산 메일 대조(`get_settlement_reconciliation` v1) 경계 계약 — 컴파일러(AST) 소스 스캔.
 *  R1 첨부 해석은 `statement-pivot-xls.ts` 한 곳뿐 — 대조·창구·실행기·형제 스캔은 xlsx 를 들이지 않는다.
 *  R2 그 모듈의 `XLSX.read` 는 둘 중 하나만: 시트 이름만 읽기(`bookSheets: true`) · `buildPivotOnlyBiffStream` 으로
 *     자른 스트림. 통째 읽기가 생기면 발주서 시트(구매자 정보)가 해석기에 닿는다. 시트 지정(`sheets`)은 허용하지 않는다 —
 *     .xls·ods 해석기는 그 옵션을 무시한다(v1 은 ZIP 표를 읽지 않는다).
 *  R3 리더·대조·창구 본체·형제 스캔은 console.* 를 부르지 않는다(데이터가 로그로 새지 않게).
 * 각 술어는 반례 프로브로 「잡아야 할 것을 잡는지」를 함께 본다.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const PIVOT_READER = "src/lib/tax-invoice-mail/statement-pivot-xls.ts";
const NO_XLSX = [
  "src/lib/tax-invoice-mail/settlement-reconcile.ts",
  "src/lib/tax-invoice-mail/brand-statement-scan.ts",
  "src/lib/agent-internal/settlement-reconciliation.ts",
  "src/lib/agent-worker/executor.ts",
  "src/app/api/internal/agent/settlement-reconciliation/route.ts",
];
const NO_CONSOLE = [
  PIVOT_READER,
  "src/lib/tax-invoice-mail/settlement-reconcile.ts",
  "src/lib/tax-invoice-mail/brand-statement-scan.ts",
  "src/lib/agent-internal/settlement-reconciliation.ts",
];

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("probe.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function read(rel: string): ts.SourceFile {
  return parse(readFileSync(join(root, rel), "utf8"));
}

function visit(node: ts.Node, fn: (node: ts.Node) => void) {
  fn(node);
  node.forEachChild((child) => visit(child, fn));
}

function importsXlsx(sf: ts.SourceFile): boolean {
  let found = false;
  visit(sf, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "xlsx") found = true;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteral(arg) && arg.text === "xlsx") found = true;
    }
  });
  return found;
}

function consoleCalls(sf: ts.SourceFile): number {
  let count = 0;
  visit(sf, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console"
    ) {
      count += 1;
    }
  });
  return count;
}

/** `XLSX.read(...)` 호출 중 허용 셋 밖인 것의 수. 자른 스트림 = `buildPivotOnlyBiffStream(...)` 으로 초기화된 이름. */
function unsafeReads(sf: ts.SourceFile): { total: number; unsafe: number } {
  const cutNames = new Set<string>();
  visit(sf, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "buildPivotOnlyBiffStream"
    ) {
      cutNames.add(node.name.text);
    }
  });
  let total = 0;
  let unsafe = 0;
  visit(sf, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const callee = node.expression;
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "XLSX" || callee.name.text !== "read") return;
    total += 1;
    const [input, options] = node.arguments;
    const bookSheetsOnly =
      options &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.some(
        (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "bookSheets" && p.initializer.kind === ts.SyntaxKind.TrueKeyword,
      );
    const cut = input !== undefined && ts.isIdentifier(input) && cutNames.has(input.text);
    if (!(bookSheetsOnly || cut)) unsafe += 1;
  });
  return { total, unsafe };
}

describe("정산 메일 대조 경계", () => {
  it("R1 xlsx 는 피벗 리더에만 들어온다", () => {
    expect(importsXlsx(read(PIVOT_READER))).toBe(true); // 양성 대조
    for (const rel of NO_XLSX) expect({ rel, imports: importsXlsx(read(rel)) }).toEqual({ rel, imports: false });
    expect(importsXlsx(parse('const X = await import("xlsx");'))).toBe(true);
  });

  it("R2 피벗 리더의 XLSX.read 는 시트 이름만 · 자른 스트림 둘뿐(시트 지정 불가)", () => {
    const real = unsafeReads(read(PIVOT_READER));
    expect(real.total).toBeGreaterThanOrEqual(2);
    expect(real.unsafe).toBe(0);
    // 반례: 통째 읽기 · 자르지 않은 이름 · bookSheets:false 는 잡혀야 한다.
    const probe = parse(`
      const cut = buildPivotOnlyBiffStream(stream, names);
      const raw = content;
      XLSX.read(cut, { type: "buffer" });
      XLSX.read(content, { type: "buffer" });
      XLSX.read(raw, { type: "buffer" });
      XLSX.read(content, { type: "buffer", bookSheets: false });
      XLSX.read(content, { type: "buffer", sheets: ["피벗"] });
      XLSX.read(content, { type: "buffer", bookSheets: true });
    `);
    expect(unsafeReads(probe)).toEqual({ total: 6, unsafe: 4 });
  });

  it("R3 리더·대조·창구 본체·형제 스캔에 console 호출이 없다", () => {
    for (const rel of NO_CONSOLE) expect({ rel, calls: consoleCalls(read(rel)) }).toEqual({ rel, calls: 0 });
    expect(consoleCalls(read("src/app/api/internal/agent/settlement-reconciliation/route.ts"))).toBe(1); // 양성 대조(고정 문구 경고 1개)
    expect(consoleCalls(parse("// console.log(x)\nconst s = 'console.log(y)';"))).toBe(0);
  });
});
