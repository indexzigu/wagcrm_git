import { describe, it, expect } from "vitest";
import {
  buildCalendarEntities,
  buildGapUrgencyByDate,
  collectMoneyMarkersByDate,
  foldGroupMoney,
  representativeStatus,
  sumMoneySlotAmounts,
  type CalendarCampaignInput,
  type MoneySlotAmountSource,
} from "../calendar-entities";
import { resolveCampaignMoneySlots } from "../tax-filing-board";
import type { ScheduleGap } from "../schedule-gap-briefing";

function campaign(
  over: Partial<CalendarCampaignInput> & { id: string },
): CalendarCampaignInput {
  return {
    dealName: "딜",
    sellerName: "셀러",
    sellerId: "s1",
    groupId: null,
    roundNumber: null,
    startDate: "2026-07-01",
    endDate: "2026-07-05",
    status: "ACTIVE",
    actualSales: null,
    sellerExpense: null,
    settlementSales: null,
    actualPayoutAmount: null,
    settlementGoodsCost: null,
    ...over,
  };
}

/** 근거 4필드가 필수라(생산자 누락 방지) 픽스처는 이 헬퍼로 만든다. */
function amountSource(over: Partial<MoneySlotAmountSource>): MoneySlotAmountSource {
  return {
    actualSales: null,
    sellerExpense: null,
    settlementSales: null,
    actualPayoutAmount: null,
    settlementGoodsCost: null,
    ...over,
  };
}

describe("representativeStatus", () => {
  it("가장 덜 진행된 상태를 대표로 고른다", () => {
    expect(representativeStatus(["COMPLETED", "ACTIVE", "SETTLEMENT_WAIT"])).toBe(
      "ACTIVE",
    );
    expect(representativeStatus(["SETTLEMENT_IN_PROGRESS", "COMPLETED"])).toBe(
      "SETTLEMENT_IN_PROGRESS",
    );
  });

  it("DROPPED만 있으면 대표 계산에서 폴백한다", () => {
    expect(representativeStatus(["DROPPED"])).toBe("DROPPED");
  });
});

describe("buildCalendarEntities", () => {
  it("같은 groupId 멤버 2건 이상을 그룹 바 하나로 병합한다", () => {
    const entities = buildCalendarEntities([
      campaign({ id: "a", groupId: "g1", dealName: "비타슈넬", sellerName: "별이", startDate: "2026-07-12", endDate: "2026-07-18" }),
      campaign({ id: "b", groupId: "g1", dealName: "칼마디", sellerName: "별이", startDate: "2026-07-13", endDate: "2026-07-20", status: "SETTLEMENT_WAIT" }),
      campaign({ id: "c", groupId: "g1", dealName: "철분제", sellerName: "별이", startDate: "2026-07-10", endDate: "2026-07-16" }),
    ]);

    expect(entities).toHaveLength(1);
    const group = entities[0];
    expect(group.kind).toBe("group");
    expect(group.key).toBe("group:g1");
    expect(group.memberCount).toBe(3);
    // 기간은 멤버 min~max 롤업
    expect(group.startDate).toBe("2026-07-10");
    expect(group.endDate).toBe("2026-07-20");
    // 대표 상태 = 가장 덜 진행된 멤버(ACTIVE < SETTLEMENT_WAIT)
    expect(group.status).toBe("ACTIVE");
    // 라벨: 대표딜 외 N · 셀러
    expect(group.label).toContain("외 2");
    expect(group.label).toContain("별이");
  });

  it("이 달에 보이는 그룹 멤버가 1건뿐이면 개별 바로 폴백한다(groupId 태그 유지)", () => {
    const entities = buildCalendarEntities([
      campaign({ id: "solo", groupId: "g9", dealName: "MVPO", sellerName: "하람" }),
    ]);
    expect(entities).toHaveLength(1);
    expect(entities[0].kind).toBe("campaign");
    expect(entities[0].groupId).toBe("g9");
  });

  it("무그룹 캠페인은 개별 바로 렌더하고 셀러명·차수를 라벨에 포함한다", () => {
    const entities = buildCalendarEntities([
      campaign({ id: "x", dealName: "보조배터리", sellerName: "김본명", roundNumber: 2 }),
    ]);
    expect(entities[0].kind).toBe("campaign");
    expect(entities[0].label).toBe("보조배터리 2차 · 김본명");
  });

  it("startDate 오름차순으로 안정 정렬한다", () => {
    const entities = buildCalendarEntities([
      campaign({ id: "late", startDate: "2026-07-20", dealName: "늦음" }),
      campaign({ id: "early", startDate: "2026-07-01", dealName: "빠름" }),
    ]);
    expect(entities.map((e) => e.key)).toEqual(["early", "late"]);
  });
});

