/**
 * 명세서의 **표시 순서**와 **파일명** 계약 (T-023).
 *
 * 오너 신고 3종이 전부 "같은 문서인데 표면·회차마다 다르게 나온다"였다:
 *   ① 묶음 명세서가 정렬 없이 호출부 배열 순서로 나온다
 *   ② 캠페인 상세에서 이미지를 저장하면 파일 이름이 목록과 다르다
 *   ③ 목록/상세가 다른 모듈로 구현된 것 아닌가
 *
 * ③은 이미 한 함수(`renderSettlementStatementPng`)를 공유하고 있었고, 갈라져 있던 것은
 * ①의 순서와 ②의 파일명이었다. 그 둘을 여기서 고정한다.
 */
import { describe, expect, it } from "vitest";

import type { CampaignRow } from "@/lib/crm-types";
import {
  buildSettlementStatementFileName,
  buildSettlementStatementHtml,
  getStatementDeals,
  sortStatementCampaigns,
} from "@/lib/settlement-statement";

function createCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "campaign-001",
    dealId: "deal-001",
    sellerId: "seller-001",
    campaignName: "캠페인",
    dealName: "캠페인",
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
    actualSales: 1_000_000,
    sellerExpense: null,
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
    ...overrides,
  } as CampaignRow;
}

const deal = (id: string, dealName: string) => ({
  id,
  campaignId: "campaign-001",
  dealId: `deal-${id}`,
  dealName,
  quantity: 1,
  actualSales: 100_000,
  feeRate: 10,
  sellerMarginRate: 10,
  costPrice: 1_000,
  sellingPrice: 2_000,
});

describe("sortStatementCampaigns", () => {
  it("orders campaigns by 진행 기간 ascending regardless of caller order", () => {
    const autumn = createCampaign({ id: "c-a", startDate: "2026-07-01", endDate: "2026-07-07" });
    const summer = createCampaign({ id: "c-b", startDate: "2026-06-01", endDate: "2026-06-07" });
    const spring = createCampaign({ id: "c-c", startDate: "2026-05-01", endDate: "2026-05-07" });

    const sorted = sortStatementCampaigns([autumn, summer, spring]);

    expect(sorted.map((c) => c.id)).toEqual(["c-c", "c-b", "c-a"]);
  });

  it("does not mutate the caller's array", () => {
    const input = [
      createCampaign({ id: "c-late", startDate: "2026-07-01" }),
      createCampaign({ id: "c-early", startDate: "2026-05-01" }),
    ];

    sortStatementCampaigns(input);

    expect(input.map((c) => c.id)).toEqual(["c-late", "c-early"]);
  });

  it("puts campaigns without a start date last, not first", () => {
    // 빈 문자열을 그대로 비교하면 미입력이 맨 앞으로 올라와 "가장 먼저 진행한 건"으로 읽힌다.
    const undated = createCampaign({ id: "c-undated", startDate: "", endDate: "" });
    const dated = createCampaign({ id: "c-dated", startDate: "2026-05-01" });

    expect(sortStatementCampaigns([undated, dated]).map((c) => c.id)).toEqual([
      "c-dated",
      "c-undated",
    ]);
  });

  it("breaks ties deterministically so the same set always renders the same way", () => {
    const first = createCampaign({ id: "c-2", dealName: "같은 이름", roundNumber: 2 });
    const second = createCampaign({ id: "c-1", dealName: "같은 이름", roundNumber: 1 });

    expect(sortStatementCampaigns([first, second]).map((c) => c.id)).toEqual(["c-1", "c-2"]);
    expect(sortStatementCampaigns([second, first]).map((c) => c.id)).toEqual(["c-1", "c-2"]);
  });
});

describe("getStatementDeals ordering", () => {
  it("sorts 품목 by name so a DB reorder cannot reshuffle the statement", () => {
    // Prisma 의 campaignDeals include 에는 orderBy 가 없다 — 순서는 정의되지 않았다.
    const campaign = createCampaign({
      campaignDeals: [deal("cd-3", "다 옵션"), deal("cd-1", "가 옵션"), deal("cd-2", "나 옵션")],
    });

    expect(getStatementDeals(campaign).map((d) => d.dealName)).toEqual([
      "가 옵션",
      "나 옵션",
      "다 옵션",
    ]);
  });
});

describe("buildSettlementStatementHtml ordering", () => {
  it("renders campaign blocks chronologically whatever order the surface passes", () => {
    const campaigns = [
      createCampaign({ id: "c-a", dealName: "가을 캠페인", startDate: "2026-07-01", endDate: "2026-07-07" }),
      createCampaign({ id: "c-b", dealName: "여름 캠페인", startDate: "2026-06-01", endDate: "2026-06-07" }),
      createCampaign({ id: "c-c", dealName: "봄 캠페인", startDate: "2026-05-01", endDate: "2026-05-07" }),
    ];

    const html = buildSettlementStatementHtml(campaigns, new Date("2026-08-08"));

    expect(html.indexOf("봄 캠페인")).toBeLessThan(html.indexOf("여름 캠페인"));
    expect(html.indexOf("여름 캠페인")).toBeLessThan(html.indexOf("가을 캠페인"));
  });

  it("gives the same 문서번호 for the same selection in any order", () => {
    const early = createCampaign({ id: "aaa-1", startDate: "2026-05-01" });
    const late = createCampaign({ id: "bbb-2", startDate: "2026-06-01" });
    const now = new Date("2026-08-08");

    const forward = buildSettlementStatementHtml([early, late], now);
    const reversed = buildSettlementStatementHtml([late, early], now);

    const docNumber = (html: string) => /문서번호: (WAG-[^<]+)/.exec(html)?.[1];
    expect(docNumber(forward)).toBe(docNumber(reversed));
  });
});

describe("buildSettlementStatementFileName", () => {
  it("names the file after the recipient and issue date on every surface", () => {
    const name = buildSettlementStatementFileName([createCampaign()], new Date("2026-08-08"));

    expect(name).toBe("정산명세서_셀러 A_2026-08-08.png");
  });

  it("strips filesystem-hostile characters from the recipient label", () => {
    const name = buildSettlementStatementFileName(
      [createCampaign({ sellerName: 'A/B:C*D?"<>|' })],
      new Date("2026-08-08"),
    );

    expect(name).toBe("정산명세서_ABCD_2026-08-08.png");
  });

  it("refuses to name a statement whose recipient is ambiguous", () => {
    const mine = createCampaign({ id: "c-1", sellerId: "s-1", sellerCompanyName: null, sellerCompanyBusinessNumber: null });
    const other = createCampaign({ id: "c-2", sellerId: "s-2", sellerCompanyName: null, sellerCompanyBusinessNumber: null });

    expect(() => buildSettlementStatementFileName([mine, other])).toThrow();
  });
});
