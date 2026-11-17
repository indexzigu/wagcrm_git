/**
 * T-310 regression: the APPLYING claim must never strand a sheet, and a committed apply must
 * never be reverted.
 *
 * Uses an in-memory fake DB (conditional updateMany + $transaction rollback) instead of call
 * assertions, so the tests check the resulting STATE:
 *   ① a crashed request's stale APPLYING claim can be taken over by a later click;
 *   ② a fresh APPLYING claim still blocks a concurrent request (409);
 *   ③ a stale claim whose apply already committed (EXECUTED proposal after the claim) is rolled
 *      forward to APPLIED instead of being applied twice;
 *   ④ once the Deal writes committed, nothing reverts the sheet (no duplicate-Deal re-apply);
 *   ⑤ row/sheet finalisation commits atomically with the Deal writes;
 *   ⑥ a request that lost its claim to a takeover cannot finalise or revert the sheet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Sheet = {
  id: string;
  status: string;
  partnerId: string | null;
  updatedAt: Date;
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
};
type Row = { id: string; priceSheetId: string; mappingStatus: string; mappedDealId: string | null };
type Proposal = {
  id: string;
  requestType: string;
  targetEntityType: string;
  targetEntityId: string;
  status: string;
  createdAt: Date;
  executionResult: unknown;
};

const db: { sheet: Sheet; rows: Row[]; proposals: Proposal[]; dealsCreated: number } = {
  sheet: { id: "sheet-1", status: "MAPPED", partnerId: null, updatedAt: new Date() },
  rows: [],
  proposals: [],
  dealsCreated: 0,
};

function matchDate(value: Date, cond: unknown): boolean {
  if (cond instanceof Date) return value.getTime() === cond.getTime();
  const c = cond as { lt?: Date; gte?: Date };
  if (c.lt && !(value.getTime() < c.lt.getTime())) return false;
  if (c.gte && !(value.getTime() >= c.gte.getTime())) return false;
  return true;
}

function matchStatus(value: string, cond: unknown): boolean {
  if (typeof cond === "string") return value === cond;
  const c = cond as { in?: string[]; notIn?: string[] };
  if (c.in && !c.in.includes(value)) return false;
  if (c.notIn && c.notIn.includes(value)) return false;
  return true;
}

// Minimal Prisma where-evaluator for the shapes the route uses on PriceSheet.
function matchSheet(sheet: Sheet, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "id" && sheet.id !== cond) return false;
    if (key === "status" && !matchStatus(sheet.status, cond)) return false;
    if (key === "updatedAt" && !matchDate(sheet.updatedAt, cond)) return false;
    if (key === "OR" && !(cond as Record<string, unknown>[]).some((w) => matchSheet(sheet, w))) return false;
    if (key === "AND" && !(cond as Record<string, unknown>[]).every((w) => matchSheet(sheet, w))) return false;
  }
  return true;
}

function matchRow(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "id") {
      const c = cond as { in?: string[] } | string;
      if (typeof c === "string" ? row.id !== c : !(c.in ?? []).includes(row.id)) return false;
    }
    if (key === "priceSheetId" && row.priceSheetId !== cond) return false;
    if (key === "mappingStatus" && !matchStatus(row.mappingStatus, cond)) return false;
  }
  return true;
}

function makeClient() {
  return {
    priceSheet: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Sheet> }) => {
        if (!matchSheet(db.sheet, where)) return { count: 0 };
        Object.assign(db.sheet, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: Partial<Sheet> }) => {
        Object.assign(db.sheet, data);
        return { ...db.sheet };
      }),
      findUnique: vi.fn(async () => ({ ...db.sheet })),
    },
    priceSheetRow: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        db.rows.filter((r) => matchRow(r, where)).map((r) => ({ ...r }))
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        if (rowUpdateShouldFail) throw new Error("row update failed");
        const hit = db.rows.filter((r) => matchRow(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    actionProposal: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const hits = db.proposals
          .filter(
            (p) =>
              p.requestType === where.requestType &&
              p.targetEntityType === where.targetEntityType &&
              p.targetEntityId === where.targetEntityId &&
              (where.status === undefined || matchStatus(p.status, where.status)) &&
              (where.createdAt === undefined || matchDate(p.createdAt, where.createdAt))
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return hits[0] ?? null;
      }),
    },
    deal: { findUnique: vi.fn() },
    // Real $transaction semantics: a throw inside the callback rolls every write back.
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone(db);
      try {
        return await cb(client);
      } catch (err) {
        Object.assign(db, snapshot);
        throw err;
      }
    }),
  };
}

let rowUpdateShouldFail = false;
let client = makeClient();
const applyBehavior: { beforeTx?: () => void; fail?: boolean } = {};
const applyPriceSheetMock = vi.fn();
const revalidateMock = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireAuth: async () => ({ authenticated: true }) }));
vi.mock("@/lib/auth-context", () => ({ getAuthContext: async () => ({ email: "tester@example.com" }) }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/repositories/priceSheetRepository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/repositories/priceSheetRepository")>();
  return {
    ...actual,
    PriceSheetRepository: {
      findById: async () => ({ ...db.sheet }),
      // Unconditional write — if the route still used it to finalise, ⑥ would catch it.
      updateStatus: async (_id: string, status: string, extra: Partial<Sheet> = {}) => {
        Object.assign(db.sheet, extra, { status });
        return { ...db.sheet };
      },
    },
  };
});
vi.mock("@/lib/price-sheet/apply-executor", () => {
  class ApplyExecutorError extends Error {}
  return { applyPriceSheet: (...a: unknown[]) => applyPriceSheetMock(...a), ApplyExecutorError };
});
vi.mock("@/lib/price-sheet/serialize-response", () => ({ normalizePriceSheetForResponse: (s: unknown) => s }));
vi.mock("@/lib/cache-tags", () => ({ revalidateMasterDataCaches: () => revalidateMock() }));

const { POST } = await import("./route");
const { ApplyExecutorError } = await import("@/lib/price-sheet/apply-executor");

// Mimics apply-executor: Deal writes + EXECUTED transition + caller finalize in ONE $transaction.
async function fakeApply(input: {
  rows: Row[];
  finalize?: (tx: unknown) => Promise<void>;
}) {
  applyBehavior.beforeTx?.();
  try {
    return await client.$transaction(async (tx) => {
      db.dealsCreated += input.rows.length;
      if (applyBehavior.fail) throw new Error("deal write failed");
      await input.finalize?.(tx);
      db.proposals.push({
        id: `p-${db.proposals.length + 1}`,
        requestType: "price_sheet_apply",
        targetEntityType: "PRICE_SHEET",
        targetEntityId: db.sheet.id,
        status: "EXECUTED",
        createdAt: new Date(),
        executionResult: { results: [] },
      });
      return { proposal: { id: "p", status: "EXECUTED" }, results: input.rows.map((r) => ({ dealId: r.id, action: "CREATE" })) };
    });
  } catch (err) {
    throw new ApplyExecutorError(`가격표 반영 실행 실패: ${(err as Error).message}`);
  }
}

const post = () =>
  POST(new NextRequest("http://localhost/api/price-sheets/sheet-1/apply", { method: "POST" }), {
    params: Promise.resolve({ id: "sheet-1" }),
  });

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  rowUpdateShouldFail = false;
  client = makeClient();
  applyBehavior.beforeTx = undefined;
  applyBehavior.fail = false;
  applyPriceSheetMock.mockReset();
  applyPriceSheetMock.mockImplementation(fakeApply);
  revalidateMock.mockReset();
  db.sheet = { id: "sheet-1", status: "MAPPED", partnerId: null, updatedAt: new Date(Date.now() - HOUR) };
  db.rows = [
    { id: "row-1", priceSheetId: "sheet-1", mappingStatus: "NEW_DEAL", mappedDealId: null },
    { id: "row-2", priceSheetId: "sheet-1", mappingStatus: "MAPPED", mappedDealId: "deal-1" },
  ];
  db.proposals = [];
  db.dealsCreated = 0;
});

describe("POST /apply — APPLYING claim lifecycle (T-310)", () => {
  it("baseline: a normal apply ends APPLIED with rows APPLIED", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(db.sheet.status).toBe("APPLIED");
    expect(db.rows.map((r) => r.mappingStatus)).toEqual(["APPLIED", "APPLIED"]);
    expect(db.dealsCreated).toBe(2);
  });

  it("① a stale APPLYING claim (crashed request) is taken over and applied", async () => {
    db.sheet.status = "APPLYING";
    db.sheet.updatedAt = new Date(Date.now() - HOUR);

    const res = await post();

    expect(res.status).toBe(200);
    expect(applyPriceSheetMock).toHaveBeenCalledTimes(1);
    expect(db.sheet.status).toBe("APPLIED");
    expect(db.dealsCreated).toBe(2);
  });

  it("② a fresh APPLYING claim still blocks a concurrent request", async () => {
    db.sheet.status = "APPLYING";
    db.sheet.updatedAt = new Date(Date.now() - 10_000);

    const res = await post();

    expect(res.status).toBe(409);
    expect(applyPriceSheetMock).not.toHaveBeenCalled();
    expect(db.sheet.status).toBe("APPLYING");
  });

  it("③ a stale claim whose apply already committed is rolled forward, not applied twice", async () => {
    const claimedAt = new Date(Date.now() - HOUR);
    db.sheet.status = "APPLYING";
    db.sheet.updatedAt = claimedAt;
    db.proposals.push({
      id: "p-legacy",
      requestType: "price_sheet_apply",
      targetEntityType: "PRICE_SHEET",
      targetEntityId: "sheet-1",
      status: "EXECUTED",
      createdAt: new Date(claimedAt.getTime() + 1000),
      executionResult: { results: [{ dealId: "d", action: "CREATE" }] },
    });

    const res = await post();

    expect(res.status).toBe(200);
    expect(applyPriceSheetMock).not.toHaveBeenCalled();
    expect(db.dealsCreated).toBe(0);
    expect(db.sheet.status).toBe("APPLIED");
    expect(db.rows.map((r) => r.mappingStatus)).toEqual(["APPLIED", "APPLIED"]);
  });

  it("③' an EXECUTED proposal from BEFORE the stale claim does not count as committed", async () => {
    const claimedAt = new Date(Date.now() - HOUR);
    db.sheet.status = "APPLYING";
    db.sheet.updatedAt = claimedAt;
    db.proposals.push({
      id: "p-old",
      requestType: "price_sheet_apply",
      targetEntityType: "PRICE_SHEET",
      targetEntityId: "sheet-1",
      status: "EXECUTED",
      createdAt: new Date(claimedAt.getTime() - 1000),
      executionResult: null,
    });

    const res = await post();

    expect(res.status).toBe(200);
    expect(applyPriceSheetMock).toHaveBeenCalledTimes(1);
  });

  it("④ a failed takeover restores a retryable status, not APPLYING", async () => {
    db.sheet.status = "APPLYING";
    db.sheet.updatedAt = new Date(Date.now() - HOUR);
    applyBehavior.fail = true;

    const res = await post();

    expect(res.status).toBe(502);
    expect(db.sheet.status).toBe("MAPPED");
    expect(db.dealsCreated).toBe(0);
  });

  it("⑤ once Deals committed, a later failure (cache revalidation) never reverts the sheet", async () => {
    revalidateMock.mockImplementation(() => {
      throw new Error("revalidate blew up");
    });

    await post().catch(() => undefined);

    expect(db.dealsCreated).toBe(2);
    expect(db.sheet.status).toBe("APPLIED");
    expect(db.rows.every((r) => r.mappingStatus === "APPLIED")).toBe(true);
  });

  it("⑤' row finalisation is atomic with the Deal writes — if it fails, the Deals roll back", async () => {
    rowUpdateShouldFail = true;

    const res = await post();

    expect(res.status).toBe(502);
    // Deals committed with rows still NEW_DEAL + sheet back to MAPPED would let a re-apply
    // create the same Deals again.
    expect(db.dealsCreated).toBe(0);
    expect(db.sheet.status).toBe("MAPPED");
  });

  it("⑥ a request that lost its claim to a takeover cannot finalise or revert the sheet", async () => {
    const takeoverToken = new Date(Date.now() + 5000);
    applyBehavior.beforeTx = () => {
      // Another request took the claim over while this one was still running.
      db.sheet.status = "APPLYING";
      db.sheet.updatedAt = takeoverToken;
    };

    const res = await post();

    expect(res.status).toBe(502);
    expect(db.dealsCreated).toBe(0);
    expect(db.sheet.status).toBe("APPLYING");
    expect(db.sheet.updatedAt.getTime()).toBe(takeoverToken.getTime());
  });
});
