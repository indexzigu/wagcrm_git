import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "./route";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((callback: () => unknown) => callback()),
  };
});

const syncCampaignToCalendarMock = vi.fn();

vi.mock("@/lib/google-calendar-sync", () => ({
  syncCampaignToCalendar: (...args: unknown[]) => syncCampaignToCalendarMock(...args),
}));

const campaignFindUniqueMock = vi.fn();
// 멤버 행 쓰기는 `writeSettlementFlags`(CG-1 SoT SSOT)를 거치므로 `updateMany` + 재조회다.
const campaignUpdateManyMock = vi.fn();
const campaignTxFindUniqueMock = vi.fn();
const groupUpdateMock = vi.fn();
const groupUpdateManyMock = vi.fn();
const groupFindUniqueMock = vi.fn();
const noteCreateMock = vi.fn();
const transactionMock = vi.fn();
const activityMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findUnique: (...args: unknown[]) => campaignFindUniqueMock(...args) },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  }),
}));

vi.mock("@/lib/activity-log", () => ({
  recordActivityChange: (...args: unknown[]) => activityMock(...args),
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: vi.fn().mockResolvedValue({ email: "ops@example.com" }),
}));

function patchRequest(body: unknown) {
  return new Request("http://localhost:3000/api/campaigns/c1/settlement-status", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function context(id = "c1") {
  return { params: Promise.resolve({ id }) };
}

function campaignFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    status: "SETTLEMENT_WAIT",
    // 완료 판정이 채널 인지형이 됐다(computeAutoStatus) — 일반 채널은 종전과 동일하게
    // [입금, 지급] 집합이다. 자사몰 케이스는 전용 테스트에서 명시적으로 덮는다.
    salesChannel: "BRAND_MALL",
    groupId: null,
    group: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    depositReceivedAt: null,
    payoutCompletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  [
    campaignFindUniqueMock,
    campaignUpdateManyMock,
    campaignTxFindUniqueMock,
    groupUpdateMock,
    groupUpdateManyMock,
    groupFindUniqueMock,
    noteCreateMock,
    transactionMock,
    activityMock,
    syncCampaignToCalendarMock,
  ].forEach((mock) => mock.mockReset());
  syncCampaignToCalendarMock.mockResolvedValue({ ok: true });

  transactionMock.mockImplementation(async (callback: (tx: {
    campaignGroup: {
      update: typeof groupUpdateMock;
      updateMany: typeof groupUpdateManyMock;
      findUnique: typeof groupFindUniqueMock;
    };
    salesCampaign: {
      updateMany: typeof campaignUpdateManyMock;
      findUnique: typeof campaignTxFindUniqueMock;
    };
    campaignNote: { create: typeof noteCreateMock };
  }) => Promise<unknown>) =>
    callback({
      campaignGroup: {
        update: groupUpdateMock,
        updateMany: groupUpdateManyMock,
        findUnique: groupFindUniqueMock,
      },
      salesCampaign: {
        updateMany: campaignUpdateManyMock,
        findUnique: campaignTxFindUniqueMock,
      },
      campaignNote: { create: noteCreateMock },
    }),
  );
  groupUpdateManyMock.mockResolvedValue({ count: 1 });
  wireCampaignWrite(campaignFixture());
});

/**
 * 멤버 행 쓰기 mock — `updateMany` 에 실린 data 를 담아 두고 재조회가 그대로 반영해 돌려준다.
 * (`writeSettlementFlags` 는 쓰기 뒤 같은 트랜잭션에서 PK 재조회로 최신 행을 읽는다.)
 */
function wireCampaignWrite(base: Record<string, unknown>) {
  let written: Record<string, unknown> = {};
  campaignUpdateManyMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    written = data;
    return { count: 1 };
  });
  campaignTxFindUniqueMock.mockImplementation(async () => ({ ...base, ...written }));
}

/** 마지막으로 멤버 행에 실린 data. */
function lastCampaignWrite(): Record<string, unknown> {
  const calls = campaignUpdateManyMock.mock.calls as Array<[{ data: Record<string, unknown> }]>;
  return calls[calls.length - 1][0].data;
}