describe("buildGapUrgencyByDate", () => {
  function gap(over: Partial<ScheduleGap> & { startDate: string; endDate: string; urgency: ScheduleGap["urgency"] }): ScheduleGap {
    return {
      label: "gap",
      daysFromNow: 10,
      dayCount: 1,
      actionLabel: null,
      ...over,
    };
  }

  it("DANGER/URGENT 갭 구간의 각 날짜를 긴급도로 펼친다(경계 포함)", () => {
    const map = buildGapUrgencyByDate([
      gap({ startDate: "2026-07-18T00:00:00.000Z", endDate: "2026-07-20T00:00:00.000Z", urgency: "URGENT" }),
    ]);
    expect(map.get("2026-07-18")).toBe("URGENT");
    expect(map.get("2026-07-19")).toBe("URGENT");
    expect(map.get("2026-07-20")).toBe("URGENT");
    expect(map.has("2026-07-21")).toBe(false);
  });

  it("CAUTION/PREPARE/OK 갭은 그리드 틴트에서 제외한다", () => {
    const map = buildGapUrgencyByDate([
      gap({ startDate: "2026-08-01T00:00:00.000Z", endDate: "2026-08-03T00:00:00.000Z", urgency: "CAUTION" }),
      gap({ startDate: "2026-09-01T00:00:00.000Z", endDate: "2026-09-01T00:00:00.000Z", urgency: "PREPARE" }),
    ]);
    expect(map.size).toBe(0);
  });

  it("겹치는 날은 DANGER가 URGENT를 덮어쓴다(더 급한 신호 우선)", () => {
    const map = buildGapUrgencyByDate([
      gap({ startDate: "2026-07-18T00:00:00.000Z", endDate: "2026-07-18T00:00:00.000Z", urgency: "URGENT" }),
      gap({ startDate: "2026-07-18T00:00:00.000Z", endDate: "2026-07-18T00:00:00.000Z", urgency: "DANGER" }),
    ]);
    expect(map.get("2026-07-18")).toBe("DANGER");
  });
});

