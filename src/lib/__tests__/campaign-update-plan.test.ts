import { describe, it, expect } from "vitest";
import {
  resolveSettlementStates,
  diffCampaignChanges,
  resolveSettlementSync,
  resolveReturnPeriodEndDate,
  resolveAutoStatus,
  type CampaignUpdateData,
  type PreviousCampaignForUpdate,
} from "@/lib/campaign-update-plan";

/**
 * 그룹 스칼라 픽스처 — 정산일 5종은 그룹이 SoT이고 **멤버 컬럼은 낡을 수 있다**.
 * 그래서 그룹 케이스는 멤버와 그룹에 **일부러 다른 값**을 넣어, 판정이 어느 쪽을 보는지
 * 실제로 갈리게 한다(멤버를 보면 실패하는 픽스처여야 회귀를 잡는다).
 */
function baseGroup(
  overrides: Partial<NonNullable<PreviousCampaignForUpdate["group"]>> = {},
): NonNullable<PreviousCampaignForUpdate["group"]> {
  return {
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    invoiceInfo: null,
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    expectedDepositDate: null,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    accountingCompletedAt: null,
    ...overrides,
  };
}

function basePrevious(overrides: Partial<PreviousCampaignForUpdate> = {}): PreviousCampaignForUpdate {
  return {
    status: "ACTIVE",
    salesChannel: "OWN_MALL",
    actualSales: "100",
    operatingExpense: "10",
    miscExpense: "0",
    quantity: 5,
    itemCount: 2,
    totalMarginRate: "20",
    sellerMarginRate: "10",
    netMarginRate: "10",
    isManualMargin: false,
    isManualSettlementSales: false,
    isManualSellerExpense: false,
    isManualTaxExpense: false,
    startDate: new Date("2026-08-01T00:00:00.000Z"),
    endDate: new Date("2026-08-10T00:00:00.000Z"),
    returnPeriodEndDate: null,
    roundNumber: 1,
    campaignName: "기존캠페인명",
    settlementSupplyCost: "1000",
    settlementGoodsCost: "500",
    supplierInvoiceIssuedAt: null,
    sellerInvoiceIssuedAt: null,
    expectedDepositDate: null,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    accountingCompletedAt: null,
    dealId: "deal-1",
    sellerId: "seller-1",
    notesFromImport: null,
    groupId: null,
    group: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    ...overrides,
  };
}

describe("resolveSettlementStates", () => {
  it("비그룹 캠페인은 자기 자신의 입금/지급 플래그를 previous 로 쓴다", () => {
    const previous = basePrevious({ isDepositReceived: true, isPayoutCompleted: false });
    const states = resolveSettlementStates({}, previous);
    expect(states.isGrouped).toBe(false);
    expect(states.previousDepositState).toBe(true);
    expect(states.previousPayoutState).toBe(false);
    expect(states.newDepositState).toBe(true);
    expect(states.newPayoutState).toBe(false);
  });

  it("그룹 캠페인은 그룹 스칼라를 previous 로 쓴다(멤버 플래그가 낡아도)", () => {
    const previous = basePrevious({
      groupId: "group-1",
      isDepositReceived: false, // 멤버 컬럼은 낡음
      isPayoutCompleted: false,
      group: baseGroup({ isDepositReceived: true, isPayoutCompleted: true, invoiceInfo: "그룹메모" }),
    });
    const states = resolveSettlementStates({}, previous);
    expect(states.isGrouped).toBe(true);
    expect(states.previousDepositState).toBe(true);
    expect(states.previousPayoutState).toBe(true);
    expect(states.previousInvoiceInfo).toBe("그룹메모");
  });

  it("depositReceivedAt 명시값이 boolean 필드보다 우선한다", () => {
    const previous = basePrevious({ isDepositReceived: false });
    const states = resolveSettlementStates({ depositReceivedAt: "2026-08-05", isDepositReceived: false }, previous);
    expect(states.newDepositState).toBe(true);
  });

  it("invoiceInfo 는 notesFromImport 로 폴백한다", () => {
    const previous = basePrevious({ notesFromImport: "이전메모" });
    const states = resolveSettlementStates({ notesFromImport: "새메모" }, previous);
    expect(states.invoiceInfo).toBe("새메모");
    expect(states.previousInvoiceInfo).toBe("이전메모");
  });
});

