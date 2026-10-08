/**
 * 그룹 상태 통합 연동 계약 — `SalesCampaign.status` 를 바꾸는 코드는 `propagateGroupStatus` 를
 * 통과한다(오너 확정 2026-10-05: 조합 캠페인의 상태 변경은 그룹 전체에 적용된다).
 *
 * 이 레포의 반복 결함은 「SSOT 함수는 있는데 새 경로가 그것을 안 탄다」다
 * (`settlement-flag-write` · `fanOutMemberSchedule` 이 같은 부류). 상태를 쓰는 경로가 새로
 * 생기면 단위 테스트는 그 경로를 모르므로 초록이다 — 그래서 `src/` 전수를 소스로 본다.
 *
 * 판정(AST — 주석이 금지 문자열을 설명으로 인용하므로 정규식으로 세면 자기 자신을 잡는다):
 * ① `<무엇>.salesCampaign.{update,updateMany,upsert,updateManyAndReturn}(…)` 호출 중
 * ② `data` 인자 **안 어디에든** `status` 키가 있는 객체 리터럴이 있으면 「상태 쓰기」다.
 * ③ 상태 쓰기는 자신을 감싼 함수 사슬 어딘가에서 `propagateGroupStatus(…)` 를 **호출**해야
 *    한다(이름 등장이 아니라 호출 노드 — import 줄만으로 초록이 되지 않게).
 * ④ `data` 가 리터럴이 아니라 변수(불투명)이면 그 쓰기도 ③을 만족하거나 아래 허용 목록에
 *    **사유와 함께** 있어야 한다 — 변수 안에 status 가 실려도 리터럴 스캔은 못 보기 때문이다.
 *    허용 목록은 SSOT 자신(형제 status 쓰기) 한 건을 빼면 전부 불투명 쓰기다.
 *
 * ⚠️ 이 그물의 범위: 생성(`create`·`createMany`)은 「변경」이 아니라 대상 밖이다. 계산된 키
 * (`{ [field]: v }`)는 키 이름을 못 읽어 상태 쓰기로 세지 않는다(현재 그 형태는 계산서 날짜
 * 필드뿐). `$executeRaw` 로 쓰는 경로도 보지 않는다(현재 테스트 파일에만 있다). `scripts/` 는
 * 오너가 돌리는 도구라 `src/` 밖이다.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SSOT_CALL = "propagateGroupStatus";
const WRITE_METHODS = new Set(["update", "updateMany", "upsert", "updateManyAndReturn"]);

/**
 * 허용 목록 — `파일:감싼 함수명` → 사유. SSOT 자신을 빼면 전부 불투명(`data` 가 변수) 쓰기다.
 * ⛔ 새 항목은 그 변수에 status 가 **실릴 수 없음**을 근거로만 넣는다.
 */
const WRITE_ALLOWLIST: Record<string, string> = {
  "src/services/campaignGroupService.ts:fanOutMemberSchedule":
    "일정 3종(start/end/returnPeriodEnd)만 조립하는 updates 다 — 타입이 날짜 필드만 받는다",
  "src/services/campaignGroupService.ts:propagateGroupStatus":
    "SSOT 자신이다(형제 status 쓰기)",
  "src/repositories/campaignRepository.ts:update":
    "범용 저장소 update — 호출부가 generatedTrackingLink 만 넘긴다(campaignService.createCampaign)",
  "src/lib/campaign-checklist.ts:setChecklistItemChecked":
    "fieldData 는 계산서 발행일 2종 중 하나다(status 없음)",
  "src/lib/agent/write-actions/update-settlement-amount.ts:handleUpdateSettlementAmount":
    "금액 칸 1개(계약 enum 8칸) + 수동 고정 플래그(3종) + 파생 재무(DerivedCampaignFinancials 4칸) + " +
    "netMarginRate 만 조립한다 — 정산 확정 플래그도 status 도 쓰지 않는 경로다",
};

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__tests__" || name === "generated") continue;
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

type Finding = { at: string; kind: "status" | "opaque"; fn: string; delegates: boolean };

function hasStatusKey(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        const name =
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name
            ? ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)
              ? p.name.text
              : null
            : null;
        if (name === "status") {
          found = true;
          return;
        }
      }
    }
    n.forEachChild(walk);
  };
  walk(node);
  return found;
}

function isLiteralData(node: ts.Expression): boolean {
  let n: ts.Expression = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) {
    n = n.expression;
  }
  return ts.isObjectLiteralExpression(n);
}

function callsSsot(fnNode: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (name === SSOT_CALL) {
        found = true;
        return;
      }
    }
    n.forEachChild(walk);
  };
  walk(fnNode);
  return found;
}

function functionName(fn: ts.Node): string {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return fn.name.getText();
  }
  const parent = fn.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.name) {
    return parent.name.getText();
  }
  return "<anonymous>";
}

/** 감싼 함수 사슬(안쪽 → 바깥). 이름은 이름이 붙은 가장 안쪽 함수로 정한다. */
function enclosingFunctions(node: ts.Node): ts.Node[] {
  const chain: ts.Node[] = [];
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (ts.isFunctionLike(n)) chain.push(n);
    n = n.parent;
  }
  return chain;
}

