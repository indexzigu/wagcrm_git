// 딜↔셀러 양방향 검토 계약 — 사유 코드 분류 · D3 부스터 · 미입력 보류 · 그룹 접기.
//
// ⏰ **고정 날짜 픽스처를 쓰지 않는다**(P9 시한폭탄). `seller-dormancy.test.ts` 와 같은
// 규약으로 기준 시각 `now` 를 명시 주입하고 상대 오프셋으로 만든다.

import { describe, it, expect } from "vitest";
import {
  RERUN_PRIORITY_SALES,
  buildPairRunSignals,
  rankSellerCandidatesForDeal,
  rankDealCandidatesForSeller,
} from "../deal-seller-matching";
import { DORMANT_DAYS } from "../seller-dormancy";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-04T00:00:00.000Z"); // 주입 기준 시각 — 시스템 시각과 무관
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

describe("buildPairRunSignals — groupBy 결과를 쌍 신호로 접는다", () => {
  it("미그룹 행은 행 수 그대로, 같은 그룹은 1회로 접는다", () => {
    const signals = buildPairRunSignals(
      [
        {
          sellerId: "s1",
          dealId: "d1",
          groupId: null,
          rowCount: 2,
          lastStartAt: daysAgo(100),
          salesSum: 5_000_000,
        },
        {
          sellerId: "s1",
          dealId: "d1",
          groupId: "g1",
          rowCount: 3,
          lastStartAt: daysAgo(300),
          salesSum: 1_000_000,
        },
      ],
      new Map([["d1", "p1"]]),
      NOW,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      sellerId: "s1",
      dealId: "d1",
      dealPartnerId: "p1",
      runCount: 3, // 미그룹 2행 + 그룹 1
      salesTotal: 6_000_000,
    });
    expect(signals[0].lastRunStartAt).toBe(daysAgo(100).toISOString());
  });

  it("서로 다른 쌍은 섞이지 않는다", () => {
    const signals = buildPairRunSignals(
      [
        { sellerId: "s1", dealId: "d1", groupId: null, rowCount: 1, lastStartAt: daysAgo(10), salesSum: 1 },
        { sellerId: "s1", dealId: "d2", groupId: null, rowCount: 1, lastStartAt: daysAgo(20), salesSum: 2 },
        { sellerId: "s2", dealId: "d1", groupId: null, rowCount: 1, lastStartAt: daysAgo(30), salesSum: 3 },
      ],
      new Map(),
      NOW,
    );
    expect(signals).toHaveLength(3);
  });

  it("미래 시작일은 마지막 진행이 아니다", () => {
    const future = new Date(NOW.getTime() + 10 * DAY_MS);
    const [signal] = buildPairRunSignals(
      [{ sellerId: "s1", dealId: "d1", groupId: null, rowCount: 1, lastStartAt: future, salesSum: null }],
      new Map(),
      NOW,
    );
    expect(signal.lastRunStartAt).toBeNull();
  });

  it("매출 미입력은 0 이 아니라 null 로 남는다", () => {
    const [signal] = buildPairRunSignals(
      [{ sellerId: "s1", dealId: "d1", groupId: null, rowCount: 1, lastStartAt: daysAgo(1), salesSum: null }],
      new Map(),
      NOW,
    );
    expect(signal.salesTotal).toBeNull();
  });

  it("딜의 거래처를 모르면 null 로 두고 같은 거래처 판정에 쓰지 않는다", () => {
    const [signal] = buildPairRunSignals(
      [{ sellerId: "s1", dealId: "d1", groupId: null, rowCount: 1, lastStartAt: daysAgo(1), salesSum: null }],
      new Map(),
      NOW,
    );
    expect(signal.dealPartnerId).toBeNull();
  });
});

const seller = (id: string, lastRunDaysAgo: number | null, runCount = 3) => ({
  sellerId: id,
  runCount,
  lastRunStartAt: lastRunDaysAgo === null ? null : daysAgo(lastRunDaysAgo).toISOString(),
});

