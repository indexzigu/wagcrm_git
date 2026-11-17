/**
 * T-311 — 승인(tx1) 뒤 실행(tx2) 전에 멈춘 기안의 복구를 **실 SQLite**(격리 임시 파일)로 고정한다.
 *
 * 재현하는 사고: tx1 이 APPROVED 를 커밋한 뒤 tx2(실행 + EXECUTED 전이)가 끝나지 못하고, FAILED 기록조차
 * 남기지 못한 채 프로세스가 죽는다 → 기안이 APPROVED 로 남는다. 고치기 전에는 ①결재함 탭에 APPROVED 가 없어
 * 보이지 않고 ②`approveProposal` 이 APPROVED 를 받지 않아(INVALID_STATUS) 다시 시도할 길이 없었다.
 *
 * 진짜로 돌리는 것: 승인 SSOT(`approveProposal` tx1 CAS · tx2 · 재시도), 저장소 CAS 전이, 복구 함수.
 * 가짜: 실행 동작(`executeWriteAction`) — 트랜잭션 안에서 표식 행 1개를 쓰고, 지시하면 「쓰고 나서 죽는다」.
 * 표식 행 수 = **커밋된 실행 횟수**다. 이중 실행 여부는 이 수로 판정한다(호출 횟수가 아니라).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushSqliteTestSchema } from "@/test/sqlite-test-db";

const REPO_ROOT = process.cwd();

let tmpDir: string;
let realPrisma: any;

vi.mock("@/lib/prisma", () => ({ getPrisma: () => realPrisma }));
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => true }));

const MARKER_NOTE = "t311-executed-marker";
const crash = { duringExecute: false };

vi.mock("@/lib/agent/write-executor", () => ({
  resolveWriteActionTxTimeoutMs: () => undefined,
  executeWriteAction: async (_action: string, _args: Record<string, unknown>, _actor: string, tx: any) => {
    // 실행의 쓰기 — tx 안에서만 쓴다(실제 핸들러 계약과 같다: `write-actions/types.ts`).
    const proposal = await tx.actionProposal.findFirst({ select: { id: true } });
    await tx.actionProposalEvent.create({
      data: { proposalId: proposal.id, fromStatus: null, toStatus: "MARKER", actor: "TEST", note: MARKER_NOTE },
    });
    if (crash.duringExecute) throw new Error("process killed mid-execution");
    return { refType: "DEAL", refId: "deal1", summary: "테스트 실행" };
  },
}));
vi.mock("@/lib/agent/write-action-effects", () => ({ applyWriteActionEffects: () => {} }));

const { approveProposal } = await import("@/lib/agent/approve-proposal");
const { ActionProposalRepository } = await import("@/repositories/actionProposalRepository");
const { recoverStaleApprovedProposals, STALE_APPROVED_MS, STALE_APPROVED_NOTE } = await import(
  "@/lib/agent/stale-approved-recovery"
);

const OWNER = "owner-uuid";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "wag-crm-stale-approved-"));
  const dbPath = join(tmpDir, "test.db");
  pushSqliteTestSchema(dbPath, REPO_ROOT);
  const generatedClientPath = join(REPO_ROOT, "prisma", "generated", "prisma-sqlite", "index.js");
  const { PrismaClient } = await import(/* @vite-ignore */ generatedClientPath);
  realPrisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
}, 60_000);

