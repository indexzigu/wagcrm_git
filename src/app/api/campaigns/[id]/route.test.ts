import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "./route";

// 월별 정산 완료 게이트(T-240) — 이 파일은 상태 전이·그룹 전파만 본다(월정산 거래처 아님 = 통과).
// 게이트 자체의 판정은 campaign-invoices.test.ts · route.monthly-gate.test.ts 가 고정한다.
vi.mock("@/services/campaignInvoiceService", () => ({
  campaignInvoiceService: {
    gateAutoCompletion: vi.fn(async (_db: unknown, _id: string, _prev: string, auto: string | null | undefined) => ({
      status: auto ?? undefined,
      blockedReason: null,
    })),
    findCompletionBlocker: vi.fn().mockResolvedValue(null),
    findCompletionBlockers: vi.fn().mockResolvedValue(new Map()),
  },
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((callback: () => unknown) => callback()),
  };
});

const campaignFindUniqueMock = vi.fn();
const campaignFindUniqueOrThrowMock = vi.fn();
const campaignUpdateMock = vi.fn();
/** 그룹 일정 팬아웃(`fanOutMemberSchedule`)이 형제 멤버에 쓰는 경로. */
const campaignUpdateManyMock = vi.fn();
const groupUpdateMock = vi.fn();
const groupFindUniqueMock = vi.fn();
const groupRollupUpdateMock = vi.fn();
const groupMembersFindManyMock = vi.fn();
const transactionMock = vi.fn();
const salesTaskFindFirstMock = vi.fn();
const toCampaignRowMock = vi.fn();
/** `syncCampaignLinkExpiry` 가 트랜잭션 안에서 부르는 링크 만료 재계산 쓰기. */
const trackedLinkUpdateManyMock = vi.fn();
/** 그룹 상태 연동(`propagateGroupStatus`)이 형제 이력을 남기는 경로. */
const campaignActivityCreateManyMock = vi.fn();
/** 셀러 단위 그룹 advisory 락(`pg_advisory_xact_lock`) — 락 순서 단언에 쓴다. */
const executeRawMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: {
      findUnique: (...args: unknown[]) => campaignFindUniqueMock(...args),
      findUniqueOrThrow: (...args: unknown[]) => campaignFindUniqueOrThrowMock(...args),
      update: (...args: unknown[]) => campaignUpdateMock(...args),
    },
    salesTask: {
      findFirst: (...args: unknown[]) => salesTaskFindFirstMock(...args),
    },
    // 드랍 처리 노트(라우트 후처리) — 그룹 상태 연동의 DROPPED 비전파 테스트가 지난다.
    campaignNote: { create: vi.fn().mockResolvedValue({}) },
    $transaction: (...args: unknown[]) => transactionMock(...args),
  }),
}));

vi.mock("@/lib/campaign-activity", () => ({
  describeChangedFields: vi.fn(() => "changed"),
  recordCampaignActivity: vi.fn(),
}));

vi.mock("@/lib/campaign-checklist", () => ({
  ensureCampaignChecklistForStatus: vi.fn(),
}));

vi.mock("@/lib/campaign-name", () => ({
  generateCampaignName: vi.fn(() => "generated"),
}));

vi.mock("@/lib/campaign-row", () => ({
  toCampaignRow: (...args: unknown[]) => toCampaignRowMock(...args),
  toKstDateStr: (value: Date | null) => value?.toISOString().slice(0, 10) ?? null,
}));

vi.mock("@/lib/auth-context", () => ({
  getAuthContext: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/user-registry", () => ({
  getCrmUsers: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/cache-tags", () => ({
  revalidateCampaignCaches: vi.fn(),
}));

vi.mock("@/lib/google-calendar-sync", () => ({
  syncCampaignToCalendar: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/campaign-financials", () => ({
  calculateDerivedCampaignFinancials: vi.fn(),
}));