describe("rankSellerCandidatesForDeal — 사유 코드 분류", () => {
  const base = {
    dealId: "d1",
    dealPartnerId: "p1" as string | null,
    excludeSellerIds: [] as string[],
    now: NOW,
  };

  it("이 딜을 전에 진행했고 재진행 간격이 도래하면 SAME_DEAL_RERUN", () => {
    const [top] = rankSellerCandidatesForDeal({
      ...base,
      sellers: [seller("s1", 200)],
      pairs: [
        {
          sellerId: "s1",
          dealId: "d1",
          dealPartnerId: "p1",
          runCount: 1,
          lastRunStartAt: daysAgo(DORMANT_DAYS).toISOString(),
          salesTotal: 1_000_000,
        },
      ],
    });
    expect(top.reason).toBe("SAME_DEAL_RERUN");
  });

  it("이 딜을 최근에 진행한 셀러는 후보에서 빠진다 (재제안하기 이르다)", () => {
    const result = rankSellerCandidatesForDeal({
      ...base,
      sellers: [seller("s1", 10)],
      pairs: [
        {
          sellerId: "s1",
          dealId: "d1",
          dealPartnerId: "p1",
          runCount: 1,
          lastRunStartAt: daysAgo(DORMANT_DAYS - 1).toISOString(),
          salesTotal: 1_000_000,
        },
      ],
    });
    expect(result).toHaveLength(0);
  });

  it("같은 거래처의 다른 딜 이력이 있으면 SAME_PARTNER", () => {
    const [top] = rankSellerCandidatesForDeal({
      ...base,
      sellers: [seller("s1", 30)],
      pairs: [
        {
          sellerId: "s1",
          dealId: "d9",
          dealPartnerId: "p1",
          runCount: 1,
          lastRunStartAt: daysAgo(30).toISOString(),
          salesTotal: null,
        },
      ],
    });
    expect(top.reason).toBe("SAME_PARTNER");
  });

  it("이력은 있으나 거래 리듬이 휴면·제외면 LONG_GAP_SELLER", () => {
    const [top] = rankSellerCandidatesForDeal({
      ...base,
      sellers: [seller("s1", DORMANT_DAYS + 5)],
      pairs: [],
    });
    expect(top.reason).toBe("LONG_GAP_SELLER");
    expect(top.dormancy.tier).toBe("DORMANT");
  });

  it("그 외 진행 이력 보유 셀러는 NEW_MATCH", () => {
    const [top] = rankSellerCandidatesForDeal({ ...base, sellers: [seller("s1", 10)], pairs: [] });
    expect(top.reason).toBe("NEW_MATCH");
  });

  it("excludeSellerIds 는 후보에서 제외한다 (이미 연결된 셀러)", () => {
    const result = rankSellerCandidatesForDeal({
      ...base,
      excludeSellerIds: ["s1"],
      sellers: [seller("s1", 10)],
      pairs: [],
    });
    expect(result).toHaveLength(0);
  });

  it("진행 이력이 없는 셀러는 스코프 밖이다 (D1)", () => {
    const result = rankSellerCandidatesForDeal({
      ...base,
      sellers: [seller("s1", null, 0)],
      pairs: [],
    });
    expect(result).toHaveLength(0);
  });

  it("딜에 거래처가 없으면 같은 거래처 판정을 하지 않는다", () => {
    const [top] = rankSellerCandidatesForDeal({
      ...base,
      dealPartnerId: null,
      sellers: [seller("s1", 30)],
      pairs: [
        {
          sellerId: "s1",
          dealId: "d9",
          dealPartnerId: null,
          runCount: 1,
          lastRunStartAt: daysAgo(30).toISOString(),
          salesTotal: null,
        },
      ],
    });
    expect(top.reason).toBe("NEW_MATCH");
  });

  it("`fitLevel` 을 입력으로 받지 않는다 — 두 축 합산 금지(D10)", () => {
    // 계정 신호가 이 함수의 시그니처에 없다는 것 자체가 계약이다.
    const [top] = rankSellerCandidatesForDeal({ ...base, sellers: [seller("s1", 10)], pairs: [] });
    expect(Object.keys(top)).not.toContain("fitLevel");
  });
});

