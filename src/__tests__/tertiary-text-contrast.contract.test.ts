import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * **흐린 보조 글자를 알파·slate-300 으로 만들지 않는다** — 앱 전역 계약(T-214, interfaces 점검 #5).
 *
 * 3차 글자(부연·캡션·0값·비활성 탭)를 소비처마다 알파로 흐리게 만들다 보니 흰 카드 위 대비가
 * 본문 기준(4.5:1)에 크게 못 미쳤다 — `text-muted-foreground/70` 2.72 · `/60` 2.30 · `/50` 1.97 ·
 * `/40` 1.69, `text-slate-300` 1.48(P8 데이터 그리드 규칙이 이미 금지). 하한은 토큰으로 고정한다:
 * 흰 배경 보조 글자 = `text-muted-foreground`(4.76), 소극 상태 = `text-slate-500`(4.77),
 * 회색 칩(slate-100) 위 = `text-slate-600`(6.90). 약하게 보이게 하려면 투명도 대신 크기·굵기로.
 *
 * 판정 범위: 문자열·템플릿 조각의 토큰 가운데 **변형 접두사가 없거나 `hover:` 인** 것만 본다.
 * `placeholder:`·`disabled:`·`marker:`·`dark:` 같은 변형은 이 계약 밖이다(자리표시자·비활성
 * 컨트롤·목록 기호는 WCAG 1.4.3 대상이 아니거나 별도 판단이고, `.dark` 는 앱에서 쓰지 않는다).
 * 주석은 AST 노드가 아니라 잡히지 않는다.
 *
 * `text-slate-400`(흰 바탕 2.63)은 아이콘에 정당하게 널리 쓰이므로 **아이콘 요소의 className**
 * (대문자 컴포넌트 — lucide 등 — 와 `svg`·`path`)에 붙은 것은 세지 않고 그 밖에서만 센다.
 * 어두운 표면(slate-900 위 6.79:1)에서는 오히려 slate-400 이 맞는 하한이라(slate-500 은 3.74:1)
 * 예외 목록에 표면 이유와 함께 둔다 — 흰 바탕 기준으로 "slate-500 으로 되돌리라"는 교정은 회귀다.
 *
 * ⚠️ 이 계약이 **못 보는 것**: 배경을 정적으로 알 수 없으므로 `text-muted-foreground` 자체가 연한
 * 표면(slate-100 4.34)에 얹히는 경우는 판정하지 않는다. 아이콘을 소문자 래퍼(`<span>`)가 감싸
 * 색을 물려주는 경우는 글자와 구분되지 않아 예외 목록에 오른다.
 */

const SRC = join(__dirname, "..");

type Exemption = { file: string; token: string; count: number; reason: string };

const SEPARATOR = "구분 기호(·, /, ›) — 정보가 없는 장식 글리프이고 양옆 글자가 뜻을 전한다";
const ICON = "아이콘(비텍스트) — 옆 라벨이 뜻을 전하는 장식 아이콘이라 1.4.3 대상이 아니다";
const DARK = "어두운 표면(slate-700~950·설치 게이트) 위라 slate-300 대비가 충분하다(6.97:1 이상)";
const DISABLED = "비활성 컨트롤 — WCAG 1.4.3 예외(비활성 UI 구성 요소)";
const ICON_WRAPPER = "아이콘만 담은 래퍼 — 색을 자식 아이콘에 물려줄 뿐 글자가 없다";
const DARK_400 = "어두운 표면(slate-900·설치 게이트 #080B11) 위라 slate-400 이 하한이다(6.79:1 이상, slate-500 은 3.74:1)";

/**
 * 정당한 잔존 목록. **개수까지 정확히 일치해야 한다** — 새로 쓰면 개수가 늘어 실패하고, 고쳐서
 * 줄였는데 목록을 안 고쳐도 실패한다(목록이 실제와 어긋난 채 남지 않게).
 * 새 예외는 이유와 함께 여기에 등재한다 — 글자라면 등재가 아니라 하한 토큰으로 고친다.
 */
const EXEMPTIONS: Exemption[] = [
  { file: "app/settings/layout.tsx", token: "text-muted-foreground/70", count: 1, reason: ICON },
  { file: "app/outreach/page.tsx", token: "text-muted-foreground/50", count: 1, reason: DISABLED },
  { file: "components/ui/empty.tsx", token: "text-muted-foreground/60", count: 1, reason: ICON },
  { file: "components/crm/asset-manager.tsx", token: "text-muted-foreground/50", count: 1, reason: ICON },
  { file: "components/crm/reference-inbox/reference-inbox-client.tsx", token: "text-muted-foreground/50", count: 1, reason: ICON },
  { file: "components/crm/reference-inbox/reference-inbox-client.tsx", token: "text-muted-foreground/60", count: 1, reason: SEPARATOR },
  { file: "components/crm/seller-detail-content.tsx", token: "text-muted-foreground/50", count: 1, reason: SEPARATOR },
  { file: "components/crm/status-stepper.tsx", token: "text-muted-foreground/50", count: 1, reason: DISABLED },
  { file: "components/mobile/mobile-pipeline-view.tsx", token: "text-muted-foreground/40", count: 2, reason: SEPARATOR },
  { file: "components/mobile/mobile-settlement-view.tsx", token: "text-muted-foreground/60", count: 1, reason: SEPARATOR },
  { file: "components/mobile/mobile-today-summary-bar.tsx", token: "text-muted-foreground/40", count: 2, reason: SEPARATOR },
  { file: "components/crm/order-dashboard.tsx", token: "text-slate-300", count: 9, reason: SEPARATOR },
  { file: "components/crm/shipping/modals/DelayDispatchModal.tsx", token: "text-slate-300", count: 4, reason: SEPARATOR },
  { file: "components/crm/execution-kanban-board.tsx", token: "text-slate-300", count: 2, reason: SEPARATOR },
  { file: "components/crm/asset-library.tsx", token: "text-slate-300", count: 1, reason: SEPARATOR },
  { file: "components/crm/system-radar-card.tsx", token: "text-slate-300", count: 1, reason: SEPARATOR },
  { file: "components/crm/claim-list.tsx", token: "text-slate-300", count: 2, reason: `${DISABLED}(배송조회 비활성 표시) + ${SEPARATOR}` },
  { file: "components/crm/deals-panel.tsx", token: "text-slate-300", count: 1, reason: DISABLED },
  { file: "components/crm/post-preview-card.tsx", token: "text-slate-300", count: 1, reason: ICON },
  { file: "components/crm/seller-analysis/SellerAiAnalysis.tsx", token: "text-slate-300", count: 3, reason: ICON },
  { file: "components/crm/schedule-gap-briefing-card.tsx", token: "text-slate-300", count: 2, reason: `${DARK} — slate-950 툴팁` },
  { file: "components/portal/seller-performance-card.tsx", token: "text-slate-300", count: 2, reason: `${DARK} — slate-900→700 헤더` },
  { file: "components/mobile/mobile-standalone-gate.tsx", token: "text-slate-300", count: 1, reason: DARK },
  { file: "app/coupang-partners/page.tsx", token: "text-slate-400", count: 1, reason: `${DARK_400} — 추천 섹션` },
  { file: "components/mobile/mobile-standalone-gate.tsx", token: "text-slate-400", count: 1, reason: DARK_400 },
  { file: "components/crm/asset-library.tsx", token: "text-slate-400", count: 2, reason: ICON_WRAPPER },
  { file: "components/crm/dashboard-home.tsx", token: "text-slate-400", count: 1, reason: ICON_WRAPPER },
  { file: "components/mobile/mobile-campaign-detail-sheet.tsx", token: "text-slate-400", count: 1, reason: ICON_WRAPPER },
  { file: "components/crm/bulk-content-collect-button.tsx", token: "text-slate-400", count: 1, reason: DISABLED },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name === "generated") continue;
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

/** 금지 토큰이면 변형 접두사를 뗀 이름을, 아니면 null. `hover:` 외의 변형은 대상 밖이다. */
function forbiddenToken(token: string): string | null {
  const bare = token.startsWith("hover:") ? token.slice("hover:".length) : token;
  if (bare.includes(":")) return null;
  if (/^text-muted-foreground\/\d+$/.test(bare) || bare === "text-slate-300") return bare;
  if (bare === "text-slate-400" || /^text-slate-400\/\d+$/.test(bare)) return "text-slate-400";
  return null;
}

/** 아이콘 요소 — 대문자 JSX 컴포넌트(lucide 등)와 인라인 `svg`·`path`. 이들의 className 은 비텍스트다. */
const isIconTag = (tag: string) => /^[A-Z]/.test(tag) || tag === "svg" || tag === "path";

/** 파일의 문자열·템플릿 조각에서 금지 토큰을 센다(주석 제외 — AST 로 읽는다). */
function countForbidden(fileName: string, text: string): Map<string, number> {
  const counts = new Map<string, number>();
  // 싼 거르기 — 이스케이프(`\u`)로 쓴 클래스는 원문에 이름이 안 보이므로 그 파일도 AST 로 본다.
  if (
    !text.includes("text-muted-foreground/") &&
    !text.includes("text-slate-300") &&
    !text.includes("text-slate-400") &&
    !text.includes("\\u")
  ) {
    return counts;
  }
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // inIcon: 지금 문자열이 아이콘 요소의 className 안에 있는가 — slate-400 만 이 문맥을 면제받는다.
  const visit = (node: ts.Node, inIcon: boolean) => {
    let icon = inIcon;
    if (ts.isJsxAttribute(node) && node.name.getText() === "className") {
      const owner = node.parent.parent;
      if (ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner)) {
        icon = isIconTag(owner.tagName.getText());
      }
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      for (const token of node.text.split(/\s+/)) {
        const hit = forbiddenToken(token);
        if (!hit || (icon && hit === "text-slate-400")) continue;
        counts.set(hit, (counts.get(hit) ?? 0) + 1);
      }
    }
    ts.forEachChild(node, (child) => visit(child, icon));
  };
  visit(source, false);
  return counts;
}

