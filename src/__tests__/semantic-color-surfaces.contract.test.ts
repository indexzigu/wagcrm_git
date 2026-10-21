import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// 색 정리 후속(애플 UI 리뉴얼 뒤, 2026-10-21) — P8 「색 사용 원칙」 §1(5개 의미축)·§4(범주는 색을 받지 않는다)·
// §5(표면 종속 대비)·세부 규칙 「hex 하드코딩 금지」를 아래 표면에 고정한다.
//   주문 관리 액션 버튼(emerald → 형제 버튼과 같은 무채색) · 동기화 기록 「부분 실패」(amber → --status-caution*)
//   영업 관리 팔로업 카드(amber/blue/indigo 종류별 테두리 → status-info 막대 하나) · 전환율 도넛 stroke hex → stroke-chart-1
//   셀러 포털 판매중 칩(emerald → 생애주기 status-active) · 마감 임박(amber → --status-caution*)
//   시간대별 주문 막대(chart-1/60 흰 바탕 2.93 → chart-1/70 3.64)
//
// 판정은 주석이 아니라 **코드의 문자열 값**에서 한다 — TypeScript 구문 트리로 문자열·템플릿·JSX 속성 값만 모은다
// (정규식 주석 제거는 "https://" 같은 문자열을 주석으로 삼킨다). 주석 속 「종전 amber」 같은 경위 서술은 대상이 아니다.

const ROOT = path.join(process.cwd(), "src");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const FILES = [
  "components/crm/order-dashboard.tsx",
  // [애플UI] 전수 정리 A — 주문·캠페인·정산·휴대폰(2026-10-22)
  "components/crm/campaign-side-panel.tsx",
  "components/crm/campaign-card.tsx",
  "components/crm/campaign-group-section.tsx",
  "components/crm/campaign-deals-table.tsx",
  "components/crm/campaign-creation-form.tsx",
  "components/crm/deal-creation-form.tsx",
  "components/crm/deals-panel.tsx",
  "components/crm/deal-options-section.tsx",
  "components/crm/calendar-view.tsx",
  "components/crm/settlement-section.tsx",
  "components/crm/settlement-checklist.tsx",
  "components/crm/commission-smart-form.tsx",
  "components/crm/schedule-gap-briefing-card.tsx",
  "components/crm/crm-dashboard.tsx",
  "components/crm/recampaign-alerts-card.tsx",
  "components/crm/step-metric-card.tsx",
  "components/crm/price-defense-card.tsx",
  "components/crm/market-price-monitor.tsx",
  "components/crm/shipping/modals/CampaignEditModal.tsx",
  "components/crm/shipping/modals/CampaignCreateModal.tsx",
  "components/crm/shipping/modals/EmailSendModal.tsx",
  "components/crm/shipping/modals/DelayDispatchModal.tsx",
  "components/mobile/mobile-campaign-detail-sheet.tsx",
  "components/mobile/mobile-schedule-calendar.tsx",
  "components/crm/outreach-list.tsx",
  "app/outreach/page.tsx",
  // [애플UI] 전수 정리 B — 셀러·영업·포털·로그인(2026-10-22)
  "app/sellers/[id]/page.tsx",
  "components/crm/seller-detail-content.tsx",
  "components/crm/sellers-management.tsx",
  "components/crm/seller-identity-info.tsx",
  "components/crm/seller-bulk-create-dialog.tsx",
  "components/crm/seller-analysis/SellerAiAnalysis.tsx",
  "components/crm/seller-analysis/CategoryProfile.tsx",
  "components/crm/seller-analysis/ScoreCard.tsx",
  "components/crm/seller-analysis/CommentIntent.tsx",
  "components/crm/seller-growth-chart.tsx",
  "components/crm/seller-er-chart.tsx",
  "components/crm/seller-portal-link-section.tsx",
  "components/crm/outreach-message-generator.tsx",
  "components/crm/activity-timeline.tsx",
  "components/crm/partners-management.tsx",
  "components/crm/referral-network-dialog.tsx",
  "components/crm/follower-bar-cell.tsx",
  "components/crm/story-inbox-grid.tsx",
  "components/auth/landing-login.tsx",
  "components/portal/seller-portal-report.tsx",
  "components/portal/campaign-countdown.tsx",
  "components/crm/shipping/modals/CampaignInsightsModal.tsx",
  "components/portal/seller-portal-report.tsx",
  "components/portal/campaign-countdown.tsx",
  "components/crm/shipping/modals/CampaignInsightsModal.tsx",
] as const;

