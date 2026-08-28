// 후보 조회 집계 계약.
//
// 🔴 이 파일의 존재 이유는 **셀러 단위 진행 횟수의 이중 집계**다. `CampaignGroup` 은
// 실캠페인 1개를 **딜별 N행**으로 분할한 것이라(CG-1) 한 그룹이 같은 셀러의 여러 딜에
// 걸친다. groupBy 결과를 (셀러,딜) 쌍으로 접으면 그룹이 딜마다 1회로 세어지고, 그걸 셀러
// 단위로 다시 더하면 한 번 진행한 그룹이 딜 수만큼 부풀어 오른다.
// 종전 계약 테스트가 이걸 못 잡은 이유: 그룹 픽스처를 **같은 dealId 안에서만** 섞었다 —
// CampaignGroup 이 존재하는 이유(여러 딜에 걸침) 자체를 재현하지 않았다.
//
// ⏰ 고정 날짜 픽스처 금지(P9) — 기준 시각을 주입한다.

import { describe, it, expect } from "vitest";
import { foldSellerRunSignals, toPairRunRows } from "../deal-seller-candidates-query";
import { tallyEffectiveCampaignCounts } from "../campaign-group-count";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-04T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

const row = (over: Partial<Parameters<typeof foldSellerRunSignals>[0][number]> = {}) => ({
  sellerId: "s1",
  dealId: "d1",
  groupId: null as string | null,
  rowCount: 1,
  lastStartAt: daysAgo(10) as Date | string | null,
  salesSum: null as number | null,
  ...over,
});

describe("foldSellerRunSignals — 셀러 단위 진행 횟수", () => {
  it("여러 딜에 걸친 한 그룹은 1회다 (딜 수만큼 부풀지 않는다)", () => {
    const signals = foldSellerRunSignals(
      [
        row({ dealId: "dealA", groupId: "g1" }),
        row({ dealId: "dealB", groupId: "g1" }),
        row({ dealId: "dealC", groupId: "g1" }),
      ],
      NOW,
    );
    expect(signals.get("s1")?.runCount).toBe(1);
  });

  it("`tallyEffectiveCampaignCounts` 와 같은 답을 낸다 (규칙 복제 금지의 확인)", () => {
    const rows = [
      row({ dealId: "dealA", groupId: "g1" }),
      row({ dealId: "dealB", groupId: "g1" }),
      row({ dealId: "dealC", groupId: null, rowCount: 2 }),
    ];
    // SSOT 를 직접 부른 기준값 — 그룹 1 + 미그룹 2행 = 3
    const expected = tallyEffectiveCampaignCounts([
      { sellerId: "s1", groupId: "g1", rowCount: 1 },
      { sellerId: "s1", groupId: null, rowCount: 2 },
    ]).get("s1");
    expect(foldSellerRunSignals(rows, NOW).get("s1")?.runCount).toBe(expected);
    expect(expected).toBe(3);
  });

  it("서로 다른 그룹은 각각 1회로 센다", () => {
    const signals = foldSellerRunSignals(
      [
        row({ dealId: "dealA", groupId: "g1" }),
        row({ dealId: "dealB", groupId: "g1" }),
        row({ dealId: "dealA", groupId: "g2" }),
      ],
      NOW,
    );
    expect(signals.get("s1")?.runCount).toBe(2);
  });

  it("미그룹 행은 딜을 가로질러 행 수 그대로 더한다", () => {
    const signals = foldSellerRunSignals(
      [row({ dealId: "dealA", rowCount: 2 }), row({ dealId: "dealB", rowCount: 3 })],
      NOW,
    );
    expect(signals.get("s1")?.runCount).toBe(5);
  });

  it("셀러끼리 섞이지 않는다", () => {
    const signals = foldSellerRunSignals(
      [row({ sellerId: "s1", groupId: "g1" }), row({ sellerId: "s2", groupId: "g1" })],
      NOW,
    );
    expect(signals.get("s1")?.runCount).toBe(1);
    expect(signals.get("s2")?.runCount).toBe(1);
  });

  it("마지막 진행일은 딜을 가로질러 최댓값이다", () => {
    const signals = foldSellerRunSignals(
      [
        row({ dealId: "dealA", lastStartAt: daysAgo(200) }),
        row({ dealId: "dealB", lastStartAt: daysAgo(30) }),
      ],
      NOW,
    );
    expect(signals.get("s1")?.lastRunStartAt).toBe(daysAgo(30).toISOString());
  });

  it("미래 시작일은 마지막 진행이 아니다", () => {
    const future = new Date(NOW.getTime() + 10 * DAY_MS);
    const signals = foldSellerRunSignals(
      [row({ lastStartAt: future }), row({ dealId: "dealB", lastStartAt: daysAgo(50) })],
      NOW,
    );
    expect(signals.get("s1")?.lastRunStartAt).toBe(daysAgo(50).toISOString());
  });

  it("과거 진행이 하나도 없으면 마지막 진행일은 null 이다 (0 일로 취급하지 않는다)", () => {
    const signals = foldSellerRunSignals([row({ lastStartAt: null })], NOW);
    expect(signals.get("s1")?.lastRunStartAt).toBeNull();
  });
});

describe("toPairRunRows — Decimal · 미입력 처리", () => {
  it("매출 미입력은 0 이 아니라 null 로 남는다", () => {
    const [converted] = toPairRunRows([
      {
        sellerId: "s1",
        dealId: "d1",
        groupId: null,
        _count: { _all: 1 },
        _max: { startDate: daysAgo(1) },
        _sum: { actualSales: null },
      },
    ]);
    expect(converted.salesSum).toBeNull();
  });

  it("Decimal 류 객체는 숫자로 바꾼다", () => {
    const [converted] = toPairRunRows([
      {
        sellerId: "s1",
        dealId: "d1",
        groupId: null,
        _count: { _all: 1 },
        _max: { startDate: daysAgo(1) },
        _sum: { actualSales: { toString: () => "12000000" } },
      },
    ]);
    expect(converted.salesSum).toBe(12_000_000);
  });
});
