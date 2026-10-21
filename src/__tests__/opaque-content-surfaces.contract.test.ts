import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * **데스크톱 콘텐츠 면은 불투명 헤어라인 질감이다** (애플 UI 리뉴얼 묶음 2·2-b·2-c — 정산·판매·영업·주문
 * 관리, 리포트, 기본정보 관리, 결재함·설정·캘린더, 공용 표 `InlineDataGrid`, 상세 옆 창 계열).
 *
 * 반투명 유리(`backdrop-blur`·`bg-white/NN`·`bg-[rgba(…)]`)는 크롬(사이드바·Sheet)에만
 * 남긴다(CrmShell 페이지 머리는 2026-10-21 없앴다) — 밝은 반투명을 겹치면 면 경계가 흐려진다. 콘텐츠 카드·표·요약띠는
 * `bg-card` + `border-border`, 내용 바닥은 `bg-background`. hex 리터럴(`bg-[#…]`)과 임의
 * 모서리(`rounded-[…]`)도 토큰 밖 값이라 같이 막는다.
 *
 * 판정은 TypeScript AST 의 문자열 노드만 본다 — 주석은 노드가 아니므로 이 금지 문자열을
 * 인용한 설명 주석이 스스로 위반으로 잡히지 않는다(정규식 스트리퍼는 레포에서 양방향으로
 * 틀린 전례가 있다: `ui-copy-em-dash.contract.test.ts` 머리말).
 *
 * 대상 밖(의도): `crm-shell.tsx` · `crm-sidebar.tsx` · `ui/sheet.tsx` — 크롬(사이드바·Sheet)은
 * 반투명 유지. 상세 옆 창(판매 조건·셀러·거래처·캠페인)은 Sheet 틀 안의 **내용**이라 대상이다 —
 * 같은 코드를 모바일 하단 시트도 쓴다(묶음 2-c B).
 *
 * 대상 파일 안에서도 의도된 반투명·임의값은 `EXCEPTIONS` 에 **사유와 정확한 적중 개수와 함께** 둔다
 * (사유가 비었거나, 적중 개수가 달라지면 실패 — 같은 모양의 새 위반이 예외에 묻어가지 않게, 낡은 예외도 남지 않게).
 */

const ROOT = join(__dirname, "..");

// `border-white/`·`bg-background/`·`bg-card/` 는 반쪽 반투명(`border-white/70 bg-background/70` 같은 것)까지 막는다.
const SURFACE_TOKENS = [
  "backdrop-blur",
  "bg-white/",
  "bg-[rgba(",
  "bg-[#",
  "rounded-[",
  "border-white/",
  "bg-background/",
  "bg-card/",
] as const;

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
  "components/crm/campaign-side-panel.tsx": [...SURFACE_TOKENS, "bg-[linear-gradient"],
  // 묶음 2-b — 영업 관리·주문 관리. `outreach-list.tsx`(모바일 공유)는 등재하지 않는다(모바일 묶음).
  // 공용 표 `inline-data-grid.tsx` 는 묶음 2-c A 에서 등재했다(아래).
  "app/outreach/page.tsx": [...SURFACE_TOKENS, "bg-[linear-gradient"],
  "components/crm/recampaign-alerts-card.tsx": SURFACE_TOKENS,
  "components/crm/order-dashboard.tsx": SURFACE_TOKENS,
  "components/crm/shipping/modals/CampaignCreateModal.tsx": ["bg-[linear-gradient", "bg-white/"],
  "components/crm/shipping/modals/ProductSelectModal.tsx": ["bg-[linear-gradient", "bg-white/"],
  // 묶음 2-c A — 공용 표(영업·판매 조건·거래처·셀러 목록 공유), 리포트, 기본정보 관리, 결재함·설정·캘린더.
  "components/crm/inline-data-grid.tsx": SURFACE_TOKENS,
  "components/crm/pnl-report-client.tsx": SURFACE_TOKENS,
  "components/crm/inflow-report-client.tsx": SURFACE_TOKENS,
  "components/crm/partners-management.tsx": SURFACE_TOKENS,
  "components/crm/sellers-management.tsx": SURFACE_TOKENS,
  "app/deals/deals-page-client.tsx": SURFACE_TOKENS,
  "components/crm/asset-library.tsx": SURFACE_TOKENS,
  "components/crm/price-sheet/price-sheet-detail.tsx": SURFACE_TOKENS,
  "components/crm/reference-inbox/reference-inbox-client.tsx": SURFACE_TOKENS,
  "components/crm/story-inbox-grid.tsx": SURFACE_TOKENS,
  "app/approvals/page.tsx": SURFACE_TOKENS,
  "components/crm/approvals/approval-detail.tsx": SURFACE_TOKENS,
  "app/settings/layout.tsx": SURFACE_TOKENS,
  "components/crm/operations-settings-client.tsx": SURFACE_TOKENS,
  "components/crm/integrations-diagnostic.tsx": SURFACE_TOKENS,
  "components/crm/AccountManagementTable.tsx": SURFACE_TOKENS,
  "components/crm/system-radar-card.tsx": SURFACE_TOKENS,
  "components/crm/data-integrity-card.tsx": SURFACE_TOKENS,
  "app/calendar/calendar-page-client.tsx": SURFACE_TOKENS,
  "components/crm/calendar-view.tsx": SURFACE_TOKENS,
  "components/crm/calendar-filter-bar.tsx": SURFACE_TOKENS,
  // 데스크톱 로딩 뼈대 — 본 화면과 질감이 다르면 화면 전환 때 유리 → 불투명으로 깜박인다.
  // `pipeline/loading.tsx` 는 모바일 탭 화면 뼈대라 모바일 묶음에서.
  "app/approvals/loading.tsx": SURFACE_TOKENS,
  "app/assets/loading.tsx": SURFACE_TOKENS,
  "app/assets/archive/loading.tsx": SURFACE_TOKENS,
  "app/sellers/loading.tsx": SURFACE_TOKENS,
  "app/outreach/loading.tsx": SURFACE_TOKENS,
  "app/reports/loading.tsx": SURFACE_TOKENS,
  "app/settlement/loading.tsx": SURFACE_TOKENS,
  // 묶음 2-c B — 상세 옆 창 계열(데스크톱 Sheet · 모바일 하단 시트 공유).
  "components/crm/deals-panel.tsx": [...SURFACE_TOKENS, "bg-[linear-gradient"],
  "components/crm/sellers-panel.tsx": [...SURFACE_TOKENS, "bg-[linear-gradient"],
  "components/crm/partners-panel.tsx": [...SURFACE_TOKENS, "bg-[linear-gradient"],
  "components/crm/seller-detail-content.tsx": SURFACE_TOKENS,
  "components/crm/asset-manager.tsx": SURFACE_TOKENS,
};