describe("판정기 자체 — 반증 프로브", () => {
  it("알파 보조 글자와 slate-300 을 잡는다(hover 변형 포함)", () => {
    expect(forbiddenToken("text-muted-foreground/70")).toBe("text-muted-foreground/70");
    expect(forbiddenToken("hover:text-muted-foreground/50")).toBe("text-muted-foreground/50");
    expect(forbiddenToken("text-slate-300")).toBe("text-slate-300");
  });

  it("하한 토큰·다른 변형·비슷한 이름은 잡지 않는다", () => {
    for (const token of [
      "text-muted-foreground",
      "text-slate-500",
      "text-slate-3000",
      "placeholder:text-slate-300",
      "disabled:text-muted-foreground/50",
      "marker:text-slate-300",
      "dark:text-slate-300",
      "bg-muted-foreground/10",
      "border-slate-300",
    ]) {
      expect(forbiddenToken(token)).toBeNull();
    }
  });

  it("slate-400 은 글자 요소에서만 센다 — 아이콘 컴포넌트·svg 의 className 은 뺀다", () => {
    const probe = [
      'const A = () => <p className="text-xs text-slate-400">x</p>;',
      'const B = () => <Search className="size-4 text-slate-400" />;',
      'const C = () => <svg className={cn("size-3", on ? "text-slate-400" : "")} />;',
      'const D = () => <span className={cn("a", on && "hover:text-slate-400")}>y</span>;',
    ].join("\n");
    expect(Object.fromEntries(countForbidden("icons.tsx", probe))).toEqual({ "text-slate-400": 2 });
  });

  it("AST 로 문자열만 읽는다 — 주석은 빼고 템플릿·삼항·이스케이프는 센다", () => {
    const probe = [
      "// text-slate-300 text-muted-foreground/70",
      'const a = "px-2 text-slate-300";',
      "const b = `x ${ok ? 'text-muted-foreground/60' : 'text-slate-500'} y`;",
      'const c = "text-muted-foreground/40 hover:text-muted-foreground/40";',
      'const d = "text-\\u0073late-300";',
    ].join("\n");
    const counts = countForbidden("probe.tsx", probe);
    expect(Object.fromEntries(counts)).toEqual({
      "text-slate-300": 2,
      "text-muted-foreground/60": 1,
      "text-muted-foreground/40": 2,
    });
  });
});

