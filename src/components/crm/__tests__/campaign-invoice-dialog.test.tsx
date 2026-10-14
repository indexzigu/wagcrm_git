// @vitest-environment jsdom
// 월정산 달별 계산서 창(T-242·T-244) — 정산서 금액으로 후보를 가르고 직접 입력을 미리 채우는 계약.
// 이름·금액은 가공이다(P0).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { CampaignInvoiceDialog, CampaignInvoiceSlot } from "../campaign-invoice-slot";
import { SUPPLIER } from "@/lib/tax-invoice-builder";
import type { ReceiptScanApiResponse } from "@/lib/tax-invoice-mail/board-evidence";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const BRAND = "2222222222";

const VIEW = {
  applicable: true,
  direction: "ISSUE",
  counterpartBusinessNumber: BRAND,
  counterpartLabel: "브랜드A",
  // 9/28~10/4 KST
  periodStart: "2026-09-27T15:00:00.000Z",
  periodEnd: "2026-10-04T14:59:59.000Z",
  memberCount: 1,
  sellerLabels: ["가나다"],
  legacyDate: null,
  legacyMode: false,
  expectedTotalAmount: null,
  expectedFromManual: false,
  rows: [],
  excludedIssueIds: [],
};

const STATEMENTS = {
  statements: [
    {
      promotionLabel: "26년 9월 가나다 공구",
      counterpartyLabel: "브랜드A",
      subject: "[브랜드A] 26년 9월 가나다님 - 마감정산서",
      receivedAt: "2026-10-02T02:00:00.000Z",
      invoices: [{ direction: "ISSUE", writtenDate: "2026-09-30", yearMonth: "2026-09", totalAmount: 74_250, dueDate: "2026-10-20" }],
    },
  ],
};

function invoice(issueId: string, totalAmount: number) {
  return {
    issueId,
    typeCode: "0101",
    writtenDate: "2026-09-30",
    invoicerBusinessNumber: SUPPLIER.businessNumber,
    invoiceeBusinessNumber: BRAND,
    supplyAmount: null,
    taxAmount: null,
    totalAmount,
    itemName: "판매수수료",
    receivedAt: "2026-10-06T02:00:00.000Z",
  };
}

const SCAN = {
  scan: { sinceDays: 90 },
  // 같은 달 같은 브랜드 계산서 두 장 — 앞에 오는 것이 정산서와 **다른** 장이다.
  results: [{ invoice: invoice("X-1", 50_000) }, { invoice: invoice("X-2", 74_250) }],
} as unknown as ReceiptScanApiResponse;

beforeEach(() => {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/brand-statements") ? STATEMENTS : VIEW;
    return { ok: true, json: async () => body } as Response;
  }) as never;
});

function renderDialog() {
  return render(
    <CampaignInvoiceDialog
      campaignId="c1"
      title="공급사 계산서 발행"
      onOpenChange={() => {}}
      scan={SCAN}
      scanLoading={false}
      onRequestScan={() => {}}
      onChanged={() => {}}
    />,
  );
}

async function september() {
  return within(await screen.findByRole("region", { name: "9월분" }));
}

