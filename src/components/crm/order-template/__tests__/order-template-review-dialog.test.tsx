import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrderTemplateReviewDialog } from "../order-template-review-dialog";
import type { OrderExcelRules } from "@/lib/order-converter/excel-rules";

// F4 Phase 2 §4단계 검수 다이얼로그의 핵심 계약: 활성 규칙을 LLM 재호출 없이 로드하고,
// 미리보기를 서버와 동일한 순수 함수로 dry-run하며, '매핑 확정'에서만 규칙을 서버로 보낸다.

const mockToast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
  },
}));

const activeRules: OrderExcelRules = {
  version: 1,
  sourceAssetId: null,
  templateStoragePath: null,
  analyzedAt: "2026-07-01T00:00:00.000Z",
  headerSnapshot: ["수취인", "브랜드"],
  write: { mode: "fill-template", sheetName: "발주", headerRow: 1, dataStartRow: 2 },
  columns: [
    { col: 1, header: "수취인", source: { type: "field", field: "수취인명" } },
    { col: 2, header: "브랜드", source: { type: "const", value: "와이그라운드" } },
  ],
  reply: { orderIdHeaders: ["상품주문번호"], orderIdPattern: "naver-strict" },
};

function renderDialog(overrides: Partial<Parameters<typeof OrderTemplateReviewDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    partnerId: "p1",
    partnerName: "트리프",
    activeRules,
    onRulesSaved: vi.fn(),
    ...overrides,
  };
  render(<OrderTemplateReviewDialog {...props} />);
  return props;
}

describe("OrderTemplateReviewDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("활성 규칙을 로드해(분석 fetch 없이) 열을 렌더하고 확정 버튼이 활성이다", () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    renderDialog();

    expect(screen.getByText("발주서 열 매핑 검수")).toBeInTheDocument();
    expect(screen.getAllByText("수취인").length).toBeGreaterThan(0);
    expect(screen.getAllByText("브랜드").length).toBeGreaterThan(0);
    // 활성 규칙 경로는 LLM 분석을 호출하지 않는다.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "매핑 확정" })).toBeEnabled();
  });

  it("미리보기가 선물 주문(구매자≠수취인)의 수취인명을 실제 매핑으로 계산한다", () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    renderDialog();
    // col1 = 수취인명 매핑 → gift 샘플의 수취인명 '박받아'가 dry-run 결과에 나타난다.
    expect(screen.getAllByText("박받아").length).toBeGreaterThan(0);
  });

  it("확정 흐름: 매핑 확정→확정 시 규칙을 POST하고 onRulesSaved를 호출한다", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ orderExcelRules: { ...activeRules } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const { onRulesSaved, onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "매핑 확정" }));

    const alert = await screen.findByRole("alertdialog");
    fireEvent.click(within(alert).getByRole("button", { name: "확정" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/partners/p1/order-rules",
        expect.objectContaining({ method: "POST" }),
      );
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.rules.columns).toHaveLength(2);
    expect(body.rules.columns[0].source).toEqual({ type: "field", field: "수취인명" });

    await waitFor(() => expect(onRulesSaved).toHaveBeenCalled());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