describe("앱 전역 — 흐린 보조 글자 금지", () => {
  const files = sourceFiles(SRC).map((full) => ({
    rel: relative(SRC, full).split("\\").join("/"),
    text: readFileSync(full, "utf8"),
  }));

  it("스캔 대상이 실제로 앱 소스다(빈 목록으로 초록이 되지 않게)", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.filter(({ text }) => text.includes("text-muted-foreground")).length).toBeGreaterThan(50);
  });

  it("예외 목록 밖에서 쓰지 않고, 예외 개수가 실제와 정확히 맞는다", () => {
    const actual: string[] = [];
    for (const { rel, text } of files) {
      for (const [token, count] of countForbidden(rel, text)) actual.push(`${rel} ${token} ×${count}`);
    }
    const expected = EXEMPTIONS.map(({ file, token, count }) => `${file} ${token} ×${count}`);
    // 실패하면: 새 글자라면 text-muted-foreground·text-slate-500(회색 칩 위 slate-600)로 고친다.
    // 구분 기호·아이콘·비활성·어두운 표면이면 이유와 함께 EXEMPTIONS 에 등재한다.
    expect(actual.sort()).toEqual(expected.sort());
  });

  it("예외마다 이유가 있다", () => {
    expect(EXEMPTIONS.filter(({ reason }) => reason.trim().length < 10)).toEqual([]);
  });
});