describe("D3 우선순위 부스터 — (셀러×딜) 쌍 매출 기준", () => {
  const pairAt = (sellerId: string, salesTotal: number | null) => ({
    sellerId,
    dealId: "d1",
    dealPartnerId: "p1",
    runCount: 1,
    lastRunStartAt: daysAgo(200).toISOString(),
    salesTotal,
  });

  it("문턱은 D3 의 1,000만원이다", () => {
    expect(RERUN_PRIORITY_SALES).toBe(10_000_000);
  });

  it("문턱 이상이면 priority 이고 위로 올라간다", () => {
    const result = rankSellerCandidatesForDeal({
      dealId: "d1",
      dealPartnerId: "p1",
      excludeSellerIds: [],
      now: NOW,
      sellers: [seller("low", 200), seller("high", 200)],
      pairs: [pairAt("low", RERUN_PRIORITY_SALES - 1), pairAt("high", RERUN_PRIORITY_SALES)],
    });
    expect(result.map((c) => c.sellerId)).toEqual(["high", "low"]);
    expect(result[0].priority).toBe(true);
    expect(result[1].priority).toBe(false);
  });

  it("매출 미입력은 0 으로 낙제시키지 않고 판정 보류다", () => {
    const [only] = rankSellerCandidatesForDeal({
      dealId: "d1",
      dealPartnerId: "p1",
      excludeSellerIds: [],
      now: NOW,
      sellers: [seller("s1", 200)],
      pairs: [pairAt("s1", null)],
    });
    expect(only.priority).toBe(false);
    expect(only.pairSalesTotal).toBeNull();
  });

  it("부스터는 정렬만 바꾸고 후보를 걸러내지 않는다 (필터 금지)", () => {
    const result = rankSellerCandidatesForDeal({
      dealId: "d1",
      dealPartnerId: "p1",
      excludeSellerIds: [],
      now: NOW,
      sellers: [seller("low", 200)],
      pairs: [pairAt("low", 1)],
    });
    expect(result).toHaveLength(1);
  });

  it("사유가 다르면 부스터보다 사유가 우선한다", () => {
    const result = rankSellerCandidatesForDeal({
      dealId: "d1",
      dealPartnerId: "p1",
      excludeSellerIds: [],
      now: NOW,
      sellers: [seller("rerun", 200), seller("partner", 30)],
      pairs: [
        pairAt("rerun", 1),
        {
          sellerId: "partner",
          dealId: "d9",
          dealPartnerId: "p1",
          runCount: 1,
          lastRunStartAt: daysAgo(30).toISOString(),
          salesTotal: RERUN_PRIORITY_SALES * 10,
        },
      ],
    });
    expect(result.map((c) => c.sellerId)).toEqual(["rerun", "partner"]);
  });
});

