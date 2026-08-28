// D2 후속 — 범주 색 회수 계약 · 정산 패널 + 판매채널 (오너 지시 2026-07-16).
//
// 짝 파일: `category-color-reclaim.test.ts`(셀러 화면). 같은 원칙의 다른 표면이다 —
// **범주는 색을 받지 않는다**(P8 색 원칙 4). 여기서 회수하는 건 전부 판단이 없는 이름표다:
// 회차(3차가 1차보다 급하지 않다) · 파일 형식(이메일/PDF/이미지) · 판매채널(네이버/카카오/
// 브랜드몰/셀러몰). 인디고·퍼플·스카이는 `globals.css` 에 없는 리터럴이기도 했다.
//
// ⚠️ **이 파일은 소스 그렙이다 — 그렙은 그 코드가 렌더에 도달하는지 못 본다.**
// 이 파일이 지키는 `campaign-side-panel.tsx` 에는 **바로 옆에 죽은 쌍둥이가 있다**:
// `settlement-page-client.tsx` 의 `<Sheet open={false}>` 안에도 같은 모양의 인디고 3곳
// (회차 배지·저장 버튼·이메일 버튼)이 살아 있고, **PR #178 이 실제로 그쪽을 고치고
// tsc·eslint·vitest 전부 green 을 받았다.** 그래서 아래 describe 는 색 단언과
// **렌더 도달 단언을 짝으로** 두고, 죽은 Sheet 가 되살아나면 알려주는 가드도 함께 둔다.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const SIDE_PANEL = read("components/crm/campaign-side-panel.tsx");
const CAMPAIGN_CARD = read("components/crm/campaign-card.tsx");
const CRM_TYPES = read("lib/crm-types.ts");
const SETTLEMENT_PAGE = read("app/settlement/settlement-page-client.tsx");
const CRM_DASHBOARD = read("components/crm/crm-dashboard.tsx");