function scanStatusWrites(fileName: string, source: string): Finding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const owner = node.expression.expression;
      const model = ts.isPropertyAccessExpression(owner) ? owner.name.text : "";
      const arg = node.arguments[0];
      if (WRITE_METHODS.has(method) && model === "salesCampaign" && arg && ts.isObjectLiteralExpression(arg)) {
        const dataProp = arg.properties.find(
          (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === "data",
        );
        const dataExpr = dataProp
          ? ts.isPropertyAssignment(dataProp)
            ? dataProp.initializer
            : dataProp.name
          : undefined;
        if (dataExpr) {
          const literal = isLiteralData(dataExpr);
          const kind: Finding["kind"] | null = literal
            ? hasStatusKey(dataExpr)
              ? "status"
              : null
            : "opaque";
          if (kind) {
            const chain = enclosingFunctions(node);
            const named = chain.find((fn) => functionName(fn) !== "<anonymous>");
            const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            findings.push({
              at: `${fileName}:${line}`,
              kind,
              fn: named ? functionName(named) : "<top-level>",
              delegates: chain.some(callsSsot),
            });
          }
        }
      }
    }
    node.forEachChild(walk);
  };
  walk(sf);
  return findings;
}

function scanRepo(): Finding[] {
  return listSourceFiles(join(ROOT, "src")).flatMap((file) =>
    scanStatusWrites(relative(ROOT, file), readFileSync(file, "utf8")),
  );
}

function violations(findings: Finding[]): string[] {
  return findings
    .filter((f) => !f.delegates)
    .filter((f) => !WRITE_ALLOWLIST[`${f.at.split(":")[0]}:${f.fn}`])
    .map((f) => `${f.at} (${f.kind}, in ${f.fn})`);
}

describe("SalesCampaign.status 쓰기는 그룹 상태 연동(propagateGroupStatus)을 통과한다", () => {
  const findings = scanRepo();

  it("src/ 의 모든 상태 쓰기·불투명 쓰기가 SSOT 를 부르거나 사유 있는 허용 목록에 있다", () => {
    expect(violations(findings)).toEqual([]);
  });

  it("알려진 상태 쓰기 경로가 실제로 스캔에 잡힌다(그물이 비어 있지 않다)", () => {
    const statusFiles = new Set(findings.filter((f) => f.kind === "status").map((f) => f.at.split(":")[0]));
    for (const file of [
      "src/services/campaignService.ts",
      "src/lib/campaign-status-sync.ts",
      "src/services/settlementService.ts",
    ]) {
      expect(statusFiles).toContain(file);
    }
    // 정산 플래그 SSOT 는 status 를 변수로 싣는다 — 불투명 쓰기로 잡히고 SSOT 를 부른다.
    const flagWrite = findings.find(
      (f) => f.at.startsWith("src/lib/settlement-flag-write.ts") && f.fn === "writeSettlementFlags",
    );
    expect(flagWrite).toMatchObject({ kind: "opaque", delegates: true });
  });

  it("허용 목록의 항목은 모두 실제로 존재한다(죽은 예외가 쌓이지 않는다)", () => {
    const present = new Set(findings.map((f) => `${f.at.split(":")[0]}:${f.fn}`));
    for (const key of Object.keys(WRITE_ALLOWLIST)) expect(present).toContain(key);
  });

  // 양성 대조군 — 같은 스캐너를 통과시켜 그물이 실제로 잡는지 본다. AST 순회가 깨지면 위
  // 단언들은 「위반 0」으로 조용히 초록이 되기 때문이다.
  it("손으로 쓴 상태 쓰기를 잡는다(양성 대조군 — 중첩 스프레드·주석 무시·불투명)", () => {
    const probe = `
      // 주석 안의 tx.salesCampaign.update({ data: { status } }) 는 세지 않는다.
      export async function bad(tx: any, id: string, s: string, payload: any) {
        await tx.salesCampaign.update({ where: { id }, data: { status: s } });
        await tx.salesCampaign.updateMany({ where: { id }, data: { ...(s ? { status: s } : {}) } });
        await getPrisma().salesCampaign.update({ where: { id }, data: payload });
        await tx.salesCampaign.update({ where: { id }, data: { campaignName: "x" } });
        await tx.salesCampaign.create({ data: { status: s } });
      }
    `;
    const found = scanStatusWrites("probe.ts", probe);
    expect(found.map((f) => f.kind)).toEqual(["status", "status", "opaque"]);
    expect(violations(found)).toHaveLength(3);
  });

  it("같은 함수 사슬에서 SSOT 를 호출하면 통과한다(음성 대조군 — import 만으로는 안 된다)", () => {
    const good = `
      import { propagateGroupStatus } from "@/services/campaignGroupService";
      export async function ok(prisma: any, id: string) {
        await prisma.$transaction(async (tx: any) => {
          await tx.salesCampaign.update({ where: { id }, data: { status: "CLOSED" } });
          await propagateGroupStatus(tx, {} as never);
        });
      }
      export async function importOnly(tx: any, id: string) {
        await tx.salesCampaign.update({ where: { id }, data: { status: "CLOSED" } });
      }
    `;
    const found = scanStatusWrites("probe.ts", good);
    expect(found.map((f) => [f.fn, f.delegates])).toEqual([
      ["ok", true],
      ["importOnly", false],
    ]);
  });
});