describe("collectMoneyMarkersByDate — 마커는 채널 슬롯에서 파생한다", () => {
  const TODAY = "2026-09-15";

  function markersOn(date: string, input: Partial<CalendarCampaignInput>) {
    const byDate = collectMoneyMarkersByDate(
      buildCalendarEntities([campaign({ id: "c1", ...input })]),
      TODAY,
    );
    return byDate.get(date) ?? [];
  }

  it("자사몰은 지급 마커가 둘이고 입금 마커가 없다", () => {
    const byDate = collectMoneyMarkersByDate(
      buildCalendarEntities([
        campaign({
          id: "own-1",
          salesChannel: "OWN_MALL_NAVER",
          // 레거시 입금 값이 남아 있어도 캘린더에는 그리지 않는다(오너 확정 2026-08-25).
          expectedDepositDate: "2026-09-05",
          expectedSupplierPayoutDate: "2026-09-10",
          expectedPayoutDate: "2026-09-20",
        }),
      ]),
      TODAY,
    );

    expect(byDate.get("2026-09-05")).toBeUndefined();
    const supplier = byDate.get("2026-09-10")!;
    expect(supplier).toHaveLength(1);
    expect(supplier[0].slotKey).toBe("supplierPayout");
    expect(`${supplier[0].verb}(${supplier[0].counterpartLabel})`).toBe("지급(공급사)");
    // 색 축은 방향이다 — 두 지급은 상대만 다르고 방향은 같다.
    expect(supplier[0].direction).toBe("payout");

    const seller = byDate.get("2026-09-20")!;
    expect(seller[0].slotKey).toBe("payout");
    expect(seller[0].counterpartLabel).toBe("셀러");
  });

  it("자사몰 두 지급이 같은 날 겹치면 마커가 두 개 서고 슬롯 키로 구분된다", () => {
    // 렌더 키가 campaignId 만이면 여기서 React key 가 충돌해 한 건이 사라진다.
    const same = markersOn("2026-09-10", {
      salesChannel: "OWN_MALL_NAVER",
      expectedSupplierPayoutDate: "2026-09-10",
      expectedPayoutDate: "2026-09-10",
    });
    expect(same.map((m) => m.slotKey).sort()).toEqual(["payout", "supplierPayout"]);
  });

  it("완료 플래그도 슬롯이 정한 필드를 읽는다 — 공급사 완료가 셀러 지급을 완료로 만들지 않는다", () => {
    const [supplier] = markersOn("2026-09-10", {
      salesChannel: "OWN_MALL_NAVER",
      expectedSupplierPayoutDate: "2026-09-10",
      isSupplierPayoutCompleted: true,
      isPayoutCompleted: false,
    });
    expect(supplier.state).toBe("completed");

    const [seller] = markersOn("2026-09-20", {
      salesChannel: "OWN_MALL_NAVER",
      expectedPayoutDate: "2026-09-20",
      isSupplierPayoutCompleted: true,
      isPayoutCompleted: false,
    });
    expect(seller.state).toBe("pending");
  });

  it("공급사 지급 줄은 셀러 축 금액을 빌려 쓰지 않는다 — 미입력이면 null", () => {
    const [supplier] = markersOn("2026-09-10", {
      salesChannel: "OWN_MALL_NAVER",
      expectedSupplierPayoutDate: "2026-09-10",
      actualPayoutAmount: 500_000,
    });
    // actualPayoutAmount 은 **셀러** 지급액이다 — 공급사 줄에 그 숫자를 쓰면 다른 축의
    // 금액이 같은 라벨로 나간다. 물품대금 미입력이므로 「미정」이 맞다.
    expect(supplier.amount).toBeNull();
  });

  it("공급사 지급 줄은 수기 물품대금을 읽는다 (T-057)", () => {
    const [supplier] = markersOn("2026-09-10", {
      salesChannel: "OWN_MALL_NAVER",
      expectedSupplierPayoutDate: "2026-09-10",
      actualPayoutAmount: 500_000,
      settlementGoodsCost: 620_000,
    });
    // ⛔ 셀러 지급액(500,000)이 새어 나오면 안 된다 — 축이 다르다.
    expect(supplier.amount).toBe(620_000);
  });

  it("그 외 채널은 종전대로 입금·지급 두 마커를 유지한다(회귀 방지)", () => {
    const byDate = collectMoneyMarkersByDate(
      buildCalendarEntities([
        campaign({
          id: "sm-1",
          salesChannel: "SELLER_MALL",
          expectedDepositDate: "2026-09-05",
          expectedPayoutDate: "2026-09-20",
          // 셀러몰 입금 = 매출 − 셀러수수료(의무표 기준) → 300,000
          actualSales: 400_000,
          sellerExpense: 100_000,
        }),
      ]),
      TODAY,
    );
    const deposit = byDate.get("2026-09-05")!;
    expect(deposit[0].direction).toBe("deposit");
    expect(deposit[0].amount).toBe(300_000);
    // 셀러몰은 입금 상대가 셀러, 지급 상대가 공급사다(2026-08-07 의무표 정정).
    expect(deposit[0].counterpartLabel).toBe("셀러");
    expect(byDate.get("2026-09-20")![0].counterpartLabel).toBe("공급사");
  });

  it("지난 예정일이고 미완료면 지연으로 분류한다(슬롯 전환 후에도 유지)", () => {
    const [supplier] = markersOn("2026-09-01", {
      salesChannel: "OWN_MALL_NAVER",
      expectedSupplierPayoutDate: "2026-09-01",
    });
    expect(supplier.state).toBe("overdue");
  });

  /**
   * 오너 지적 2026-07-15 — 20일 예정건을 15일에 지급했으면 20일 마커는 사라지고 15일에
   * 서야 한다. 판정은 `resolveMoneySlotEffectiveDate`(슬롯 SSOT) 소관이고 여기서는 그
   * 결과가 마커 날짜로 흐르는지만 본다.
   */
  it("완료된 지급은 예정일에서 사라지고 실제 지급일에 선다", () => {
    const byDate = collectMoneyMarkersByDate(
      buildCalendarEntities([
        campaign({
          id: "moved-1",
          salesChannel: "BRAND_MALL",
          expectedPayoutDate: "2026-09-20",
          payoutCompletedAt: "2026-09-15",
          isPayoutCompleted: true,
        }),
      ]),
      TODAY,
    );

    expect(byDate.get("2026-09-20")).toBeUndefined();
    const moved = byDate.get("2026-09-15")!;
    expect(moved).toHaveLength(1);
    expect(moved[0].slotKey).toBe("payout");
    expect(moved[0].state).toBe("completed");
  });

  it("입금도 같은 규칙이다 — 실제 입금일로 옮겨간다", () => {
    const byDate = collectMoneyMarkersByDate(
      buildCalendarEntities([
        campaign({
          id: "moved-2",
          salesChannel: "BRAND_MALL",
          expectedDepositDate: "2026-09-05",
          depositReceivedAt: "2026-09-08",
          isDepositReceived: true,
        }),
      ]),
      TODAY,
    );

    expect(byDate.get("2026-09-05")).toBeUndefined();
    expect(byDate.get("2026-09-08")![0].direction).toBe("deposit");
  });

  /**
   * ⛔ 완료일이 비어 있는 완료 행(완료일 컬럼 이전·그룹 스칼라 미승계)이 화면에서
   * 통째로 사라지면 크래시 없는 침묵형 소실이다.
   */
  it("완료인데 완료일이 없으면 예정일에 완료 마커로 남는다", () => {
    const [marker] = markersOn("2026-09-20", {
      salesChannel: "BRAND_MALL",
      expectedPayoutDate: "2026-09-20",
      isPayoutCompleted: true,
    });
    expect(marker.state).toBe("completed");
  });

  it("완료 마커는 지난 날짜여도 지연이 아니다 — 이미 끝난 일이다", () => {
    const [marker] = markersOn("2026-09-10", {
      salesChannel: "BRAND_MALL",
      expectedPayoutDate: "2026-09-01",
      payoutCompletedAt: "2026-09-10",
      isPayoutCompleted: true,
    });
    expect(marker.state).toBe("completed");
  });
});