describe("resolveSettlementSync", () => {
  const now = new Date("2026-08-07T00:00:00.000Z");

  it("depositReceivedAt 명시값(date) → 커밋 + true", () => {
    const previous = basePrevious();
    const states = resolveSettlementStates({}, previous);
    const sync = resolveSettlementSync({ depositReceivedAt: "2026-08-05" }, states, now);
    expect(sync.isDepositReceived).toBe(true);
    expect(sync.depositReceivedAt).toEqual(new Date("2026-08-05"));
  });

  it("depositReceivedAt 명시값(null) → 커밋 + false", () => {
    const previous = basePrevious();
    const states = resolveSettlementStates({}, previous);
    const sync = resolveSettlementSync({ depositReceivedAt: null }, states, now);
    expect(sync.isDepositReceived).toBe(false);
    expect(sync.depositReceivedAt).toBeNull();
  });

  it("불린 토글(isDepositReceived 만 옴, 값 변경) → now 로 채운다", () => {
    const previous = basePrevious({ isDepositReceived: false });
    const states = resolveSettlementStates({}, previous);
    const sync = resolveSettlementSync({ isDepositReceived: true }, states, now);
    expect(sync.isDepositReceived).toBe(true);
    expect(sync.depositReceivedAt).toEqual(now);
  });

  it("no-op(값이 이전과 동일) → settlementSync 에 아무 것도 안 실린다", () => {
    const previous = basePrevious({ isDepositReceived: true });
    const states = resolveSettlementStates({}, previous);
    const sync = resolveSettlementSync({ isDepositReceived: true }, states, now);
    expect(sync).toEqual({});
  });

  it("payout 도 동일 3분기를 따른다", () => {
    const previous = basePrevious({ isPayoutCompleted: false });
    const states = resolveSettlementStates({}, previous);
    expect(resolveSettlementSync({ payoutCompletedAt: "2026-08-06" }, states, now).isPayoutCompleted).toBe(true);
    expect(resolveSettlementSync({ payoutCompletedAt: null }, states, now).isPayoutCompleted).toBe(false);
    expect(resolveSettlementSync({ isPayoutCompleted: true }, states, now).payoutCompletedAt).toEqual(now);
  });
});

describe("resolveReturnPeriodEndDate", () => {
  it("명시값이 있으면 그대로(Date 변환) 쓴다", () => {
    const previous = basePrevious({ returnPeriodEndDate: null });
    const result = resolveReturnPeriodEndDate({ returnPeriodEndDate: "2026-09-01" }, previous);
    expect(result).toEqual(new Date("2026-09-01"));
  });

  it("명시적으로 null 을 보내면 null 로 지운다", () => {
    const previous = basePrevious({ returnPeriodEndDate: new Date("2026-08-01") });
    const result = resolveReturnPeriodEndDate({ returnPeriodEndDate: null }, previous);
    expect(result).toBeNull();
  });

  // ⚠️ basePrevious 의 endDate 는 2026-08-10 이다 — "변경" 케이스는 반드시 그와 **다른**
  // 날짜를 보내야 한다(종전 픽스처는 같은 값을 보내면서 이름만 "변경"이라 T-019 를 놓쳤다).
  it("endDate 실제 변경 + 기존값 없음 → +14일 자동", () => {
    const previous = basePrevious({ returnPeriodEndDate: null });
    const result = resolveReturnPeriodEndDate({ endDate: "2026-08-17" }, previous);
    const expected = new Date("2026-08-17");
    expected.setDate(expected.getDate() + 14);
    expect(result).toEqual(expected);
  });

  it("endDate 실제 변경 + 기존값 있음 → 자동 미발동(undefined)", () => {
    const previous = basePrevious({ returnPeriodEndDate: new Date("2026-08-20") });
    const result = resolveReturnPeriodEndDate({ endDate: "2026-08-17" }, previous);
    expect(result).toBeUndefined();
  });

  // T-019 회귀 — 종료일을 **같은 값으로 재전송**해도 비어 있던 반품기간에 날짜가 생기면 안 된다.
  // 비어 있음 = "반품기간 미정"이라는 오너의 의도이고, 무관한 필드 저장이 그걸 덮으면 안 된다.
  it("endDate 를 같은 값으로 재전송 + 기존값 없음 → 자동 미발동(undefined)", () => {
    const previous = basePrevious({ returnPeriodEndDate: null });
    const result = resolveReturnPeriodEndDate({ endDate: "2026-08-10" }, previous);
    expect(result).toBeUndefined();
  });

  it("endDate 재전송 판정은 시각 성분이 아니라 날짜로 한다(자정 정규화된 같은 날 = 무변경)", () => {
    const previous = basePrevious({
      returnPeriodEndDate: null,
      endDate: new Date("2026-08-10T00:00:00.000Z"),
    });
    const result = resolveReturnPeriodEndDate({ endDate: "2026-08-10" }, previous);
    expect(result).toBeUndefined();
  });

  it("returnPeriodEndDate, endDate 둘 다 미입력 → undefined", () => {
    const previous = basePrevious({ returnPeriodEndDate: null });
    const result = resolveReturnPeriodEndDate({}, previous);
    expect(result).toBeUndefined();
  });
});

