import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { OUTREACH_STATUSES, isValidOutreachTransition, updateOutreachSchema } from "@/lib/validations/outreach";

/**
 * 아웃리치 화면이 서버로 보내는 상태값은 서버가 받는 목록(`OUTREACH_STATUSES`) 안에 있어야 한다.
 *
 * 「캠페인 생성 (승인)」 버튼이 목록에 없는 옛 값을 보내고 있었다 — 서버 검증이 400 으로 거절해
 * 버튼이 아무 일도 하지 않았고, 알림에는 오류 객체가 그대로 넘어갔다. 요청 본문은 `JSON.stringify`
 * 안의 문자열이라 타입 검사가 못 잡는다. 그래서 소스에서 직접 본다(AST — 주석·다른 `status` 는 지나친다).
 */
const PAGE = join(__dirname, "..", "page.tsx");

export function findStatusLiteralsInJsonBodies(source: string): string[] {
  const sf = ts.createSourceFile("probe.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sf) === "JSON.stringify" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const prop of node.arguments[0].properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          prop.name.getText(sf) === "status" &&
          (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))
        ) {
          found.push(prop.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("아웃리치 화면이 보내는 상태값", () => {
  it("스캐너가 요청 본문의 status 만 집는다(프로브)", () => {
    const probe = `
      // body: JSON.stringify({ status: "IN_COMMENT" })
      const other = { status: "NOT_A_BODY" };
      fetch(url, { body: JSON.stringify({ status: "DROPPED", dropReason }) });
      fetch(url, { body: JSON.stringify({ status: newStatus }) });
    `;
    expect(findStatusLiteralsInJsonBodies(probe)).toEqual(["DROPPED"]);
  });

  it("전부 서버가 받는 목록 안에 있다", () => {
    const sent = findStatusLiteralsInJsonBodies(readFileSync(PAGE, "utf8"));
    // 리마인드·드롭·캠페인 생성 세 곳이 글자로 적어 보낸다 — 0건이면 스캐너가 죽은 것이다.
    expect(sent.length).toBeGreaterThanOrEqual(3);
    const allowed: readonly string[] = OUTREACH_STATUSES;
    expect(sent.filter((status) => !allowed.includes(status))).toEqual([]);
  });

  it("「캠페인 생성 (승인)」 요청이 서버 검증과 전이 규칙을 통과한다", () => {
    // 버튼은 승인 대기 상태의 테스크에만 뜬다 → 같은 상태로의 요청이다.
    expect(updateOutreachSchema.safeParse({ status: "PENDING_APPROVAL", autoCreateCampaign: true }).success).toBe(true);
    expect(isValidOutreachTransition("PENDING_APPROVAL", "PENDING_APPROVAL")).toBe(true);
    // 종전에 보내던 값은 검증에서 떨어진다(되돌아가면 위 스캔이 잡는다).
    expect(updateOutreachSchema.safeParse({ status: "CONFIRMED", autoCreateCampaign: true }).success).toBe(false);
  });
});
