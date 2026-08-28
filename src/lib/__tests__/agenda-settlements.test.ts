import { describe, it, expect } from "vitest";
import { buildOverdueSettlementItems, type AgendaSettlementCampaign } from "../agenda-settlements";

/**
 * 지연된 정산의 그룹캠페인 규약(CG-1) 회귀:
 * ① 그룹 멤버 N행은 지연 1건(그룹명·금액 합산·대표 id)으로 접힌다.
 * ② 지연 판정은 그룹 플래그가 SoT — 멤버 플래그가 낡아도(false) 그룹이 입금 완료면
 *    지연으로 뜨지 않는다.
 * ③ 그룹 날짜가 null이면 멤버 최솟값 폴백(buildUpcomingEvents와 동일 규칙).
 */
describe("buildOverdueSettlementItems", () => {
  const now = new Date("2026-07-31T00:00:00.000Z");
  const past = new Date("2026-07-20T00:00:00.000Z");
  const future = new Date("2026-08-20T00:00:00.000Z");

  const base = (over: Partial<AgendaSettlementCampaign>): AgendaSettlementCampaign => ({
    id: "c1",
    status: "SETTLEMENT_WAIT",
    // 셀러몰(입금+지급) — 종전 픽스처의 암묵 채널이다. 자사몰 회귀는 아래 별도 describe.
    salesChannel: "SELLER_MALL",
    expectedDepositDate: past,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    settlementSales: 100,
    actualPayoutAmount: 40,
    groupId: null,
    group: null,
    deal: { dealName: "비타민" },
    seller: { name: "본명", alias: "가온", accountNumber: "110-1234", snsType: "INSTAGRAM" },
    ...over,
  });

  it("미그룹 캠페인은 종전과 동일하게 행 단위로 판정한다", () => {
    const items = buildOverdueSettlementItems([base({})], now);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "c1",
      title: "비타민 - 가온",
      label: "셀러 입금 지연",
      overdueSlot: { kind: "DEPOSIT", verb: "입금", counterpartLabel: "셀러", flagField: "isDepositReceived" },
      targetAmount: 100,
      settlementSales: 100,
    });
  });

  it("그룹 멤버 3행은 그룹명 라벨의 지연 1건으로 접히고 금액은 멤버 합산이다", () => {
    const group = {
      name: "[가온] 비타민 외 2건",
      expectedDepositDate: past,
      expectedPayoutDate: null,
      expectedSupplierPayoutDate: null,
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
    };
    const items = buildOverdueSettlementItems(
      [
        base({ id: "m1", groupId: "g1", group, settlementSales: 100 }),
        base({ id: "m2", groupId: "g1", group, deal: { dealName: "오메가3" }, settlementSales: 50 }),
        base({ id: "m3", groupId: "g1", group, deal: { dealName: "유산균" }, settlementSales: 30, actualPayoutAmount: 10 }),
      ],
      now,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "m1",
      title: "[가온] 비타민 외 2건",
      label: "셀러 입금 지연",
      settlementSales: 180,
      actualPayoutAmount: 90,
    });
  });

  it("그룹 플래그가 SoT — 멤버 플래그가 낡아도 그룹이 입금 완료면 지연이 아니다", () => {
    const group = {
      name: "[가온] 비타민 외 1건",
      expectedDepositDate: past,
      expectedPayoutDate: future,
      expectedSupplierPayoutDate: null,
      isDepositReceived: true, // 그룹에서 입금 처리됨
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
    };
    const items = buildOverdueSettlementItems(
      [
        base({ id: "m1", groupId: "g1", group, isDepositReceived: false }),
        base({ id: "m2", groupId: "g1", group, isDepositReceived: false }),
      ],
      now,
    );
    // 입금은 그룹 기준 완료, 지급 예정일은 미래 → 지연 항목 없음
    expect(items).toEqual([]);
  });

  it("그룹 날짜가 null이면 멤버 최솟값으로 폴백해 판정한다", () => {
    const group = {
      name: null,
      expectedDepositDate: null,
      expectedPayoutDate: null,
      expectedSupplierPayoutDate: null,
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
    };
    const items = buildOverdueSettlementItems(
      [
        base({ id: "m1", groupId: "g1", group, expectedDepositDate: future }),
        base({ id: "m2", groupId: "g1", group, deal: { dealName: "오메가3" }, expectedDepositDate: past }),
      ],
      now,
    );
    expect(items).toHaveLength(1);
    // 그룹명이 없으면 대표 딜명 + 외 N-1건 합성
    expect(items[0]).toMatchObject({ title: "비타민 - 가온 외 1건", label: "셀러 입금 지연" });
    expect(items[0].dueDate).toBe(past.toISOString());
  });

  it("지급 지연만 있는 미그룹 건은 지급 지연으로 표기한다", () => {
    const items = buildOverdueSettlementItems(
      [base({ expectedDepositDate: null, expectedPayoutDate: past })],
      now,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: "공급사 지급 지연",
      overdueSlot: { flagField: "isPayoutCompleted" },
      targetAmount: 40,
    });
  });
});