describe("resolveAutoStatus", () => {
  /** 요구 플래그 밖 상태는 전부 false 인 기본 스냅샷. */
  function legStates(overrides: Partial<Parameters<typeof resolveAutoStatus>[0]> = {}) {
    return {
      newDepositState: false,
      previousDepositState: false,
      newPayoutState: false,
      previousPayoutState: false,
      newSupplierPayoutState: false,
      previousSupplierPayoutState: false,
      ...overrides,
    };
  }

  it("일반 채널: 입금·지급 둘 다 참이 되면 COMPLETED", () => {
    const states = legStates({
      newDepositState: true,
      newPayoutState: true,
      previousPayoutState: true,
    });
    expect(resolveAutoStatus(states, "ACTIVE", "BRAND_MALL")).toBe("COMPLETED");
  });

  it("일반 채널: 하나만 참이 되고 이전 상태가 COMPLETED 면 SETTLEMENT_WAIT", () => {
    const states = legStates({ newDepositState: true });
    expect(resolveAutoStatus(states, "COMPLETED", "BRAND_MALL")).toBe("SETTLEMENT_WAIT");
  });

  it("일반 채널: 이전 상태가 COMPLETED 아니고 하나만 참 → undefined", () => {
    const states = legStates({ newDepositState: true });
    expect(resolveAutoStatus(states, "ACTIVE", "BRAND_MALL")).toBeUndefined();
  });

  it("상태 변화 없음 → undefined", () => {
    const states = legStates({
      newDepositState: true,
      previousDepositState: true,
      newPayoutState: true,
      previousPayoutState: true,
    });
    expect(resolveAutoStatus(states, "COMPLETED", "BRAND_MALL")).toBeUndefined();
  });

  it("자사몰: 공급사+셀러 지급이 모두 참이 되면 입금과 무관하게 COMPLETED", () => {
    const states = legStates({
      newPayoutState: true,
      newSupplierPayoutState: true,
      previousSupplierPayoutState: false,
      previousPayoutState: true,
    });
    // 입금 플래그는 영원히 false — 자사몰은 몰 정산금이 일별 입금이라 입금 칸이 없다.
    expect(resolveAutoStatus(states, "SETTLEMENT_WAIT", "OWN_MALL_NAVER")).toBe("COMPLETED");
  });

  it("자사몰: 셀러 지급만 참이면 완료가 아니다(공급사 지급 미완)", () => {
    const states = legStates({ newPayoutState: true });
    expect(resolveAutoStatus(states, "ACTIVE", "OWN_MALL_NAVER")).toBeUndefined();
  });

  it("자사몰: 입금 플래그 토글은 판정 집합 밖이라 status 를 흔들지 않는다", () => {
    const states = legStates({ newDepositState: true });
    expect(resolveAutoStatus(states, "COMPLETED", "OWN_MALL")).toBeUndefined();
  });
});

