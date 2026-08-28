/**
 * getCalendarMonthCampaigns — CG-2 dual-read 그룹-정본(무폴백) 계약.
 *
 * 그룹 캠페인은 그룹 값이 정본이다 — 그룹 값이 null이어도 캠페인 잔존 스칼라로
 * 폴백하지 않는다. read-time 멤버 폴백은 오너가 그룹 예정일을 "명시적으로 지운"
 * 값을 되살리는 결함이 있었다("미설정 virgin"과 "명시 삭제"는 read 시점에 구분
 * 불가). 근본수정은 형성 시 승계(campaignGroupService.inheritGroupSettlement)+
 * 기존 그룹 백필(#155)이고, 렌더 계층은 데스크톱 campaign-row와 동일하게
 * 그룹-정본을 유지한다.
 *
 * 계약: 날짜·완료 플래그 모두 그룹 소속이면 무조건 그룹이 정본, 비그룹이면
 * 캠페인 값. 정산 금액은 캠페인 소유 유지(방화벽).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findMany: findManyMock },
  }),
}));

const { getCalendarMonthCampaigns } = await import("./mobile-calendar-data");

type DbRow = {
  id: string;
  dealName?: string;
  groupId: string | null;
  group: {
    expectedDepositDate: Date | null;
    expectedPayoutDate: Date | null;
    isDepositReceived: boolean;
    isPayoutCompleted: boolean;
    depositReceivedAt?: Date | null;
    payoutCompletedAt?: Date | null;
    supplierPayoutCompletedAt?: Date | null;
    name?: string | null;
  } | null;
  startDate: Date;
  endDate: Date;
  status: string;
  sellerId: string;
  roundNumber: number | null;
  expectedDepositDate: Date | null;
  expectedPayoutDate: Date | null;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  depositReceivedAt?: Date | null;
  payoutCompletedAt?: Date | null;
  supplierPayoutCompletedAt?: Date | null;
  deal: { dealName: string };
  seller: { name: string; alias: string | null };
};

function makeRow(overrides: Partial<DbRow> = {}): DbRow {
  return {
    id: "camp-1",
    groupId: null,
    group: null,
    startDate: new Date("2026-06-15T00:00:00.000Z"),
    endDate: new Date("2026-06-23T00:00:00.000Z"),
    status: "SETTLEMENT_WAIT",
    sellerId: "seller-1",
    roundNumber: null,
    expectedDepositDate: null,
    expectedPayoutDate: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    deal: { dealName: "테스트 딜" },
    seller: { name: "테스트 셀러", alias: null },
    ...overrides,
  };
}

describe("getCalendarMonthCampaigns — CG-2 dual-read 그룹-정본(무폴백)", () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it("그룹 날짜 null이면 멤버 잔존 예정일로 되살리지 않는다(오너 명시 삭제 보존)", async () => {
    // 그룹 값 null + 멤버 스칼라 존재는 "그룹핑 시점에 얼어붙은 잔존값"이다.
    // 폴백하면 오너가 그룹에서 지운 예정일을 되살리므로, 그룹-정본으로 null을
    // 그대로 노출한다(기존 그룹의 미표시는 #155 백필이 승계로 해소).
    findManyMock.mockResolvedValue([
      makeRow({
        groupId: "group-1",
        group: {
          expectedDepositDate: null,
          expectedPayoutDate: null,
          isDepositReceived: false,
          isPayoutCompleted: false,
          name: "그룹 A",
        },
        expectedDepositDate: new Date("2026-07-20T00:00:00.000Z"),
        expectedPayoutDate: new Date("2026-07-20T00:00:00.000Z"),
        isDepositReceived: false,
        isPayoutCompleted: true,
      }),
    ]);

    const [row] = await getCalendarMonthCampaigns(2026, 7);
    expect(row.expectedDepositDate).toBeNull();
    expect(row.expectedPayoutDate).toBeNull();
    // 플래그는 그룹 소속이면 무조건 그룹 정본 — 멤버의 정체된 true에 속지 않는다.
    expect(row.isDepositReceived).toBe(false);
    expect(row.isPayoutCompleted).toBe(false);
  });

  it("그룹 플래그 true — 수령 처리가 멤버 잔존값으로 역행하지 않는다(HIGH 회귀)", async () => {
    // 정산 토글은 그룹 멤버면 그룹 레코드만 갱신하고 그룹 예정일은 건드리지
    // 않는다(settlement-status 라우트) — "그룹 날짜 null + 그룹 플래그 true"는
    // 정상 운영에서 흔한 조합이다. 날짜는 그룹-정본(null)이지만 플래그는 그룹의
    // true가 이겨야 하며, 멤버의 정체된 false로 역행하면 안 된다.
    findManyMock.mockResolvedValue([
      makeRow({
        groupId: "group-1",
        group: {
          expectedDepositDate: null,
          expectedPayoutDate: null,
          isDepositReceived: true,
          isPayoutCompleted: true,
          name: "그룹 A",
        },
        expectedDepositDate: new Date("2026-07-20T00:00:00.000Z"),
        expectedPayoutDate: null,
        isDepositReceived: false,
        isPayoutCompleted: false,
      }),
    ]);

    const [row] = await getCalendarMonthCampaigns(2026, 7);
    expect(row.expectedDepositDate).toBeNull();
    expect(row.isDepositReceived).toBe(true);
    expect(row.isPayoutCompleted).toBe(true);
  });

  it("그룹 값이 있으면 그룹이 정본 — 멤버 잔존값·잔존 플래그는 무시한다", async () => {
    findManyMock.mockResolvedValue([
      makeRow({
        groupId: "group-1",
        group: {
          expectedDepositDate: new Date("2026-07-25T00:00:00.000Z"),
          expectedPayoutDate: new Date("2026-07-28T00:00:00.000Z"),
          isDepositReceived: true,
          isPayoutCompleted: false,
          name: "그룹 A",
        },
        expectedDepositDate: new Date("2026-07-01T00:00:00.000Z"),
        expectedPayoutDate: new Date("2026-07-02T00:00:00.000Z"),
        isDepositReceived: false,
        isPayoutCompleted: true,
      }),
    ]);

    const [row] = await getCalendarMonthCampaigns(2026, 7);
    expect(row.expectedDepositDate).toBe("2026-07-25T00:00:00.000Z");
    expect(row.expectedPayoutDate).toBe("2026-07-28T00:00:00.000Z");
    expect(row.isDepositReceived).toBe(true);
    expect(row.isPayoutCompleted).toBe(false);
  });

  it("비그룹 캠페인은 자기 값 그대로 통과한다", async () => {
    findManyMock.mockResolvedValue([
      makeRow({
        expectedDepositDate: new Date("2026-07-10T00:00:00.000Z"),
        isDepositReceived: true,
      }),
    ]);

    const [row] = await getCalendarMonthCampaigns(2026, 7);
    expect(row.expectedDepositDate).toBe("2026-07-10T00:00:00.000Z");
    expect(row.expectedPayoutDate).toBeNull();
    expect(row.isDepositReceived).toBe(true);
    expect(row.isPayoutCompleted).toBe(false);
  });

  it("월 필터는 판매기간 겹침 OR 예정일(캠페인·그룹) 소속을 유지한다", async () => {
    findManyMock.mockResolvedValue([]);
    await getCalendarMonthCampaigns(2026, 7);

    const where = findManyMock.mock.calls[0][0].where;
    // 자사몰 공급사 지급일(캠페인·그룹)이 더해져 5 → 7, 실제 완료일 3종(캠페인·그룹)이
    // 더해져 7 → 13. ⚠️ 대금 필드를 늘리면서 이 절을 안 늘리면 그 날짜만 이 달에 있는
    // 캠페인이 통째로 안 실려 마커가 조용히 사라진다.
    expect(where.OR).toHaveLength(13);
    expect(where.OR[0]).toHaveProperty("startDate");
    expect(where.OR[1]).toHaveProperty("expectedDepositDate");
    expect(where.OR[2]).toHaveProperty("expectedPayoutDate");
    expect(where.OR[3]).toHaveProperty("expectedSupplierPayoutDate");
    expect(where.OR[7]).toHaveProperty("group.expectedDepositDate");
    expect(where.OR[8]).toHaveProperty("group.expectedPayoutDate");
    expect(where.OR[9]).toHaveProperty("group.expectedSupplierPayoutDate");
  });

  /**
   * 완료된 대금 칸은 **실제로 오간 날**에 선다(`resolveMoneySlotEffectiveDate`). 그 날짜가
   * 예정일과 다른 달이면 — 9월 예정건을 8월에 지급한 경우 — 조회 창이 완료일을 안 보는 한
   * 그 캠페인은 8월 응답에 **아예 실리지 않아** 마커가 조용히 사라진다.
   */
  it("월 필터가 실제 완료일(캠페인·그룹)도 본다 — 예정일과 다른 달에 지급한 건이 사라지지 않는다", async () => {
    findManyMock.mockResolvedValue([]);
    await getCalendarMonthCampaigns(2026, 7);

    const where = findManyMock.mock.calls[0][0].where;
    const keys = where.OR.flatMap((clause: Record<string, unknown>) => Object.keys(clause));
    const groupKeys = where.OR.flatMap((clause: Record<string, { [k: string]: unknown }>) =>
      clause.group ? Object.keys(clause.group) : [],
    );
    for (const field of ["depositReceivedAt", "payoutCompletedAt", "supplierPayoutCompletedAt"]) {
      expect(keys).toContain(field);
      expect(groupKeys).toContain(field);
    }
  });

  it("완료일도 CG-2 그룹-정본이다 — 그룹이 null 이면 멤버 잔존값으로 되살리지 않는다", async () => {
    findManyMock.mockResolvedValue([
      makeRow({
        groupId: "group-1",
        group: {
          expectedDepositDate: null,
          expectedPayoutDate: null,
          isDepositReceived: false,
          isPayoutCompleted: true,
          payoutCompletedAt: new Date("2026-07-15T00:00:00.000Z"),
          name: "그룹 A",
        },
        expectedPayoutDate: new Date("2026-07-20T00:00:00.000Z"),
        isPayoutCompleted: true,
        payoutCompletedAt: new Date("2026-07-02T00:00:00.000Z"),
      }),
    ]);

    const [row] = await getCalendarMonthCampaigns(2026, 7);
    expect(row.payoutCompletedAt).toBe("2026-07-15T00:00:00.000Z");
    expect(row.depositReceivedAt).toBeNull();
  });

  it("비그룹 캠페인의 완료일은 자기 값 그대로 통과한다", async () => {
    findManyMock.mockResolvedValue([
      makeRow({
        expectedPayoutDate: new Date("2026-07-20T00:00:00.000Z"),
        isPayoutCompleted: true,
        payoutCompletedAt: new Date("2026-07-15T00:00:00.000Z"),
        supplierPayoutCompletedAt: new Date("2026-07-11T00:00:00.000Z"),
      }),
    ]);

    const [row] = await getCalendarMonthCampaigns(2026, 7);
    expect(row.payoutCompletedAt).toBe("2026-07-15T00:00:00.000Z");
    expect(row.supplierPayoutCompletedAt).toBe("2026-07-11T00:00:00.000Z");
    expect(row.depositReceivedAt).toBeNull();
  });
});
