import { describe, it, expect } from "vitest";
import {
  computeAcquisitionBreakdown,
  computeConnectorLeaderboard,
  computeReferralConversion,
} from "../referral-analytics";

type S = Parameters<typeof computeAcquisitionBreakdown>[0][number];

function seller(over: Partial<S> & { id: string }): S {
  return { name: over.id, ...over };
}

describe("computeAcquisitionBreakdown", () => {
  it("경로별 셀러 수를 많은 순으로 집계하고 미태깅은 미분류로 모은다", () => {
    const b = computeAcquisitionBreakdown([
      seller({ id: "a", acquisitionChannel: "REFERRAL" }),
      seller({ id: "b", acquisitionChannel: "REFERRAL" }),
      seller({ id: "c", acquisitionChannel: "DISCOVERY" }),
      seller({ id: "d", acquisitionChannel: null }),
    ]);
    expect(b[0]).toMatchObject({ channel: "REFERRAL", label: "소개", count: 2 });
    const unknown = b.find((x) => x.channel === "UNKNOWN");
    expect(unknown).toMatchObject({ label: "미분류", count: 1 });
  });
});

describe("computeConnectorLeaderboard", () => {
  it("소개자별 소개 수·거래 소개 수·다운스트림 매출을 집계한다", () => {
    const sellers = [
      seller({ id: "connector", name: "김본명", alias: "가온" }),
      seller({ id: "r1", referredById: "connector", campaigns: [{ actualSales: 1000 }] }),
      seller({ id: "r2", referredById: "connector", campaigns: [{ actualSales: 500 }, { actualSales: 200 }] }),
      seller({ id: "r3", referredById: "connector", campaigns: [] }), // 소개됐으나 미거래
      seller({ id: "other", campaigns: [{ actualSales: 9999 }] }), // 소개 무관
    ];
    const board = computeConnectorLeaderboard(sellers);
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({
      connectorId: "connector",
      connectorName: "가온", // alias 우선
      referredCount: 3,
      activeReferredCount: 2,
      downstreamSales: 1700,
    });
  });

  it("소개 수 → 다운스트림 매출 순으로 정렬한다", () => {
    const sellers = [
      seller({ id: "A" }),
      seller({ id: "B" }),
      seller({ id: "x", referredById: "A" }),
      seller({ id: "y", referredById: "A" }),
      seller({ id: "z", referredById: "B", campaigns: [{ actualSales: 5000 }] }),
    ];
    const board = computeConnectorLeaderboard(sellers);
    expect(board.map((r) => r.connectorId)).toEqual(["A", "B"]); // A 2명 > B 1명
  });

  it("끊어진 referredById(실재하지 않는 소개자)는 집계에서 제외한다", () => {
    const board = computeConnectorLeaderboard([
      seller({ id: "r1", referredById: "ghost", campaigns: [{ actualSales: 100 }] }),
    ]);
    expect(board).toHaveLength(0);
  });

  it("소개 이력이 없으면 빈 리더보드", () => {
    expect(computeConnectorLeaderboard([seller({ id: "a" }), seller({ id: "b" })])).toEqual([]);
  });
});

describe("computeReferralConversion", () => {
  it("소개 유입 중 거래 전환율을 계산한다", () => {
    const r = computeReferralConversion([
      seller({ id: "a", acquisitionChannel: "REFERRAL", campaigns: [{ actualSales: 1 }] }),
      seller({ id: "b", acquisitionChannel: "REFERRAL", campaigns: [] }),
      seller({ id: "c", acquisitionChannel: "DISCOVERY", campaigns: [{ actualSales: 1 }] }),
    ]);
    expect(r).toMatchObject({ referred: 2, converted: 1, rate: 50 });
  });

  it("소개 유입이 없으면 전환율 0", () => {
    expect(computeReferralConversion([seller({ id: "a", acquisitionChannel: "DISCOVERY" })])).toMatchObject({
      referred: 0,
      converted: 0,
      rate: 0,
    });
  });
});