describe("buildOverdueSettlementItems — 정렬", () => {
  it("마감일 오름차순 — 더 오래 지연된 그룹 건이 미그룹 건보다 앞에 온다", () => {
    const now = new Date("2026-07-31T00:00:00.000Z");
    const older = new Date("2026-07-01T00:00:00.000Z");
    const newer = new Date("2026-07-25T00:00:00.000Z");
    const group = {
      name: "[가온] 비타민 외 1건",
      expectedDepositDate: older,
      expectedPayoutDate: null,
      expectedSupplierPayoutDate: null,
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
    };
    const base = (over: Partial<AgendaSettlementCampaign>): AgendaSettlementCampaign => ({
      id: "x",
      status: "SETTLEMENT_WAIT",
      salesChannel: "SELLER_MALL",
      expectedDepositDate: newer,
      expectedPayoutDate: null,
      expectedSupplierPayoutDate: null,
      isDepositReceived: false,
      isPayoutCompleted: false,
      isSupplierPayoutCompleted: false,
      settlementSales: 0,
      actualPayoutAmount: 0,
      groupId: null,
      group: null,
      deal: { dealName: "콜라겐" },
      seller: { name: "본명", alias: "가온", accountNumber: null, snsType: null },
      ...over,
    });
    const items = buildOverdueSettlementItems(
      [
        base({ id: "solo" }),
        base({ id: "m1", groupId: "g1", group, deal: { dealName: "비타민" } }),
        base({ id: "m2", groupId: "g1", group, deal: { dealName: "오메가3" } }),
      ],
      now,
    );
    expect(items.map((i) => i.id)).toEqual(["m1", "solo"]);
  });
});

/**
 * 자사몰(2026-08-25 2단계) — 슬롯이 [공급사 지급, 셀러 지급]이고 입금 칸이 없다.
 * 종전 코드는 입금·지급 두 축을 상수로 박아 둬서 ①공급사 지급 지연을 **아예 감지하지
 * 못하고** ②레거시 입금 예정일이 남아 있으면 있지도 않은 「입금 지연」을 냈다.
 */
