/**
 * 주문 일감 칸 판정 — 단위 계약.
 *
 * 종전 「오늘 처리할 주문」 카드는 홈 「오늘 처리할 일」(`today-work-card.test.tsx`)로 흡수됐다
 * (2026-10-18). 여기서는 그 카드가 쓰던 순수 판정 두 개만 본다 — 칸(`buildOrderWorkBuckets`)과
 * 동기화 신선도(`resolveOrderSyncState`). 평소 주기(매일 09:00 크론 → 26시간)를 넘겨 낡았으면 0 을
 * 믿을 수 없다.
 */
import { describe, expect, it } from "vitest";
import { buildOrderWorkBuckets, resolveOrderSyncState } from "../order-work-buckets";
import type { OrderWorkSummary } from "@/lib/order-converter/order-work";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-18T03:00:00.000Z");

function summary(overrides: Partial<OrderWorkSummary> = {}): OrderWorkSummary {
  return {
    awaitingPo: { lines: 0, campaigns: 0, delayedLines: 0 },
    delayed: { lines: 0, campaigns: 0, invoiceLines: 0, shippingLines: 0 },
    openClaims: { lines: 0, campaigns: 0, unmatchedLines: 0 },
    total: 0,
    lastSyncAt: new Date(NOW - HOUR).toISOString(),
    activeCampaignCount: 3,
    hasSnapshot: true,
    ...overrides,
  };
}

describe("buildOrderWorkBuckets", () => {
  it("세 칸을 고정 순서로 낸다 — 발주 대기 · 송장·배송 지연 · 반품/교환", () => {
    expect(buildOrderWorkBuckets(summary()).map((b) => [b.key, b.label])).toEqual([
      ["awaiting-po", "발주 대기"],
      ["delayed", "송장·배송 지연"],
      ["open-claims", "반품/교환"],
    ]);
  });

  it("발주 대기는 평상시 무채색, 결제 후 2일 이상 건이 있을 때만 주의", () => {
    const calm = buildOrderWorkBuckets(summary({ awaitingPo: { lines: 12, campaigns: 3, delayedLines: 0 } }))[0];
    expect(calm.tone).toBeNull();
    expect(calm.detail).toBeNull();
    const late = buildOrderWorkBuckets(summary({ awaitingPo: { lines: 12, campaigns: 3, delayedLines: 5 } }))[0];
    expect(late.tone).toBe("caution");
    expect(late.detail).toBe("결제 후 2일 이상 5건");
  });

  it("송장·배송 지연은 위험색이고 세부 줄은 주문 관리 화면과 같은 말로 나눠 말한다", () => {
    const delayed = buildOrderWorkBuckets(
      summary({ delayed: { lines: 4, campaigns: 2, invoiceLines: 3, shippingLines: 1 } }),
    )[1];
    expect(delayed.tone).toBe("urgent");
    expect(delayed.detail).toBe("송장 지연 3건 · 배송 지연 1건");
  });

  it("반품/교환은 위험색, 캠페인을 못 찾은 건은 건수로 말한다", () => {
    const claims = buildOrderWorkBuckets(summary({ openClaims: { lines: 2, campaigns: 1, unmatchedLines: 1 } }))[2];
    expect(claims.tone).toBe("urgent");
    expect(claims.detail).toBe("캠페인 못 찾은 1건");
  });

  it("0 인 칸은 색도 세부 줄도 없다", () => {
    for (const bucket of buildOrderWorkBuckets(summary())) {
      expect(bucket.tone).toBeNull();
      expect(bucket.detail).toBeNull();
    }
  });
});

describe("resolveOrderSyncState", () => {
  it("요약이 없으면 불러오는 중", () => {
    expect(resolveOrderSyncState(undefined, NOW)).toEqual({ kind: "loading" });
  });

  it("동기화 기록이 없거나 활성 캠페인이 있는데 스냅샷이 없으면 동기화대기", () => {
    expect(resolveOrderSyncState(summary({ lastSyncAt: null }), NOW).kind).toBe("waiting");
    expect(resolveOrderSyncState(summary({ hasSnapshot: false }), NOW).kind).toBe("waiting");
  });

  it("26시간을 넘겨 낡았으면 며칠 전인지와 함께 낡음", () => {
    expect(resolveOrderSyncState(summary({ lastSyncAt: new Date(NOW - 50 * HOUR).toISOString() }), NOW)).toEqual({
      kind: "stale",
      daysAgo: 2,
    });
  });

  it("평소 주기 안이면 신선", () => {
    expect(resolveOrderSyncState(summary(), NOW).kind).toBe("fresh");
  });
});