describe("PATCH /api/campaigns/[id]/settlement-status", () => {
  it("그룹 캠페인의 입금 토글은 CampaignGroup에 쓰고 캠페인 정산 플래그는 직접 바꾸지 않는다", async () => {
    campaignFindUniqueMock.mockResolvedValue(
      campaignFixture({
        groupId: "g1",
        group: {
          id: "g1",
          isDepositReceived: false,
          isPayoutCompleted: false,
          depositReceivedAt: null,
          payoutCompletedAt: null,
        },
      }),
    );
    groupFindUniqueMock.mockResolvedValue({
      id: "g1",
      isDepositReceived: true,
      isPayoutCompleted: false,
      depositReceivedAt: new Date("2026-07-10T00:00:00.000Z"),
      payoutCompletedAt: null,
    });

    const response = await PATCH(patchRequest({ isDepositReceived: true }), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(groupUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "g1", members: { some: { id: "c1" } } },
      data: {
        isDepositReceived: true,
        depositReceivedAt: expect.any(Date),
      },
    });
    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      id: "c1",
      status: "SETTLEMENT_WAIT",
      isDepositReceived: true,
      isPayoutCompleted: false,
    });
    // 정산 상태가 바뀌면 캘린더 입금/출금 이벤트 재동기화(그룹은 내부 위임)
    expect(syncCampaignToCalendarMock).toHaveBeenCalledWith("c1");
  });

  it("그룹 공유 상태가 입금+지급 완료가 되면 현재 캠페인 status만 COMPLETED로 전이한다", async () => {
    campaignFindUniqueMock.mockResolvedValue(
      campaignFixture({
        groupId: "g1",
        group: {
          id: "g1",
          isDepositReceived: true,
          isPayoutCompleted: false,
          depositReceivedAt: new Date("2026-07-09T00:00:00.000Z"),
          payoutCompletedAt: null,
        },
      }),
    );
    groupFindUniqueMock.mockResolvedValue({
      id: "g1",
      isDepositReceived: true,
      isPayoutCompleted: true,
      depositReceivedAt: new Date("2026-07-09T00:00:00.000Z"),
      payoutCompletedAt: new Date("2026-07-10T00:00:00.000Z"),
    });
    wireCampaignWrite(campaignFixture({ groupId: "g1" }));

    const response = await PATCH(patchRequest({ isPayoutCompleted: true }), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(groupUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "g1", members: { some: { id: "c1" } } },
      data: {
        isPayoutCompleted: true,
        payoutCompletedAt: expect.any(Date),
      },
    });
    expect(campaignUpdateManyMock).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { status: "COMPLETED" },
    });
    expect(body).toMatchObject({
      id: "c1",
      status: "COMPLETED",
      isDepositReceived: true,
      isPayoutCompleted: true,
    });
  });

  it("이미 완료된 그룹에 같은 입금 토글을 재전송해도 현재 캠페인 status를 전이시키지 않는다", async () => {
    const group = {
      id: "g1",
      isDepositReceived: true,
      isPayoutCompleted: true,
      depositReceivedAt: new Date("2026-07-09T00:00:00.000Z"),
      payoutCompletedAt: new Date("2026-07-10T00:00:00.000Z"),
    };
    campaignFindUniqueMock.mockResolvedValue(
      campaignFixture({
        groupId: "g1",
        group,
      }),
    );
    groupUpdateMock.mockResolvedValue(group);

    const response = await PATCH(patchRequest({ isDepositReceived: true }), context());

    expect(response.status).toBe(200);
    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
    // no-op 토글(상태 변화 없음)은 캘린더 재동기화도 트리거하지 않는다
    expect(syncCampaignToCalendarMock).not.toHaveBeenCalled();
  });

  it("현재 멤버가 아니면 이전 CampaignGroup을 수정하지 않고 409을 반환한다", async () => {
    campaignFindUniqueMock.mockResolvedValue(
      campaignFixture({
        groupId: "g1",
        group: {
          id: "g1",
          isDepositReceived: false,
          isPayoutCompleted: false,
          depositReceivedAt: null,
          payoutCompletedAt: null,
        },
      }),
    );
    groupUpdateManyMock.mockResolvedValue({ count: 0 });

    const response = await PATCH(patchRequest({ isDepositReceived: true }), context());

    expect(response.status).toBe(409);
    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  /**
   * 자사몰 공급사 지급 레그(2026-08-25 2단계) — 대시보드 「지연된 정산」 모달의 쓰기
   * 대상이다. 이 필드가 스키마에 없으면 그 지연을 **처리할 방법이 없다**.
   */
  it("공급사 지급 토글은 타임스탬프·감사기록·완료 자동전이를 입금/지급과 같은 형태로 처리한다", async () => {
    campaignFindUniqueMock.mockResolvedValue(
      campaignFixture({
        salesChannel: "OWN_MALL_NAVER",
        // 셀러 지급은 이미 끝났다 — 공급사 지급만 켜면 자사몰 완료 집합이 채워진다.
        isPayoutCompleted: true,
      }),
    );
    wireCampaignWrite(campaignFixture({ salesChannel: "OWN_MALL_NAVER", isPayoutCompleted: true }));

    const response = await PATCH(
      patchRequest({ isSupplierPayoutCompleted: true }),
      context(),
    );
    expect(response.status).toBe(200);

    const data = lastCampaignWrite();
    expect(data.isSupplierPayoutCompleted).toBe(true);
    expect(data.supplierPayoutCompletedAt).toBeInstanceOf(Date);
    // 자사몰 완료 집합 = [공급사 지급, 셀러 지급] → 둘 다 참이므로 COMPLETED 로 전이.
    expect(data.status).toBe("COMPLETED");

    expect(activityMock).toHaveBeenCalledWith(
      "CAMPAIGN",
      "c1",
      "isSupplierPayoutCompleted",
      false,
      true,
      "ops@example.com",
    );
    // 대금 상태가 바뀌었으므로 캘린더 재동기화 훅도 함께 발화한다(입금/지급과 동일).
    expect(syncCampaignToCalendarMock).toHaveBeenCalledWith("c1");
  });

  it("공급사 지급 해제는 타임스탬프를 null 로 되돌린다", async () => {
    campaignFindUniqueMock.mockResolvedValue(
      campaignFixture({
        salesChannel: "OWN_MALL_NAVER",
        isSupplierPayoutCompleted: true,
      }),
    );
    wireCampaignWrite(campaignFixture({ salesChannel: "OWN_MALL_NAVER" }));

    await PATCH(patchRequest({ isSupplierPayoutCompleted: false }), context());

    const data = lastCampaignWrite();
    expect(data.isSupplierPayoutCompleted).toBe(false);
    expect(data.supplierPayoutCompletedAt).toBeNull();
  });
});