describe("rankDealCandidatesForSeller — 셀러 → 딜", () => {
  const deals = [
    {
      dealId: "d1",
      dealName: "딜 하나",
      brandName: "브랜드A",
      partnerId: "p1",
      isLive: true,
      createdAt: daysAgo(10).toISOString(),
    },
    {
      dealId: "d2",
      dealName: "딜 둘",
      brandName: "브랜드B",
      partnerId: "p2",
      isLive: true,
      createdAt: daysAgo(5).toISOString(),
    },
    {
      dealId: "d3",
      dealName: "딜 셋",
      brandName: "브랜드C",
      partnerId: "p3",
      isLive: true,
      createdAt: daysAgo(1).toISOString(),
    },
  ];

  it("전에 진행했고 간격이 도래한 딜이 최상단, 같은 거래처가 그다음", () => {
    const result = rankDealCandidatesForSeller({
      sellerId: "s1",
      deals,
      pairs: [
        {
          sellerId: "s1",
          dealId: "d1",
          dealPartnerId: "p1",
          runCount: 2,
          lastRunStartAt: daysAgo(200).toISOString(),
          salesTotal: RERUN_PRIORITY_SALES,
        },
        {
          sellerId: "s1",
          dealId: "d8",
          dealPartnerId: "p2",
          runCount: 1,
          lastRunStartAt: daysAgo(200).toISOString(),
          salesTotal: null,
        },
      ],
      now: NOW,
    });
    expect(result.map((c) => c.dealId)).toEqual(["d1", "d2", "d3"]);
    expect(result[0].reason).toBe("SAME_DEAL_RERUN");
    expect(result[0].priority).toBe(true);
    expect(result[1].reason).toBe("SAME_PARTNER");
    expect(result[2].reason).toBe("NEW_MATCH");
  });

  it("최근에 진행한 딜은 후보에서 빠진다", () => {
    const result = rankDealCandidatesForSeller({
      sellerId: "s1",
      deals: [deals[0]],
      pairs: [
        {
          sellerId: "s1",
          dealId: "d1",
          dealPartnerId: "p1",
          runCount: 1,
          lastRunStartAt: daysAgo(DORMANT_DAYS - 1).toISOString(),
          salesTotal: null,
        },
      ],
      now: NOW,
    });
    expect(result).toHaveLength(0);
  });

  it("다른 셀러의 쌍 신호는 이 셀러 판정에 섞이지 않는다", () => {
    const [top] = rankDealCandidatesForSeller({
      sellerId: "s1",
      deals: [deals[0]],
      pairs: [
        {
          sellerId: "other",
          dealId: "d1",
          dealPartnerId: "p1",
          runCount: 1,
          lastRunStartAt: daysAgo(200).toISOString(),
          salesTotal: null,
        },
      ],
      now: NOW,
    });
    expect(top.reason).toBe("NEW_MATCH");
  });

  // 🪤 `ARCHIVED` 의 라벨은 "완료"다 — 끝난 딜이 곧 D3 재진행의 주 모집단이다.
  // 살아 있는 딜만 후보로 두면 재진행이 원천적으로 안 뜬다(실렌더에서 잡힌 결함).
  it("끝난 딜이어도 이 셀러가 전에 돌렸으면 재진행 후보다", () => {
    const [top] = rankDealCandidatesForSeller({
      sellerId: "s1",
      deals: [{ ...deals[0], isLive: false }],
      pairs: [
        {
          sellerId: "s1",
          dealId: "d1",
          dealPartnerId: "p1",
          runCount: 1,
          lastRunStartAt: daysAgo(200).toISOString(),
          salesTotal: null,
        },
      ],
      now: NOW,
    });
    expect(top.reason).toBe("SAME_DEAL_RERUN");
  });

  it("끝난 딜에 접점이 없으면 신규 제안 대상이 아니다", () => {
    const result = rankDealCandidatesForSeller({
      sellerId: "s1",
      deals: [{ ...deals[0], isLive: false }],
      pairs: [],
      now: NOW,
    });
    expect(result).toHaveLength(0);
  });

  // 🪤 두 방향이 같은 모수를 봐야 한다 — 이 제외가 셀러 쪽에만 없으면 목록은 후보로
  // 보여주는데 기안은 "후보가 아니다"로 거절한다(실렌더에서 잡힌 불일치).
  it("이미 아웃리치가 있는 딜은 후보에서 빠진다", () => {
    const result = rankDealCandidatesForSeller({
      sellerId: "s1",
      deals: [deals[0], deals[1]],
      pairs: [],
      excludeDealIds: ["d1"],
      now: NOW,
    });
    expect(result.map((c) => c.dealId)).toEqual(["d2"]);
  });

  it("사유가 같으면 최근 등록 딜이 위다", () => {
    const result = rankDealCandidatesForSeller({
      sellerId: "s1",
      deals: [deals[0], deals[2]],
      pairs: [],
      now: NOW,
    });
    expect(result.map((c) => c.dealId)).toEqual(["d3", "d1"]);
  });
});