/** globals.css 밖 팔레트 hue(셰이드가 붙은 유틸) + hex 리터럴. */
const OFF_TOKEN_HUE = /\b(?:emerald|amber|blue|indigo|sky|violet|purple|rose|orange|green|yellow|teal|cyan|pink|red|lime|fuchsia)-\d{2,3}\b/g;
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/** 파일 → 남겨 둔 hue(또는 "#" hex 값) 와 정확한 개수·사유. 줄이기만 한다(고치면 개수를 낮추고, 0 이 되면 항목을 지운다). */
const REMAINING: Record<string, { hue: string; count: number; reason: string }[]> = {
  "components/crm/campaign-card.tsx": [
    { hue: "emerald", count: 2, reason: "ACTIVE 라이브 도트 — 오너 확정 예외(2026-07-16), status-literal-token-alignment 가 고정" },
  ],
  "components/crm/shipping/modals/CampaignEditModal.tsx": [
    { hue: "green", count: 1, reason: "개발용 디버그 로그 글자(어두운 slate-900 바탕) — 그 표면 대비를 지키는 토큰 없음" },
  ],
  "components/crm/schedule-gap-briefing-card.tsx": [
    { hue: "#FBF7F0", count: 1, reason: "크림 바탕 — 무채색에 가까운 바탕(범위 밖)" },
    { hue: "#1F2A30", count: 4, reason: "본문 진한 글자 — 무채색(범위 밖)" },
  ],
  "app/outreach/page.tsx": [
    {
      hue: "rose",
      count: 6,
      reason:
        "오너 확인: 유지 — 「전환율 낮은 판매 조건·셀러」 순위 막대·아이콘(2026-10-21)",
    },
  ],
  "components/auth/landing-login.tsx": [
    { hue: "#4285F4", count: 1, reason: "구글 로그인 G 로고 — 남의 상표 원색" },
    { hue: "#34A853", count: 1, reason: "구글 로그인 G 로고 — 남의 상표 원색" },
    { hue: "#FBBC05", count: 1, reason: "구글 로그인 G 로고 — 남의 상표 원색" },
    { hue: "#EA4335", count: 1, reason: "구글 로그인 G 로고 — 남의 상표 원색" },
  ],
};

/** 코드의 문자열 값만 모은다(주석·JSX 본문 글자 제외). */
export function stringValues(source: string, fileName = "x.tsx"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function hueHits(values: string[]): string[] {
  return values.flatMap((v) => v.match(OFF_TOKEN_HUE) ?? []);
}

// ── 대비 계산(WCAG 2.x) ──────────────────────────────────────────────────────
type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const lum = (c: Rgb) => {
  const s = c.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2];
};
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as Rgb;