describe("sumMoneySlotAmounts", () => {
  const payout = resolveCampaignMoneySlots("BRAND_MALL").find((s) => s.key === "payout")!;
  const supplierPayout = resolveCampaignMoneySlots("OWN_MALL").find(
    (s) => s.key === "supplierPayout",
  )!;

  it("멤버 금액을 합산한다 (조합의 대금 한 건 = 멤버 전원의 합)", () => {
    const total = sumMoneySlotAmounts(
      [
        amountSource({ settlementSales: null, actualPayoutAmount: 100 }),
        amountSource({ settlementSales: null, actualPayoutAmount: 250 }),
        amountSource({ settlementSales: null, actualPayoutAmount: 50 }),
      ],
      payout,
    );
    expect(total).toBe(400);
  });

  it("값이 있는 멤버만 더한다", () => {
    const total = sumMoneySlotAmounts(
      [
        amountSource({ settlementSales: null, actualPayoutAmount: 100 }),
        amountSource({ settlementSales: null, actualPayoutAmount: null }),
        amountSource({ settlementSales: 999, actualPayoutAmount: null }),
      ],
      payout,
    );
    expect(total).toBe(100);
  });

  it("전원이 값이 없으면 0 이 아니라 null 이다", () => {
    expect(sumMoneySlotAmounts(
        [
          amountSource({ settlementSales: null, actualPayoutAmount: null }),
          amountSource({ settlementSales: 999, actualPayoutAmount: null }),
        ],
        payout,
      )).toBeNull();
  });

  it("빈 멤버 목록도 null 이다", () => {
    expect(sumMoneySlotAmounts([], payout)).toBeNull();
  });

  it("금액 컬럼이 없는 슬롯은 멤버가 아무리 많아도 null 이다", () => {
    const total = sumMoneySlotAmounts(
      [
        amountSource({ settlementSales: 100, actualPayoutAmount: 200 }),
        amountSource({ settlementSales: null, actualPayoutAmount: 300 }),
      ],
      supplierPayout,
    );
    expect(total).toBeNull();
  });
});