describe("CampaignInvoiceDialog — 정산서 금액 (T-242)", () => {
  it("달마다 정산서 금액·지급일을 보이고, 맞는 후보를 위로 올리며, 다른 후보에는 차이를 적는다", async () => {
    renderDialog();
    const sep = await september();
    expect(await sep.findByText("정산서 금액 74,250원 · 지급일 10/20")).toBeInTheDocument();
    // 합계 칸은 금액 뒤에 정산서 대조 문구가 붙는다 — 앞 금액으로 순서를 본다.
    const totals = sep.getAllByText(/^(74,250|50,000)원/).map((node) => node.textContent?.slice(0, 7));
    expect(totals).toEqual(["74,250원", "50,000원"]);
    expect(sep.getByText("정산서 금액과 같음")).toBeInTheDocument();
    expect(sep.getByText("정산서보다 24,250원 적음")).toBeInTheDocument();
  });

  it("직접 입력을 정산서 작성일·금액으로 미리 채우고 「정산서 값」임을 알린다", async () => {
    renderDialog();
    const sep = await september();
    await sep.findByText(/정산서 금액 74,250원/);
    fireEvent.click(sep.getByRole("button", { name: "직접 입력" }));
    expect(sep.getByLabelText("작성일")).toHaveValue("2026-09-30");
    expect(sep.getByLabelText("합계(원)")).toHaveValue("74250");
    expect(sep.getByText("정산서 값입니다. 실제 계산서와 다르면 고쳐 주세요.")).toBeInTheDocument();
  });

  it("아직 오지 않은 작성일로는 기록할 수 없다", async () => {
    renderDialog();
    const sep = await september();
    await sep.findByText(/정산서 금액 74,250원/);
    fireEvent.click(sep.getByRole("button", { name: "직접 입력" }));
    fireEvent.change(sep.getByLabelText("작성일"), { target: { value: "2099-12-31" } });
    expect(sep.getByText("작성일이 아직 오지 않았습니다.")).toBeInTheDocument();
    expect(sep.getByRole("button", { name: "기록" })).toBeDisabled();
  });
});

// 기록은 됐는데 합계가 전액과 어긋난 한 달짜리 캠페인(실렌더 지적 R0, 2026-10-14) — 9/10~9/16, 전액 200만, 기록 194만.
const MISMATCH_VIEW = {
  ...VIEW,
  periodStart: "2026-09-09T15:00:00.000Z",
  periodEnd: "2026-09-20T14:59:59.000Z",
  expectedTotalAmount: 2_000_000,
  expectedFromManual: true,
  rows: [
    {
      id: "r1",
      campaignId: "c1",
      direction: "ISSUE",
      yearMonth: "2026-09",
      status: "RECORDED",
      writtenAt: "2026-09-30",
      approvalNo: "X-9",
      supplyAmount: null,
      taxAmount: null,
      totalAmount: 1_940_000,
      itemName: null,
      source: "MAIL",
      mailReceivedAt: null,
      note: null,
    },
  ],
};

describe("CampaignInvoiceSlot — 기록한 합계가 전액과 어긋난 달 (R0)", () => {
  it("칸은 작성일을 두고 「오류 가능성」을 덧붙이며, 머리글 1/1 옆에 「확인 필요」를 보이고 풀이에 수동 입력 안내가 붙는다", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/brand-statements") ? { statements: [] } : MISMATCH_VIEW;
      return { ok: true, json: async () => body } as Response;
    }) as never;
    render(
      <CampaignInvoiceSlot
        campaignId="c1"
        title="공급사 계산서 발행"
        scan={{ scan: { sinceDays: 90 }, results: [] } as unknown as ReceiptScanApiResponse}
        scanLoading={false}
        onRequestScan={() => {}}
        onChanged={() => {}}
        legacyFallback={null}
        attachment={null}
      />,
    );
    const cell = await screen.findByTestId("invoice-month-2026-09");
    expect(cell).toHaveTextContent("9월9/30 · 오류 가능성");
    const slot = screen.getByTestId("campaign-invoice-slot");
    expect(slot).toHaveTextContent("1/1");
    const review = screen.getByTestId("campaign-invoice-review");
    expect(review).toHaveTextContent("확인 필요");
    expect(review).toHaveAttribute("title", expect.stringContaining("정산 오류 가능성 · 원인 확인 필요"));
    // 풀이 창(마우스 올림) — 어긋남 풀이 + 수동 입력 안내 + 기록 세부
    fireEvent.pointerDown(cell, { pointerType: "touch" });
    expect(await screen.findByText(/정산 오류 가능성 · 원인 확인 필요/)).toBeInTheDocument();
    expect(screen.getByText("기대액이 수동 입력값에서 계산됨 · CRM 금액 재확인")).toBeInTheDocument();
    expect(screen.getByText("1,940,000원")).toBeInTheDocument();
  });
});
