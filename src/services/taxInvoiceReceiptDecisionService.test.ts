import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  applyReceiptDecision,
  revertReceiptDecision,
  parseReceivableKey,
  ReceiptDecisionRejected,
} from "./taxInvoiceReceiptDecisionService";

/**
 * 결정 서비스의 쓰기 계약.
 *
 * 고정하는 것 셋 —
 * ①**그룹이면 그룹 스칼라만** 쓴다(CG-1). 멤버 컬럼을 함께 쓰면 그룹 값과 멤버 값이 갈라져
 *   `buildOverdueSettlementItems` 가 밟은 #196 함정이 계산서 축에서 재현된다.
 * ②되돌리기는 **우리가 쓴 값**만 지운다. 그 사이 오너가 손으로 넣은 값은 건드리지 않는다.
 * ③작성일자가 없으면 승인 자체를 거부한다 — 오늘 날짜로 대신 찍으면 없는 사실을 만들고,
 *   결정 행만 남기면 화면은 「승인됨」인데 정산 SoT 는 미수취인 상태가 굳는다.
 */

const APPLIED = new Date("2026-07-31T00:00:00.000Z");

interface TxRecorder {
  groupUpdates: Array<{ where: unknown; data: Record<string, unknown> }>;
  campaignUpdates: Array<{ where: unknown; data: Record<string, unknown> }>;
  upserts: number;
  deletes: number;
}

/**
 * 최소 Prisma 대역. `$transaction(fn)` 은 콜백에 자기 자신을 넘긴다 — 실제 Prisma 의
 * 인터랙티브 트랜잭션과 같은 모양이라 서비스 코드를 고치지 않고 검사할 수 있다.
 */
function fakePrisma(options: {
  campaign: { id: string; groupId: string | null } | null;
  currentValue?: Date | null;
  decision?: {
    decision: string;
    matchedKeys: string;
    appliedDate: Date | null;
  } | null;
}): { prisma: PrismaClient; rec: TxRecorder } {
  const rec: TxRecorder = { groupUpdates: [], campaignUpdates: [], upserts: 0, deletes: 0 };

  const tx = {
    taxInvoiceReceiptDecision: {
      upsert: vi.fn(async () => {
        rec.upserts += 1;
      }),
      findUnique: vi.fn(async () => options.decision ?? null),
      delete: vi.fn(async () => {
        rec.deletes += 1;
      }),
    },
    salesCampaign: {
      findUnique: vi.fn(async () =>
        options.campaign
          ? {
              ...options.campaign,
              supplierInvoiceIssuedAt: options.currentValue ?? null,
              sellerInvoiceIssuedAt: options.currentValue ?? null,
            }
          : null,
      ),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        rec.campaignUpdates.push(args);
      }),
    },
    campaignGroup: {
      findUnique: vi.fn(async () => ({
        id: options.campaign?.groupId,
        supplierInvoiceIssuedAt: options.currentValue ?? null,
        sellerInvoiceIssuedAt: options.currentValue ?? null,
      })),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        rec.groupUpdates.push(args);
      }),
    },
  };

  const prisma = {
    ...tx,
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;

  return { prisma, rec };
}

function approveInput(overrides: Record<string, unknown> = {}) {
  return {
    issueId: "202607311234567890123456",
    decision: "APPROVED" as const,
    matchedKeys: ["camp1:SELLER_COMMISSION"],
    appliedDate: APPLIED,
    observedTotal: 5489000,
    expectedTotal: 5500000,
    amountDelta: -11000,
    signalSummary: null,
    ...overrides,
  };
}

