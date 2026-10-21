import { afterEach, describe, expect, it, vi } from "vitest";

// [캘린더수집] 단일 실행 잠금 — Postgres 갈래(자문 잠금)를 가짜 트랜잭션으로 본다. sqlite·미설정 갈래(프로세스
// 플래그)의 겹침은 scan.test.ts 「단일 실행」이 실제 스캔으로 고정한다.
const queryRaw = vi.fn();
const transaction = vi.fn(async (fn: (tx: unknown) => unknown, _opts?: unknown) => fn({ $queryRaw: queryRaw }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ $transaction: transaction }) }));

const { withScanLock, LOCK_TX_TIMEOUT_MS } = await import("./run-lock");

const ORIGINAL_URL = process.env.DATABASE_URL;
afterEach(() => {
  if (ORIGINAL_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_URL;
  queryRaw.mockReset();
  transaction.mockClear();
});

describe("withScanLock — Postgres", () => {
  it("자문 잠금을 잡으면 본문을 돌리고, 시간 제한은 회차 예산보다 길다", async () => {
    process.env.DATABASE_URL = "postgresql://127.0.0.1:5432/db";
    queryRaw.mockResolvedValue([{ locked: true }]);
    const work = vi.fn(async () => 42);
    expect(await withScanLock(work)).toEqual({ acquired: true, value: 42 });
    expect(work).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][1]).toMatchObject({ timeout: LOCK_TX_TIMEOUT_MS });
    expect(LOCK_TX_TIMEOUT_MS).toBeGreaterThan(240_000);
  });

  it("잠금을 못 잡으면 본문을 돌리지 않는다", async () => {
    process.env.DATABASE_URL = "postgresql://127.0.0.1:5432/db";
    queryRaw.mockResolvedValue([{ locked: false }]);
    const work = vi.fn(async () => 1);
    expect(await withScanLock(work)).toEqual({ acquired: false });
    expect(work).not.toHaveBeenCalled();
  });
});

describe("withScanLock — sqlite(프로세스 플래그)", () => {
  it("DB 트랜잭션을 열지 않는다", async () => {
    process.env.DATABASE_URL = "file:./dev.db";
    expect(await withScanLock(async () => "ok")).toEqual({ acquired: true, value: "ok" });
    expect(transaction).not.toHaveBeenCalled();
  });
});
