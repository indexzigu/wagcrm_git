import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { POST } from "./route";
import { SYNC_WAIT_TIMEOUT_MS } from "@/lib/mobile-order-refresh";

const requireAuthMock = vi.fn();
const latestSyncMetaMock = vi.fn();
const runSyncMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({
  requireAuth: () => requireAuthMock(),
}));

vi.mock("@/repositories/naverOrderSnapshotRepository", () => ({
  naverOrderSnapshotRepository: {
    latestSyncMeta: () => latestSyncMetaMock(),
  },
}));

vi.mock("@/lib/order-converter/naver-order-sync", () => ({
  runSync: (...args: unknown[]) => runSyncMock(...args),
}));

function authenticated() {
  requireAuthMock.mockResolvedValue({
    authenticated: true,
    context: { role: "admin" },
  });
}

function syncResult(overrides: Record<string, unknown> = {}) {
  return {
    syncType: "CHANGED",
    changedProductOrderIds: [],
    affectedDates: [],
    fetchedAt: "2026-07-15T10:00:00.000Z",
    skipped: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as { __mobileOrderRefreshRate?: unknown }).__mobileOrderRefreshRate;
  delete process.env.MOBILE_ORDER_REFRESH_TTL_S;
  delete process.env.MOBILE_ORDER_REFRESH_RPM;
  authenticated();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/mobile/order-sync", () => {
  it("미인증이면 401을 그대로 반환하고 동기화를 호출하지 않는다", async () => {
    requireAuthMock.mockResolvedValue({
      authenticated: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const response = await POST();
    expect(response.status).toBe(401);
    expect(latestSyncMetaMock).not.toHaveBeenCalled();
    expect(runSyncMock).not.toHaveBeenCalled();
  });

  it("TTL(90s) 이내 fresh면 200 + status=fresh, 네이버 동기화 미호출", async () => {
    const lastCall = new Date(Date.now() - 30_000);
    latestSyncMetaMock.mockResolvedValue({ lastCallTime: lastCall, syncType: "CHANGED" });

    const response = await POST();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("fresh");
    expect(body.asOf).toBe(lastCall.toISOString());
    expect(body.nextAllowedAt).toBe(
      new Date(lastCall.getTime() + 90_000).toISOString(),
    );
    expect(runSyncMock).not.toHaveBeenCalled();
  });

  it("TTL 경과(stale)면 runSync('CHANGED')를 호출하고 synced + 영향 일자 수를 돌려준다", async () => {
    latestSyncMetaMock.mockResolvedValue({
      lastCallTime: new Date(Date.now() - 120_000),
      syncType: "CHANGED",
    });
    runSyncMock.mockResolvedValue(
      syncResult({ affectedDates: ["2026-07-14", "2026-07-15"] }),
    );

    const response = await POST();
    expect(runSyncMock).toHaveBeenCalledWith("CHANGED");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "synced",
      asOf: "2026-07-15T10:00:00.000Z",
      changed: 2,
    });
  });

  it("스냅샷이 아예 없으면 stale로 간주해 동기화한다", async () => {
    latestSyncMetaMock.mockResolvedValue(null);
    runSyncMock.mockResolvedValue(syncResult({ affectedDates: ["2026-07-15"] }));

    const response = await POST();
    expect(runSyncMock).toHaveBeenCalledWith("CHANGED");
    const body = await response.json();
    expect(body).toEqual({
      status: "synced",
      asOf: "2026-07-15T10:00:00.000Z",
      changed: 1,
    });
  });

  it("8초 타임아웃을 넘기면 syncing + 기존 asOf로 먼저 응답한다", async () => {
    vi.useFakeTimers();
    const lastCall = new Date(Date.now() - 300_000);
    latestSyncMetaMock.mockResolvedValue({ lastCallTime: lastCall, syncType: "CHANGED" });
    // 절대 resolve되지 않는 동기화 — 백그라운드 완주 시나리오
    runSyncMock.mockReturnValue(new Promise(() => {}));

    const responsePromise = POST();
    await vi.advanceTimersByTimeAsync(SYNC_WAIT_TIMEOUT_MS);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "syncing",
      asOf: lastCall.toISOString(),
    });
  });

  it("동기화 전면 실패(error + 영향 일자 0)는 502로 표면화한다", async () => {
    latestSyncMetaMock.mockResolvedValue(null);
    runSyncMock.mockResolvedValue(
      syncResult({ error: "naver api down", affectedDates: [] }),
    );

    const response = await POST();
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "naver api down" });
  });

  it("env TTL 클램프: MOBILE_ORDER_REFRESH_TTL_S=60일 때 경과 70초는 stale", async () => {
    process.env.MOBILE_ORDER_REFRESH_TTL_S = "60";
    latestSyncMetaMock.mockResolvedValue({
      lastCallTime: new Date(Date.now() - 70_000),
      syncType: "CHANGED",
    });
    runSyncMock.mockResolvedValue(syncResult());

    await POST();
    expect(runSyncMock).toHaveBeenCalledWith("CHANGED");
  });

  it("분당 기본 3회 초과만 429 + Retry-After — fresh 응답은 429가 아니다", async () => {
    latestSyncMetaMock.mockResolvedValue({
      lastCallTime: new Date(Date.now() - 1_000),
      syncType: "CHANGED",
    });

    for (let i = 0; i < 3; i += 1) {
      const response = await POST();
      // TTL 이내 fresh — 게이트에 걸려도 정상 200이다(스펙: fresh는 429 아님)
      expect(response.status).toBe(200);
    }
    const fourth = await POST();
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(runSyncMock).not.toHaveBeenCalled();
  });

  it("env MOBILE_ORDER_REFRESH_RPM=1이면 2번째부터 429다(오너 하향 레버)", async () => {
    process.env.MOBILE_ORDER_REFRESH_RPM = "1";
    latestSyncMetaMock.mockResolvedValue({
      lastCallTime: new Date(Date.now() - 1_000),
      syncType: "CHANGED",
    });

    const first = await POST();
    expect(first.status).toBe(200);
    const second = await POST();
    expect(second.status).toBe(429);
    expect(runSyncMock).not.toHaveBeenCalled();
  });
});
