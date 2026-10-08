/**
 * 월정산 공급사 계산서 **확인 없는 자동 기록**(T-242)의 안전 계약 — 소스를 TypeScript AST 로 읽는다
 * (주석은 노드가 아니라 설명문의 금지 문자열이 자기 자신을 잡지 않는다). 스캐너가 고장 나면 「0건」이
 * 초록이 되므로 각 단언 앞에 같은 스캐너로 양성 대조를 둔다.
 *
 * ① 쓰기는 env 게이트 뒤 — 크론의 `runMonthlyAutoRecord` 는 예행이면 쓰기 호출 **전에** 돌아간다.
 * ② 자동 기록은 지우거나 고치지 않는다 — 새 행 생성만(메일 커버리지가 100% 가 아니다).
 * ③ 수취(RECEIVE)는 자동 기록하지 않는다(오너 확정 2026-08-12 — 언제나 1클릭).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..", "..", "..");
const CRON = join(ROOT, "src/app/api/cron/tax-invoice-issue-confirm/route.ts");
const SERVICE = join(ROOT, "src/services/campaignInvoiceService.ts");

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}

function find<T extends ts.Node>(root: ts.Node, pick: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (pick(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

const isCall = (node: ts.Node): node is ts.CallExpression => ts.isCallExpression(node);

function calleeText(call: ts.CallExpression, source: ts.SourceFile): string {
  return call.expression.getText(source);
}

/** 이름으로 함수 선언 또는 객체 메서드를 찾는다. */
function findFunctionBody(source: ts.SourceFile, name: string): ts.Block | undefined {
  for (const node of find(source, (n): n is ts.Node => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n))) {
    const fn = node as ts.FunctionDeclaration | ts.MethodDeclaration;
    if (fn.name?.getText(source) === name && fn.body) return fn.body;
  }
  return undefined;
}

describe("① 크론 — 월정산 자동 기록 쓰기는 예행 반환 뒤에만 있다", () => {
  const source = parse(CRON);
  const body = findFunctionBody(source, "runMonthlyAutoRecord");

  it("양성 대조 — 함수와 쓰기 호출을 실제로 찾는다", () => {
    expect(body).toBeDefined();
    const writes = find(body!, isCall).filter((c) => calleeText(c, source).endsWith("autoRecordMailInvoice"));
    expect(writes.length).toBe(1);
  });

  it("쓰기 호출보다 앞에 `if (input.dryRun) return …` 가 있다", () => {
    const writeAt = find(body!, isCall).find((c) => calleeText(c, source).endsWith("autoRecordMailInvoice"))!.getStart(source);
    const guards = find(body!, (n): n is ts.IfStatement => ts.isIfStatement(n)).filter(
      (n) =>
        n.expression.getText(source) === "input.dryRun" &&
        (ts.isReturnStatement(n.thenStatement) ||
          (ts.isBlock(n.thenStatement) && n.thenStatement.statements.some(ts.isReturnStatement))),
    );
    expect(guards.length).toBeGreaterThan(0);
    expect(Math.min(...guards.map((g) => g.getStart(source)))).toBeLessThan(writeAt);
  });

  it("핸들러는 env 게이트로 정해진 `dryRun` 을 그대로 넘긴다", () => {
    const calls = find(source, isCall).filter((c) => calleeText(c, source) === "runMonthlyAutoRecord");
    expect(calls).toHaveLength(1);
    const arg = calls[0].arguments[0];
    expect(arg && ts.isObjectLiteralExpression(arg)).toBe(true);
    const dryRunProp = (arg as ts.ObjectLiteralExpression).properties.find((p) => p.name?.getText(source) === "dryRun");
    expect(dryRunProp && ts.isShorthandPropertyAssignment(dryRunProp)).toBe(true);
    expect(source.getFullText()).toMatch(/const dryRun = dryRunRequested \|\| !writeEnabled/);
  });
});

describe("②③ 서비스 — autoRecordMailInvoice 는 만들기만 하고 발행 방향만 받는다", () => {
  const source = parse(SERVICE);
  const body = findFunctionBody(source, "autoRecordMailInvoice");
  const calls = body ? find(body, isCall).map((c) => calleeText(c, source)) : [];

  it("양성 대조 — 메서드를 찾고 그 안의 생성 호출을 본다", () => {
    expect(body).toBeDefined();
    expect(calls).toContain("tx.campaignInvoice.create");
  });

  it("계산서 행·캠페인 날짜를 지우거나 고치는 호출이 없다", () => {
    const forbidden = calls.filter((text) =>
      /(campaignInvoice|salesCampaign|campaignGroup)\.(delete|deleteMany|update|updateMany|upsert)$/.test(text),
    );
    expect(forbidden).toEqual([]);
    // 레거시 날짜는 공용 롤업(비어 있을 때만 채움)으로만 건드린다.
    expect(calls).toContain("rollupLegacyDate");
  });

  it("발행이 아니면 아무것도 하지 않는다", () => {
    const guards = find(body!, (n): n is ts.IfStatement => ts.isIfStatement(n)).map((n) => n.expression.getText(source));
    expect(guards).toContain('unit.direction !== "ISSUE"');
  });
});
