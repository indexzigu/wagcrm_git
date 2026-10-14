/**
 * `update_record` 실행기 — 실 DB 로 못 만드는 갈래만 여기서 고정한다(나머지는 `update-record.realdb.test.ts`).
 *  - 잠금 실패(읽은 뒤 다른 저장이 먼저 커밋됨) → 반영하지 않는다.
 *  - 칸 검사: 화면 PATCH 스키마 · 제외 칸 사유 문구.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const applyMock = vi.fn();
const lockMock = vi.fn();
const snapshotMock = vi.fn();

vi.mock("@/lib/agent/record-update-entities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/record-update-entities")>();
  return {
    ...actual,
    readRecordSnapshot: (...args: unknown[]) => snapshotMock(...args),
    lockRecordRows: (...args: unknown[]) => lockMock(...args),
    applyRecordChanges: (...args: unknown[]) => applyMock(...args),
  };
});
vi.mock("@/lib/activity-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/activity-log")>()),
  recordActivityMemo: vi.fn(),
}));

const { executeWriteAction } = await import("../write-executor");
const { validateRecordChanges } = await import("../record-update-entities");

const tx = {} as Prisma.TransactionClient;
const args = {
  entityType: "CAMPAIGN",
  entityId: "camp-1",
  changes: { expectedDepositDate: "2026-06-01" },
  expected: { expectedDepositDate: null },
};

beforeEach(() => {
  applyMock.mockReset();
  lockMock.mockReset();
  snapshotMock.mockReset();
  snapshotMock.mockResolvedValue({ values: { expectedDepositDate: null }, updatedAt: new Date(0), group: null });
});

describe("update_record 실행기", () => {
  it("잠금 쓰기가 0건이면(읽은 뒤 다른 저장이 먼저 커밋) 반영하지 않고 실패한다", async () => {
    lockMock.mockResolvedValue(false);
    await expect(executeWriteAction("update_record", args, "owner", tx)).rejects.toThrow(/다른 수정이 먼저 반영/);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it("지금 값 대조는 날짜를 KST 달력 날짜로 맞춘다(UTC 자정 저장값 = 같은 날)", async () => {
    snapshotMock.mockResolvedValue({
      values: { expectedDepositDate: new Date("2026-05-31T15:30:00.000Z") },
      updatedAt: new Date(0),
      group: null,
    });
    lockMock.mockResolvedValue(true);
    const result = await executeWriteAction(
      "update_record",
      { ...args, expected: { expectedDepositDate: "2026-06-01" }, changes: { expectedDepositDate: "2026-06-02" } },
      "owner",
      tx,
    );
    expect(applyMock).toHaveBeenCalledWith(tx, "CAMPAIGN", "camp-1", { expectedDepositDate: "2026-06-02" }, "owner");
    expect(result.summary).toBe("캠페인 기록 수정: 입금 예정일 2026-06-01 → 2026-06-02");
  });

  it("Decimal 저장값은 숫자로 대조한다", async () => {
    snapshotMock.mockResolvedValue({ values: { sellingPrice: { toString: () => "10000.00" } }, updatedAt: new Date(0), group: null });
    lockMock.mockResolvedValue(true);
    await executeWriteAction(
      "update_record",
      { entityType: "DEAL", entityId: "d-1", changes: { sellingPrice: 12000 }, expected: { sellingPrice: 10000 } },
      "owner",
      tx,
    );
    expect(applyMock).toHaveBeenCalled();
  });
});

describe("validateRecordChanges — 화면 PATCH 스키마 그대로", () => {
  it("화면 스키마가 받는 칸·값은 통과한다", () => {
    expect(validateRecordChanges("CAMPAIGN", { salesChannel: "BRAND_MALL", sellerInvoiceIssuedAt: "2026-05-22" }).ok).toBe(true);
    expect(validateRecordChanges("PARTNER", { notes: "메모" }).ok).toBe(true);
  });

  it.each([
    ["CAMPAIGN", { salesChannel: "NAVER" }, /salesChannel/],
    ["CAMPAIGN", { depositReceivedAt: "2026/04/28" }, /depositReceivedAt/],
    ["CAMPAIGN", { operatingProfit: 1 }, /operatingProfit|Unrecognized/i],
    ["SELLER", { residentNumber: "000000-0000000" }, /주민등록번호는 기안/],
    ["SELLER", { currentFollowers: 10 }, /팔로워 수는/],
    ["PARTNER", { bankAccount: "가상" }, /계좌 정보는/],
  ] as const)("%s %j 는 거절한다", (entityType, changes, message) => {
    const result = validateRecordChanges(entityType, changes as Record<string, unknown>);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });
});

describe("자동 실행 경계", () => {
  it("정산 자동 실행기가 집는 액션·requestType 과 겹치지 않는다(기록 수정은 언제나 사람이 승인)", async () => {
    const { SETTLEMENT_ACTION, SETTLEMENT_REQUEST_TYPE } = await import("../auto-execute/settlement-auto-execute");
    const { getRequestTypeForAction } = await import("../approval-policy");
    expect(SETTLEMENT_ACTION).not.toBe("update_record");
    expect(getRequestTypeForAction("update_record")).toBe("record_update");
    expect(SETTLEMENT_REQUEST_TYPE).not.toBe("record_update");
  });

  it("시스템 실행자는 값 대조 전에 거부한다", async () => {
    await expect(executeWriteAction("update_record", args, "SYSTEM_AUTO", tx)).rejects.toThrow(/사람이 결재함에서 승인해야/);
    expect(snapshotMock).not.toHaveBeenCalled();
    expect(applyMock).not.toHaveBeenCalled();
  });
});
