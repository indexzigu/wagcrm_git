import { describe, it, expect } from "vitest";
import { buildMobileCalendarItems } from "../mobile-calendar-groups";
import type { MobileCalendarCampaign } from "../mobile-calendar-data";
import { resolveMoneySlotsForChannels } from "../tax-filing-board";

/**
 * 이 파일이 생긴 이유(2026-08-25 교차검증): 모바일 그룹 집계는 테스트가 **전무**했고,
 * 그 사이 `groupItem()` 이 그룹의 자금 슬롯 판정 채널로 **대표(첫) 멤버 하나**를 쓰고
 * 있었다. 같은 시점 구글 동기화 쪽은 같은 질문을 **합집합**으로 판정하고 있었다 —
 * 즉 한 도메인 판정을 두 표면이 **서로 다른 규칙**으로 들고 있었고, 백엔드 계약만으로는
 * 그 어긋남이 안 잡혔다. 이 테스트가 고정하는 것은 그 **판정 통일**이다.
 *
 * ⚠️ **채널이 섞인 조합 캠페인은 운영에 존재하지 않는다**(오너 확정 2026-08-25 —
 * "묶음은 항상 같은 곳에서 판다". 조합은 딜만 여러 개이고 판매채널은 하나다).
 * 그래서 아래 혼재 케이스는 **관측된 결함의 재현이 아니라 속성 테스트**다 — 이 파일을
 * 읽고 "지금 화면이 틀리게 보이고 있다"로 오독하지 말 것. `CampaignGroup` 에 채널
 * 컬럼이 없어 **코드상으로는** 멤버마다 다를 수 있고, 세무 보드도 그 조합을 이상
 * 상태로 신고하는 경로를 이미 갖고 있어(`CHANNEL_MISMATCH`) 방어적으로 고정해 둔다.
 */
function member(over: Partial<MobileCalendarCampaign> & { id: string }): MobileCalendarCampaign {
  return {
    dealName: "딜",
    sellerName: "셀러",
    sellerId: "s1",
    groupId: "g1",
    groupName: null,
    roundNumber: null,
    startDate: "2026-09-01T00:00:00.000Z",
    endDate: "2026-09-05T00:00:00.000Z",
    status: "ACTIVE",
    salesChannel: "SELLER_MALL",
    expectedDepositDate: null,
    expectedPayoutDate: null,
    expectedSupplierPayoutDate: null,
    depositReceivedAt: null,
    payoutCompletedAt: null,
    supplierPayoutCompletedAt: null,
    settlementSales: null,
    actualSales: null,
    sellerExpense: null,
    actualPayoutAmount: null,
    settlementGoodsCost: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    ...over,
  };
}

describe("buildMobileCalendarItems — 묶음의 채널은 멤버 합집합이다", () => {
  it("개별 캠페인은 자기 채널 하나만 싣는다", () => {
    const [item] = buildMobileCalendarItems([
      member({ id: "c1", groupId: null, salesChannel: "OWN_MALL_NAVER" }),
    ]);
    expect(item.salesChannels).toEqual(["OWN_MALL_NAVER"]);
  });

  it("균일 채널 그룹은 그 채널의 슬롯과 정확히 같다 — 자사몰이면 입금 슬롯이 없다", () => {
    const [item] = buildMobileCalendarItems([
      member({ id: "c1", salesChannel: "OWN_MALL_NAVER" }),
      member({ id: "c2", salesChannel: "OWN_MALL_NAVER" }),
    ]);
    const keys = resolveMoneySlotsForChannels(item.salesChannels).map((s) => s.key);
    expect(keys.sort()).toEqual(["payout", "supplierPayout"]);
    expect(keys).not.toContain("deposit");
  });

  it("⛔ 속성 — 채널이 섞여도 어느 레그도 잃지 않는다(운영엔 없는 조합, 방어)", () => {
    // 대표(첫) 멤버 하나로 판정하면 자사몰이 먼저 올 때 그룹 입금 예정일이 어느 슬롯에도
    // 안 걸리고, 반대 순서면 공급사 지급을 잃는다. 운영에 그런 그룹이 없다는 것이
    // 오너 확정이므로 이건 **관측된 증상이 아니라 판정 규칙의 속성**을 고정하는 것이다.
    const ownFirst = buildMobileCalendarItems([
      member({ id: "c1", salesChannel: "OWN_MALL_NAVER" }),
      member({ id: "c2", salesChannel: "BRAND_MALL" }),
    ])[0];
    const brandFirst = buildMobileCalendarItems([
      member({ id: "c1", salesChannel: "BRAND_MALL" }),
      member({ id: "c2", salesChannel: "OWN_MALL_NAVER" }),
    ])[0];

    for (const item of [ownFirst, brandFirst]) {
      const keys = resolveMoneySlotsForChannels(item.salesChannels).map((s) => s.key);
      expect(keys.sort()).toEqual(["deposit", "payout", "supplierPayout"]);
    }
  });

  it("멤버 순서가 달라도 슬롯 **집합**은 같다(표시가 순서에 흔들리지 않는다)", () => {
    const a = buildMobileCalendarItems([
      member({ id: "c1", salesChannel: "OWN_MALL_NAVER" }),
      member({ id: "c2", salesChannel: "BRAND_MALL" }),
    ])[0];
    const b = buildMobileCalendarItems([
      member({ id: "c2", salesChannel: "BRAND_MALL" }),
      member({ id: "c1", salesChannel: "OWN_MALL_NAVER" }),
    ])[0];
    const keysOf = (item: typeof a) =>
      resolveMoneySlotsForChannels(item.salesChannels)
        .map((s) => s.key)
        .sort();
    expect(keysOf(a)).toEqual(keysOf(b));
  });

  it("날짜 3종은 여전히 그룹 스칼라(대표 멤버) 규약을 따른다 — 채널과 규약이 다르다", () => {
    // ⚠️ 채널을 합집합으로 바꾼 것이 날짜까지 합치라는 뜻이 아니다. 날짜는 CG-2
    // dual-read 로 전 멤버가 같은 값을 들고 있으므로 대표에서 읽는 것이 맞다.
    const [item] = buildMobileCalendarItems([
      member({ id: "c1", expectedPayoutDate: "2026-09-20T00:00:00.000Z" }),
      member({ id: "c2", expectedPayoutDate: "2026-09-20T00:00:00.000Z" }),
    ]);
    expect(item.expectedPayoutDate).toBe("2026-09-20T00:00:00.000Z");
  });
});