/** className="..." / className={...} 안의 문자열만 — 주석 속 색 이름에 오탐하지 않는다. */
function classText(source: string): string {
  return (source.match(/className=(?:"[^"]*"|\{[^}]*\}|`[^`]*`)/g) ?? []).join("\n");
}

/**
 * 색을 나르는 표면 전부 — className **과** `variant="status-*"`.
 * 토큰 정렬(2026-07-16) 뒤로 배지 색은 리터럴 클래스가 아니라 Badge 변형으로도 실린다
 * (`<Badge variant="status-urgent">`). className 만 보면 그 색을 **못 보고** "색이 사라졌다"고
 * 오판한다 — 실제로 이 파일이 그렇게 한 번 깨졌다.
 */
function styleText(source: string): string {
  return [classText(source), ...(source.match(/variant="[^"]*"/g) ?? [])].join("\n");
}

/** 앵커 구간. 앵커가 사라지면 테스트가 조용히 무력해지므로 항상 존재를 단언한다. */
function slice(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + 1);
  expect(a, `앵커 "${start}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(-1);
  expect(b, `앵커 "${end}" 를 못 찾음 — 테스트가 무력해졌다`).toBeGreaterThan(a);
  return source.slice(a, b);
}

/** 범주에 다시 붙으면 안 되는 hue — 전부 globals.css 에 없는 리터럴이다. */
const CATEGORY_HUES = ["indigo", "purple", "violet", "sky", "emerald", "amber", "blue", "rose"];

describe("D2 후속 — 렌더 도달 (그렙이 못 보는 것)", () => {
  it("CampaignSidePanel 은 앱이 실제로 렌더한다 — 테스트만 부르는 죽은 코드가 아니다", () => {
    expect(SETTLEMENT_PAGE).toContain("<CampaignSidePanel");
    expect(CRM_DASHBOARD).toContain("<CampaignSidePanel");
  });

  it("죽은 표면 가드: settlement-page-client 의 레거시 Sheet 는 아예 없다", () => {
    // 종전 이 단언은 `<Sheet open={false}>` 가 **여전히 비활성인지**를 봤다 — 그 안의 인디고
    // 3곳(회차 배지·저장·이메일)이 살아나면 알려주는 장치였다. T-023 에서 그 Sheet 를 통째로
    // 제거해(그 안에 명세서의 3번째 손수 구현이 숨어 있었다) 이제 되살아날 코드 자체가 없다.
    // 가드의 의도("죽은 표면에 색을 고치고 고쳤다고 보고하지 말 것")는 부재 단언이 더 세게
    // 지킨다 — 파일이 통째로 다시 붙는 경우도 여기서 걸린다.
    // `desktop-money-axis.test.ts` 가 같은 자리를 손익 축에서 지킨다(둘 중 하나가 지워져도 남게).
    expect(SETTLEMENT_PAGE).not.toContain("<Sheet open={false}");
    expect(SETTLEMENT_PAGE).not.toContain("Legacy settlement detail sheet kept disabled");
  });

  it("CampaignCard 는 앱이 실제로 렌더한다", () => {
    const boards = [
      read("components/crm/stage-column.tsx"),
      read("components/crm/zoned-pipeline-board.tsx"),
    ];
    expect(boards.some((b) => b.includes("<CampaignCard"))).toBe(true);
  });
});

describe("D2 후속 — 정산 패널: 인디고 회수", () => {
  const classes = classText(SIDE_PANEL);

  it("라이브 패널에 인디고가 없다", () => {
    expect(classes).not.toMatch(/indigo/);
  });

  it("회차 배지는 무채색이고 자매 표면(campaign-card)과 같은 Badge 컴포넌트를 쓴다", () => {
    const badge = slice(SIDE_PANEL, "{campaign.roundNumber ? (", ") : null}");
    expect(badge).toContain("<Badge");
    expect(badge).toContain("bg-slate-100");
    expect(badge).toContain("text-slate-600");
    for (const hue of CATEGORY_HUES) expect(badge).not.toContain(hue);
    // 정렬 대상이 실재하는지 — 사라지면 이 단언의 근거가 사라진 것이다.
    expect(classText(CAMPAIGN_CARD)).toContain("bg-slate-100 text-slate-600");
  });

  it("내보내기 3형제(이메일·PDF·이미지)는 셋 다 무채색이다 — 파일 형식은 범주다", () => {
    const toolbar = slice(SIDE_PANEL, "onClick={handleCopyStatement}", "onClick={handleEdit}");
    for (const hue of CATEGORY_HUES) {
      expect(classText(toolbar), `내보내기 툴바에 ${hue} 재유입`).not.toContain(hue);
    }
  });

  it("1차 액션(편집)은 네이비를 유지한다 — 무채색화가 위계를 지우면 안 된다", () => {
    expect(classes).toContain("bg-primary");
  });

  it("영업이익 카드 셸은 무채색이고, 숫자 색은 profit-tone SSOT 가 전담한다", () => {
    expect(SIDE_PANEL).toContain("border border-slate-200 bg-slate-50 px-3 py-2 text-xs");
    // #178 이 착지시킨 부호색이 살아 있어야 회수가 "빼기"가 아니라 "노출"이 된다.
    expect(SIDE_PANEL).toContain("PROFIT_TONE_TEXT[summaryProfitTone]");
  });

  it("FinancialLine 의 accent 틴트는 무채색이다", () => {
    expect(SIDE_PANEL).toContain('accent && "rounded-lg bg-slate-100 text-primary"');
  });
});

describe("D2 후속 — 판매채널: 범주 색 맵 제거", () => {
  it("salesChannelBadgeStyles 는 존재하지 않는다 — 맵의 존재 이유가 hue 뿐이었다", () => {
    expect(CRM_TYPES).not.toMatch(/export const salesChannelBadgeStyles/);
    expect(CAMPAIGN_CARD).not.toContain("salesChannelBadgeStyles");
  });

  it("라벨(salesChannelLabels)은 남는다 — 구분은 색이 아니라 라벨이 한다", () => {
    expect(CRM_TYPES).toContain("export const salesChannelLabels");
    expect(CAMPAIGN_CARD).toContain("salesChannelLabels[campaign.salesChannel]");
  });

  it("채널 배지는 손익 리포트 선례와 같은 맨 outline 이다", () => {
    const badge = slice(
      CAMPAIGN_CARD,
      "<Badge variant=\"outline\"",
      "{salesChannelLabels[campaign.salesChannel]}",
    );
    for (const hue of CATEGORY_HUES) expect(badge).not.toContain(hue);
  });

  it("카드에 남은 색은 전부 판단색이다 — 회수해도 밋밋해지지 않는 근거", () => {
    // 지연/완료(actionToneClass) · 정체 · 최저가 위반 · 실매출 미입력 — 전부 "봐야 할 것"이다.
    // 2026-07-16: 이 판단색들의 **표현**이 리터럴 → --status-* 토큰으로 옮겨졌다(색은 그대로,
    // status-literal-token-alignment.test.ts 가 짝을 고정한다). 이 단언의 뜻은 바뀌지 않는다 —
    // "채널색을 회수한 뒤에도 카드에 판단색이 남아 있다"는 근거다.
    const styles = styleText(CAMPAIGN_CARD);
    expect(styles).toMatch(/status-urgent/); // 지연·최저가 위반
    expect(styles).toMatch(/status-caution/); // 정체
  });
});
