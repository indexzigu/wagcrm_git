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
  reviewAcks: [] as Array<{ fingerprint: string; acknowledgedBy: string | null; acknowledgedAt: string | null }>,
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
        autoLookup
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
    expect(cell).toHaveTextContent("9월9/30 · 오류 가능성1,940,000원");
    // 발행금액 열 = 그 달 기록한 계산서 합계(오너 지시 2026-10-21)
    expect(screen.getByTestId("invoice-month-amount-2026-09")).toHaveTextContent(/^1,940,000원$/);
    const slot = screen.getByTestId("campaign-invoice-slot");
    expect(slot).toHaveTextContent("1/1");
    const review = screen.getByTestId("campaign-invoice-review");
    expect(review).toHaveTextContent("확인 필요");
    expect(review).toHaveAttribute("title", expect.stringContaining("정산 오류 가능성 · 원인 확인 필요"));
    // 풀이 창(마우스 올림) — 어긋남 풀이 + 수동 입력 안내 + 기록 세부
    fireEvent.pointerDown(cell, { pointerType: "touch" });
    expect(await screen.findByText(/정산 오류 가능성 · 원인 확인 필요/)).toBeInTheDocument();
    expect(screen.getByText("기대액이 수동 입력값에서 계산됨 · CRM 금액 재확인")).toBeInTheDocument();
    // 줄의 발행금액 열 + 풀이 창의 합계 — 두 곳에 같은 금액
    expect(screen.getAllByText("1,940,000원")).toHaveLength(2);
  });
});

// 「확인함」(오너 승인 2026-10-15) — 확인은 그 차이의 지문에만 묶인다. 지문 = 이유 코드 · 기록 합계 · 전액.
const FINGERPRINT = "v1|MINOR_MISMATCH|1940000|2000000";
const ACK = { fingerprint: FINGERPRINT, acknowledgedBy: "owner-1", acknowledgedAt: "2026-10-15T03:00:00.000Z" };

function mockFetch(view: unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    const body = url.includes("/brand-statements") ? { statements: [] } : view;
    return { ok: true, json: async () => body } as Response;
  }) as never;
  return calls;
}

function renderSlot(scan: ReceiptScanApiResponse = { scan: { sinceDays: 90 }, results: [] } as unknown as ReceiptScanApiResponse) {
  return render(
    <CampaignInvoiceSlot
      autoLookup
      campaignId="c1"
      title="공급사 계산서 발행"
      scan={scan}
      scanLoading={false}
      onRequestScan={() => {}}
      onChanged={() => {}}
      legacyFallback={null}
      attachment={null}
    />,
  );
}

