// T-313 — the agent's confirm_settlement must not move a "기간 미정" PREPARATION campaign to
// COMPLETED: the flag is confirmed, the status stays. A dated campaign still completes (control).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const writeSettlementFlags = vi.fn();

vi.mock("@/lib/activity-log", () => ({ recordActivityChange: vi.fn() }));
vi.mock("../types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../types")>()),
  assertEntityExists: vi.fn(),
}));
vi.mock("@/lib/settlement-flag-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/settlement-flag-write")>()),
  writeSettlementFlags: (...args: unknown[]) => writeSettlementFlags(...args),
}));
vi.mock("@/services/campaignInvoiceService", () => ({
  campaignInvoiceService: {
    gateAutoCompletion: vi.fn(async (_db: unknown, _id: string, _prev: string, status: string | null | undefined) => ({
      status: status ?? undefined,
      blockedReason: null,
    })),
  },
}));

import { confirmSettlementAction } from "../confirm-settlement";

const placeholder = new Date("2026-11-17T03:00:00.000Z");

function campaignRow(overrides: Record<string, unknown>) {
  return {
    id: "camp-1",
    groupId: null,
    group: null,
    salesChannel: "BRAND_MALL",
    status: "PREPARATION",
    startDate: placeholder,
    endDate: placeholder,
    periodPlaceholderAt: placeholder,
    isDepositReceived: true,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    actualSales: 100000,
    sellerExpense: 0,
    settlementSales: 100000,
    actualPayoutAmount: 100000,
    ...overrides,
  };
}

function txFor(row: ReturnType<typeof campaignRow>) {
  return {
    salesCampaign: {
      findUnique: vi.fn(async () => row),
      findMany: vi.fn(async () => [row]),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("confirm_settlement — 기간 미정 준비 캠페인(T-313)", () => {
  beforeEach(() => {
    writeSettlementFlags.mockReset();
    writeSettlementFlags.mockResolvedValue({ ok: true });
  });

  it("플래그는 확정하되 상태는 준비에 둔다", async () => {
    const result = await confirmSettlementAction.handler(
      { campaignId: "camp-1", target: "payout" },
      "tester",
      txFor(campaignRow({})),
    );
    expect(writeSettlementFlags).toHaveBeenCalledTimes(1);
    const params = writeSettlementFlags.mock.calls[0][1];
    expect(params.settlementUpdates.isPayoutCompleted).toBe(true);
    expect(params.campaignUpdates).toEqual({});
    expect(result.summary).not.toContain("COMPLETED");
  });

  it("기간이 정해진 준비 캠페인은 그대로 정산 완료로 넘어간다(대조군)", async () => {
    await confirmSettlementAction.handler(
      { campaignId: "camp-1", target: "payout" },
      "tester",
      txFor(campaignRow({ startDate: new Date("2026-11-20T03:00:00.000Z"), endDate: new Date("2026-11-30T03:00:00.000Z") })),
    );
    expect(writeSettlementFlags.mock.calls[0][1].campaignUpdates).toEqual({ status: "COMPLETED" });
  });
});
