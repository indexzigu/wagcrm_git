import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 데스크톱 돈 화면 3곳이 **손익 규칙을 profit-tone SSOT 로만** 쓰는지 고정한다.
 *
 * 고친 것 — 셋 다 같은 파생값(손익)인데 표면마다 다른 규칙을 썼고, 전부 부호를 무시했다:
 * - `settlement-table.tsx`: 영업이익 열이 **부호 무관 emerald-600**(적자도 초록).
 * - `settlement-page-client.tsx`: 최종 영업 이익이 **부호 무관 text-primary**(적자도 네이비).
 * - `pnl-report-client.tsx`: 월별 표 손익·이익률이 음수여도 무색.
 *
 * 색 값 자체는 여기서 단언하지 않는다(`profit-tone.test.ts` 소유). 여기서 막는 건
 * **화면이 자기만의 규칙을 다시 쓰는 것** — 리터럴 재유입과 축 오용이다.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const SETTLEMENT_TABLE = read("src/components/crm/settlement-table.tsx");
const SETTLEMENT_PAGE = read("src/app/settlement/settlement-page-client.tsx");
const COMPLETED_TABLE = read("src/components/crm/settlement-completed-table.tsx");
const SIDE_PANEL = read("src/components/crm/campaign-side-panel.tsx");
const PNL = read("src/components/crm/pnl-report-client.tsx");
const INFLOW = read("src/components/crm/inflow-report-client.tsx");
const SELECTION_BAR = read("src/components/crm/settlement-selection-bar.tsx");

describe("정산 목록 표 — 손익 열", () => {
  it("profit-tone SSOT 를 소비한다", () => {
    expect(SETTLEMENT_TABLE).toContain('from "@/lib/profit-tone"');
    expect(SETTLEMENT_TABLE).toContain("resolveProfitTone(campaign.operatingProfit)");
  });

  it("영업이익을 부호 무관 초록으로 칠하지 않는다 (고친 잠재 버그)", () => {
    expect(SETTLEMENT_TABLE).not.toContain("tabular-nums text-emerald-600");
  });

  it("판매 대행비는 자금 방향축 토큰을 쓴다 (리터럴 rose-600 폐기)", () => {
    expect(SETTLEMENT_TABLE).toContain("text-money-out");
    expect(SETTLEMENT_TABLE).not.toContain("tabular-nums text-rose-600");
  });
});

describe("정산 완료 표 — 활성 표의 자매(같은 페이지에 나란히 렌더)", () => {
  it("영업이익이 부호를 따른다 (활성 표와 같은 SSOT)", () => {
    expect(COMPLETED_TABLE).toContain('from "@/lib/profit-tone"');
    expect(COMPLETED_TABLE).toContain("resolveProfitTone(campaign.operatingProfit)");
  });

  it("부호 무관 emerald-600 을 쓰지 않는다 — 적자도 초록이었고 그 값은 AA 미달(3.77:1)", () => {
    expect(COMPLETED_TABLE).not.toContain("text-emerald-600");
  });

  it("셀러 수수료액은 자금 방향축 토큰", () => {
    expect(COMPLETED_TABLE).toContain("text-money-out");
    expect(COMPLETED_TABLE).not.toContain("text-rose-600");
  });
});

describe("캠페인 상세 패널 — 실제로 열리는 재무 정산 내역", () => {
  // ⚠️ settlement-page-client.tsx 의 <Sheet open={false}>(1007~1382) 는 레거시 죽은 코드다.
  //    실제 사용자가 정산 행을 클릭해 여는 원장은 CampaignSidePanel 이다 — 여기가 계약 대상.
  it("실제 렌더되는 패널이 SSOT 를 소비한다", () => {
    expect(SIDE_PANEL).toContain('from "@/lib/profit-tone"');
    expect(SIDE_PANEL).toContain("summaryProfitTone");
  });

  it("매출총이익이 부호를 따른다 — 이전엔 적자여도 text-primary(네이비) 고정", () => {
    // ⚠️ 2026-08-08 개명: 이 중간값의 라벨이 최종 「영업이익」과 **동명**이라 같은 카드에
    //    같은 이름의 다른 숫자가 둘 있었다(부가 항목이 붙으면서 오독이 배가될 자리였다).
    //    변수·라벨을 「매출총이익」으로 바꿨을 뿐 부호 추종 계약은 그대로다.
    expect(SIDE_PANEL).toContain("amount={grossProfit}");
    expect(SIDE_PANEL).toContain("resolveProfitTone(isEditing ? draftOperatingProfit : operatingProfit)");
  });

  it("비용 줄은 자금 방향축 토큰 (리터럴 rose-600 폐기)", () => {
    expect(SIDE_PANEL).toContain('danger && "text-money-out"');
    expect(SIDE_PANEL).not.toContain('danger && "text-rose-600"');
  });
});

describe("죽은 표면 가드 — 이 세션이 실제로 저지른 실수", () => {
  it("레거시 Sheet 는 아예 없다 (죽은 표면에 색을 고치고 고쳤다고 보고할 자리가 없다)", () => {
    // 이 세션은 처음에 이 죽은 Sheet 안의 색을 고치고 "고쳤다"고 보고할 뻔했다.
    // 소스 그렙 테스트는 코드가 렌더에 도달하는지 못 본다 — 그래서 이 가드를 남긴다.
    // T-023 에서 그 Sheet 를 제거했다(안에 명세서 HTML 의 3번째 손수 구현이 있었다).
    // 단언을 "비활성이다"에서 "없다"로 바꾼 것은 완화가 아니라 강화다 — 다시 붙는 순간 깨진다.
    expect(SETTLEMENT_PAGE).not.toContain("<Sheet open={false}");
    expect(SETTLEMENT_PAGE).not.toContain("Legacy settlement detail sheet kept disabled");
  });

  it("실제 원장은 CampaignSidePanel 이 소유한다", () => {
    expect(SETTLEMENT_PAGE).toContain("<CampaignSidePanel");
    expect(SETTLEMENT_PAGE).toContain("settlementWorkspace");
  });
});

