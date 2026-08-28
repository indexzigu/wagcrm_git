// POST /api/settlement/tax-invoice — 정산 그룹 부분 선택 회귀 (whole-branch 리뷰
// 실사고, 2026-08-04).
//
// ⛔ `buildTaxInvoiceObligationRows`는 "받은 캠페인 안에서" 그룹을 재구성한다.
// route.ts가 `campaignIds`로 요청받은 캠페인만 조회해 그대로 넘기면, 3인 그룹 중
// 1건만 요청받았을 때 그 1건이 "멤버가 1명뿐인 그룹"으로 다뤄져 조용히 정상
// 행(금액은 그 1건 몫만, selectable:true, 경고 없음)이 나온다 — 생성된 XLSX가
// 3분의 1 금액의 정상 세금계산서와 구분되지 않는다(과소 신고). route.ts는 요청받은
// 캠페인이 속한 그룹의 **전원**을 다시 채워야 한다(그룹은 어차피 한 행으로
// 접히므로 멤버를 더 가져오는 것은 안전하다).
import { describe, it, expect, vi, beforeEach } from "vitest";

type FakeCampaign = Record<string, unknown> & { id: string; groupId: string | null };

function createCampaign(overrides: Partial<FakeCampaign> = {}): FakeCampaign {
  return {
    id: "m1",
    dealId: "deal-1",
    sellerId: "seller-1",
    groupId: null,
    campaignName: "캠페인",
    salesCode: null,
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    startDate: new Date("2026-07-01T00:00:00Z"),
    endDate: new Date("2026-07-10T00:00:00Z"),
    salesChannel: "SELLER_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 0,
    sellerExpense: 0,
    settlementSales: 0,
    totalMarginRate: 20,
    sellerMarginRate: 10,
    netMarginRate: 10,
    status: "SETTLEMENT_IN_PROGRESS",
    isManualMargin: false,
    payoutCompletedAt: new Date("2026-07-20T00:00:00Z"),
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    deal: {
      dealName: "딜",
      costPrice: 0,
      sellingPrice: 10_000,
      brandName: "브랜드",
      partner: { name: "공급사" },
    },
    seller: {
      name: "셀러",
      alias: null,
      snsType: "INSTAGRAM",
      snsHandle: "handle",
      agency: {
        name: "셀러법인",
        type: "BUSINESS",
        businessNumber: "1234567890",
        ceoName: "대표",
        address: "주소",
        businessType: "업태",
        businessItem: "종목",
        representativeEmail: "seller@example.com",
      },
    },
    campaignDeals: [],
    ...overrides,
  } as FakeCampaign;
}

// 3인 그룹 "g1" — 멤버별 원금이 서로 달라야 "부분 선택 시 금액이 준다"는 사고를
// 실측으로 구분할 수 있다. base = actualSales - sellerExpense.
// m1 base=4,000,000 · m2 base=2,400,000 · m3 base=1,600,000 → 합계 8,000,000
// → 공급가 round(8,000,000/1.1) = 7,272,727
const GROUP_MEMBERS: FakeCampaign[] = [
  createCampaign({ id: "m1", groupId: "g1", actualSales: 5_000_000, sellerExpense: 1_000_000 }),
  createCampaign({ id: "m2", groupId: "g1", actualSales: 3_000_000, sellerExpense: 600_000 }),
  createCampaign({ id: "m3", groupId: "g1", actualSales: 2_000_000, sellerExpense: 400_000 }),
];

let capturedRows: Array<{ totalSupplyAmount: number; lineItems: Array<{ name: string }> }> = [];

vi.mock("@/lib/api-auth", () => ({
  requireAuth: async () => ({ authenticated: true }),
}));

vi.mock("@/lib/tax-invoice-builder", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/tax-invoice-builder")>("@/lib/tax-invoice-builder");
  return {
    ...actual,
    // 실제 exceljs 파일 생성은 이 테스트의 관심사가 아니다 — buildTaxInvoiceRows가
    // 만든 TaxInvoiceRow[](금액·품목명)를 그대로 가로채 검증한다.
    buildTaxInvoiceXlsx: vi.fn(async (rows: typeof capturedRows) => {
      capturedRows = rows;
      return Buffer.from("stub");
    }),
  };
});

