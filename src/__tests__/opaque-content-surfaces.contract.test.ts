import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * **정산 관리·판매 관리 화면의 콘텐츠 면은 불투명 헤어라인 질감이다** (애플 UI 리뉴얼 묶음 2).
 *
 * 반투명 유리(`backdrop-blur`·`bg-white/NN`·`bg-[rgba(…)]`)는 크롬(CrmShell 머리·사이드바·
 * Sheet)에만 남긴다 — 밝은 반투명을 겹치면 면 경계가 흐려진다. 콘텐츠 카드·표·요약띠는
 * `bg-card` + `border-border`, 내용 바닥은 `bg-background`. hex 리터럴(`bg-[#…]`)과 임의
 * 모서리(`rounded-[…]`)도 토큰 밖 값이라 같이 막는다.
 *
 * 판정은 TypeScript AST 의 문자열 노드만 본다 — 주석은 노드가 아니므로 이 금지 문자열을
 * 인용한 설명 주석이 스스로 위반으로 잡히지 않는다(정규식 스트리퍼는 레포에서 양방향으로
 * 틀린 전례가 있다: `ui-copy-em-dash.contract.test.ts` 머리말).
 *
 * 대상 밖(의도): `crm-shell.tsx` · `crm-sidebar.tsx` · `ui/sheet.tsx` — 크롬은 반투명 유지.
 */

const ROOT = join(__dirname, "..");

const SURFACE_TOKENS = ["backdrop-blur", "bg-white/", "bg-[rgba(", "bg-[#", "rounded-["] as const;

/** 파일 → 그 파일에서 금지하는 문자열. */
const TARGETS: Record<string, readonly string[]> = {
  "app/settlement/settlement-page-client.tsx": SURFACE_TOKENS,
  "components/crm/settlement-table.tsx": SURFACE_TOKENS,
  "components/crm/settlement-completed-table.tsx": SURFACE_TOKENS,
  "components/crm/crm-dashboard.tsx": SURFACE_TOKENS,
  "components/crm/execution-kanban-board.tsx": SURFACE_TOKENS,
  "components/crm/campaign-card.tsx": SURFACE_TOKENS,
  "components/crm/grouped-table-view.tsx": SURFACE_TOKENS,
  "components/crm/settlement-section.tsx": SURFACE_TOKENS,
  "components/crm/money-summary-strip.tsx": SURFACE_TOKENS,
  // 캠페인 상세 시트는 **시트 바탕 그라디언트만** 막는다. 이 파일의 다른 섹션 카드
  // (`rounded-[24px]`·`bg-white/90` 등)는 이 묶음의 교체 규칙 밖이라 아직 대상이 아니다 —
  // 그 섹션들을 정리하는 묶음에서 SURFACE_TOKENS 로 넓힐 것.
  "components/crm/campaign-side-panel.tsx": ["bg-[linear-gradient"],
};

type Hit = { token: string; line: number; text: string };

/** 소스의 문자열·템플릿·JSX 텍스트 노드에서 금지 문자열을 찾는다(주석 제외). */
function findForbidden(source: string, fileName: string, tokens: readonly string[]): Hit[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const text = node.text;
      for (const token of tokens) {
        if (text.includes(token)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          hits.push({ token, line: line + 1, text: text.slice(0, 120) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("opaque content surfaces — 스캐너 자체", () => {
  it("양성 프로브: className 문자열·템플릿 안의 금지 문자열을 잡는다", () => {
    const probe = [
      'const a = <div className="rounded-2xl bg-white/50 border" />;',
      "const b = cn(`p-4 ${x ? \"backdrop-blur\" : \"\"}`, \"bg-[#f8fafc]\");",
      "const c = `rounded-[24px] ${y}`;",
    ].join("\n");
    const tokens = findForbidden(probe, "probe.tsx", SURFACE_TOKENS).map((h) => h.token).sort();
    expect(tokens).toEqual(["backdrop-blur", "bg-[#", "bg-white/", "rounded-["].sort());
  });

  it("음성 프로브: 주석에만 등장하는 금지 문자열은 잡지 않는다", () => {
    const probe = [
      "// 종전 bg-white/50 backdrop-blur 를 bg-card 로 바꿨다",
      "/* rounded-[24px] → rounded-2xl, bg-[#f8fafc] → bg-background */",
      'const a = <div className="rounded-2xl bg-card" />; // bg-[rgba(255,255,255,0.6)]',
      "const b = <div>{/* bg-white/70 */}</div>;",
    ].join("\n");
    expect(findForbidden(probe, "probe.tsx", SURFACE_TOKENS)).toEqual([]);
  });
});

describe("opaque content surfaces — 대상 파일", () => {
  it.each(Object.entries(TARGETS))("%s 에 반투명·hex·임의 모서리 클래스가 없다", (rel, tokens) => {
    const source = readFileSync(join(ROOT, rel), "utf8");
    const hits = findForbidden(source, rel, tokens);
    expect(hits, hits.map((h) => `${rel}:${h.line} [${h.token}] ${h.text}`).join("\n")).toEqual([]);
  });
});
