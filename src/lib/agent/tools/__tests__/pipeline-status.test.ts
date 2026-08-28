import { describe, expect, it, vi, beforeEach } from "vitest";

const findManyMock = vi.fn();

vi.mock("@/repositories/campaignRepository", () => ({
  campaignRepository: {
    findMany: (...args: unknown[]) => findManyMock(...args),
  },
}));

import { getPipelineStatusTool } from "../pipeline-status";

describe("get_pipeline_status 도구", () => {
  beforeEach(() => {
    findManyMock.mockReset();
  });

  it("상태별 집계를 반환한다", async () => {
    findManyMock.mockResolvedValue([
      { id: "c1", status: "ACTIVE", deal: { dealName: "딜A" }, seller: { name: "셀러A" }, startDate: new Date("2026-07-01"), endDate: new Date("2026-07-15") },
      { id: "c2", status: "ACTIVE", deal: { dealName: "딜B" }, seller: { name: "셀러B" }, startDate: new Date("2026-07-01"), endDate: new Date("2026-07-15") },
      { id: "c3", status: "PROPOSAL", deal: { dealName: "딜C" }, seller: { name: "셀러C" }, startDate: new Date("2026-07-01"), endDate: new Date("2026-07-15") },
    ]);

    const result = await getPipelineStatusTool.execute({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.totalCount).toBe(3);
    const activeCount = result.data.statusCounts.find((s) => s.status === "ACTIVE")?.count;
    expect(activeCount).toBe(2);
    // status 미지정이면 상세 목록은 비워둔다 (집계만).
    expect(result.data.campaigns).toHaveLength(0);
  });

  it("status를 지정하면 해당 상태의 상세 목록을 함께 반환한다", async () => {
    findManyMock.mockResolvedValue([
      { id: "c1", status: "ACTIVE", deal: { dealName: "딜A" }, seller: { name: "셀러A" }, startDate: new Date("2026-07-01"), endDate: new Date("2026-07-15") },
    ]);

    const result = await getPipelineStatusTool.execute({ status: "ACTIVE" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.campaigns).toHaveLength(1);
    expect(result.data.campaigns[0].dealName).toBe("딜A");
  });

  it("NOT_FOUND: 조건에 맞는 캠페인이 없으면 NOT_FOUND", async () => {
    findManyMock.mockResolvedValue([]);
    const result = await getPipelineStatusTool.execute({ sellerName: "존재하지않음" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("QUERY_FAILED: repository 예외 시 QUERY_FAILED", async () => {
    findManyMock.mockRejectedValue(new Error("DB 오류"));
    const result = await getPipelineStatusTool.execute({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("QUERY_FAILED");
  });
});
