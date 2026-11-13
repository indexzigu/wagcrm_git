import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({ deal: { findMany: vi.fn() } }));
const snapshotRepo = vi.hoisted(() => ({
  findLatestByDeal: vi.fn(),
  upsertDaily: vi.fn(),
  parseRawResults: (row: { rawResults: unknown }) => row.rawResults,
  parseEvidence: (row: { evidence: unknown }) => row.evidence,
}));
const findLabelsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaMock }));
vi.mock("@/repositories/priceMonitorSnapshotRepository", () => ({ priceMonitorSnapshotRepository: snapshotRepo }));
vi.mock("@/repositories/priceMatchLabelRepository", () => ({
  priceMatchLabelRepository: { findByRootDealIds: (...args: unknown[]) => findLabelsMock(...args) },
}));

import { reevaluateLatestSnapshots } from "../reevaluate-snapshots";

const ROOT = {
  id: "root-1",
  dealName: "올리브레몬 듀얼 올레샷",
  brandName: "비비랩",
  unit: "박스",
  unitQuantity: null,
  supplementaryInfo: null,
  parentDealId: null,
  monitorBrandAliases: "뉴트리원",
};
const OPTION = { ...ROOT, id: "opt-1", dealName: "올리브레몬 듀얼 올레샷 - 2박스", brandName: null, parentDealId: "root-1", monitorBrandAliases: null };

describe("reevaluateLatestSnapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.deal.findMany.mockResolvedValue([ROOT, OPTION]);
    findLabelsMock.mockResolvedValue(new Map());
    snapshotRepo.findLatestByDeal.mockImplementation(async (dealId: string) =>
      dealId === "opt-1"
        ? {
            dealId,
            campaignId: "c-1",
            snapshotDate: "2026-11-13",
            searchQuery: "비비랩 올리브레몬 듀얼 올레샷 2박스https://gift.example.com/p/1",
            evidence: { ourTotalPrice: 24100, sourceStates: {} },
            rawResults: [
              // stored as VIOLATED-causing candidate under the old single score
              { productName: "순 유기농 올레샷 올리브 오일 레몬즙 2박스", mall: "메디트리", price: 22000, totalPrice: 22000, matchScore: 65 },
              // an old excluded row must not stay excluded just because the stale field is there
              { productName: "유기농 올리브 엔 레몬 듀얼샷 올레샷 2박스", mall: "뉴트리원공식스토어", price: 25000, totalPrice: 25000, excludeReason: "MATCH_TOO_LOW" },
            ],
          }
        : null,
    );
    snapshotRepo.upsertDaily.mockResolvedValue(undefined);
  });

  it("re-judges the latest snapshot with brand axis and keeps date/query/campaign", async () => {
    const summary = await reevaluateLatestSnapshots("root-1");
    expect(summary).toEqual({ reevaluated: 1, skipped: 0 });
    const saved = snapshotRepo.upsertDaily.mock.calls[0][0];
    expect(saved).toMatchObject({ dealId: "opt-1", campaignId: "c-1", snapshotDate: "2026-11-13", verdict: "OK" });
    const other = saved.rawResults.find((c: { mall: string }) => c.mall === "메디트리");
    const same = saved.rawResults.find((c: { mall: string }) => c.mall === "뉴트리원공식스토어");
    expect(other.excludeReason).toBe("BRAND_MISMATCH");
    expect(same.excludeReason).toBeUndefined();
    expect(saved.evidence.reevaluatedAt).toEqual(expect.any(String));
  });

  it("applies owner labels from the root deal", async () => {
    findLabelsMock.mockResolvedValue(
      new Map([["root-1", [{ nameKey: "뉴트리원공식스토어|유기농올리브엔레몬듀얼샷올레샷2박스", urlKey: null, label: "DIFFERENT" }]]]),
    );
    await reevaluateLatestSnapshots("root-1");
    const saved = snapshotRepo.upsertDaily.mock.calls[0][0];
    expect(saved.rawResults.find((c: { mall: string }) => c.mall === "뉴트리원공식스토어").excludeReason).toBe("OWNER_DIFFERENT");
    expect(saved.verdict).toBe("NO_DATA");
  });

  it("skips snapshots without our recorded total price", async () => {
    snapshotRepo.findLatestByDeal.mockResolvedValue({ dealId: "x", snapshotDate: "d", searchQuery: "q", evidence: {}, rawResults: [] });
    expect(await reevaluateLatestSnapshots("root-1")).toEqual({ reevaluated: 0, skipped: 2 });
    expect(snapshotRepo.upsertDaily).not.toHaveBeenCalled();
  });

  it("does nothing for an unknown root", async () => {
    prismaMock.deal.findMany.mockResolvedValue([]);
    expect(await reevaluateLatestSnapshots("nope")).toEqual({ reevaluated: 0, skipped: 0 });
  });
});
