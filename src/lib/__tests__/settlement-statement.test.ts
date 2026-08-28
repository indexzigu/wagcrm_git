import { describe, expect, it } from "vitest";

import type { CampaignRow } from "@/lib/crm-types";
import {
  buildSettlementStatementHtml,
  buildSettlementStatementPrintDoc,
  validateSettlementStatementCampaigns,
} from "@/lib/settlement-statement";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function createCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "campaign-001",
    dealId: "deal-001",
    sellerId: "seller-001",
    campaignName: "봄 캠페인",
    dealName: "봄 캠페인",
    partnerName: "브랜드",
    sellerName: "셀러 A",
    sellerCompanyName: "셀러 주식회사",
    sellerCompanyBusinessNumber: "1234567890",
    snsType: "INSTAGRAM",
    snsHandle: "seller",
    startDate: "2026-05-01",
    endDate: "2026-05-07",
    salesChannel: "BRAND_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 100_000,
    sellerExpense: 10_000,
    totalMarginRate: 20,
    sellerMarginRate: 10,
    netMarginRate: 10,
    status: "SETTLEMENT_IN_PROGRESS",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-05-08T00:00:00.000Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    campaignDeals: [
      {
        id: "campaign-deal-001",
        campaignId: "campaign-001",
        dealId: "deal-001",
        dealName: "옵션 A",
        quantity: 2,
        actualSales: 100_000,
        feeRate: 10,
        costPrice: 30_000,
        sellingPrice: 50_000,
      },
    ],
    ...overrides,
  };
}

describe("validateSettlementStatementCampaigns", () => {
  it("allows campaigns linked to the same company", () => {
    const result = validateSettlementStatementCampaigns([
      createCampaign(),
      createCampaign({ id: "campaign-002", sellerId: "seller-002", sellerName: "셀러 B" }),
    ]);

    expect(result.ok).toBe(true);
  });

  it("rejects campaigns linked to different companies", () => {
    const result = validateSettlementStatementCampaigns([
      createCampaign(),
      createCampaign({
        id: "campaign-002",
        sellerCompanyName: "다른 회사",
        sellerCompanyBusinessNumber: "9876543210",
      }),
    ]);

    expect(result.ok).toBe(false);
  });

  it("allows campaigns without linked companies only for the same seller", () => {
    const withoutCompany = {
      sellerCompanyName: null,
      sellerCompanyBusinessNumber: null,
    };

    expect(validateSettlementStatementCampaigns([
      createCampaign(withoutCompany),
      createCampaign({ ...withoutCompany, id: "campaign-002" }),
    ]).ok).toBe(true);

    expect(validateSettlementStatementCampaigns([
      createCampaign(withoutCompany),
      createCampaign({ ...withoutCompany, id: "campaign-002", sellerId: "seller-002" }),
    ]).ok).toBe(false);
  });
});

