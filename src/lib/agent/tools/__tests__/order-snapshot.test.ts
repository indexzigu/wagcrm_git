import { describe, expect, it, vi, beforeEach } from "vitest";

const findRangeCountsMock = vi.fn();

vi.mock("@/repositories/naverOrderSnapshotRepository", () => ({
  naverOrderSnapshotRepository: {
    findRangeCounts: (...args: unknown[]) => findRangeCountsMock(...args),
  },
}));

import { getOrderSnapshotTool } from "../order-snapshot";

describe("get_order_snapshot 도구", () => {
  beforeEach(() => {
    findRangeCountsMock.mockReset();
  });

  it("MISSING_PARAM: startDate/endDate 형식이 잘못되면 되묻기 대상 에러를 반환한다", async () => {
    const result = await getOrderSnapshotTool.execute({ startDate: "2026/07/01", endDate: "2026-07-05" } as any);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("MISSING_PARAM");
  });

  it("정상 조회 시 일자별 데이터와 합계를 반환한다", async () => {
    findRangeCountsMock.mockResolvedValue([
      {
        snapshotDate: "2026-07-01",
        ordersCount: 10,
        newOrdersCount: 3,
        preparingCount: 2,
        deliveringCount: 5,
        lastCallTime: new Date("2026-07-01T10:00:00Z"),
      },
      {
        snapshotDate: "2026-07-02",
        ordersCount: 8,
        newOrdersCount: 1,
        preparingCount: 1,
        deliveringCount: 6,
        lastCallTime: new Date("2026-07-02T10:00:00Z"),
      },
    ]);

    const result = await getOrderSnapshotTool.execute({ startDate: "2026-07-01", endDate: "2026-07-02" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.days).toHaveLength(2);
    expect(result.data.totals.ordersCount).toBe(18);
    expect(result.data.totals.newOrdersCount).toBe(4);
  });

  it("NOT_FOUND: 기간 내 스냅샷이 없으면 NOT_FOUND", async () => {
    findRangeCountsMock.mockResolvedValue([]);
    const result = await getOrderSnapshotTool.execute({ startDate: "2026-07-01", endDate: "2026-07-02" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("QUERY_FAILED: repository 예외 시 QUERY_FAILED", async () => {
    findRangeCountsMock.mockRejectedValue(new Error("DB 오류"));
    const result = await getOrderSnapshotTool.execute({ startDate: "2026-07-01", endDate: "2026-07-02" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("QUERY_FAILED");
  });

  describe("m2: 조회 범위 상한 (zod refine)", () => {
    it("endDate가 startDate보다 앞서면 스키마 검증이 실패한다", () => {
      const parsed = getOrderSnapshotTool.inputSchema.safeParse({
        startDate: "2026-07-10",
        endDate: "2026-07-01",
      });
      expect(parsed.success).toBe(false);
    });

    it("범위가 366일을 초과하면 스키마 검증이 실패한다", () => {
      const parsed = getOrderSnapshotTool.inputSchema.safeParse({
        startDate: "2025-01-01",
        endDate: "2026-01-03", // 367일 (366일 초과)
      });
      expect(parsed.success).toBe(false);
    });

    it("정확히 366일 범위는 허용된다", () => {
      const parsed = getOrderSnapshotTool.inputSchema.safeParse({
        startDate: "2025-01-01",
        endDate: "2026-01-02", // 정확히 366일
      });
      expect(parsed.success).toBe(true);
    });

    it("startDate와 endDate가 같은 경우(1일 조회)는 허용된다", () => {
      const parsed = getOrderSnapshotTool.inputSchema.safeParse({
        startDate: "2026-07-01",
        endDate: "2026-07-01",
      });
      expect(parsed.success).toBe(true);
    });
  });
});
