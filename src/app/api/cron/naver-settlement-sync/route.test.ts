import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * 정산 크론 라우트의 경로 계약 셋.
 *
 * ① **기본 경로는 계획이다**(2단계, 2026-09-10) — 파라미터가 없으면 `runPlannedSettlementSync`
 *    가 계획한 결제일만 부르고, 고정 달력(`runSettlementSync`, 하루 24콜)은 부르지 않는다.
 * ② **백필은 명시적 요청일 때만** — `settledDays`/`unsettledDays` 중 하나라도 있으면 고정
 *    달력으로 넓게 훑는다(재확인 창보다 긴 크론 중단 구간의 유일한 복구 경로).
 * ③ **`?dryRun=1` 은 아무것도 부르지 않고 아무것도 쓰지 않는다.**
 *    🪤 크론 상태 기록도 「쓰기」다. dry-run 분기를 `withSystemTaskStatus` **안**에 두면 실제
 *    동기화를 한 적이 없는데 마지막 실행 시각이 갱신되고 직전 실패 기록이 덮여, 레이더가 정상
 *    실행으로 표시된다(교차 검증이 잡은 결함). 그래서 조회·상태 기록·캐시 무효화를 함께 본다.
 */

const runSettlementSyncMock = vi.fn();
const runPlannedMock = vi.fn();
const recomputeMock = vi.fn();
const syncPostCloseCancellationsMock = vi.fn();
const revalidateMock = vi.fn();
const withSystemTaskStatusMock = vi.fn();
const loadPlanMock = vi.fn();

vi.mock("@/lib/order-converter/naver-settlement-sync", () => ({
  runSettlementSync: (...args: unknown[]) => runSettlementSyncMock(...args),
  runPlannedSettlementSync: (...args: unknown[]) => runPlannedMock(...args),
  recomputeClosedCampaignSettlements: (...args: unknown[]) => recomputeMock(...args),
  syncPostCloseCancellations: (...args: unknown[]) => syncPostCloseCancellationsMock(...args),
}));
vi.mock("@/lib/order-converter/settlement-pending-dates", () => ({
  loadSettlementQueryPlan: (...args: unknown[]) => loadPlanMock(...args),
  formatSettlementQueryPlan: () => "calls=1",
}));
vi.mock("@/lib/cache-tags", () => ({ revalidateCampaignCaches: (...a: unknown[]) => revalidateMock(...a) }));
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => true }));
vi.mock("@/lib/system-task-status", () => ({
  // 래퍼가 **호출됐는지 자체**를 본다 — 감싸인 핸들러가 돌면 그 안에서 상태가 기록된다.
  withSystemTaskStatus: (_key: string, handler: (r: Request) => Promise<Response>) => {
    return (request: Request) => {
      withSystemTaskStatusMock();
      return handler(request);
    };
  },
}));

const PLAN = {
  dates: [{ dateKey: "2026-09-10", reasons: ["recent-order-date"], pendingOrders: 0 }],
  estimatedCalls: 1,
  counters: { truncatedDates: 0 },
};

function call(query: string) {
  return GET(new Request(`http://localhost/api/cron/naver-settlement-sync${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  loadPlanMock.mockResolvedValue({ plan: PLAN, claimSourceUnavailableDates: [] });
  runSettlementSyncMock.mockResolvedValue({ settledFetched: 0, unsettledFetched: 0 });
  runPlannedMock.mockResolvedValue({ datesFetched: 1, calls: 1, casesUpserted: 0 });
  recomputeMock.mockResolvedValue({ campaigns: 0, updated: 0 });
  syncPostCloseCancellationsMock.mockResolvedValue({ campaigns: 0, updated: 0 });
});

describe("naver-settlement-sync 기본 경로 — 계획", () => {
  it("파라미터가 없으면 계획한 날짜만 조회하고 고정 달력은 부르지 않는다", async () => {
    const res = await call("");

    expect(runPlannedMock).toHaveBeenCalledWith(PLAN);
    expect(runSettlementSyncMock).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, mode: "planned", calls: 1 });
    expect(withSystemTaskStatusMock).toHaveBeenCalledTimes(1);
  });

  it("백필 파라미터를 주면 계획 대신 고정 달력으로 넓게 훑는다", async () => {
    const res = await call("?settledDays=31&unsettledDays=31");

    expect(runSettlementSyncMock).toHaveBeenCalledWith(31, 31);
    expect(runPlannedMock).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, mode: "backfill", settledDays: 31, unsettledDays: 31 });
  });
});

describe("naver-settlement-sync ?dryRun=1", () => {
  it("계획만 돌려주고 네이버 조회·결산·사후취소를 부르지 않는다", async () => {
    const res = await call("?dryRun=1");

    expect(await res.json()).toMatchObject({ ok: true, dryRun: true, plan: PLAN });
    expect(runPlannedMock).not.toHaveBeenCalled();
    expect(runSettlementSyncMock).not.toHaveBeenCalled();
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(syncPostCloseCancellationsMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("크론 실행 상태를 기록하지 않는다", async () => {
    await call("?dryRun=1");
    expect(withSystemTaskStatusMock).not.toHaveBeenCalled();
  });
});
