import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 체크 토글은 항목 한 줄만 바꾸지 않는다 — 캠페인 status 자동 전이, 계산서 발행일(그룹이면
 * 그룹 행), 그룹 형제 항목 동기화까지 쓴다(`setChecklistItemChecked`). 그런데 이 라우트만
 * 캐시 태그를 깨지 않아 홈·정산 표면이 TTL 까지 옛 단계·날짜를 보였다.
 */

const setCheckedMock = vi.fn();
const revalidateMock = vi.fn();
const itemUpdateMock = vi.fn();

const { FakeMonthlyInvoiceManagedError } = vi.hoisted(() => ({
  FakeMonthlyInvoiceManagedError: class extends Error {
    constructor() {
      super("월정산 거래처의 공급사 계산서는 캠페인 상세 계산서 칸의 「조회」에서 달별로 기록합니다.");
    }
  },
}));

vi.mock("@/lib/campaign-checklist", () => ({
  setChecklistItemChecked: (...a: unknown[]) => setCheckedMock(...a),
  MonthlyInvoiceManagedError: FakeMonthlyInvoiceManagedError,
}));

vi.mock("@/lib/cache-tags", () => ({
  revalidateCampaignCaches: () => revalidateMock(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    campaignChecklistItem: { update: (...a: unknown[]) => itemUpdateMock(...a) },
  }),
}));

import { PATCH } from "./route";

const context = { params: Promise.resolve({ itemId: "item-1" }) };
const patch = (body: unknown) =>
  PATCH(
    new Request("http://localhost/api/campaign-checklist/items/item-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    context,
  );

beforeEach(() => {
  setCheckedMock.mockReset();
  revalidateMock.mockReset();
  itemUpdateMock.mockReset();
});

describe("PATCH /api/campaign-checklist/items/[itemId] — 체크 토글", () => {
  it("토글이 성공하면 캠페인 캐시 태그를 무효화한다(단계 전이가 없어도)", async () => {
    setCheckedMock.mockResolvedValue({
      item: { id: "item-1", isChecked: true },
      campaignStatus: "ACTIVE",
      transitioned: false,
    });

    const response = await patch({ isChecked: true });

    expect(response.status).toBe(200);
    expect(setCheckedMock).toHaveBeenCalledWith(expect.anything(), "item-1", true);
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });

  it("항목이 없어 토글이 실패하면 무효화하지 않는다", async () => {
    setCheckedMock.mockRejectedValue(new Error("CHECKLIST_ITEM_NOT_FOUND"));

    const response = await patch({ isChecked: true });

    expect(response.status).toBe(404);
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("월정산 공급사 계산서 거절은 409 와 사유 문구로 돌려준다(T-244) — 500 이 아니다", async () => {
    setCheckedMock.mockRejectedValue(new FakeMonthlyInvoiceManagedError());

    const response = await patch({ isChecked: true });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("달별로 기록합니다");
    expect(revalidateMock).not.toHaveBeenCalled();
  });
});
