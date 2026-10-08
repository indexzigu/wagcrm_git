/**
 * 단일 실행 잠금의 **Postgres 갈래** — `pg_try_advisory_xact_lock` 을 못 잡으면 회차가 아무것도
 * 하지 않는다. sqlite 갈래(프로세스 안 플래그)는 realdb 테스트가 실제 동시 실행으로 본다.
 * DB 분기를 테스트 안에서 고정해(`isSqliteDatabaseUrl` 모킹) `npm test`·`test:ci` 어느 쪽에서도
 * 같은 길을 탄다(dev-qa P9 「npm test 통과는 CI 통과가 아니다」).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const queryRaw = vi.fn();
const transaction = vi.fn();

vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => false }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    $transaction: transaction,
    actionProposal: { findMany },
  }),
}));
vi.mock("@/lib/agent/approve-proposal", () => ({ approveProposal: vi.fn() }));

const { runSettlementAutoExecutePass } = await import("../settlement-auto-execute");

const ENV = { AGENT_AUTO_EXECUTE: "on" } as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
  queryRaw.mockReset();
  transaction.mockReset().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRaw: queryRaw }),
  );
});

describe("Postgres 단일 실행 잠금", () => {
  it("잠금을 못 잡으면(다른 회차가 쥠) 후보 조회조차 하지 않는다", async () => {
    queryRaw.mockResolvedValue([{ locked: false }]);
    const result = await runSettlementAutoExecutePass({ env: ENV, fetchImpl: vi.fn() });
    expect(result).toMatchObject({ ran: false, lockBusy: true, quiet: true });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("잠금을 잡으면 회차가 돈다 — 잠금은 트랜잭션 잠금(xact)이고 시간 제한을 둔다", async () => {
    queryRaw.mockResolvedValue([{ locked: true }]);
    const result = await runSettlementAutoExecutePass({ env: ENV, fetchImpl: vi.fn() });
    expect(result).toMatchObject({ ran: true, lockBusy: false });
    expect(findMany).toHaveBeenCalled();
    const sql = (queryRaw.mock.calls[0][0] as TemplateStringsArray).join("?");
    expect(sql).toContain("pg_try_advisory_xact_lock");
    expect(transaction.mock.calls[0][1]).toMatchObject({ timeout: expect.any(Number) });
  });

  it("off 면 잠금도 잡지 않는다(DB 를 건드리지 않는다)", async () => {
    await runSettlementAutoExecutePass({ env: {} as NodeJS.ProcessEnv });
    expect(transaction).not.toHaveBeenCalled();
  });
});