describe("buildOverdueSettlementItems — 자사몰 슬롯", () => {
  const now = new Date("2026-07-31T00:00:00.000Z");
  const past = new Date("2026-07-20T00:00:00.000Z");
  const future = new Date("2026-08-20T00:00:00.000Z");

  const ownMall = (over: Partial<AgendaSettlementCampaign>): AgendaSettlementCampaign => ({
    id: "own-1",
    status: "SETTLEMENT_IN_PROGRESS",
    salesChannel: "OWN_MALL_NAVER",
    expectedDepositDate: null,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    settlementSales: 100,
    actualPayoutAmount: 40,
    groupId: null,
    group: null,
    deal: { dealName: "비타민" },
    seller: { name: "본명", alias: "가온", accountNumber: "110-1234", snsType: "INSTAGRAM" },
    ...over,
  });

  it("공급사 지급 예정일이 지나면 지연으로 잡고 전용 플래그를 쓰기 대상으로 낸다", () => {
    const items = buildOverdueSettlementItems([ownMall({ expectedSupplierPayoutDate: past })], now);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: "공급사 지급 지연",
      overdueSlot: { kind: "PAYOUT", counterpartLabel: "공급사", flagField: "isSupplierPayoutCompleted" },
    });
    // 공급사 지급에는 대응하는 금액 컬럼이 없다 — 0 이 아니라 「모름」이어야 한다.
    expect(items[0].targetAmount).toBeNull();
  });

  it("레거시 입금 예정일이 남아 있어도 입금 지연을 만들지 않는다(칸 자체가 없다)", () => {
    const items = buildOverdueSettlementItems(
      [ownMall({ expectedDepositDate: past, expectedSupplierPayoutDate: future })],
      now,
    );
    expect(items).toEqual([]);
  });

  it("공급사 지급이 끝나면 다음 칸(셀러 지급)이 지연 대상이 되고 금액은 지급액이다", () => {
    const items = buildOverdueSettlementItems(
      [
        ownMall({
          isSupplierPayoutCompleted: true,
          expectedSupplierPayoutDate: past,
          expectedPayoutDate: past,
        }),
      ],
      now,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: "셀러 지급 지연",
      overdueSlot: { flagField: "isPayoutCompleted" },
      targetAmount: 40,
    });
  });
});

/**
 * 「오늘」 경계 통일 (T-062, 2026-08-27).
 *
 * 종전 이 빌더는 `date <= now` 로 판정했다. 예정일은 전부 UTC 자정(=KST 09:00)으로
 * 저장되므로 그 식은 **오늘 예정인 건을 오전 9시부터** 지연으로 봤고, 같은 데이터를 읽는
 * 모바일 대기 목록은 `ymd < today`(어제까지)여서 두 화면이 하루 어긋나 있었다.
 * 경계 SSOT 는 `settlement-stage.isOverdueKst` — 오늘은 아직 늦지 않았다.
 */
describe("buildOverdueSettlementItems — 오늘 경계", () => {
  // KST 2026-07-31 12:00. 종전 식이라면 아래 「오늘 예정」이 이미 지연으로 잡혔다.
  const now = new Date("2026-07-31T03:00:00.000Z");

  const withDeposit = (expectedDepositDate: Date): AgendaSettlementCampaign => ({
    id: "c1",
    status: "SETTLEMENT_WAIT",
    salesChannel: "SELLER_MALL",
    expectedDepositDate,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    settlementSales: 100,
    actualPayoutAmount: 40,
    groupId: null,
    group: null,
    deal: { dealName: "비타민" },
    seller: { name: "본명", alias: "가온", accountNumber: "110-1234", snsType: "INSTAGRAM" },
  });

  it("오늘 예정인 건은 지연이 아니다", () => {
    const today = new Date("2026-07-31T00:00:00.000Z");
    expect(today <= now).toBe(true); // 종전 식은 참이었다
    expect(buildOverdueSettlementItems([withDeposit(today)], now)).toHaveLength(0);
  });

  it("어제 예정인 건은 지연이다", () => {
    const items = buildOverdueSettlementItems(
      [withDeposit(new Date("2026-07-30T00:00:00.000Z"))],
      now,
    );
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("셀러 입금 지연");
  });

  it("내일 예정인 건은 지연이 아니다", () => {
    expect(
      buildOverdueSettlementItems([withDeposit(new Date("2026-08-01T00:00:00.000Z"))], now),
    ).toHaveLength(0);
  });
});
