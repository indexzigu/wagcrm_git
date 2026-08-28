/**
 * 정산 완료 플래그 쓰기의 CG-1 계약.
 *
 * 이 레포의 반복 결함은 **「정본 함수는 있는데 호출부가 한 조각을 손으로 다시 만든다」**다
 * (`settlement-statement.ts` 가 세 번, `deal-claim-context` 가 한 번 겪었다). 정산 플래그가
 * 정확히 그 얼굴로 갈렸다 — 오너의 버튼 경로는 그룹 스칼라에 썼는데 어시스턴트 경로는
 * 멤버 행에만 써서, 그룹 소속 캠페인을 확정하면 화면·지연 판정·정산 목록이 그대로였다.
 *
 * 그래서 이 계약은 **플래그만 쓰는 두 경로**가 SSOT(`writeSettlementFlags`)를 통과하는지를
 * 소스에서 확인한다. 단위 테스트로는 **미래의 되돌림**을 못 막는다 — 누군가 `tx.salesCampaign
 * .updateMany` 를 한 줄 되살려도, 그 경로의 기존 단언이 그룹 픽스처를 안 쓰면 초록이다.
 *
 * ⚠️ **이 계약의 범위는 두 경로뿐이다.** 캠페인 PATCH(`campaignService.updateCampaign`)도 같은
 * 플래그를 쓰지만 계산서일·예정일·반품기간과 **한 statement 로 묶어** 쓰므로(그리고 그 묶음은
 * `resolveSettlementSync` 가 만든 **변수**라 소스 스캔에 보이지도 않는다) 여기 넣지 않는다.
 * 그 경로는 이미 CG-1 을 지킨다 — 쪼개서 SSOT 를 태우면 그룹 쓰기가 두 번으로 갈라져
 * 원자성만 잃는다. 🪤 「전 writer 를 스캔한다」로 넓히려는 다음 세션에게: 실제로 시도했고
 * **플래그 이름이 리터럴로 보이는 쓰기가 레포에 0건**이었다(전부 변수·스프레드로 조립된다).
 * 그물을 「data 가 불투명한 쓰기」까지 넓히면 무관한 14곳이 걸려 등록부가 소음이 된다.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** 플래그만 쓰는 경로 = 이 계약의 대상. */
const DELEGATING_PATHS = [
  "src/app/api/campaigns/[id]/settlement-status/route.ts",
  "src/lib/agent/write-executor.ts",
] as const;

const SSOT_MODULE = "@/lib/settlement-flag-write";
const WRITE_METHODS = new Set(["update", "updateMany", "upsert", "create", "createMany"]);
const GUARDED_MODELS = new Set(["salesCampaign", "campaignGroup"]);

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * `<무엇>.salesCampaign.update…(` / `<무엇>.campaignGroup.update…(` 호출 위치.
 *
 * AST 로 세는 이유는 주석 때문이다 — 이 파일들의 주석에는 금지 대상 문자열이 **설명으로**
 * 인용돼 있어 정규식으로 세면 자기 자신을 위반으로 잡는다(`encryption-audit` ·
 * `settlement-statement-surface-parity` 가 실제로 밟은 함정).
 */
function findGuardedWrites(fileName: string, source: string): string[] {
  const sf = parse(fileName, source);
  const found: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const owner = node.expression.expression;
      const model = ts.isPropertyAccessExpression(owner)
        ? owner.name.text
        : ts.isIdentifier(owner)
          ? owner.text
          : "";
      if (WRITE_METHODS.has(method) && GUARDED_MODELS.has(model)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        found.push(`${fileName}:${line} ${model}.${method}()`);
      }
    }
    node.forEachChild(walk);
  };
  walk(sf);
  return found;
}

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("settlement-flag-write 계약 — 플래그 쓰기는 CG-1 SSOT 를 통과한다", () => {
  it.each(DELEGATING_PATHS)("%s 는 writeSettlementFlags 를 통과한다", (relativePath) => {
    const source = read(relativePath);
    expect(source).toContain(SSOT_MODULE);
    expect(source).toMatch(/\bwriteSettlementFlags\b/);
  });

  it.each(DELEGATING_PATHS)(
    "%s 는 salesCampaign·campaignGroup 쓰기를 직접 하지 않는다",
    (relativePath) => {
      expect(findGuardedWrites(relativePath, read(relativePath))).toEqual([]);
    },
  );

  it.each(DELEGATING_PATHS)(
    "%s 는 정본 플래그를 resolveSettlementFlagSnapshot 으로 읽는다",
    (relativePath) => {
      const source = read(relativePath);
      expect(source).toMatch(/\bresolveSettlementFlagSnapshot\b/);
      // ⛔ 손으로 정본 행을 고르는 관용구가 되살아나면 세 플래그 중 하나만 빠뜨리기 쉽다.
      expect(source).not.toMatch(/group\?\.\s*is(?:Deposit|Payout|SupplierPayout)\w*\s*\?\?/);
    },
  );

  /**
   * 양성 대조군 — 위 그물이 실제로 무언가를 잡는지 확인한다. AST 순회가 깨지면 위 단언들은
   * 「전부 통과」로 조용히 초록이 되므로, 손으로 쓴 쓰기가 **반드시** 걸리는지 함께 본다.
   */
  it("탐지기는 손으로 쓴 플래그 쓰기를 잡는다(양성 대조군)", () => {
    const handRolled = `
      export async function bad(tx: any, id: string) {
        // 주석 안의 tx.salesCampaign.updateMany( 는 세지 않는다 — AST 라 주석은 보이지 않는다.
        await tx.campaignGroup.updateMany({ where: { id }, data: { isDepositReceived: true } });
        await tx.salesCampaign.update({ where: { id }, data: { isPayoutCompleted: true } });
      }
    `;
    const hits = findGuardedWrites("probe.ts", handRolled);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toContain("campaignGroup.updateMany()");
    expect(hits[1]).toContain("salesCampaign.update()");
  });

  it("탐지기는 조회 호출을 잡지 않는다(음성 대조군)", () => {
    const readsOnly = `
      export async function fine(tx: any, id: string) {
        await tx.salesCampaign.findUnique({ where: { id } });
        await tx.campaignGroup.findMany({ where: { id } });
      }
    `;
    expect(findGuardedWrites("probe.ts", readsOnly)).toEqual([]);
  });
});