const findManyMock = vi.fn(async ({ where }: { where: { id?: { in: string[] }; groupId?: { in: string[] } } }) => {
  if (where.id) {
    return GROUP_MEMBERS.filter((c) => where.id!.in.includes(c.id));
  }
  if (where.groupId) {
    return GROUP_MEMBERS.filter((c) => where.groupId!.in.includes(c.groupId as string));
  }
  return [];
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ salesCampaign: { findMany: findManyMock } }),
}));

import { POST } from "../route";

function makeRequest(campaignIds: string[]): Request {
  return new Request("https://example.com/api/settlement/tax-invoice", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ campaignIds }),
  });
}

describe("POST /api/settlement/tax-invoice — 정산 그룹 부분 선택", () => {
  beforeEach(() => {
    capturedRows = [];
    findManyMock.mockClear();
  });

  it("3인 그룹 중 1건만 요청해도 그룹 전원의 합산 금액으로 세금계산서를 만든다(과소 신고 방지)", async () => {
    const res = await POST(makeRequest(["m2"]));
    expect(res.status).toBe(200);

    expect(capturedRows).toHaveLength(1);
    // round((4,000,000+2,400,000+1,600,000)/1.1) = round(8,000,000/1.1) = 7,272,727
    expect(capturedRows[0].totalSupplyAmount).toBe(7_272_727);
    // m2 단독이었다면 round(2,400,000/1.1) = 2,181,818 — 이 값이 나오면 회귀다.
    expect(capturedRows[0].totalSupplyAmount).not.toBe(2_181_818);

    // 그룹 전원을 다시 채우려면 groupId="g1" 로 재조회해야 한다.
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ groupId: { in: ["g1"] } }) }),
    );
  });

  it("그룹 전원을 이미 요청했을 때도 결과가 같다(재조회가 중복으로 부풀리지 않는다)", async () => {
    const res = await POST(makeRequest(["m1", "m2", "m3"]));
    expect(res.status).toBe(200);
    expect(capturedRows).toHaveLength(1);
    expect(capturedRows[0].totalSupplyAmount).toBe(7_272_727);
  });
});

// format: "json" — 홈택스 로컬 헬퍼(건별발급 폼 자동 입력)의 페이로드 경로.
// XLSX 와 완전히 같은 검증·행 구성(보드 ISSUE 행 → buildTaxInvoiceRows)을 타야
// 한다 — 헬퍼 전용 별도 계산 경로가 생기면 화면·파일·헬퍼 금액이 갈리는 이
// 도메인의 반복 사고가 재발한다. 이 테스트가 그 동일성(그룹 합산 금액이 XLSX
// 경로와 같은 값)을 고정한다.
describe("POST /api/settlement/tax-invoice — format: json (홈택스 로컬 헬퍼 페이로드)", () => {
  beforeEach(() => {
    capturedRows = [];
    findManyMock.mockClear();
  });

  function makeJsonRequest(campaignIds: string[]): Request {
    return new Request("https://example.com/api/settlement/tax-invoice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ campaignIds, format: "json" }),
    });
  }

  it("TaxInvoiceRow JSON 을 반환하고, 금액은 XLSX 경로와 같은 그룹 합산 값이다", async () => {
    const res = await POST(makeJsonRequest(["m2"]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as {
      rows: Array<{ totalSupplyAmount: number; totalTaxAmount: number; supplierBusinessNumber: string }>;
    };
    expect(body.rows).toHaveLength(1);
    // XLSX 테스트와 같은 기준값 — round(8,000,000/1.1) = 7,272,727 (그룹 전원 합산).
    expect(body.rows[0].totalSupplyAmount).toBe(7_272_727);
    expect(body.rows[0].supplierBusinessNumber).toBe("6866800667");

    // JSON 모드는 XLSX 를 만들지 않는다.
    expect(capturedRows).toHaveLength(0);
  });
});