describe("foldGroupMoney (조합 대금 폴딩 정본)", () => {
  function member(over: Partial<CalendarCampaignInput> & { id: string }) {
    return campaign({ groupId: "g1", salesChannel: "SELLER_MALL", ...over });
  }

  // 금액은 폴딩이 아니라 슬롯 단위 조회가 소유한다(기준이 채널마다 달라 평평하게 접히지
  // 않는다) — 그래서 단언 경로가 `sumMoneySlotAmounts` 다. 규약 자체는 그대로다.
  const brandDeposit = resolveCampaignMoneySlots("BRAND_MALL").find((s) => s.key === "deposit")!;
  const brandPayout = resolveCampaignMoneySlots("BRAND_MALL").find((s) => s.key === "payout")!;

  it("금액은 멤버 합산이다 — 대표 한 명의 값이 아니다", () => {
    const members = [
      member({ id: "a", settlementSales: 100_000, actualPayoutAmount: 10_000 }),
      member({ id: "b", settlementSales: 200_000, actualPayoutAmount: 20_000 }),
      member({ id: "c", settlementSales: 300_000, actualPayoutAmount: 30_000 }),
    ];
    expect(sumMoneySlotAmounts(members, brandDeposit)).toBe(600_000);
    expect(sumMoneySlotAmounts(members, brandPayout)).toBe(60_000);
  });

  it("전원 미입력이면 null(=금액 미정)이고 0 으로 접지 않는다", () => {
    const members = [member({ id: "a" }), member({ id: "b" })];
    expect(sumMoneySlotAmounts(members, brandDeposit)).toBeNull();
    expect(sumMoneySlotAmounts(members, brandPayout)).toBeNull();
  });

  it("일부만 입력됐으면 입력된 값만 더한다", () => {
    const members = [member({ id: "a", settlementSales: 100_000 }), member({ id: "b" })];
    expect(sumMoneySlotAmounts(members, brandDeposit)).toBe(100_000);
  });

  it("완료 플래그는 전원 완료일 때만 true 다", () => {
    const partial = foldGroupMoney([
      member({ id: "a", isDepositReceived: true }),
      member({ id: "b", isDepositReceived: false }),
    ]);
    expect(partial.isDepositReceived).toBe(false);
    const all = foldGroupMoney([
      member({ id: "a", isDepositReceived: true }),
      member({ id: "b", isDepositReceived: true }),
    ]);
    expect(all.isDepositReceived).toBe(true);
  });

  it("예정일은 그룹 스칼라(CG-2 dual-read)라 대표 멤버에서 읽는다", () => {
    const fold = foldGroupMoney([
      member({ id: "a", expectedDepositDate: "2026-07-15", expectedPayoutDate: "2026-07-20" }),
      member({ id: "b", expectedDepositDate: "2026-07-15", expectedPayoutDate: "2026-07-20" }),
    ]);
    expect(fold.expectedDepositDate).toBe("2026-07-15");
    expect(fold.expectedPayoutDate).toBe("2026-07-20");
  });

  it("슬롯은 멤버 채널의 합집합이다 — 대표 채널 하나로 접지 않는다", () => {
    const fold = foldGroupMoney([
      member({ id: "a", salesChannel: "OWN_MALL" }),
      member({ id: "b", salesChannel: "BRAND_MALL" }),
    ]);
    // 자사몰[공급사 지급, 셀러 지급] ∪ 브랜드몰[입금, 셀러 지급]
    expect(fold.slots.map((slot) => slot.key).sort()).toEqual([
      "deposit",
      "payout",
      "supplierPayout",
    ]);
  });

  it("채널 미상 멤버도 기본 슬롯으로 접힌다 — 대금 칸이 통째로 사라지지 않는다", () => {
    const fold = foldGroupMoney([member({ id: "a", salesChannel: null }), member({ id: "b" })]);
    expect(fold.slots.length).toBeGreaterThan(0);
  });

  // ── 그룹 물품대금 접기 = 부분 합산 금지 (T-057) ───────────────────────────
  // 그룹은 매입 계산서 **한 장**이다. 입력된 멤버만 더하면 「일부만 반영된 합계」가 실물
  // 총액인 것처럼 보이고, 그 오답은 곧 영구 금액 불일치이거나 우연히 근사해 오확정이 된다.

  function ownMallPair(over: Array<Record<string, unknown>>) {
    return [
      member({ id: "a", salesChannel: "OWN_MALL", actualPayoutAmount: 10_000, ...over[0] }),
      member({ id: "b", salesChannel: "OWN_MALL", actualPayoutAmount: 20_000, ...over[1] }),
    ];
  }

  function supplierSlotOf(members: CalendarCampaignInput[]) {
    return foldGroupMoney(members).slots.find((slot) => slot.key === "supplierPayout")!;
  }

  it("전원 미입력이면 공급사 물품대금은 null 이다", () => {
    const members = ownMallPair([{}, {}]);
    expect(sumMoneySlotAmounts(members, supplierSlotOf(members))).toBeNull();
    // 셀러 축은 종전대로 합산된다(회귀 방지).
    const seller = foldGroupMoney(members).slots.find((slot) => slot.key === "payout")!;
    expect(sumMoneySlotAmounts(members, seller)).toBe(30_000);
  });

  it("한 멤버라도 미입력이면 그룹 전체가 null 이다 — 입력된 멤버만 더하지 않는다", () => {
    const members = ownMallPair([{ settlementGoodsCost: 620_000 }, {}]);
    // ⛔ 620,000 이 나오면 「일부만 반영된 합계」가 실물 계산서 총액으로 둔갑한 것이다.
    expect(sumMoneySlotAmounts(members, supplierSlotOf(members))).toBeNull();
  });

  it("합산 이관(0) 멤버는 「모름」이 아니다 — 총액 멤버 + 0 멤버 = 실물 1장 금액", () => {
    const members = ownMallPair([{ settlementGoodsCost: 620_000 }, { settlementGoodsCost: 0 }]);
    expect(sumMoneySlotAmounts(members, supplierSlotOf(members))).toBe(620_000);
  });

  it("전원 입력이면 합산한다", () => {
    const members = ownMallPair([{ settlementGoodsCost: 400_000 }, { settlementGoodsCost: 220_000 }]);
    expect(sumMoneySlotAmounts(members, supplierSlotOf(members))).toBe(620_000);
  });
});