function patchRequest(body: unknown) {
  return new Request("http://localhost:3000/api/campaigns/c1", {
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
    // 완료 판정이 채널 인지형이라(resolveAutoStatus) previous 행에 채널이 실려야 한다 —
    // 일반 채널은 종전과 동일한 [입금, 지급] 집합이다.
    salesChannel: "BRAND_MALL",
    dealId: "deal-1",
    sellerId: "seller-1",
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-15T00:00:00.000Z"),
    returnPeriodEndDate: null,
    roundNumber: 1,
    campaignName: "딜 - 셀러",
    groupId: "g1",
    group: {
      id: "g1",
      isDepositReceived: false,
      isPayoutCompleted: false,
    },
    isDepositReceived: false,
    isPayoutCompleted: false,
    depositReceivedAt: null,
    payoutCompletedAt: null,
    actualSales: null,
    operatingExpense: null,
    miscExpense: null,
    totalMarginRate: 0,
    sellerMarginRate: 0,
    sellerTaxType: null,
    assignedTo: null,
    notesFromImport: null,
    seller: { alias: "셀러", name: "셀러", agency: null },
    ...overrides,
  };
}

beforeEach(() => {
  [
    campaignFindUniqueMock,
    campaignFindUniqueOrThrowMock,
    campaignUpdateMock,
    groupUpdateMock,
    groupFindUniqueMock,
    groupRollupUpdateMock,
    groupMembersFindManyMock,
    transactionMock,
    salesTaskFindFirstMock,
    toCampaignRowMock,
    campaignUpdateManyMock,
    trackedLinkUpdateManyMock,
    campaignActivityCreateManyMock,
    executeRawMock,
  ].forEach((mock) => mock.mockReset());
  executeRawMock.mockResolvedValue(0);

  transactionMock.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      // 그룹 롤업 재계산(recomputeGroupRollup)이 같은 트랜잭션에서 도는 경로 —
      // advisory 락 · 그룹 조회 · 멤버 조회 · 롤업 쓰기를 가짜로 채운다.
      $executeRaw: (...args: unknown[]) => executeRawMock(...args),
      campaignGroup: {
        updateMany: groupUpdateMock,
        findUnique: groupFindUniqueMock,
        update: groupRollupUpdateMock,
      },
      salesCampaign: {
        update: campaignUpdateMock,
        findMany: groupMembersFindManyMock,
        updateMany: campaignUpdateManyMock,
      },
      trackedLink: {
        updateMany: trackedLinkUpdateManyMock,
      },
      campaignActivity: {
        createMany: campaignActivityCreateManyMock,
      },
    }),
  );
  campaignUpdateManyMock.mockResolvedValue({ count: 1 });
  trackedLinkUpdateManyMock.mockResolvedValue({ count: 0 });
  groupFindUniqueMock.mockResolvedValue({ id: "g1", sellerId: "s1" });
  // 롤업(listMembers)과 그룹 상태 연동(형제 status·채널 조회)이 같은 findMany 를 쓴다.
  groupMembersFindManyMock.mockResolvedValue([
    { id: "c1", status: "SETTLEMENT_WAIT", salesChannel: "BRAND_MALL", startDate: new Date("2026-07-02T00:00:00.000Z"), endDate: new Date("2026-07-16T00:00:00.000Z") },
    { id: "c2", status: "SETTLEMENT_WAIT", salesChannel: "BRAND_MALL", startDate: new Date("2026-07-05T00:00:00.000Z"), endDate: new Date("2026-07-20T00:00:00.000Z") },
  ]);
  groupRollupUpdateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "g1",
    ...data,
  }));
  campaignUpdateMock.mockResolvedValue(campaignFixture());
  groupUpdateMock.mockResolvedValue({ count: 1 });
  campaignFindUniqueOrThrowMock.mockResolvedValue(campaignFixture());
  salesTaskFindFirstMock.mockResolvedValue(null);
  toCampaignRowMock.mockImplementation((campaign: {
    id: string;
    expectedDepositDate?: Date | null;
    group?: { expectedDepositDate?: Date | null } | null;
  }) => ({
    id: campaign.id,
    expectedDepositDate: (campaign.group?.expectedDepositDate ?? campaign.expectedDepositDate)?.toISOString().slice(0, 10) ?? null,
  }));
});