describe("diffCampaignChanges", () => {
  it("status 가 바뀌면 'status' 라벨, 동일값이면 무변경", () => {
    const previous = basePrevious({ status: "ACTIVE" });
    const states = resolveSettlementStates({}, previous);
    expect(diffCampaignChanges({ status: "CLOSED" }, previous, states)).toContain("status");
    expect(diffCampaignChanges({ status: "ACTIVE" }, previous, states)).not.toContain("status");
  });

  it("actualSales 는 수치 비교 — 동일 숫자는 무변경, 다르면 'actual sales'", () => {
    const previous = basePrevious({ actualSales: "100" });
    const states = resolveSettlementStates({}, previous);
    expect(diffCampaignChanges({ actualSales: 100 }, previous, states)).not.toContain("actual sales");
    expect(diffCampaignChanges({ actualSales: 200 }, previous, states)).toContain("actual sales");
  });

  it("입금 상태가 실질적으로 바뀌면(previous 대비) 'deposit date' 라벨이 붙는다", () => {
    const previous = basePrevious({ isDepositReceived: false });
    const dataUnchanged: CampaignUpdateData = { isDepositReceived: false };
    const dataChanged: CampaignUpdateData = { isDepositReceived: true };
    expect(diffCampaignChanges(dataUnchanged, previous, resolveSettlementStates(dataUnchanged, previous))).not.toContain("deposit date");
    expect(diffCampaignChanges(dataChanged, previous, resolveSettlementStates(dataChanged, previous))).toContain("deposit date");
  });

  // ⚠️ 아래 블록은 `?? -1` 센티널 결함(T-018)의 회귀 방어선이다. 실제 값 -1 과 "미입력"이
  // 같은 자리로 접히면 변경이 이력·캘린더 동기화에서 조용히 사라지거나 없는 변경이 생긴다.
  describe("-1 센티널 경계", () => {
    it("previous 가 미입력인데 -1 을 넣으면 변경으로 잡는다(actual sales)", () => {
      const previous = basePrevious({ actualSales: null });
      const states = resolveSettlementStates({}, previous);
      expect(diffCampaignChanges({ actualSales: -1 }, previous, states)).toContain("actual sales");
    });

    it("previous 가 -1 인데 미입력으로 지우면 변경으로 잡는다(actual sales)", () => {
      const previous = basePrevious({ actualSales: "-1" });
      const states = resolveSettlementStates({}, previous);
      expect(diffCampaignChanges({ actualSales: null }, previous, states)).toContain("actual sales");
    });

    it("operating/misc expense 도 같은 규약을 따른다", () => {
      const previous = basePrevious({ operatingExpense: null, miscExpense: "-1" });
      const states = resolveSettlementStates({}, previous);
      const changed = diffCampaignChanges({ operatingExpense: -1, miscExpense: null }, previous, states);
      expect(changed).toContain("operating expense");
      expect(changed).toContain("misc expense");
    });

    it("정수 필드 3종(order count·item count·round number)도 같은 규약을 따른다", () => {
      const previous = basePrevious({ quantity: null, itemCount: -1, roundNumber: null });
      const states = resolveSettlementStates({}, previous);
      const changed = diffCampaignChanges(
        { quantity: -1, itemCount: null, roundNumber: -1 },
        previous,
        states,
      );
      expect(changed).toContain("order count");
      expect(changed).toContain("item count");
      expect(changed).toContain("round number");
    });

    it("양쪽 다 미입력이면 무변경이다", () => {
      const previous = basePrevious({ actualSales: null, quantity: null, roundNumber: null });
      const states = resolveSettlementStates({}, previous);
      const changed = diffCampaignChanges(
        { actualSales: null, quantity: null, roundNumber: null },
        previous,
        states,
      );
      expect(changed).not.toContain("actual sales");
      expect(changed).not.toContain("order count");
      expect(changed).not.toContain("round number");
    });

    it("양쪽 다 -1 이면 무변경이다(실제 값끼리의 비교)", () => {
      const previous = basePrevious({ actualSales: "-1", quantity: -1 });
      const states = resolveSettlementStates({}, previous);
      const changed = diffCampaignChanges({ actualSales: -1, quantity: -1 }, previous, states);
      expect(changed).not.toContain("actual sales");
      expect(changed).not.toContain("order count");
    });
  });

  // ── T-020 회귀: 종전 `data.X !== undefined` 항목 9종을 실변경 판정으로 좁힌 건 ──────────
  // 🪤 픽스처는 이름대로여야 한다 — "재전송" 케이스는 basePrevious 와 **같은 값**을,
  // "변경" 케이스는 **다른 값**을 보내야 한다(T-019 가 반대로 돼 결함을 놓쳤다).

  it("정산일 5종: 같은 값 재전송은 무변경, 다른 값은 변경", () => {
    const previous = basePrevious({
      supplierInvoiceIssuedAt: new Date("2026-08-05T00:00:00.000Z"),
      sellerInvoiceIssuedAt: new Date("2026-08-06T00:00:00.000Z"),
      expectedDepositDate: new Date("2026-08-07T00:00:00.000Z"),
      expectedPayoutDate: new Date("2026-08-08T00:00:00.000Z"),
      accountingCompletedAt: new Date("2026-08-09T00:00:00.000Z"),
    });
    const states = resolveSettlementStates({}, previous);

    const resent: CampaignUpdateData = {
      supplierInvoiceIssuedAt: "2026-08-05",
      sellerInvoiceIssuedAt: "2026-08-06",
      expectedDepositDate: "2026-08-07",
      expectedPayoutDate: "2026-08-08",
      accountingCompletedAt: "2026-08-09",
    };
    expect(diffCampaignChanges(resent, previous, states)).toEqual([]);

    const changed: CampaignUpdateData = {
      supplierInvoiceIssuedAt: "2026-08-15",
      sellerInvoiceIssuedAt: "2026-08-16",
      expectedDepositDate: "2026-08-17",
      expectedPayoutDate: "2026-08-18",
      accountingCompletedAt: "2026-08-19",
    };
    expect(diffCampaignChanges(changed, previous, states)).toEqual([
      "supplier invoice date",
      "seller invoice date",
      "expected deposit date",
      "expected payout date",
      "accounting completed at",
    ]);
  });

  it("정산일: null ↔ 값 전환은 양방향 모두 변경으로 본다", () => {
    const empty = basePrevious({ expectedDepositDate: null });
    expect(
      diffCampaignChanges({ expectedDepositDate: "2026-08-07" }, empty, resolveSettlementStates({}, empty)),
    ).toContain("expected deposit date");
    // 이미 비어 있는데 null 을 다시 보내는 것은 무변경(지우기 버튼 연타)
    expect(
      diffCampaignChanges({ expectedDepositDate: null }, empty, resolveSettlementStates({}, empty)),
    ).not.toContain("expected deposit date");

    const filled = basePrevious({ expectedDepositDate: new Date("2026-08-07T00:00:00.000Z") });
    expect(
      diffCampaignChanges({ expectedDepositDate: null }, filled, resolveSettlementStates({}, filled)),
    ).toContain("expected deposit date");
  });

  // ⚠️ CG-1 함정 — 그룹이면 정산일 5종의 SoT 는 그룹 스칼라이고 멤버 컬럼은 낡는다
  // (`campaignService` 가 그룹일 때 멤버에 쓰지 않는다). 멤버와 대조하면 여기서 갈린다.
  it("그룹 캠페인은 멤버 컬럼이 아니라 그룹 스칼라와 대조한다", () => {
    const previous = basePrevious({
      groupId: "group-1",
      expectedDepositDate: new Date("2026-01-01T00:00:00.000Z"), // 멤버 컬럼 = 낡음
      group: baseGroup({ expectedDepositDate: new Date("2026-08-07T00:00:00.000Z") }),
    });
    const states = resolveSettlementStates({}, previous);
    // 화면이 보여준 값(그룹 스칼라)을 그대로 재전송 → 무변경
    expect(
      diffCampaignChanges({ expectedDepositDate: "2026-08-07" }, previous, states),
    ).not.toContain("expected deposit date");
    // 낡은 멤버 값을 보내는 것은 그룹 기준으로 실제 변경이다
    expect(
      diffCampaignChanges({ expectedDepositDate: "2026-01-01" }, previous, states),
    ).toContain("expected deposit date");
  });

  it("그룹 값이 null 이면 멤버 값이 아니라 null 이 이전값이다(오버레이는 undefined 로만 폴백)", () => {
    const previous = basePrevious({
      groupId: "group-1",
      expectedPayoutDate: new Date("2026-01-01T00:00:00.000Z"), // 멤버 = 낡음
      group: baseGroup({ expectedPayoutDate: null }),
    });
    const states = resolveSettlementStates({}, previous);
    // 화면은 비어 있으므로 null 재전송 = 무변경
    expect(
      diffCampaignChanges({ expectedPayoutDate: null }, previous, states),
    ).not.toContain("expected payout date");
  });

  it("반품기간 종료일은 그룹 오버레이 대상이 아니다 — 멤버 컬럼과 대조한다", () => {
    const previous = basePrevious({
      groupId: "group-1",
      returnPeriodEndDate: new Date("2026-08-24T00:00:00.000Z"),
      group: baseGroup(),
    });
    const states = resolveSettlementStates({}, previous);
    expect(
      diffCampaignChanges({ returnPeriodEndDate: "2026-08-24" }, previous, states),
    ).not.toContain("return period end date");
    expect(
      diffCampaignChanges({ returnPeriodEndDate: "2026-08-25" }, previous, states),
    ).toContain("return period end date");
  });

  it("정산 금액 2종은 금액 관용구를 따른다 — 동일값 무변경, 0 과 미입력을 구분한다", () => {
    const previous = basePrevious({ settlementSupplyCost: "1000", settlementGoodsCost: null });
    const states = resolveSettlementStates({}, previous);
    expect(diffCampaignChanges({ settlementSupplyCost: 1000 }, previous, states)).not.toContain("settlement supply cost");
    expect(diffCampaignChanges({ settlementSupplyCost: 2000 }, previous, states)).toContain("settlement supply cost");
    // 0 은 「타 캠페인 계산서에 합산됨」 마커라 미입력(null)과 다른 값이다
    expect(diffCampaignChanges({ settlementGoodsCost: 0 }, previous, states)).toContain("settlement goods cost");
    expect(diffCampaignChanges({ settlementGoodsCost: null }, previous, states)).not.toContain("settlement goods cost");
  });

  it("campaignName 은 같은 이름 재전송이면 무변경(캘린더 동기화 트리거 아님)", () => {
    const previous = basePrevious({ campaignName: "기존캠페인명" });
    const states = resolveSettlementStates({}, previous);
    expect(diffCampaignChanges({ campaignName: "기존캠페인명" }, previous, states)).not.toContain("campaign name");
    expect(diffCampaignChanges({ campaignName: "새캠페인명" }, previous, states)).toContain("campaign name");
  });

  it("salesTask·campaignDeals 는 의도적으로 전송 여부만 본다(심층 비교 미도입)", () => {
    const previous = basePrevious();
    const states = resolveSettlementStates({}, previous);
    const changed = diffCampaignChanges({ salesTask: {}, campaignDeals: [] }, previous, states);
    expect(changed).toContain("connected task details");
    expect(changed).toContain("revenue items");
  });

  it("라벨 문자열이 정확히 일치한다(CALENDAR_SYNC_FIELDS·describeChangedFields 의존)", () => {
    const previous = basePrevious();
    const data: CampaignUpdateData = {
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      // basePrevious 의 settlementGoodsCost 는 "500" 이다 — 라벨이 나오려면 **다른 값**이어야
      // 한다(T-020 이후 이 항목도 실변경 판정이다).
      settlementGoodsCost: 900,
    };
    const states = resolveSettlementStates(data, previous);
    const changed = diffCampaignChanges(data, previous, states);
    expect(changed).toContain("start date");
    expect(changed).toContain("end date");
    expect(changed).toContain("settlement goods cost");
  });
});
