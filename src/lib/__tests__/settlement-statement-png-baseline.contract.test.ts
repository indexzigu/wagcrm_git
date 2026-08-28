/**
 * 셀러가 받는 PNG 의 **글자 세로 위치 계약** (오너 신고 2026-08-19 「표마다 하단 정렬」).
 *
 * ## 무엇을 막는가
 *
 * `html2canvas` 는 `fillText(…, bounds.top + baseline)` 로 글자를 그리고, 그 `baseline` 을
 * **인라인 `<img>` 의 `offsetTop`** 으로 실시간 측정한다. Tailwind preflight 의
 * `img { display: block }` 이 그 img 를 자기 줄로 내려보내면 측정값이 ascent 가 아니라
 * 줄 높이가 되고, **문서 전체 글자가 아래로 밀린다.** 실측(앱 런타임, 2배 좌표):
 * 기준 행 `위 29 / 아래 5`(편차 +12) → 복구 후 `위 17 / 아래 17`(편차 0). 오너가 받은
 * 원본 PNG 의 같은 행이 `위 29 / 아래 5` 로 일치했다.
 *
 * ## 왜 이 테스트가 필요한가 — 격리 검증으로는 못 잡는다
 *
 * 이 결함은 **preflight 가 있는 앱 런타임에서만** 난다. 스크래치 하네스로는 조건 6가지를
 * 맞춰도 재현되지 않았다(≤3px). 그래서 "브라우저에서 열어 보니 멀쩡하더라" 는 근거가 되지
 * 못하고, 최소한 **복구 장치가 붙어 있다는 사실**을 기계가 지켜야 한다.
 *
 * ⚠️ 이 테스트는 "글자가 가운데인가" 를 재지 못한다(jsdom 에 레이아웃이 없다). 재는 것은
 * ①복구 스타일이 굽는 동안 붙어 있는가 ②끝나면 제거되는가 ③셀렉터가 html2canvas 의 실제
 * 프로브 마크업을 여전히 겨냥하는가 다. 실제 위치 판정은 실렌더 계측의 몫이다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CampaignRow } from "@/lib/crm-types";

function createCampaign(): CampaignRow {
  return {
    id: "campaign-001",
    dealId: "deal-001",
    sellerId: "seller-001",
    campaignName: "샘플딜",
    dealName: "샘플딜",
    partnerName: "브랜드",
    sellerName: "샘플셀러",
    sellerCompanyName: "샘플 주식회사",
    sellerCompanyBusinessNumber: "0000000000",
    snsType: "INSTAGRAM",
    snsHandle: "sample",
    startDate: "2026-07-06",
    endDate: "2026-07-20",
    salesChannel: "BRAND_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 1_000_000,
    sellerExpense: null,
    totalMarginRate: 20,
    sellerMarginRate: 15,
    netMarginRate: 5,
    status: "SETTLEMENT_IN_PROGRESS",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-07-21T00:00:00.000Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    campaignDeals: [
      {
        id: "cd-1",
        campaignId: "campaign-001",
        dealId: "deal-001",
        dealName: "옵션 A",
        quantity: 12,
        actualSales: 600_000,
        feeRate: 15,
        costPrice: 10_000,
        sellingPrice: 50_000,
      },
    ],
  } as unknown as CampaignRow;
}

/** 굽는 순간의 `<head>` 상태를 훔쳐본다 — 복구가 "굽는 동안" 살아 있어야 의미가 있다. */
let headDuringRender = "";

vi.mock("html2canvas", () => ({
  default: () => {
    headDuringRender = document.head.innerHTML;
    return Promise.resolve({ toDataURL: () => "data:image/png;base64,STUB" });
  },
}));

afterEach(() => {
  headDuringRender = "";
});

describe("PNG 기준선 프로브 복구", () => {
  it("굽는 동안 복구 스타일이 문서에 붙어 있다", async () => {
    const { renderSettlementStatementPng } = await import("@/lib/settlement-statement");
    await renderSettlementStatementPng([createCampaign()]);

    expect(
      headDuringRender,
      "복구 스타일이 없다 — PNG 글자가 통째로 아래로 밀린다(오너 신고 2026-08-19)",
    ).toContain("data-html2canvas-probe-fix");
    expect(headDuringRender).toContain("display: inline !important");
  });

  it("끝나면 제거한다 (앱 전역에 잔류시키지 않는다)", async () => {
    const { renderSettlementStatementPng } = await import("@/lib/settlement-statement");
    await renderSettlementStatementPng([createCampaign()]);

    expect(
      document.querySelectorAll("[data-html2canvas-probe-fix]").length,
      "복구 스타일이 남았다 — 앱의 다른 이미지 레이아웃을 흔든다",
    ).toBe(0);
  });

  it("실패해도 제거한다", async () => {
    const { renderSettlementStatementPng } = await import("@/lib/settlement-statement");
    await expect(renderSettlementStatementPng([])).rejects.toThrow();

    expect(document.querySelectorAll("[data-html2canvas-probe-fix]").length).toBe(0);
  });

  it("셀렉터가 html2canvas 의 실제 프로브 마크업을 겨냥한다", async () => {
    // 🪤 이 계약의 급소 — html2canvas 를 올려 프로브 구현이 바뀌면 셀렉터가 조용히 빗나가고
    //    복구는 **무동작**이 된다(테스트는 여전히 초록). 그래서 설치본 소스를 직접 읽는다.
    const { readFileSync } = await import("node:fs");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const src = readFileSync(require.resolve("html2canvas/dist/html2canvas.js"), "utf8");

    const probe = /parseMetrics[\s\S]{0,2000}?return \{ baseline/.exec(src)?.[0] ?? "";
    expect(probe, "parseMetrics 를 찾지 못했다 — html2canvas 구조가 바뀌었다").not.toBe("");

    for (const anchor of ["visibility = 'hidden'", "whiteSpace = 'nowrap'", "verticalAlign = 'baseline'"]) {
      expect(
        probe,
        `프로브 마크업이 바뀌었다(${anchor} 없음) — 복구 셀렉터가 빗나가 무동작이 된다. ` +
          "실렌더 계측으로 다시 판정하고 셀렉터를 맞춰라.",
      ).toContain(anchor);
    }
  });
});