describe("PATCH /api/campaigns/[id]", () => {
  it("그룹 캠페인의 공유 이벤트 필드만 CampaignGroup에 쓰고 기간·금액·식별 필드는 캠페인에 남긴다", async () => {
    campaignFindUniqueMock.mockResolvedValue(campaignFixture());

    const response = await PATCH(
      patchRequest({
        expectedDepositDate: "2026-08-01",
        depositReceivedAt: "2026-08-02",
        isDepositReceived: true,
        expectedPayoutDate: "2026-08-10",
        payoutCompletedAt: "2026-08-11",
        isPayoutCompleted: true,
        supplierInvoiceIssuedAt: "2026-08-03",
        sellerInvoiceIssuedAt: "2026-08-04",
        accountingCompletedAt: "2026-08-12",
        notesFromImport: '{"approvalNumber":"A-1"}',
        startDate: "2026-07-02",
        endDate: "2026-07-16",
        returnPeriodEndDate: "2026-07-30",
        settlementSupplyCost: 1234,
        groupId: "must-not-be-accepted",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(groupUpdateMock).toHaveBeenCalledWith({
      where: { id: "g1", members: { some: { id: "c1" } } },
      data: {
        expectedDepositDate: new Date("2026-08-01T00:00:00.000Z"),
        depositReceivedAt: new Date("2026-08-02T00:00:00.000Z"),
        isDepositReceived: true,
        expectedPayoutDate: new Date("2026-08-10T00:00:00.000Z"),
        payoutCompletedAt: new Date("2026-08-11T00:00:00.000Z"),
        isPayoutCompleted: true,
        supplierInvoiceIssuedAt: new Date("2026-08-03T00:00:00.000Z"),
        sellerInvoiceIssuedAt: new Date("2026-08-04T00:00:00.000Z"),
        accountingCompletedAt: new Date("2026-08-12T00:00:00.000Z"),
        invoiceInfo: '{"approvalNumber":"A-1"}',
        // 반품기간은 그룹 행에도 미러링한다(`campaign-group-row` 표시용) — 다만 아래처럼
        // **멤버 컬럼에도 계속 쓴다**(대시보드 카운터가 멤버를 프리필터로 직접 읽는다).
        returnPeriodEndDate: new Date("2026-07-30T00:00:00.000Z"),
      },
    });

    // 기간이 바뀌었으므로 그룹 롤업이 멤버 포락선으로 재계산돼야 한다(드리프트 방지, 2026-08-01).
    expect(groupRollupUpdateMock).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: {
        startDate: new Date("2026-07-02T00:00:00.000Z"),
        endDate: new Date("2026-07-20T00:00:00.000Z"),
      },
    });

    const campaignUpdateData = campaignUpdateMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(campaignUpdateData).toMatchObject({
      startDate: new Date("2026-07-02T00:00:00.000Z"),
      endDate: new Date("2026-07-16T00:00:00.000Z"),
      returnPeriodEndDate: new Date("2026-07-30T00:00:00.000Z"),
      settlementSupplyCost: 1234,
    });
    [
      "expectedDepositDate",
      "depositReceivedAt",
      "isDepositReceived",
      "expectedPayoutDate",
      "payoutCompletedAt",
      "isPayoutCompleted",
      "supplierInvoiceIssuedAt",
      "sellerInvoiceIssuedAt",
      "accountingCompletedAt",
      "invoiceInfo",
      "groupId",
      "notesFromImport",
    ].forEach((field) => expect(campaignUpdateData).not.toHaveProperty(field));
  });

  describe("그룹 상태 통합 연동(오너 확정 2026-10-05)", () => {
    function siblingStatusWrites() {
      return (campaignUpdateManyMock.mock.calls as Array<[{ where: Record<string, unknown>; data: Record<string, unknown> }]>)
        .map(([args]) => args)
        .filter((args) => "status" in args.data);
    }

    it("수동 상태 변경은 같은 tx 에서 형제에 전파되고, 형제도 체크리스트 후처리를 받으며 응답에 형제 id 를 싣는다", async () => {
      campaignFindUniqueMock.mockResolvedValue(campaignFixture({ status: "ACTIVE" }));
      groupMembersFindManyMock.mockResolvedValue([
        { id: "c1", status: "CLOSED", salesChannel: "BRAND_MALL" },
        { id: "c2", status: "ACTIVE", salesChannel: "BRAND_MALL" },
        { id: "c3", status: "DROPPED", salesChannel: "BRAND_MALL" },
        // 제안 단계 형제는 수동 상태 변경도 따라가지 않는다(오너 확정 2026-10-05).
        { id: "c4", status: "PROPOSAL", salesChannel: "BRAND_MALL" },
      ]);
      const { ensureCampaignChecklistForStatus } = await import("@/lib/campaign-checklist");
      vi.mocked(ensureCampaignChecklistForStatus).mockClear();

      const response = await PATCH(patchRequest({ status: "CLOSED" }), context());
      const body = await response.json();

      expect(response.status).toBe(200);
      const writes = siblingStatusWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0].where.id).toEqual({ in: ["c2"] });
      expect(writes[0].data).toEqual({ status: "CLOSED" });
      expect(campaignActivityCreateManyMock.mock.calls[0][0].data).toEqual([
        expect.objectContaining({ campaignId: "c2", action: "UPDATED", label: "Campaign updated" }),
      ]);
      expect(vi.mocked(ensureCampaignChecklistForStatus).mock.calls.map((c) => c[1])).toEqual(["c1", "c2"]);
      expect(body.groupStatusSyncedIds).toEqual(["c2"]);
    });

    it("🪤 락 순서 — 그룹 락이 원본 행 쓰기보다 먼저다(팬아웃과의 교착 방지)", async () => {
      const saved = process.env.DATABASE_URL;
      process.env.DATABASE_URL = "postgresql://user@localhost:5432/db";
      try {
        campaignFindUniqueMock.mockResolvedValue(campaignFixture({ status: "ACTIVE" }));

        await PATCH(patchRequest({ status: "CLOSED" }), context());

        expect(executeRawMock).toHaveBeenCalled();
        expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
          campaignUpdateMock.mock.invocationCallOrder[0],
        );
      } finally {
        if (saved === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = saved;
      }
    });

    it("DROPPED 로의 변경은 멤버 단위다 — 형제를 건드리지 않는다", async () => {
      campaignFindUniqueMock.mockResolvedValue(campaignFixture({ status: "ACTIVE" }));

      const response = await PATCH(
        patchRequest({ status: "DROPPED", dropReason: "셀러 이탈" }),
        context(),
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(siblingStatusWrites()).toHaveLength(0);
      expect(body.groupStatusSyncedIds).toBeUndefined();
    });

    it("정산 자동전이(COMPLETED)는 원본과 같은 답이 나오는 형제에 전파된다", async () => {
      campaignFindUniqueMock.mockResolvedValue(campaignFixture({
        group: { id: "g1", isDepositReceived: true, isPayoutCompleted: false },
      }));

      await PATCH(patchRequest({ isPayoutCompleted: true }), context());

      const campaignUpdateData = campaignUpdateMock.mock.calls[0][0].data as Record<string, unknown>;
      expect(campaignUpdateData).toMatchObject({ status: "COMPLETED" });
      const writes = siblingStatusWrites();
      expect(writes).toHaveLength(1);
      expect(writes[0].where.id).toEqual({ in: ["c2"] });
      expect(writes[0].data).toEqual({ status: "COMPLETED" });
    });

    it("무그룹 캠페인의 상태 변경은 형제 조회조차 하지 않는다", async () => {
      campaignFindUniqueMock.mockResolvedValue(campaignFixture({ status: "ACTIVE", groupId: null, group: null }));

      await PATCH(patchRequest({ status: "CLOSED" }), context());

      expect(groupMembersFindManyMock).not.toHaveBeenCalled();
      expect(siblingStatusWrites()).toHaveLength(0);
    });
  });

  it("기간이 안 바뀐 그룹 PATCH는 롤업을 다시 쓰지 않는다 — 같은 값 재전송도 마찬가지", async () => {
    campaignFindUniqueMock.mockResolvedValue(campaignFixture());

    // ① 기간과 무관한 필드만
    await PATCH(patchRequest({ invoiceInfo: '{"approvalNumber":"A-3"}' }), context());
    expect(groupRollupUpdateMock).not.toHaveBeenCalled();

    // ② 기존과 **같은** 기간을 다시 보냄(픽스처: 2026-07-01 ~ 07-15)
    await PATCH(
      patchRequest({ startDate: "2026-07-01", endDate: "2026-07-15" }),
      context(),
    );
    expect(groupRollupUpdateMock).not.toHaveBeenCalled();
  });

  // 그룹 일정 통합 연동(2026-08-04 오너 요청) — 조합 캠페인은 1개 실캠페인이므로
  // 한 멤버의 기간·반품기간 수정이 형제 멤버에도 그대로 반영돼야 한다.
  it("그룹 멤버의 기간 수정이 형제 멤버에 팬아웃되고, 반영 건수를 응답에 고지한다", async () => {
    campaignFindUniqueMock.mockResolvedValue(campaignFixture());
    campaignUpdateManyMock.mockResolvedValue({ count: 2 });

    const response = await PATCH(
      patchRequest({ startDate: "2026-07-02", endDate: "2026-07-16" }),
      context(),
    );

    expect(campaignUpdateManyMock).toHaveBeenCalledWith({
      where: { groupId: "g1", id: { not: "c1" } },
      data: expect.objectContaining({
        startDate: new Date("2026-07-02T00:00:00.000Z"),
        endDate: new Date("2026-07-16T00:00:00.000Z"),
      }),
    });
    expect(await response.json()).toMatchObject({ groupScheduleSyncedCount: 2 });
  });

  it("정산일만 바뀐 그룹 PATCH는 형제 멤버를 건드리지 않는다 — 팬아웃 대상은 일정 3종뿐", async () => {
    campaignFindUniqueMock.mockResolvedValue(campaignFixture());

    const response = await PATCH(patchRequest({ expectedPayoutDate: "2026-08-10" }), context());

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
    // 고지도 붙지 않는다 — 형제가 안 바뀌었는데 "함께 반영"이라고 말하면 거짓말이다.
    expect(await response.json()).not.toHaveProperty("groupScheduleSyncedCount");
  });

  it("같은 기간을 재전송하면 형제에 기간을 복사하지 않는다 (불필요한 쓰기 방지)", async () => {
    campaignFindUniqueMock.mockResolvedValue(
      campaignFixture({ returnPeriodEndDate: new Date("2026-07-29T00:00:00.000Z") }),
    );

    // 픽스처와 같은 기간 + 반품기간 기존값 존재 → 자동 +14 도 안 걸린다.
    await PATCH(patchRequest({ startDate: "2026-07-01", endDate: "2026-07-15" }), context());

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  it("무그룹 캠페인은 팬아웃하지 않는다", async () => {
    campaignFindUniqueMock.mockResolvedValue(campaignFixture({ groupId: null, group: null }));

    await PATCH(patchRequest({ startDate: "2026-07-02", endDate: "2026-07-16" }), context());

    expect(campaignUpdateManyMock).not.toHaveBeenCalled();
  });

  it("무그룹 캠페인의 기간 PATCH는 롤업 경로를 타지 않는다", async () => {
    campaignFindUniqueMock.mockResolvedValue(campaignFixture({ groupId: null, group: null }));

    await PATCH(patchRequest({ startDate: "2026-07-02", endDate: "2026-07-16" }), context());

    expect(groupFindUniqueMock).not.toHaveBeenCalled();
    expect(groupRollupUpdateMock).not.toHaveBeenCalled();
  });

  it("공유 정산 상태를 바꾸지 않는 그룹 PATCH는 현재 캠페인 상태를 자동 전이시키지 않는다", async () => {
    campaignFindUniqueMock.mockResolvedValue(campaignFixture({
      group: { id: "g1", isDepositReceived: true, isPayoutCompleted: true },
    }));

    await PATCH(
      patchRequest({ invoiceInfo: '{"approvalNumber":"A-2"}' }),
      context(),
    );

    const campaignUpdateData = campaignUpdateMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(campaignUpdateData).not.toHaveProperty("status");
  });

  it("동일한 그룹 정산 토글을 다시 보내도 현재 캠페인 상태를 자동 전이시키지 않는다", async () => {
    campaignFindUniqueMock.mockResolvedValue(campaignFixture({
      group: { id: "g1", isDepositReceived: true, isPayoutCompleted: true },
    }));

    await PATCH(
      patchRequest({ isDepositReceived: true }),
      context(),
    );

    expect(campaignUpdateMock).not.toHaveBeenCalled();
  });

  it("그룹 멤버십이 변경되면 이전 그룹을 쓰지 않고 재시도를 요청한다", async () => {
    campaignFindUniqueMock.mockResolvedValue(campaignFixture());
    groupUpdateMock.mockResolvedValue({ count: 0 });

    const response = await PATCH(
      patchRequest({ expectedDepositDate: "2026-08-01" }),
      context(),
    );

    expect(response.status).toBe(409);
    expect(campaignUpdateMock).not.toHaveBeenCalled();
  });

  it("그룹 공유 필드 PATCH는 응답에도 갱신된 그룹 값을 반영한다", async () => {
    const targetDate = new Date("2026-08-01T00:00:00.000Z");
    campaignFindUniqueMock.mockResolvedValue(campaignFixture());
    campaignFindUniqueOrThrowMock.mockResolvedValue(campaignFixture({
      expectedDepositDate: new Date("2026-07-20T00:00:00.000Z"),
      group: {
        id: "g1",
        isDepositReceived: false,
        isPayoutCompleted: false,
        expectedDepositDate: targetDate,
      },
    }));

    const response = await PATCH(
      patchRequest({ expectedDepositDate: "2026-08-01" }),
      context(),
    );

    await expect(response.json()).resolves.toMatchObject({ expectedDepositDate: "2026-08-01" });
  });

  // I1 — 재계산 게이트는 문자열 리터럴("end date", campaign-update-plan.ts) 하나에 매달려
  // 있다. 이 라벨이 리팩터로 바뀌면 syncCampaignLinkExpiry 가 영원히 안 불리고, 링크가
  // 잘못된 날 죽은 뒤에야 드러난다 — 값까지 단언해 규칙이 바뀌어도 초록이 나오지 않게 한다.
  it("종료일이 바뀌는 PATCH는 링크 만료를 KST 종료일 다음날 00:00으로 다시 쓴다", async () => {
    campaignFindUniqueMock.mockResolvedValue(
      campaignFixture({ groupId: null, group: null, endDate: new Date("2026-07-01T00:00:00.000Z") }),
    );
    // syncCampaignLinkExpiry 가 트랜잭션 안에서 다시 읽는 salesCampaign.findMany —
    // 무그룹이라 대상은 자기 자신(id: "c1") 하나뿐이다.
    groupMembersFindManyMock.mockResolvedValueOnce([
      { id: "c1", endDate: new Date("2026-07-20T00:00:00.000Z") },
    ]);

    await PATCH(patchRequest({ startDate: "2026-07-01", endDate: "2026-07-20" }), context());

    // 2026-07-20T00:00:00Z(=07-20 09:00 KST) 종료 → 다음날 07-21 00:00 KST → UTC 07-20T15:00:00Z.
    expect(trackedLinkUpdateManyMock).toHaveBeenCalledWith({
      where: { salesCampaignId: { in: ["c1"] } },
      data: { expiresAt: new Date("2026-07-20T15:00:00.000Z") },
    });
  });

  it("종료일이 바뀌지 않는 PATCH는 링크 만료를 다시 쓰지 않는다", async () => {
    campaignFindUniqueMock.mockResolvedValue(campaignFixture({ groupId: null, group: null }));

    await PATCH(patchRequest({ invoiceInfo: '{"approvalNumber":"A-9"}' }), context());

    expect(trackedLinkUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("PATCH settlementGoodsCost — 수기 물품대금(세무 대조 전용)", () => {
  it("값·0·null 세 상태를 전부 캠페인 컬럼에 그대로 쓴다(그룹 필드가 아니다)", async () => {
    // 0 은 「타 캠페인 계산서에 합산됨」 마커라 유효값이고, null 은 미입력(공식 폴백)이다.
    for (const value of [4_889_470, 0, null]) {
      campaignUpdateMock.mockClear();
      groupUpdateMock.mockClear();
      campaignFindUniqueMock.mockResolvedValue(campaignFixture());

      const response = await PATCH(patchRequest({ settlementGoodsCost: value }), context());
      expect(response.status).toBe(200);

      const data = campaignUpdateMock.mock.calls[0][0].data as Record<string, unknown>;
      expect(data).toMatchObject({ settlementGoodsCost: value });
      // 음성 대조군 — 그룹 공유 필드 경로로 새면 멤버 전원의 값이 한 번에 덮인다.
      const groupData = (groupUpdateMock.mock.calls[0]?.[0]?.data ?? {}) as Record<string, unknown>;
      expect(groupData).not.toHaveProperty("settlementGoodsCost");
    }
  });

  it("음수는 검증에서 거부한다", async () => {
    campaignFindUniqueMock.mockResolvedValue(campaignFixture());
    const response = await PATCH(patchRequest({ settlementGoodsCost: -1 }), context());
    expect(response.status).toBe(400);
  });
});