describe("collectMoneyMarkersByDate — 조합은 실세계 사건 한 건으로 접는다", () => {
  const TODAY = "2026-09-15";

  function member(over: Partial<CalendarCampaignInput> & { id: string }) {
    return campaign({
      groupId: "g1",
      salesChannel: "SELLER_MALL",
      expectedDepositDate: "2026-09-20",
      // 셀러몰 입금 = 매출 − 셀러수수료 → 멤버당 100,000(3인 합산 300,000)
      actualSales: 150_000,
      sellerExpense: 50_000,
      ...over,
    });
  }

  function markersOn(date: string, campaigns: CalendarCampaignInput[]) {
    const byDate = collectMoneyMarkersByDate(buildCalendarEntities(campaigns), TODAY);
    return byDate.get(date) ?? [];
  }

  function trio() {
    return [
      member({ id: "a", dealName: "딜A" }),
      member({ id: "b", dealName: "딜B" }),
      member({ id: "c", dealName: "딜C" }),
    ];
  }

  it("3인 조합의 공유 입금 예정일에는 마커가 하나만 선다", () => {
    const markers = markersOn("2026-09-20", trio());
    expect(markers).toHaveLength(1);
    expect(markers[0].memberCount).toBe(3);
  });

  it("마커 금액은 멤버 합산이다 — 대표 한 명의 몫이 아니다", () => {
    const [marker] = markersOn("2026-09-20", trio());
    expect(marker.amount).toBe(300_000);
  });

  it("마커의 entityKey 는 그룹 바와 같은 키다 — 팝오버가 조합 상세를 되찾는다", () => {
    const [marker] = markersOn("2026-09-20", trio());
    expect(marker.entityKey).toBe("group:g1");
  });

  it("라벨은 조합 하나를 가리킨다 — 멤버 딜명 하나가 아니다", () => {
    const [marker] = markersOn("2026-09-20", trio());
    expect(marker.dealLabel).toBe("딜A 외 2");
  });

  it("한 멤버라도 미완료면 완료 마커가 되지 않는다", () => {
    const [marker] = markersOn("2026-09-20", [
      member({ id: "a", isDepositReceived: true }),
      member({ id: "b", isDepositReceived: true }),
      member({ id: "c", isDepositReceived: false }),
    ]);
    expect(marker.state).toBe("pending");
  });

  it("슬롯은 멤버 채널 합집합이다 — 대표 채널로 접어 레그를 잃지 않는다", () => {
    const markers = markersOn("2026-09-20", [
      member({ id: "a", salesChannel: "OWN_MALL", expectedSupplierPayoutDate: "2026-09-20" }),
      member({ id: "b", salesChannel: "BRAND_MALL", expectedSupplierPayoutDate: "2026-09-20" }),
    ]);
    // 자사몰[공급사 지급] ∪ 브랜드몰[입금] — 어느 쪽도 조용히 사라지지 않는다.
    expect(markers.map((marker) => marker.slotKey).sort()).toEqual([
      "deposit",
      "supplierPayout",
    ]);
  });

  it("이 달에 바가 없어도 자금 예정일만 있으면 마커가 잡힌다(기존 계약 유지)", () => {
    // 기간은 7월인데 입금 예정일은 9월 — 9월 그리드에 바가 없어도 도트는 서야 한다.
    const markers = markersOn("2026-09-20", [
      member({ id: "a", startDate: "2026-07-01", endDate: "2026-07-05" }),
      member({ id: "b", startDate: "2026-07-01", endDate: "2026-07-05" }),
    ]);
    expect(markers).toHaveLength(1);
  });

  it("이 달에 보이는 멤버가 1건뿐이면 개별 마커로 폴백한다(바와 같은 규칙)", () => {
    const [marker] = markersOn("2026-09-20", [member({ id: "a", dealName: "딜A" })]);
    expect(marker.entityKey).toBe("a");
    expect(marker.memberCount).toBe(1);
    expect(marker.amount).toBe(100_000);
    expect(marker.dealLabel).toBe("딜A");
  });
});
