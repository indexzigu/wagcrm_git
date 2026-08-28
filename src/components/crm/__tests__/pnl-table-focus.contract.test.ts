import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 손익 리포트 표의 **초점 계약** — "이 표는 숫자를 읽는 자리다"(오너 2026-08-25).
 *
 * 이 파일이 막는 것은 **되살아남**이다. 걷어낸 두 배지는 없어진 자리가 "빠뜨린 것"처럼
 * 보여서, 다음 세션이 선의로 다시 넣기 쉽다. 근거를 코드 옆에 남겨도 배지 추가 PR 은
 * 그 주석을 안 읽는다 — 그래서 테스트로 옮긴다.
 *
 * ⚠️ 소스 스캔이라 **주석을 먼저 걷어낸다.** 지운 문자열을 설명하는 경고 주석이 그대로
 * 있으면 그 주석이 자기 자신을 위반으로 잡는다(이 레포가 두 번 겪은 부류). 대신 주석
 * 제거 뒤에도 **앵커 긍정 단언**을 살려 둔다 — 스트리퍼가 파일을 통째로 날려도 부정
 * 단언만으로는 전부 초록이 되기 때문이다.
 */

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

const PNL = stripComments(
  readFileSync(join(process.cwd(), "src/components/crm/pnl-report-client.tsx"), "utf8"),
);

describe("손익 리포트 표 — 앵커 (스트리퍼·경로 고장 검출)", () => {
  it("스캔 대상이 실제 손익 표다", () => {
    expect(PNL).toContain("campaignsByMonth.map");
    expect(PNL).toContain("캠페인별 순수익");
  });
});

describe("표의 배지는 예외 신호 하나뿐이다", () => {
  it('"적자"만 남는다 — 소수 행에만 뜨는 판정이라 색을 받을 자격이 있다', () => {
    expect(PNL).toContain('<Badge variant="status-urgent">적자</Badge>');
  });

  it("상시 경고 배지를 다시 달지 않는다 (발화율 100% = 신호 0)", () => {
    // 운영비·기타비용이 아예 안 드는 캠페인이 많아 "비용 미입력"이 전 행에 떴다.
    // 미입력 사실은 배지가 아니라 상세 시트가 항목까지 들어 말한다(아래 계약).
    expect(PNL).not.toContain("status-pending");
  });

  it("채널 배지를 표에 되살리지 않는다 (P8 색 원칙 4 — 범주는 배지를 받지 않는다)", () => {
    expect(PNL).not.toContain("channelLabel(row.salesChannel)");
  });
});

describe("걷어낸 정보는 상세 시트가 보유한다 — 삭제가 아니라 이동이다", () => {
  it("채널은 시트 메타에 남는다", () => {
    expect(PNL).toContain("channelLabel(selectedCampaign.salesChannel)");
  });

  it("비용 미입력 항목은 시트의 계산 근거로 남는다", () => {
    expect(PNL).toContain("selectedCampaign.missingCostFields.length > 0");
  });
});

describe("채널 라벨은 정본 하나만 읽는다", () => {
  it("salesChannelLabels(crm-types) 를 소비한다", () => {
    expect(PNL).toContain('salesChannelLabels } from "@/lib/crm-types"');
  });

  it("손수 만든 라벨 사본이 없다 — 사본은 OWN_MALL 을 몰라 원문 코드를 뱉었다", () => {
    expect(PNL).not.toMatch(/BRAND_MALL|SELLER_MALL|OWN_MALL/);
  });
});

describe("숫자 초점", () => {
  it("0 은 무채색으로 낮춘다 — 범주가 아니라 값이 기준이다", () => {
    expect(PNL).toContain('value === 0 && "text-muted-foreground"');
    // 기각된 규칙(범주=비용이면 무조건 강등)이 이 헬퍼를 타고 되돌아오지 않게.
    expect(PNL).not.toContain('emphasis === "cost" && "text-muted-foreground"');
  });

  it("구성요소와 결과를 헤어라인으로 가른다", () => {
    expect(PNL).toContain('<TableHead className="border-l text-right">세전 순이익</TableHead>');
  });
});