describe("성과 리포트 — 손익", () => {
  it("profit-tone SSOT 를 소비한다", () => {
    expect(PNL).toContain('from "@/lib/profit-tone"');
    expect(PNL).toContain("resolveProfitTone(row.preTaxOperatingProfit)");
    expect(PNL).toContain("resolveProfitTone(row.afterTaxOperatingProfit)");
  });

  it("비용 KPI 타일의 강등을 해제했다 — 색 대신 정상 강도", () => {
    // 버그는 "색이 없다"가 아니라 KPI 값을 캡션처럼 흐리게 칠한 것이었다.
    expect(PNL).not.toContain('emphasis === "cost" && "text-muted-foreground"');
    // 그렇다고 비용을 칠하지도 않는다 — 라벨이 이미 비용이라고 말한다(4개 빨강 = 습관화).
    expect(PNL).not.toContain('emphasis === "cost" && "text-money-out"');
  });

  it("손익 타일은 각자 부호를 본다 (세전 흑자·세후 적자가 갈릴 수 있다)", () => {
    expect(PNL).toContain("amount={totals.preTaxOperatingProfit}");
    expect(PNL).toContain("amount={totals.afterTaxOperatingProfit}");
  });

  it("적자 배지가 status-urgent 로 정렬됐다 (shadcn 범용 destructive 폐기)", () => {
    expect(PNL).toContain('<Badge variant="status-urgent">적자</Badge>');
    expect(PNL).not.toContain('<Badge variant="destructive">적자</Badge>');
  });
});

/**
 * 밀도 축(2026-08-26) — **어느 표면이 어느 강도인가**를 표면별로 못박는다.
 *
 * 값 자체는 `profit-tone.test.ts` 가 소유한다(맵에 흑자 키가 없다는 계약). 여기서 막는
 * 것은 **소비처가 잘못된 맵을 고르는 것**이다. 두 맵은 이름만 다르고 타입이 호환되므로
 * tsc·eslint 가 못 잡고, 화면도 "그냥 초록이 좀 더 많은" 정도로만 보여 리뷰를 통과한다.
 *
 * 기준은 중요도가 아니라 **동시 노출 개수**다(P8 §3) — 표·원장처럼 행마다 되풀이되면
 * 흑자를 칠하는 순간 색이 그 열의 배경이 되어 적자가 묻힌다.
 */
describe("밀도 축 — 표·원장은 적자만 칠한다", () => {
  const DENSE = [
    ["정산 목록 표 영업이익 열", SETTLEMENT_TABLE],
    ["정산 완료 표 영업이익 열", COMPLETED_TABLE],
    ["손익 리포트 표 3열 + 상세 시트 원장", PNL],
    ["캠페인 상세 패널 재무 원장", SIDE_PANEL],
    ["유입 리포트 순이익 열", INFLOW],
  ] as const;

  for (const [label, code] of DENSE) {
    it(`${label} 은 밀집 맵을 쓴다`, () => {
      expect(code).toContain("PROFIT_TONE_TEXT_DENSE[");
    });
  }

  it("표 전용 파일에는 초점 맵이 아예 없다 — 헷갈릴 여지를 남기지 않는다", () => {
    // 이 셋은 표 하나뿐이라 초점 값이 존재하지 않는다. 초점 맵이 다시 import 되면
    // 그건 누군가 흑자에 색을 되돌린 것이다.
    for (const code of [SETTLEMENT_TABLE, COMPLETED_TABLE, INFLOW]) {
      expect(code).not.toMatch(/PROFIT_TONE_TEXT(?!_DENSE)/);
    }
  });
});

describe("밀도 축 — 초점 값은 양쪽 부호를 칠한다", () => {
  it("손익 리포트 KPI 타일 (화면당 2개)", () => {
    // 타일은 세전·세후 둘뿐이라 색이 여전히 값의 함수다. 여기서 초록을 걷는 것도 회귀다.
    expect(PNL).toContain('tone && PROFIT_TONE_TEXT[tone]');
  });

  it("캠페인 상세 패널 헤더 요약 (패널당 1개)", () => {
    expect(SIDE_PANEL).toContain("PROFIT_TONE_TEXT[summaryProfitTone]");
  });

  it("정산 선택 요약 바 (화면당 1개)", () => {
    expect(SELECTION_BAR).toContain("PROFIT_TONE_TEXT[summaryProfitTone]");
    expect(SELECTION_BAR).not.toContain("PROFIT_TONE_TEXT_DENSE");
  });
});

describe("축 오용 가드 — 전 표면", () => {
  it("적자/손익에 money-out 을 쓰지 않는다", () => {
    // --money-out 은 "지급은 위험이 아니라서 --status-urgent 에 흡수 불가"라고 선언된 반대편 축이다.
    // 손익이 마이너스인 건 계산된 결과값이지 실제 이체 사건이 아니다.
    for (const src of [SIDE_PANEL, PNL, COMPLETED_TABLE, SETTLEMENT_TABLE]) {
      expect(src).not.toMatch(/operatingProfit[^;]{0,80}money-out/);
    }
  });
});