/**
 * 대상 파일 안의 의도된 예외 — `cls` 는 허용하는 클래스 낱말 그대로, `context` 는 그 클래스가 든 문자열 노드에
 * 함께 있어야 하는 부분 문자열, `count` 는 그 적중의 정확한 개수. 같은 노드의 다른 금지 클래스는 예외가 아니다.
 */
type Exception = { token: string; cls: string; context: string; count: number; reason: string };

const EXCEPTIONS: Record<string, readonly Exception[]> = {
  "components/crm/reference-inbox/reference-inbox-client.tsx": [
    {
      token: "backdrop-blur",
      cls: "backdrop-blur-sm",
      context: "bg-black/40",
      count: 1,
      reason: "사진 위에 얹는 오버레이 칩 — 어두운 반투명 바탕이라야 어떤 사진 위에서도 흰 글자가 읽힌다",
    },
  ],
  "components/crm/calendar-view.tsx": [
    {
      token: "rounded-[",
      cls: "rounded-[3px]",
      context: "size-2.5 rounded-[3px]",
      count: 1,
      reason: "범례 점(10px) — 모서리 사다리의 가장 작은 단(rounded-md 6.4px)도 10px 사각형에는 너무 둥글어 원과 구분되지 않는다",
    },
  ],
  "components/crm/asset-manager.tsx": [
    {
      token: "backdrop-blur",
      cls: "backdrop-blur-sm",
      context: "bg-black/55",
      count: 2,
      reason: "사진 썸네일 위 영상·장수 표시 칩 — 어두운 반투명 바탕이라야 어떤 사진 위에서도 흰 글자가 읽힌다",
    },
    {
      token: "backdrop-blur",
      cls: "backdrop-blur-sm",
      context: "bg-primary/90",
      count: 2,
      reason: "사진 썸네일 위 「대표」 칩 — 사진 위에 얹는 오버레이라 살짝 비치는 청록 바탕이 의도",
    },
  ],
  "components/crm/calendar-filter-bar.tsx": [
    {
      token: "rounded-[",
      cls: "rounded-[3px]",
      context: "size-2.5 shrink-0 rounded-[3px]",
      count: 1,
      reason: "캘린더 범례 점과 같은 모양의 필터 점 — calendar-view 범례와 같은 사유",
    },
  ],
};

const isExempt = (rel: string, hit: Hit) =>
  (EXCEPTIONS[rel] ?? []).some((e) => e.token === hit.token && hit.cls === e.cls && hit.full.includes(e.context));

/** 적중 1건 = 금지 문자열이 든 클래스 낱말 1개(`cls`). 같은 문자열 노드에 두 번 들어 있으면 2건이다. */
type Hit = { token: string; cls: string; line: number; text: string; full: string };

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
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      for (const cls of text.split(/\s+/)) {
        for (const token of tokens) {
          if (cls.includes(token)) hits.push({ token, cls, line: line + 1, text: text.slice(0, 120), full: text });
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

  it("양성 프로브: 반쪽 반투명(테두리·바탕 알파)도 잡는다", () => {
    const probe = 'const a = <div className="border-white/70 bg-background/70" />; const b = "bg-card/90";';
    const tokens = findForbidden(probe, "probe.tsx", SURFACE_TOKENS).map((h) => h.token).sort();
    expect(tokens).toEqual(["bg-background/", "bg-card/", "border-white/"].sort());
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
    const hits = findForbidden(source, rel, tokens).filter((h) => !isExempt(rel, h));
    expect(hits, hits.map((h) => `${rel}:${h.line} [${h.token}] ${h.text}`).join("\n")).toEqual([]);
  });
});

describe("opaque content surfaces — 예외 목록", () => {
  const entries = Object.entries(EXCEPTIONS).flatMap(([rel, list]) => list.map((e) => [rel, e] as const));

  it.each(entries)("%s 예외에 사유가 있다", (_rel, e) => {
    expect(e.reason.trim().length).toBeGreaterThan(0);
  });

  it.each(entries)("%s 예외의 적중 개수가 등재값과 같다(낡은 예외·묻어가는 위반 금지)", (rel, e) => {
    expect(TARGETS[rel], `${rel} 은 TARGETS 에 없다`).toBeDefined();
    const source = readFileSync(join(ROOT, rel), "utf8");
    const used = findForbidden(source, rel, TARGETS[rel]).filter((h) => h.token === e.token && h.cls === e.cls && h.full.includes(e.context));
    expect(
      used.length,
      `${rel} 의 예외 ${e.cls} (${e.context}) 적중이 ${used.length}건 — 0건이면 예외를 지우고, 늘었으면 새 줄을 고칠 것`,
    ).toBe(e.count);
  });
});