describe("buildSettlementStatementHtml", () => {
  it("builds one statement with campaign subtotals and bundled totals", () => {
    const html = buildSettlementStatementHtml([
      createCampaign(),
      createCampaign({
        id: "campaign-002",
        dealId: "deal-002",
        dealName: "여름 캠페인",
        actualSales: 200_000,
        sellerExpense: 20_000,
        campaignDeals: [],
      }),
    ], new Date("2026-06-01T00:00:00.000Z"));

    expect(html).toContain("(캠페인 2건)");
    expect(html).toContain("300,000원");
    expect(html).toContain("30,000원");
    expect(html).toContain("캠페인 소계");
    expect(html).toContain("여름 캠페인");
  });

  it("escapes user-entered values in Rich HTML", () => {
    const html = buildSettlementStatementHtml([
      createCampaign({ dealName: "<script>alert('x')</script>" }),
    ]);

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("builds statement for INDIVIDUAL withholding tax seller", () => {
    const withoutCompany = {
      sellerCompanyName: null,
      sellerCompanyBusinessNumber: null,
      sellerTaxType: "INDIVIDUAL",
      sellerExpense: 10_000,
      taxExpense: 330,
    };
    const html = buildSettlementStatementHtml([
      createCampaign(withoutCompany),
    ], new Date("2026-06-01T00:00:00.000Z"));

    expect(html).toContain("차인지급액 (세후)");
    expect(html).toContain("원천세 (3.3%)");
    expect(html).toContain("10,000원");
    expect(html).toContain("-330원");
    expect(html).toContain("9,670원");
  });
});

describe("buildSettlementStatementPrintDoc — 크롬 인쇄 머리말/꼬리말 제거", () => {
  const doc = buildSettlementStatementPrintDoc([createCampaign()]);

  it("페이지 여백을 0 으로 없앤다 — 크롬은 여백 자리에만 날짜·URL·쪽번호를 그린다", () => {
    // 이 규칙이 사라지거나 margin 이 0 이 아니게 되면 머리말/꼬리말이 되살아난다.
    expect(doc).toMatch(/@page\s*\{[^}]*margin:\s*0/);
    expect(doc).not.toMatch(/@page\s*\{[^}]*margin:\s*20mm/);
  });

  it("빈 <title> 을 명시한다 — 없으면 크롬이 페이지 제목(W CRM)을 상단에 넣는다", () => {
    expect(doc).toContain("<title></title>");
  });

  it("완전한 문서다 — 문서 여백은 body 패딩으로 대신 준다", () => {
    expect(doc).toMatch(/^<!DOCTYPE html>/);
    expect(doc).toMatch(/body\s*\{[^}]*padding:/);
  });

  it("명세서 본문(정본 조각)을 그대로 감싼다 — 셀러 이름·합계가 살아 있다", () => {
    expect(doc).toContain("셀러 A");
    expect(doc).toContain("정산 명세서");
  });

  it("다중 페이지 완화책: 캠페인 블록에 break-inside/상단 padding 규칙을 건다", () => {
    // body 상하 패딩은 첫/마지막 장에만 적용되므로(CSS 분할 규칙), 묶음이 2장을 넘기면 중간 장
    // 상단이 0mm 에 붙는다. @page{margin:0} 은 P0(내부 URL 꼬리말) 때문에 유지해야 하므로
    // 캠페인 블록에 완화책을 건다. 이 규칙이 사라지면 중간 장 상단 여백이 다시 사라진다.
    expect(doc).toMatch(/\.stmt-campaign-block\s*\{[^}]*break-inside:\s*avoid/);
    // padding(=페이지 경계에서 유지) 이어야 한다 — margin 은 크롬이 절단한다.
    expect(doc).toMatch(/\.stmt-campaign-block\s*\+\s*\.stmt-campaign-block\s*\{[^}]*padding-top:/);
  });

  it("캠페인 블록마다 완화책 훅 클래스가 붙는다(개인·법인 두 분기 모두)", () => {
    const individual = buildSettlementStatementPrintDoc([
      createCampaign({ sellerCompanyName: null, sellerCompanyBusinessNumber: null }),
    ]);
    const business = buildSettlementStatementPrintDoc([
      createCampaign({ sellerCompanyName: "셀러상사", sellerCompanyBusinessNumber: "123-45-67890" }),
    ]);
    expect(individual).toContain('class="stmt-campaign-block"');
    expect(business).toContain('class="stmt-campaign-block"');
  });
});

// 소스 그렙 계약: 라이브 인쇄 경로가 정본 래퍼를 쓰는지 고정한다. 그렙은 렌더 도달을 못 보므로
// (PR #178·#194 교훈) 각 경로의 라이브 여부는 별도 가드로 잡는다 — 여기선 "옛 인라인 @page 를 다시
// 쓰지 않는다"만 고정한다. 두 경로가 갈라지면 머리말/꼬리말이 한쪽에서 되살아난다.
describe("인쇄 경로 계약 — 라이브 표면은 정본 래퍼만 쓴다", () => {
  const crm = join(process.cwd(), "src/components/crm");
  // 주석 속 `@page` 언급에 오탐하지 않도록 주석을 벗겨낸다(#191 이 hue 이름에 겪은 함정과 같은 계열).
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const sidePanel = stripComments(readFileSync(join(crm, "campaign-side-panel.tsx"), "utf8"));
  // 2026-08-24: 인쇄 경로는 정산 표가 아니라 선택 액션 바가 소유한다(표면 이동, 계약 동일).
  const table = stripComments(readFileSync(join(crm, "settlement-selection-bar.tsx"), "utf8"));

  it("사이드패널 PDF 경로가 정본 래퍼를 쓴다", () => {
    expect(sidePanel).toContain("buildSettlementStatementPrintDoc([campaign])");
  });

  it("정산표 PDF 경로가 정본 래퍼를 쓴다", () => {
    expect(table).toContain("buildSettlementStatementPrintDoc(selectedCampaigns)");
  });

  it("두 라이브 파일의 실제 코드에 인라인 @page 가 남아있지 않다", () => {
    // 옛 방식(각 파일이 자체 <head><style>@page 를 감싸던 것)의 재유입 차단. 주석은 위에서 제거됨.
    expect(sidePanel).not.toMatch(/@page/);
    expect(table).not.toMatch(/@page/);
  });
});