describe("「확인함」 — 금액 차이 확인", () => {
  it("창 맨 위에 차이와 「확인함」을 보이고, 누르면 화면이 본 지문을 보낸다", async () => {
    const calls = mockFetch(MISMATCH_VIEW);
    renderDialog();
    const block = within(await screen.findByTestId("invoice-review-block"));
    expect(block.getByText("확인 필요")).toBeInTheDocument();
    expect(block.getByText("정산 오류 가능성 · 원인 확인 필요")).toBeInTheDocument();
    expect(block.getByText("1,940,000원")).toBeInTheDocument();
    expect(block.getByText("2,000,000원")).toBeInTheDocument();
    expect(block.getByText("-60,000원")).toBeInTheDocument();
    fireEvent.click(block.getByRole("button", { name: "확인함" }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ url: "/api/campaigns/c1/invoices", body: { action: "acknowledgeReview", fingerprint: FINGERPRINT } });
  });

  it("확인한 차이는 칸이 조용하다 — 「확인 필요」·어긋남 낱말 없이 작성일과 「확인됨」(누가·언제는 풀이 창)", async () => {
    mockFetch({ ...MISMATCH_VIEW, reviewAcks: [ACK] });
    renderSlot();
    const cell = await screen.findByTestId("invoice-month-2026-09");
    expect(cell).toHaveTextContent("9월9/30");
    expect(cell).not.toHaveTextContent("오류 가능성");
    expect(screen.queryByTestId("campaign-invoice-review")).toBeNull();
    const marker = screen.getByTestId("campaign-invoice-review-ack");
    expect(marker).toHaveTextContent("확인됨");
    fireEvent.pointerDown(marker, { pointerType: "touch" });
    expect(await screen.findByText("owner-1")).toBeInTheDocument();
    expect(screen.getByText("2026-10-15")).toBeInTheDocument();
  });

  it("확인한 창에서는 「확인됨 · 누가 · 언제」와 「확인 취소」 — 누르면 확인을 걷어낸다", async () => {
    const calls = mockFetch({ ...MISMATCH_VIEW, reviewAcks: [ACK] });
    renderDialog();
    const block = within(await screen.findByTestId("invoice-review-block"));
    expect(block.getByText("확인됨 · owner-1 · 2026-10-15")).toBeInTheDocument();
    expect(block.queryByRole("button", { name: "확인함" })).toBeNull();
    fireEvent.click(block.getByRole("button", { name: "확인 취소" }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ action: "revokeReviewAck" });
  });

  it("확인한 뒤 금액이 바뀌었으면(지문이 다름) 다시 「확인 필요」이고 그 이유를 한 줄로 알린다", async () => {
    mockFetch({ ...MISMATCH_VIEW, reviewAcks: [{ ...ACK, fingerprint: "v1|MINOR_MISMATCH|1930000|2000000" }] });
    renderSlot();
    expect(await screen.findByTestId("campaign-invoice-review")).toHaveTextContent("확인 필요");
    expect(screen.queryByTestId("campaign-invoice-review-ack")).toBeNull();
    renderDialog();
    const block = within(await screen.findByTestId("invoice-review-block"));
    expect(block.getByText("확인한 뒤 금액이 바뀌어 다시 확인이 필요합니다.")).toBeInTheDocument();
    expect(block.getByRole("button", { name: "확인함" })).toBeInTheDocument();
  });

  it("차이가 없으면 블록을 그리지 않는다", async () => {
    mockFetch(VIEW);
    renderDialog();
    await september();
    expect(screen.queryByTestId("invoice-review-block")).toBeNull();
  });
});

describe("CampaignInvoiceSlot — 수정세금계산서가 따라온 달이 금액도 어긋날 때 (리뷰 2026-10-15 #5)", () => {
  it("작성일과 어긋남 낱말을 함께 보이고 풀이에 「수정됨」 안내를 덧붙인다", async () => {
    mockFetch(MISMATCH_VIEW);
    const amendment = { ...invoice("B-1", -10_000), typeCode: "0201", writtenDate: "2026-09-30" };
    renderSlot({ scan: { sinceDays: 90 }, results: [{ invoice: amendment }] } as unknown as ReceiptScanApiResponse);
    const cell = await screen.findByTestId("invoice-month-2026-09");
    await vi.waitFor(() => expect(cell).toHaveTextContent("9월9/30 · 오류 가능성"));
    fireEvent.pointerDown(cell, { pointerType: "touch" });
    expect(await screen.findByText(/수정세금계산서가 따라왔습니다/)).toBeInTheDocument();
    expect(screen.getByText(/정산 오류 가능성 · 원인 확인 필요/)).toBeInTheDocument();
  });
});

