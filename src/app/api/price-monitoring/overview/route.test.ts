import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  priceMonitorSnapshot: { findMany: vi.fn() },
  salesCampaign: { findMany: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaMock }));

import { GET } from "./route";

describe("GET /api/price-monitoring/overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.priceMonitorSnapshot.findMany.mockResolvedValue([
      {
        dealId: "deal-1",
        campaignId: "campaign-1",
        snapshotDate: "2026-11-13",
        verdict: "NO_DATA",
        ourUnitPrice: null,
        minValidPrice: null,
        evidence: JSON.stringify({
          sourceErrors: { naver: "NAVER_SEARCH_CLIENT_ID/SECRET 미설정", coupang: null, kakao: null },
          sourceStates: {
            naver: { status: "error", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
            coupang: { status: "disabled", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
            kakao: { status: "ok", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 2 },
          },
        }),
        deal: { dealName: "테스트 딜" },
      },
    ]);
    prismaMock.salesCampaign.findMany.mockResolvedValue([]);
  });

  it("저장된 evidence에서 최신 오류와 소스별 최근 성공을 요약한다", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.sourceHealth).toMatchObject({
      naver: { status: "error", latestError: "NAVER_SEARCH_CLIENT_ID/SECRET 미설정" },
      coupang: { status: "disabled", lastSuccessAt: null },
      kakao: {
        status: "ok",
        lastSuccessAt: "2026-11-13T04:00:00.000Z",
        checkedAt: "2026-11-13T04:00:00.000Z",
      },
    });
  });

  it("한 타깃의 최신 실패 상태를 다른 타깃의 최신 성공이 덮지 않고 위반 행도 보존한다", async () => {
    prismaMock.priceMonitorSnapshot.findMany.mockResolvedValue([
      {
        dealId: "deal-failed",
        campaignId: "campaign-failed",
        snapshotDate: "2026-11-13",
        verdict: "VIOLATED",
        ourUnitPrice: 12000,
        minValidPrice: 10000,
        evidence: JSON.stringify({
          sourceErrors: { naver: "네이버 조회 실패", coupang: null, kakao: null },
          sourceStates: {
            naver: { status: "error", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
            coupang: { status: "disabled", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
            kakao: { status: "empty", checkedAt: "2026-11-13T04:00:00.000Z", itemCount: 0 },
          },
        }),
        deal: { dealName: "실패 타깃" },
      },
      {
        dealId: "deal-ok",
        campaignId: "campaign-ok",
        snapshotDate: "2026-11-13",
        verdict: "OK",
        ourUnitPrice: 10000,
        minValidPrice: 10000,
        evidence: JSON.stringify({
          sourceErrors: { naver: null, coupang: null, kakao: null },
          sourceStates: {
            naver: { status: "ok", checkedAt: "2026-11-13T05:00:00.000Z", itemCount: 2 },
            coupang: { status: "disabled", checkedAt: "2026-11-13T05:00:00.000Z", itemCount: 0 },
            kakao: { status: "empty", checkedAt: "2026-11-13T05:00:00.000Z", itemCount: 0 },
          },
        }),
        deal: { dealName: "성공 타깃" },
      },
    ]);

    const response = await GET();
    const body = await response.json();

    expect(body.sourceHealth.naver).toMatchObject({
      status: "error",
      latestError: "네이버 조회 실패",
      checkedAt: "2026-11-13T04:00:00.000Z",
    });
    expect(body.violations).toEqual([
      expect.objectContaining({ dealId: "deal-failed", campaignId: "campaign-failed" }),
    ]);
  });

  it("최신 legacy evidence는 이전 성공 상태를 상속하지 않고 unknown으로 덮는다", async () => {
    prismaMock.priceMonitorSnapshot.findMany.mockResolvedValue([
      {
        dealId: "deal-legacy",
        campaignId: "campaign-legacy",
        snapshotDate: "2026-11-13",
        verdict: "NO_DATA",
        ourUnitPrice: null,
        minValidPrice: null,
        evidence: JSON.stringify({}),
        deal: { dealName: "레거시 타깃" },
      },
      {
        dealId: "deal-legacy",
        campaignId: "campaign-legacy",
        snapshotDate: "2026-11-12",
        verdict: "OK",
        ourUnitPrice: 10000,
        minValidPrice: 10000,
        evidence: JSON.stringify({
          sourceStates: {
            naver: { status: "ok", checkedAt: "2026-11-12T04:00:00.000Z", itemCount: 2 },
            coupang: { status: "empty", checkedAt: "2026-11-12T04:00:00.000Z", itemCount: 0 },
            kakao: { status: "empty", checkedAt: "2026-11-12T04:00:00.000Z", itemCount: 0 },
          },
        }),
        deal: { dealName: "레거시 타깃" },
      },
    ]);

    const response = await GET();
    const body = await response.json();

    expect(body.sourceHealth.naver).toMatchObject({
      status: "unknown",
      checkedAt: null,
      latestError: null,
      lastSuccessAt: "2026-11-12T04:00:00.000Z",
    });
  });

  it("무효·미래·오래된 checkedAt은 정상 상태로 집계하지 않는다", async () => {
    const recentKakaoCheckedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    prismaMock.priceMonitorSnapshot.findMany.mockResolvedValue([
      {
        dealId: "deal-invalid-time",
        campaignId: "campaign-invalid-time",
        snapshotDate: "2026-11-13",
        verdict: "NO_DATA",
        ourUnitPrice: null,
        minValidPrice: null,
        evidence: JSON.stringify({
          sourceStates: {
            naver: { status: "ok", checkedAt: "2099-01-01T00:00:00.000Z", itemCount: 1 },
            coupang: { status: "empty", checkedAt: "not-a-date", itemCount: 0 },
            kakao: { status: "ok", checkedAt: recentKakaoCheckedAt, itemCount: 1 },
          },
        }),
        deal: { dealName: "시각 오류 타깃" },
      },
    ]);

    const response = await GET();
    const body = await response.json();

    expect(body.sourceHealth.naver).toMatchObject({ status: "unknown", checkedAt: null, lastSuccessAt: null });
    expect(body.sourceHealth.coupang).toMatchObject({ status: "unknown", checkedAt: null, lastSuccessAt: null });
    expect(body.sourceHealth.kakao).toMatchObject({ status: "ok", checkedAt: recentKakaoCheckedAt });
  });

  it("오래된 checkedAt은 정상 상태로 집계하지 않는다", async () => {
    const recentKakaoCheckedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    prismaMock.priceMonitorSnapshot.findMany.mockResolvedValue([
      {
        dealId: "deal-old-time",
        campaignId: "campaign-old-time",
        snapshotDate: "2026-11-13",
        verdict: "NO_DATA",
        ourUnitPrice: null,
        minValidPrice: null,
        evidence: JSON.stringify({
          sourceStates: {
            naver: { status: "ok", checkedAt: "2026-01-01T00:00:00.000Z", itemCount: 1 },
            coupang: { status: "empty", checkedAt: recentKakaoCheckedAt, itemCount: 0 },
            kakao: { status: "empty", checkedAt: recentKakaoCheckedAt, itemCount: 0 },
          },
        }),
        deal: { dealName: "오래된 시각 타깃" },
      },
    ]);

    const response = await GET();
    const body = await response.json();

    expect(body.sourceHealth.naver).toMatchObject({ status: "unknown", checkedAt: null, lastSuccessAt: null });
    expect(body.sourceHealth.kakao).toMatchObject({ status: "empty", checkedAt: recentKakaoCheckedAt });
  });
});