const GLOBALS = read("app/globals.css");
function token(name: string): Rgb {
  const root = GLOBALS.slice(GLOBALS.indexOf(":root {"), GLOBALS.indexOf("\n}", GLOBALS.indexOf(":root {")));
  const m = root.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})\\b`));
  expect(m, `${name} 의 :root hex 정의를 못 찾음 — 대비 단언이 무력해졌다`).not.toBeNull();
  return hex(m![1]);
}
const WHITE = hex("#FFFFFF");
const SLATE_100 = hex("#F1F5F9"); // 0건 시간대 기준선 — 막대 바로 옆에 붙는 면

describe("스캐너 프로브 — 스캐너가 고장 나면 아래 「0건」이 거짓말이 된다", () => {
  it("양성: 문자열·템플릿·JSX 속성 안의 팔레트 hue 와 hex 를 잡는다", () => {
    const src = [
      'const a = "bg-emerald-50 text-amber-700";',
      "const b = `x ${y ? 'border-l-indigo-500' : ''} text-blue-600`;",
      'const c = <circle stroke="#10b981" className="fill-rose-500" />;',
    ].join("\n");
    expect(hueHits(stringValues(src))).toEqual([
      "emerald-50",
      "amber-700",
      "indigo-500",
      "blue-600",
      "rose-500",
    ]);
    expect(stringValues(src).filter((v) => /#[0-9a-fA-F]{3,8}\b/.test(v))).toEqual(["#10b981"]);
  });

  it("음성: 주석과 토큰 유틸은 잡지 않는다", () => {
    const src = [
      "// 종전 bg-emerald-50 은 축 밖 hue",
      "/* amber-700 #10b981 */",
      'const a = <div className="bg-status-caution-bg text-status-active stroke-chart-1">{/* blue-500 */}</div>;',
      'const u = "https://example.com/a";',
    ].join("\n");
    expect(hueHits(stringValues(src))).toEqual([]);
    expect(stringValues(src).filter((v) => /#[0-9a-fA-F]{3,8}\b/.test(v))).toEqual([]);
  });
});

describe("대상 표면에 globals.css 밖 hue·hex 가 돌아오지 않는다", () => {
  it.each(FILES)("%s", (rel) => {
    const values = stringValues(read(rel), rel);
    const hits = hueHits(values);
    const allowed = REMAINING[rel] ?? [];
    const hexes = values.flatMap((v) => v.match(HEX) ?? []);
    // hue 가 "#" 로 시작하는 항목은 hex 남김(무채색·남의 상표) — 대소문자 무시로 정확히 같은 값만 센다.
    const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    for (const entry of allowed) {
      expect(entry.reason.length, `${rel} 예외 사유가 비었다`).toBeGreaterThan(0);
      const n = entry.hue.startsWith("#")
        ? hexes.filter((h) => sameHex(h, entry.hue)).length
        : hits.filter((h) => h.startsWith(`${entry.hue}-`)).length;
      expect(n, `${rel} 의 ${entry.hue} 개수가 바뀌었다 — 줄었으면 REMAINING 을 낮출 것`).toBe(entry.count);
    }
    const unexpected = hits.filter((h) => !allowed.some((e) => h.startsWith(`${e.hue}-`)));
    expect(unexpected, `${rel} 에 팔레트 hue 재유입`).toEqual([]);
    const unexpectedHex = hexes.filter((h) => !allowed.some((e) => e.hue.startsWith("#") && sameHex(h, e.hue)));
    expect(unexpectedHex, `${rel} 에 hex 하드코딩 재유입 — 토큰을 쓸 것`).toEqual([]);
  });
});

describe("의미축 고정", () => {
  const outreachList = read("components/crm/outreach-list.tsx");
  const portal = read("components/portal/seller-portal-report.tsx");
  const orders = read("components/crm/order-dashboard.tsx");
  const outreach = read("app/outreach/page.tsx");

  it("팔로업 카드: 종류별 분기 없이 status-info 막대 하나", () => {
    expect(outreachList).toContain("border-l-4 border-l-status-info");
    expect(outreachList).not.toMatch(/followUp\.type === "(?:MANUAL_REMINDER|1ST_REMINDER|2ND_REMINDER|SAMPLE_CHECK)"/);
  });

  it("셀러 포털: 판매중 = 생애주기(status-active), 마감 임박 = 심각도(status-caution)", () => {
    expect(portal).toContain('"bg-status-active/10 text-status-active border-status-active/30"');
    expect(portal).toContain('"bg-status-caution-bg text-status-caution-text border-status-caution/50"');
    expect(portal).toContain('"bg-status-caution-bg text-status-caution border-status-caution/25"');
  });

  it("주문 관리: 부분 실패 = 심각도(status-caution), 액션 버튼 = 무채색", () => {
    expect(orders).toContain("border-status-caution/30 bg-status-caution-bg text-status-caution-text");
    // 주석이 아니라 코드 문자열 값만 본다 — 경위 주석에 「bg-white」가 적혀도 오탐하지 않게.
    expect(stringValues(orders).join(" ")).not.toMatch(/\bbg-white\b(?!\/)/);
  });

  it("전환율 도넛: 두 링 모두 차트 토큰, 트랙은 무채색", () => {
    expect(outreach.split('className="stroke-chart-1"').length - 1).toBe(2);
    expect(outreach.split('className="stroke-slate-200"').length - 1).toBe(2);
  });
});

describe("대비 — 흰 바탕 기준(§5 표면 종속)", () => {
  it("전수 정리 B — 셀러 목록 팔로워 막대가 slate-100 트랙 위 3:1 이상", () => {
    // 종전 emerald-400(2.0)·chart-growth-soft(1.3)는 트랙과 뭉갰다 — 데이터 크기 막대라 차트 축(chart-2).
    expect(read("components/crm/follower-bar-cell.tsx")).toContain("rounded-sm bg-chart-2");
    expect(ratio(token("--chart-2"), SLATE_100)).toBeGreaterThanOrEqual(3);
  });

  it("오너 결정(2026-10-22) — 단계 막대는 청록 진하기 사다리, 가장 옅은 칸도 흰 바탕 3:1", () => {
    const src = read("components/crm/step-metric-card.tsx");
    expect(src).toContain('"bg-primary/65",\n  "bg-primary/80",\n  "bg-primary",');
    expect(ratio(over(token("--primary"), 0.65, WHITE), WHITE)).toBeGreaterThanOrEqual(3);
  });

  it("전수 정리 A — 위험 행 점수 글자·셀러지급액 칸이 AA(4.5:1) 이상", () => {
    // 시세 모니터: 위험 행(bg-status-urgent-bg) 위 점수 글자는 -text 짝이어야 한다(맨 status-urgent 는 4.1).
    expect(read("components/crm/market-price-monitor.tsx")).toContain('"text-status-urgent-text font-medium"');
    expect(ratio(token("--status-urgent-text"), token("--status-urgent-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("--status-urgent"), token("--status-urgent-bg"))).toBeLessThan(4.5);
    // 캠페인 옆 패널 셀러지급액: money-out 글자가 자기 2% 틴트 위에서 AA(5% 틴트면 4.36 미달).
    expect(read("components/crm/campaign-side-panel.tsx")).toContain("border-money-out/20 bg-money-out/[0.02]");
    const mo = token("--money-out");
    expect(ratio(mo, over(mo, 0.02, WHITE))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(mo, over(mo, 0.05, WHITE))).toBeLessThan(4.5);
  });

  it("시간대별 주문 막대(두 화면)가 흰 바탕·slate-100 기준선 옆 모두 3:1 이상", () => {
    const bars = [
      read("components/portal/seller-portal-report.tsx"),
      read("components/crm/shipping/modals/CampaignInsightsModal.tsx"),
    ];
    for (const src of bars) {
      const m = src.match(/h\.orders > 0 \? ['"]bg-chart-1\/(\d+)/);
      expect(m, "시간대 막대 클래스 앵커를 못 찾음").not.toBeNull();
      const fill = over(token("--chart-1"), Number(m![1]) / 100, WHITE);
      expect(ratio(fill, WHITE)).toBeGreaterThanOrEqual(3);
      expect(ratio(fill, SLATE_100)).toBeGreaterThanOrEqual(3);
    }
    // 종전 60% 는 미달이었다 — 되돌리면 다시 깨진다는 근거.
    expect(ratio(over(token("--chart-1"), 0.6, WHITE), WHITE)).toBeLessThan(3);
  });

  it("팔로업 막대(비텍스트 3:1)·도넛 링(트랙 slate-200 위 3:1)", () => {
    expect(ratio(token("--status-info"), WHITE)).toBeGreaterThanOrEqual(3);
    expect(ratio(token("--chart-1"), hex("#E2E8F0"))).toBeGreaterThanOrEqual(3);
  });

  it("포털 칩·부분 실패 글자가 AA(4.5:1) 이상", () => {
    const active = token("--status-active");
    expect(ratio(active, over(active, 0.1, WHITE))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("--status-caution-text"), token("--status-caution-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token("--status-caution"), token("--status-caution-bg"))).toBeGreaterThanOrEqual(4.5);
  });
});