// 자동 조회 대상(오너 확정 2026-10-21) — 정산 단계 · 판매 종료 +10일 ~ +60일만 열 때 메일함을 본다.
describe("CampaignInvoiceSlot — 열 때 자동 조회는 대상 캠페인에서만", () => {
  function renderUnscanned(autoLookup: boolean, onRequestScan: (mode: "auto" | "manual") => void) {
    return render(
      <CampaignInvoiceSlot
        autoLookup={autoLookup}
        campaignId="c1"
        title="공급사 계산서 발행"
        scan={null}
        scanLoading={false}
        onRequestScan={onRequestScan}
        onChanged={() => {}}
        legacyFallback={null}
        attachment={null}
      />,
    );
  }

  it("대상이면 빈 달이 있을 때 메일함 조회를 한 번 시작한다", async () => {
    const onRequestScan = vi.fn();
    renderUnscanned(true, onRequestScan);
    await screen.findByTestId("invoice-month-2026-09");
    expect(onRequestScan).toHaveBeenCalledTimes(1);
    // 열 때 도는 조회는 자동 조회 기간을 쓴다(월정산은 판매 시작일부터 — 기간 계산은 부모의 `invoiceLookupSinceDays`).
    expect(onRequestScan).toHaveBeenCalledWith("auto");
  });

  it("대상이 아니면 조회를 시작하지 않고, 안 본 달을 「미발견」으로 단정하지 않으며 풀이로 이유를 알린다", async () => {
    const onRequestScan = vi.fn();
    renderUnscanned(false, onRequestScan);
    const cell = await screen.findByTestId("invoice-month-2026-09");
    expect(onRequestScan).not.toHaveBeenCalled();
    expect(cell).not.toHaveTextContent("미발견");
    expect(screen.getByRole("button", { name: "조회" })).toBeEnabled();
    fireEvent.pointerDown(cell, { pointerType: "touch" });
    // 이 칸은 월정산 거래처 캠페인에만 그려진다 — 월정산 규칙(판매 시작일부터)을 말한다(오너 확정 2026-10-27, T-270).
    expect(await screen.findByText(/판매중부터 정산중까지인 캠페인은 판매를 시작한 날부터 판매 종료 60일 뒤까지 자동으로 메일함을 확인합니다/)).toBeInTheDocument();
    expect(screen.queryByText(/판매 종료 10일 뒤부터/)).not.toBeInTheDocument();
  });

  it("대상이 아니면 정산서 메일도 미리 읽지 않고, 「조회」를 누를 때 함께 읽는다", async () => {
    const onRequestScan = vi.fn();
    renderUnscanned(false, onRequestScan);
    await screen.findByTestId("invoice-month-2026-09");
    const statementCalls = () =>
      vi.mocked(global.fetch).mock.calls.filter(([input]) => String(input).includes("/brand-statements")).length;
    expect(statementCalls()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "조회" }));
    expect(onRequestScan).toHaveBeenCalledTimes(1);
    // 버튼은 수동 조회 기간(종료 +1일부터)을 쓴다.
    expect(onRequestScan).toHaveBeenCalledWith("manual");
    expect(statementCalls()).toBe(1);
  });
});

// 발행금액 열(오너 지시 2026-10-21) — 그 달 기록한 계산서 합계. 9월 두 장 · 10월 없음.
const recordedRow = (id: string, totalAmount: number | null) => ({
  ...MISMATCH_VIEW.rows[0],
  id,
  approvalNo: `X-${id}`,
  totalAmount,
});
const TWO_MONTH_VIEW = {
  ...MISMATCH_VIEW,
  periodStart: "2026-09-09T15:00:00.000Z",
  periodEnd: "2026-10-20T14:59:59.000Z",
  expectedTotalAmount: null,
  expectedFromManual: false,
  rows: [recordedRow("a", 1_000_000), recordedRow("b", 940_000)],
};

describe("CampaignInvoiceSlot — 달별 발행금액 열", () => {
  it("한 달에 여러 장이면 합계를, 기록이 없는 달은 「—」를 보인다", async () => {
    mockFetch(TWO_MONTH_VIEW);
    renderSlot();
    expect(await screen.findByTestId("invoice-month-amount-2026-09")).toHaveTextContent(/^1,940,000원$/);
    expect(screen.getByTestId("invoice-month-amount-2026-10")).toHaveTextContent(/^—$/);
    expect(screen.getByTestId("campaign-invoice-slot")).toHaveTextContent("발행금액");
  });

  it("금액을 모르는 장이 섞인 달은 합계를 추정하지 않고 「—」", async () => {
    mockFetch({ ...TWO_MONTH_VIEW, rows: [recordedRow("a", 1_000_000), recordedRow("b", null)] });
    renderSlot();
    expect(await screen.findByTestId("invoice-month-amount-2026-09")).toHaveTextContent(/^—$/);
  });
});