describe("applyReceiptDecision", () => {
  it("그룹 소속이면 그룹 스칼라만 쓰고 멤버 컬럼은 건드리지 않는다", async () => {
    const { prisma, rec } = fakePrisma({ campaign: { id: "camp1", groupId: "grp1" } });

    const result = await applyReceiptDecision(prisma, approveInput());

    expect(rec.groupUpdates).toHaveLength(1);
    expect(rec.groupUpdates[0].data).toEqual({ sellerInvoiceIssuedAt: APPLIED });
    // ⛔ 이 단언이 CG-1 의 핵심이다 — 멤버 쓰기가 한 건이라도 있으면 실패한다.
    expect(rec.campaignUpdates).toHaveLength(0);
    expect(result.applied).toEqual([
      { campaignId: "camp1", groupId: "grp1", field: "sellerInvoiceIssuedAt" },
    ]);
  });

  it("미그룹이면 캠페인 컬럼만 쓴다", async () => {
    const { prisma, rec } = fakePrisma({ campaign: { id: "camp1", groupId: null } });

    await applyReceiptDecision(prisma, approveInput({ matchedKeys: ["camp1:SUPPLIER_GOODS"] }));

    expect(rec.campaignUpdates).toHaveLength(1);
    expect(rec.campaignUpdates[0].data).toEqual({ supplierInvoiceIssuedAt: APPLIED });
    expect(rec.groupUpdates).toHaveLength(0);
  });

  /**
   * ⛔ 종전에는 「결정만 기록하고 필드는 안 쓴다」로 관대했고, 그게 교차 검증에서 잡힌
   * 실제 결함이었다(2026-08-12) — 결정 행이 남는 순간 화면은 「승인됨」이 되는데 정산
   * SoT 는 미수취로 남고, 다음 스캔은 「결정된 건」이라 제안조차 띄우지 않아 되돌아올 길이
   * 없다. 응답이 200 이라 호출부의 `res.ok` 가드도 발동하지 않았다.
   */
  it("작성일자가 없으면 승인을 거부하고 결정 행조차 남기지 않는다", async () => {
    const { prisma, rec } = fakePrisma({ campaign: { id: "camp1", groupId: "grp1" } });

    await expect(applyReceiptDecision(prisma, approveInput({ appliedDate: null }))).rejects.toThrow(
      ReceiptDecisionRejected,
    );

    expect(rec.upserts).toBe(0);
    expect(rec.groupUpdates).toHaveLength(0);
    expect(rec.campaignUpdates).toHaveLength(0);
  });

  it("무관 처리는 어떤 필드도 쓰지 않는다", async () => {
    const { prisma, rec } = fakePrisma({ campaign: { id: "camp1", groupId: "grp1" } });

    await applyReceiptDecision(prisma, approveInput({ decision: "DISMISSED", matchedKeys: [] }));

    expect(rec.upserts).toBe(1);
    expect(rec.groupUpdates).toHaveLength(0);
    expect(rec.campaignUpdates).toHaveLength(0);
  });

  it("대상 캠페인이 사라졌으면 삼키지 않고 거부한다", async () => {
    const { prisma } = fakePrisma({ campaign: null });

    await expect(applyReceiptDecision(prisma, approveInput())).rejects.toThrow(
      ReceiptDecisionRejected,
    );
  });

  it("모르는 슬롯이 섞이면 쓰기 전에 거부한다", async () => {
    const { prisma, rec } = fakePrisma({ campaign: { id: "camp1", groupId: null } });

    await expect(
      applyReceiptDecision(prisma, approveInput({ matchedKeys: ["camp1:이상한슬롯"] })),
    ).rejects.toThrow(ReceiptDecisionRejected);

    expect(rec.upserts).toBe(0);
  });
});

describe("revertReceiptDecision", () => {
  it("우리가 쓴 값과 같으면 지운다", async () => {
    const { prisma, rec } = fakePrisma({
      campaign: { id: "camp1", groupId: "grp1" },
      currentValue: APPLIED,
      decision: {
        decision: "APPROVED",
        matchedKeys: JSON.stringify(["camp1:SELLER_COMMISSION"]),
        appliedDate: APPLIED,
      },
    });

    const result = await revertReceiptDecision(prisma, "202607311234567890123456");

    expect(result.found).toBe(true);
    expect(rec.groupUpdates[0].data).toEqual({ sellerInvoiceIssuedAt: null });
    expect(result.cleared).toHaveLength(1);
    expect(rec.deletes).toBe(1);
  });

  it("승인 이후 오너가 바꾼 값은 건드리지 않고 알린다", async () => {
    const { prisma, rec } = fakePrisma({
      campaign: { id: "camp1", groupId: "grp1" },
      // 오너가 손으로 다른 날짜를 넣었다 — 우리 값이 아니므로 지우면 안 된다.
      currentValue: new Date("2026-08-05T00:00:00.000Z"),
      decision: {
        decision: "APPROVED",
        matchedKeys: JSON.stringify(["camp1:SELLER_COMMISSION"]),
        appliedDate: APPLIED,
      },
    });

    const result = await revertReceiptDecision(prisma, "202607311234567890123456");

    expect(rec.groupUpdates).toHaveLength(0);
    expect(result.cleared).toHaveLength(0);
    expect(result.skipped).toEqual([{ campaignId: "camp1", field: "sellerInvoiceIssuedAt" }]);
  });

  it("결정 기록이 없으면 found=false", async () => {
    const { prisma } = fakePrisma({ campaign: null, decision: null });
    expect((await revertReceiptDecision(prisma, "없는번호")).found).toBe(false);
  });
});

describe("parseReceivableKey", () => {
  it("cuid 에 콜론이 없어도 마지막 콜론 기준으로 슬롯을 가른다", () => {
    expect(parseReceivableKey("camp1:SELLER_COMMISSION")).toEqual({
      campaignId: "camp1",
      slot: "SELLER_COMMISSION",
    });
  });

  it("모르는 슬롯은 null 이다 - 조용히 통과시키지 않는다", () => {
    expect(parseReceivableKey("camp1:UNKNOWN_SLOT")).toBeNull();
    expect(parseReceivableKey("슬롯없음")).toBeNull();
  });
});
