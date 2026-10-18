/**
 * 홈 「오늘 처리할 일」 — 행 빌더 계약.
 *
 * 주문(발주 대기·송장·배송 지연·반품/교환) · 영업 팔로업 · 지연된 정산 · 승인대기 · 데이터 점검을
 * 한 목록으로 모은다. 0건 행은 빠지고, 순서는 고정이며, 색(tone)은 종전 두 카드의 규칙을 승계한다.
 */
import { describe, expect, it } from "vitest";
import { buildTodayWorkRows, type TodayWorkInput } from "../today-work";
import type { OrderWorkSummary } from "../order-converter/order-work";

function orders(overrides: Partial<OrderWorkSummary> = {}): OrderWorkSummary {
  return {
    awaitingPo: { lines: 0, campaigns: 0, delayedLines: 0 },
    delayed: { lines: 0, campaigns: 0, invoiceLines: 0, shippingLines: 0 },
    openClaims: { lines: 0, campaigns: 0, unmatchedLines: 0 },
    total: 0,
    lastSyncAt: "2026-10-18T00:00:00.000Z",
    activeCampaignCount: 3,
    hasSnapshot: true,
    ...overrides,
  };
}

function input(overrides: Partial<TodayWorkInput> = {}): TodayWorkInput {
  return {
    orders: orders(),
    agenda: { tasks: 0, settlements: 0 },
    approvalsPending: 0,
    dataCheck: 0,
    ...overrides,
  };
}

const busy = (): TodayWorkInput =>
  input({
    orders: orders({
      awaitingPo: { lines: 12, campaigns: 3, delayedLines: 0 },
      delayed: { lines: 4, campaigns: 2, invoiceLines: 3, shippingLines: 1 },
      openClaims: { lines: 2, campaigns: 1, unmatchedLines: 0 },
      total: 18,
    }),
    agenda: { tasks: 5, settlements: 2, overdueSettlementIds: ["c-1", "c-2"] },
    approvalsPending: 3,
    dataCheck: 7,
  });

describe("buildTodayWorkRows", () => {
  it("전부 0 이면 빈 배열이다", () => {
    expect(buildTodayWorkRows(input())).toEqual([]);
  });

  it("주문 요약이 아직 없으면(로딩·실패) 주문 행은 만들지 않는다", () => {
    const rows = buildTodayWorkRows(input({ orders: undefined, approvalsPending: 1 }));
    expect(rows.map((r) => r.key)).toEqual(["approvals-pending"]);
  });

  it("0건 행은 빠진다", () => {
    const rows = buildTodayWorkRows(input({ agenda: { tasks: 2, settlements: 0 }, dataCheck: 1 }));
    expect(rows.map((r) => r.key)).toEqual(["outreach-followup", "data-check"]);
  });

  it("순서는 주문 → 영업 → 정산 → 결재 → 점검으로 고정이고, 라벨은 종전 화면 낱말 그대로다", () => {
    const rows = buildTodayWorkRows(busy());
    expect(rows.map((r) => r.key)).toEqual([
      "orders-pending",
      "orders-delayed",
      "orders-returns",
      "outreach-followup",
      "settlement-delayed",
      "approvals-pending",
      "data-check",
    ]);
    expect(rows.map((r) => r.label)).toEqual([
      "발주 대기",
      "송장·배송 지연",
      "반품/교환",
      "영업 팔로업",
      "지연된 정산",
      "승인대기",
      "데이터 점검",
    ]);
    expect(rows.map((r) => r.count)).toEqual([12, 4, 2, 5, 2, 3, 7]);
  });

  it("발주 대기는 평상시 무채색, 결제 후 2일 이상 건이 있을 때만 주의색이다(buildOrderWorkBuckets 승계)", () => {
    const calm = buildTodayWorkRows(busy())[0];
    expect(calm.tone).toBe("neutral");
    expect(calm.detail ?? null).toBeNull();

    const late = buildTodayWorkRows(
      input({ orders: orders({ awaitingPo: { lines: 12, campaigns: 3, delayedLines: 5 }, total: 12 }) }),
    )[0];
    expect(late.tone).toBe("caution");
    expect(late.detail).toBe("결제 후 2일 이상 5건");
  });

  it("색은 종전 규칙을 승계한다 — 지연·반품/교환·정산 지연 = 위험, 팔로업 = 정보, 점검 = 주의", () => {
    const tone = Object.fromEntries(buildTodayWorkRows(busy()).map((r) => [r.key, r.tone]));
    expect(tone).toMatchObject({
      "orders-delayed": "urgent",
      "orders-returns": "urgent",
      "outreach-followup": "info",
      "settlement-delayed": "urgent",
      "data-check": "caution",
    });
  });

  it("송장·배송 지연의 세부 줄은 주문 관리 화면과 같은 말로 나눠 말한다", () => {
    const delayed = buildTodayWorkRows(busy()).find((r) => r.key === "orders-delayed")!;
    expect(delayed.detail).toBe("송장 지연 3건 · 배송 지연 1건");
  });

  it("행마다 그 일을 처리하는 화면으로 간다", () => {
    const href = Object.fromEntries(buildTodayWorkRows(busy()).map((r) => [r.key, r.href]));
    expect(href).toEqual({
      "orders-pending": "/order-converter",
      "orders-delayed": "/order-converter",
      "orders-returns": "/order-converter",
      "outreach-followup": "/outreach",
      "settlement-delayed": "/settlement",
      "approvals-pending": "/approvals",
      "data-check": "/#data-check",
    });
  });

  it("지연된 정산이 한 건이면 그 캠페인 상세를 연 채로 정산 관리로 간다", () => {
    const row = buildTodayWorkRows(
      input({ agenda: { tasks: 0, settlements: 1, overdueSettlementIds: ["camp/1"] } }),
    )[0];
    expect(row.key).toBe("settlement-delayed");
    expect(row.href).toBe("/settlement?campaign=camp%2F1");
  });

  it("한 건이어도 캠페인 번호를 모르면 정산 관리 첫 화면으로 간다", () => {
    const row = buildTodayWorkRows(input({ agenda: { tasks: 0, settlements: 1 } }))[0];
    expect(row.href).toBe("/settlement");
  });
});