afterAll(async () => {
  await realPrisma?.$disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await realPrisma.actionProposalEvent.deleteMany({});
  await realPrisma.actionProposal.deleteMany({});
  crash.duringExecute = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function createPending(): Promise<string> {
  const created = await realPrisma.actionProposal.create({
    data: {
      requestType: "deal_create",
      kind: "WRITE",
      status: "PENDING_APPROVAL",
      title: "판매 조건 등록",
      createdBy: "AGENT_WORKER",
      payload: JSON.stringify({ action: "create_deal", args: { name: "x" } }),
    },
  });
  return created.id;
}

const committedExecutions = () => realPrisma.actionProposalEvent.count({ where: { note: MARKER_NOTE } });
const statusOf = async (id: string) =>
  (await realPrisma.actionProposal.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

/**
 * 프로세스가 tx2 도중 죽은 상황: 실행은 쓰고 나서 죽고(tx2 롤백), 이어지는 FAILED 기록도 DB 에 닿지 못한다.
 * 결과 = tx1 의 APPROVED 만 커밋된 채 남는다.
 */
async function approveAndDieMidExecution(id: string): Promise<void> {
  crash.duringExecute = true;
  const original = ActionProposalRepository.transition.bind(ActionProposalRepository);
  const spy = vi.spyOn(ActionProposalRepository, "transition").mockImplementation(async (pid, to, opts) => {
    if (to === "FAILED") throw new Error("connection lost");
    return original(pid, to, opts);
  });
  await expect(approveProposal(id, OWNER)).rejects.toThrow("connection lost");
  spy.mockRestore();
  crash.duringExecute = false;
}

/** 시계를 돌리는 대신 기안의 마지막 변경 시각을 과거로 민다(복구 판정은 `updatedAt` 기준). */
async function ageApproved(id: string, ms: number): Promise<void> {
  await realPrisma.actionProposal.update({ where: { id }, data: { updatedAt: new Date(Date.now() - ms) } });
}

describe("T-311 승인 뒤 실행 전에 멈춘 기안", () => {
  it("재현: 실행 도중 죽으면 APPROVED 로 남고 실행 쓰기는 커밋되지 않는다 — 그대로는 재시도가 거부된다", async () => {
    const id = await createPending();
    await approveAndDieMidExecution(id);

    expect(await statusOf(id)).toBe("APPROVED");
    expect(await committedExecutions()).toBe(0);
    const retry = await approveProposal(id, OWNER);
    expect(retry).toMatchObject({ ok: false, code: "INVALID_STATUS" });
  });

  it("오래 멈춘 APPROVED 는 복구가 FAILED 로 보내고, 그 뒤 재시도로 정확히 한 번 실행된다", async () => {
    const id = await createPending();
    await approveAndDieMidExecution(id);
    await ageApproved(id, STALE_APPROVED_MS + 60_000);

    const recovery = await recoverStaleApprovedProposals(new Date());
    expect(recovery).toEqual({ recovered: 1, errors: 0 });

    const row = await realPrisma.actionProposal.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toBe(STALE_APPROVED_NOTE);
    const event = await realPrisma.actionProposalEvent.findFirst({
      where: { proposalId: id, fromStatus: "APPROVED", toStatus: "FAILED" },
    });
    expect(event?.note).toBe(STALE_APPROVED_NOTE);

    const retry = await approveProposal(id, OWNER);
    expect(retry).toMatchObject({ ok: true });
    expect(await statusOf(id)).toBe("EXECUTED");
    expect(await committedExecutions()).toBe(1);

    // 다시 돌려도 EXECUTED 는 건드리지 않고, 재승인도 거부된다 — 두 번째 실행은 없다.
    expect(await recoverStaleApprovedProposals(new Date())).toEqual({ recovered: 0, errors: 0 });
    expect(await approveProposal(id, OWNER)).toMatchObject({ ok: false, code: "INVALID_STATUS" });
    expect(await committedExecutions()).toBe(1);
  });

  it("방금 승인된(실행 중일 수 있는) APPROVED 는 건드리지 않는다", async () => {
    const id = await createPending();
    await approveAndDieMidExecution(id);
    await ageApproved(id, STALE_APPROVED_MS - 60_000);

    expect(await recoverStaleApprovedProposals(new Date())).toEqual({ recovered: 0, errors: 0 });
    expect(await statusOf(id)).toBe("APPROVED");
  });

  it("다른 상태(대기·완료·실패·반려)는 오래됐어도 건드리지 않는다", async () => {
    const old = new Date(Date.now() - STALE_APPROVED_MS - 60_000);
    for (const status of ["PENDING_APPROVAL", "EXECUTED", "FAILED", "REJECTED"]) {
      await realPrisma.actionProposal.create({
        data: { requestType: "deal_create", kind: "WRITE", status, title: status, createdBy: "AGENT_WORKER", updatedAt: old },
      });
    }
    expect(await recoverStaleApprovedProposals(new Date())).toEqual({ recovered: 0, errors: 0 });
    expect(await realPrisma.actionProposalEvent.count()).toBe(0);
  });

  it("경합: 후보로 읽은 뒤 실행이 먼저 EXECUTED 를 커밋했으면 FAILED 로 덮지 않고 오류로도 세지 않는다", async () => {
    const id = await createPending();
    await approveAndDieMidExecution(id);
    await ageApproved(id, STALE_APPROVED_MS + 60_000);

    // 후보 조회와 전이 사이에 늦게 끝난 실행이 EXECUTED 를 커밋하는 상황.
    const originalFindMany = realPrisma.actionProposal.findMany.bind(realPrisma.actionProposal);
    vi.spyOn(realPrisma.actionProposal, "findMany").mockImplementationOnce(async (args: unknown) => {
      const rows = await originalFindMany(args);
      await realPrisma.actionProposal.update({ where: { id }, data: { status: "EXECUTED" } });
      return rows;
    });

    expect(await recoverStaleApprovedProposals(new Date())).toEqual({ recovered: 0, errors: 0 });
    expect(await statusOf(id)).toBe("EXECUTED");
  });

  // SQLite 단일 프로세스로는 「전이 함수가 APPROVED 를 읽은 뒤·조건부 쓰기 전」 창을 만들 수 없다 — 그 창에서
  // 저장소가 던지는 ConcurrentModificationError 를 직접 주입해 건너뜀으로 처리되는지, 그리고 조건부 쓰기
  // (expectedFrom: "APPROVED")를 실제로 요구하는지를 고정한다.
  it("조건부 쓰기에서 지면(ConcurrentModificationError) 건너뛰고, 전이는 expectedFrom APPROVED 로 요청한다", async () => {
    const id = await createPending();
    await approveAndDieMidExecution(id);
    await ageApproved(id, STALE_APPROVED_MS + 60_000);
    const { ConcurrentModificationError } = await import("@/repositories/actionProposalRepository");
    const spy = vi.spyOn(ActionProposalRepository, "transition").mockRejectedValueOnce(new ConcurrentModificationError("lost"));

    expect(await recoverStaleApprovedProposals(new Date())).toEqual({ recovered: 0, errors: 0 });
    expect(spy).toHaveBeenCalledWith(id, "FAILED", expect.objectContaining({ expectedFrom: "APPROVED" }));
    expect(await statusOf(id)).toBe("APPROVED");
  });

  it("전이가 다른 이유로 실패하고 행이 여전히 APPROVED 면 오류로 센다(조용히 삼키지 않는다)", async () => {
    const id = await createPending();
    await approveAndDieMidExecution(id);
    await ageApproved(id, STALE_APPROVED_MS + 60_000);
    vi.spyOn(ActionProposalRepository, "transition").mockRejectedValueOnce(new Error("db hiccup"));

    expect(await recoverStaleApprovedProposals(new Date())).toEqual({ recovered: 0, errors: 1 });
    expect(await statusOf(id)).toBe("APPROVED");
  });

  it("캘린더에서 들어온 기안이면 수집 행을 재판정 대기(PENDING_RETRY)로 되돌린다", async () => {
    const id = await createPending();
    const inbound = await realPrisma.calendarInboundEvent.create({
      data: {
        googleEventId: "evt-t311",
        calendarId: "cal-t311",
        summary: "테스트 일정",
        startDate: "2026-11-20",
        endDate: "2026-11-20",
        fingerprint: "fp",
        status: "PROPOSED",
        proposalId: id,
        lastSeenAt: new Date(),
      },
    });
    const ref = {
      calendarInbound: {
        inboundId: inbound.id,
        eventId: "evt-t311",
        calendarId: "cal-t311",
        ledgerKind: "campaign",
        adopt: false,
        summary: "테스트 일정",
        startDate: "2026-11-20",
        endDate: "2026-11-20",
        htmlLink: null,
        warnings: [],
      },
    };
    await realPrisma.actionProposal.update({
      where: { id },
      data: { status: "APPROVED", sourceRef: JSON.stringify(ref), updatedAt: new Date(Date.now() - STALE_APPROVED_MS - 60_000) },
    });

    expect(await recoverStaleApprovedProposals(new Date())).toEqual({ recovered: 1, errors: 0 });
    const row = await realPrisma.calendarInboundEvent.findUniqueOrThrow({ where: { id: inbound.id } });
    expect(row.status).toBe("PENDING_RETRY");
    await realPrisma.calendarInboundEvent.deleteMany({});
  });
});
