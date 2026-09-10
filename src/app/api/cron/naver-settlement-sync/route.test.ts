import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * `?dryRun=1` 의 유일한 계약: **아무것도 부르지 않고 아무것도 쓰지 않는다.**
 *
 * 이 레버는 재설계 전환(2단계) 전에 "새 규칙이었다면 몇 콜이었나"를 값싸게 확인하려고 있다.
 * 종전 구조는 확인 자체가 한 회차치 네이버 호출이라 검증이 곧 프록시 한도 소모였다.
 *
 * 🪤 **크론 상태 기록도 「쓰기」다.** dry-run 분기를 `withSystemTaskStatus` **안**에 두면
 * 실제 동기화를 한 적이 없는데 마지막 실행 시각이 갱신되고 직전 실패 기록이 덮여, 레이더가
 * 정상 실행으로 표시된다(교차 검증이 잡은 결함). 그래서 아래 테스트가 세 축을 함께 본다 —
 * 네이버 조회 함수 미호출 · 상태 기록 미호출 · 캐시 무효화 미호출.
 */

const runSettlementSyncMock = vi.fn();
const recomputeMock = vi.fn();
const syncPostCloseCancellationsMock = vi.fn();
const revalidateMock = vi.fn();
const withSystemTaskStatusMock = vi.fn();
const loadPlanMock = vi.fn();

vi.mock("@/lib/order-converter/naver-settlement-sync", () => ({
  runSettlementSync: (...args: unknown[]) => runSettlementSyncMock(...args),
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
  counters: {},
};

function call(query: string) {
  return GET(new Request(`http://localhost/api/cron/naver-settlement-sync${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  loadPlanMock.mockResolvedValue({ plan: PLAN, claimSourceUnavailableDates: [] });
  runSettlementSyncMock.mockResolvedValue({ settledFetched: 0, unsettledFetched: 0 });
  recomputeMock.mockResolvedValue({ campaigns: 0, updated: 0 });
  syncPostCloseCancellationsMock.mockResolvedValue({ campaigns: 0, updated: 0 });
});

describe("naver-settlement-sync ?dryRun=1", () => {
  it("계획만 돌려주고 네이버 조회·결산·사후취소를 부르지 않는다", async () => {
    const res = await call("?dryRun=1");

    expect(await res.json()).toMatchObject({ ok: true, dryRun: true, plan: PLAN });
    expect(runSettlementSyncMock).not.toHaveBeenCalled();
    expect(recomputeMock).not.toHaveBeenCalled();
    expect(syncPostCloseCancellationsMock).not.toHaveBeenCalled();
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("크론 실행 상태를 기록하지 않는다", async () => {
    await call("?dryRun=1");
    expect(withSystemTaskStatusMock).not.toHaveBeenCalled();
  });

  it("플래그가 없으면 평소대로 동기화하고 상태도 기록한다", async () => {
    await call("");
    expect(withSystemTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(runSettlementSyncMock).toHaveBeenCalledTimes(1);
  });
});
