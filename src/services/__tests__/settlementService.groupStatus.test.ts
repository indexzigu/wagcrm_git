/**
 * 정산 체크리스트(레거시 `/api/settlement-checklist/*`) 경로의 status 전이도 그룹 상태 연동을
 * 탄다(오너 확정 2026-10-05). 원본 쓰기와 `propagateGroupStatus` 가 **한 트랜잭션**인지 본다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  findChecklistItemById: vi.fn(),
  updateChecklistItem: vi.fn(),
  findParentChecklistWithItems: vi.fn(),
  txUpdate: vi.fn(),
  propagate: vi.fn(),
  lock: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/repositories/settlementRepository", () => ({
  SettlementRepository: {
    findChecklistItemById: hoisted.findChecklistItemById,
    updateChecklistItem: hoisted.updateChecklistItem,
    findParentChecklistWithItems: hoisted.findParentChecklistWithItems,
  },
}));

vi.mock("@/services/campaignGroupService", () => ({
  propagateGroupStatus: hoisted.propagate,
  lockCampaignGroup: hoisted.lock,
}));

// 월별 정산 완료 게이트(T-240) — 이 파일은 그룹 전파만 본다(월정산 거래처 아님 = 통과).
vi.mock("@/services/monthlySettlementService", () => ({
  monthlySettlementService: { findCompletionBlocker: vi.fn().mockResolvedValue(null) },
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ $transaction: hoisted.transaction }),
}));

import { SettlementService } from "@/services/settlementService";

const TX = { salesCampaign: { update: hoisted.txUpdate } };

beforeEach(() => {
  Object.values(hoisted).forEach((m) => m.mockReset());
  hoisted.findChecklistItemById.mockResolvedValue({ id: "i1", checklistId: "cl1" });
  hoisted.updateChecklistItem.mockResolvedValue({ id: "i1", isChecked: true });
  hoisted.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(TX));
  hoisted.propagate.mockResolvedValue([{ id: "c2", previousStatus: "SETTLEMENT_IN_PROGRESS" }]);
  hoisted.lock.mockResolvedValue(true);
});

describe("SettlementService.toggleChecklistItem × 그룹 상태 연동", () => {
  it("전부 체크되어 COMPLETED 로 전이하면 같은 tx 에서 형제에 전파한다", async () => {
    hoisted.findParentChecklistWithItems.mockResolvedValue({
      campaign: { id: "c1", status: "SETTLEMENT_IN_PROGRESS", groupId: "g1" },
      items: [{ id: "i1", isChecked: false }],
    });

    const result = await SettlementService.toggleChecklistItem("i1", true);

    expect(result.campaignStatus).toBe("COMPLETED");
    expect(hoisted.transaction).toHaveBeenCalledTimes(1);
    // 🪤 락 순서 — 그룹 락이 원본 행 쓰기보다 먼저다(교착 방지, `lockCampaignGroup`).
    expect(hoisted.lock).toHaveBeenCalledWith(TX, "g1");
    expect(hoisted.lock.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.txUpdate.mock.invocationCallOrder[0],
    );
    expect(hoisted.txUpdate).toHaveBeenCalledWith({ where: { id: "c1" }, data: { status: "COMPLETED" } });
    expect(hoisted.propagate).toHaveBeenCalledWith(TX, {
      originCampaignId: "c1",
      groupId: "g1",
      originPreviousStatus: "SETTLEMENT_IN_PROGRESS",
      status: "COMPLETED",
      actor: "SYSTEM",
      log: { kind: "activity-change" },
    });
  });

  it("해제로 SETTLEMENT_IN_PROGRESS 로 되돌릴 때도 같은 규칙을 탄다", async () => {
    hoisted.findParentChecklistWithItems.mockResolvedValue({
      campaign: { id: "c1", status: "COMPLETED", groupId: "g1" },
      items: [{ id: "i1", isChecked: true }],
    });

    const result = await SettlementService.toggleChecklistItem("i1", false);

    expect(result.campaignStatus).toBe("SETTLEMENT_IN_PROGRESS");
    expect(hoisted.propagate.mock.calls[0][1]).toMatchObject({
      status: "SETTLEMENT_IN_PROGRESS",
      originPreviousStatus: "COMPLETED",
    });
  });

  it("상태가 안 바뀌면 트랜잭션도 전파도 없다", async () => {
    hoisted.findParentChecklistWithItems.mockResolvedValue({
      campaign: { id: "c1", status: "SETTLEMENT_IN_PROGRESS", groupId: "g1" },
      items: [{ id: "i1", isChecked: false }, { id: "i2", isChecked: false }],
    });

    await SettlementService.toggleChecklistItem("i1", true);

    expect(hoisted.transaction).not.toHaveBeenCalled();
    expect(hoisted.propagate).not.toHaveBeenCalled();
  });
});
