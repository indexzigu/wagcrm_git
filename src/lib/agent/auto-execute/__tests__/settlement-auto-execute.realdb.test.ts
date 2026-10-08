/**
 * 정산 금액 수정 자동 실행기 — 회차 전체를 **실 SQLite**(격리 임시 파일)로 고정한다.
 *
 * 설계 정본: Hermes `docs/wag-bridge-phase2-plan.md` §7 「시험(코드)으로 고정」 목록. 각 항목이
 * 아래 `§7` 이 붙은 it 하나에 대응한다.
 *
 * 무엇을 진짜로 돌리고 무엇을 가짜로 두는가:
 * - 진짜: 후보 조회·rid 중복·하루 건수(이벤트 집계)·판정 기록·잠금(sqlite 레인 = 프로세스 안 플래그)·
 *   승인 SSOT(`approveProposal` 의 tx1 CAS · tx2 · FAILED 기록)·멈춘 승인 정리(저장소 CAS 전이).
 * - 가짜: 슬랙(가짜 fetch — 네트워크 없음), 실행 동작(`executeWriteAction` — 「실제 값 =
 *   expectedCurrentKrw 일 때만 쓴다」 가드만 흉내 낸다. 실제 가드 자체는
 *   `update-settlement-amount.test.ts` 가 고정한다), 캐시 무효화(Next 런타임 없음).
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

/** 가짜 캠페인 저장소 — campaignId → 현재 값. */
const campaignValues = new Map<string, number | null>();
const executeCalls: unknown[] = [];

vi.mock("@/lib/agent/write-executor", () => ({
  executeWriteAction: async (action: string, args: Record<string, unknown>) => {
    executeCalls.push({ action, args });
    const id = args.campaignId as string;
    const current = campaignValues.has(id) ? campaignValues.get(id) : null;
    if (current !== args.expectedCurrentKrw) {
      throw new Error("정산 금액 수정 불가: 현재 값이 기안 때와 다릅니다");
    }
    campaignValues.set(id, args.newAmountKrw as number);
    return { refType: "CAMPAIGN", refId: id, summary: "정산 금액 수정" };
  },
}));
vi.mock("@/lib/agent/write-action-effects", () => ({ applyWriteActionEffects: () => {} }));

const { runSettlementAutoExecutePass, STUCK_APPROVED_MS } = await import("../settlement-auto-execute");

const CHANNEL = "C0TESTCHAN1";
const MUSE = { bot: "BMUSE0001", app: "AMUSE0001", user: "UMUSE0001" };
const WAG = { bot: "BWAG00001", app: "AWAG00001", user: "UWAG00001" };

const BASE_ENV = {
  AGENT_AUTO_EXECUTE: "on",
  SLACK_BRIDGE_READ_TOKEN: "test-read-token",
  AGENT_AUTO_EXECUTE_CHANNEL_ID: CHANNEL,
  AGENT_AUTO_EXECUTE_MUSE_BOT_ID: MUSE.bot,
  AGENT_AUTO_EXECUTE_MUSE_APP_ID: MUSE.app,
  AGENT_AUTO_EXECUTE_MUSE_USER_ID: MUSE.user,
} as unknown as NodeJS.ProcessEnv;

let ridSeq = 0;
function nextRid(): string {
  ridSeq += 1;
  return `01M4E4P6Z4QJ5A7X1178QJ7Y${String(ridSeq).padStart(2, "0")}`;
}

function tsFromMs(ms: number): string {
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, "0")}`;
}

type Args = {
  campaignId: string;
  field: string;
  expectedCurrentKrw: number | null;
  newAmountKrw: number;
  memo?: string;
};

type Fixture = { id: string; rid: string; ts: string; args: Args };

let campaignSeq = 0;
function defaultArgs(over: Partial<Args> = {}): Args {
  campaignSeq += 1;
  return {
    campaignId: `cmtestcampaign${campaignSeq}`,
    field: "settlementSales",
    expectedCurrentKrw: 1_200_000,
    newAmountKrw: 1_350_000,
    ...over,
  };
}

/** 브리지가 올린 정산 금액 수정 기안 1건(+ 상신 이벤트). */
async function createProposal(
  opts: { args?: Args; rid?: string; messageAgoMs?: number; createdAt?: Date; sourceRef?: unknown } = {},
): Promise<Fixture> {
  const args = opts.args ?? defaultArgs();
  const rid = opts.rid ?? nextRid();
  const createdAt = opts.createdAt ?? new Date();
  const ts = tsFromMs(createdAt.getTime() - (opts.messageAgoMs ?? 30_000));
  if (!campaignValues.has(args.campaignId)) campaignValues.set(args.campaignId, args.expectedCurrentKrw);
  const sourceRef =
    opts.sourceRef === undefined ? { slack: { channelId: CHANNEL, threadTs: ts, messageTs: ts, rid } } : opts.sourceRef;
  const created = await realPrisma.actionProposal.create({
    data: {
      requestType: "settlement_amount_update",
      kind: "WRITE",
      status: "PENDING_APPROVAL",
      title: "정산 금액 수정",
      createdBy: "AGENT_WORKER",
      payload: JSON.stringify({ action: "update_settlement_amount", args }),
      sourceRef: sourceRef === null ? null : JSON.stringify(sourceRef),
      createdAt,
    },
  });
  await realPrisma.actionProposalEvent.create({
    data: { proposalId: created.id, fromStatus: "DRAFT", toStatus: "PENDING_APPROVAL", actor: "AGENT_WORKER" },
  });
  return { id: created.id, rid, ts, args };
}

type SlackMsgOverrides = Record<string, unknown> & { params?: unknown; rid?: string; action?: string };

/** 슬랙 메시지 사전(ts → 메시지)으로 conversations.history 를 흉내 내는 가짜 fetch. */
function slackFake(messages: Map<string, Record<string, unknown>>) {
  return vi.fn(async (input: string) => {
    const url = new URL(input);
    const latest = url.searchParams.get("latest") ?? url.searchParams.get("ts") ?? "";
    const message = messages.get(latest);
    return new Response(JSON.stringify({ ok: true, messages: message ? [message] : [] }), { status: 200 });
  });
}

function museMessageFor(fixture: Fixture, over: SlackMsgOverrides = {}): Record<string, unknown> {
  const { params, rid, action, ...rest } = over;
  const block = {
    v: 1,
    rid: rid ?? fixture.rid,
    action: action ?? "crm.update_settlement_amount",
    params: params ?? fixture.args,
    reason: "정산 정정",
    reply: "thread",
    dry_run: false,
    created_at: "2026-10-09T01:00:00+09:00",
    expires_at: "2026-10-09T03:00:00+09:00",
  };
  // 슬랙이 본문의 & < > 를 바꿔 보내는 것까지 흉내 낸다.
  const json = JSON.stringify(block).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return {
    type: "message",
    ts: fixture.ts,
    user: MUSE.user,
    bot_id: MUSE.bot,
    bot_profile: { app_id: MUSE.app },
    text: `정산 정정 요청입니다.\n\`\`\`muse-req\n${json}\n\`\`\``,
    ...rest,
  };
}

async function statusOf(id: string): Promise<string> {
  return (await realPrisma.actionProposal.findUniqueOrThrow({ where: { id } })).status;
}

async function eventsOf(id: string, actor: string) {
  return realPrisma.actionProposalEvent.findMany({ where: { proposalId: id, actor }, orderBy: { createdAt: "asc" } });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "wag-crm-auto-execute-"));
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
  await realPrisma.actionProposalEvent.deleteMany({});
  await realPrisma.actionProposal.deleteMany({});
  campaignValues.clear();
  executeCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("자동 실행 — 통과하면 사람 없이 실행된다", () => {
  it("Muse 원문과 정확히 같은 한도 안 기안은 EXECUTED, 실행자 SYSTEM_AUTO", async () => {
    const p = await createProposal({ args: defaultArgs({ memo: "A&B <정정>" }) });
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p)]]));

    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl });

    expect(result).toMatchObject({ mode: "on", ran: true, executed: 1, quiet: false });
    const row = await realPrisma.actionProposal.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe("EXECUTED");
    expect(row.executedBy).toBe("SYSTEM_AUTO");
    expect(campaignValues.get(p.args.campaignId)).toBe(1_350_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("§7 시험 — 하나라도 어긋나면 PENDING 그대로", () => {
  it("§7 Wag 토큰으로 쓴 같은 형식 메시지 → PENDING (not_muse)", async () => {
    const p = await createProposal();
    const fetchImpl = slackFake(
      new Map([[p.ts, museMessageFor(p, { user: WAG.user, bot_id: WAG.bot, bot_profile: { app_id: WAG.app } })]]),
    );
    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl });
    expect(result.executed).toBe(0);
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
    const events = await eventsOf(p.id, "SYSTEM_AUTO");
    expect(events.map((e: { note: string }) => e.note)).toEqual([expect.stringContaining("verdict=not_muse")]);
    expect(executeCalls).toHaveLength(0);
  });

  it("§7 존재하지 않는 ts → PENDING (message_not_found)", async () => {
    const p = await createProposal();
    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl: slackFake(new Map()) });
    expect(result.verdicts).toEqual({ message_not_found: 1 });
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
  });

  it("§7 칸 하나만 다른 요청 → PENDING (params_mismatch)", async () => {
    const p = await createProposal();
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p, { params: { ...p.args, newAmountKrw: 1_350_001 } })]]));
    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl });
    expect(result.verdicts).toEqual({ params_mismatch: 1 });
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
  });

  it("§7 메모 유무만 달라도 → PENDING (params_mismatch)", async () => {
    const p = await createProposal();
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p, { params: { ...p.args, memo: "추가" } })]]));
    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl });
    expect(result.verdicts).toEqual({ params_mismatch: 1 });
  });

  it("§7 수정(edited)된 메시지 → PENDING", async () => {
    const p = await createProposal();
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p, { edited: { user: MUSE.user, ts: p.ts } })]]));
    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl });
    expect(result.verdicts).toEqual({ edited: 1 });
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
  });

  it("subtype 있는 메시지·rid 다름·action 다름·창 밖 메시지 → PENDING", async () => {
    const a = await createProposal();
    const b = await createProposal();
    const c = await createProposal();
    const d = await createProposal({ messageAgoMs: 61 * 60_000 });
    const fetchImpl = slackFake(
      new Map([
        [a.ts, museMessageFor(a, { subtype: "bot_message" })],
        [b.ts, museMessageFor(b, { rid: nextRid() })],
        [c.ts, museMessageFor(c, { action: "crm.add_entity_memo" })],
        [d.ts, museMessageFor(d)],
      ]),
    );
    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl });
    expect(result.verdicts).toEqual({ has_subtype: 1, rid_mismatch: 1, action_mismatch: 1, outside_window: 1 });
    expect(result.executed).toBe(0);
  });

  it("§7 한도(|변동| 50만 원) 밖 → PENDING (over_delta), 슬랙을 부르지도 않는다", async () => {
    const p = await createProposal({ args: defaultArgs({ expectedCurrentKrw: 1_000_000, newAmountKrw: 1_500_001 }) });
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p)]]));
    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl });
    expect(result.verdicts).toEqual({ over_delta: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
  });

  it("현재 값이 비어 있으면(null) 변동은 새 값 그대로 — 한도를 넘으면 PENDING", async () => {
    const p = await createProposal({ args: defaultArgs({ expectedCurrentKrw: null, newAmountKrw: 600_000 }) });
    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl: slackFake(new Map()) });
    expect(result.verdicts).toEqual({ over_delta: 1 });
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
  });

  it("§7 하루 10건째 다음 건 → PENDING (daily_limit)", async () => {
    // 오늘 SYSTEM_AUTO 가 이미 10건 승인했다(실행·실패 무관하게 센다).
    for (let i = 0; i < 10; i += 1) {
      const done = await realPrisma.actionProposal.create({
        data: {
          requestType: "settlement_amount_update",
          kind: "WRITE",
          status: i % 2 === 0 ? "EXECUTED" : "FAILED",
          title: "done",
          createdBy: "AGENT_WORKER",
        },
      });
      await realPrisma.actionProposalEvent.create({
        data: { proposalId: done.id, fromStatus: "PENDING_APPROVAL", toStatus: "APPROVED", actor: "SYSTEM_AUTO" },
      });
    }
    const p = await createProposal();
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p)]]));
    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl });
    expect(result.verdicts).toEqual({ daily_limit: 1 });
    expect(result.executed).toBe(0);
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
  });

  it("한 회차 안에서도 하루 한도를 센다(MAX_PER_DAY=1 이면 둘째 건은 daily_limit)", async () => {
    const a = await createProposal();
    const b = await createProposal();
    const fetchImpl = slackFake(new Map([[a.ts, museMessageFor(a)], [b.ts, museMessageFor(b)]]));
    const result = await runSettlementAutoExecutePass({
      env: { ...BASE_ENV, AGENT_AUTO_EXECUTE_MAX_PER_DAY: "1" },
      fetchImpl,
    });
    expect(result.executed).toBe(1);
    expect(result.verdicts).toEqual({ daily_limit: 1 });
    expect(await statusOf(a.id)).toBe("EXECUTED");
    expect(await statusOf(b.id)).toBe("PENDING_APPROVAL");
  });

  it("§7 현재 값을 속인 요청 → 실행 실패(FAILED), 변동 확대 없음", async () => {
    // 기안은 「현재 1,200,000 → 1,350,000」(변동 15만, 한도 안)이라 주장하지만 실제 값은 0 이다.
    // 실제 기준이면 변동이 135만이라 한도 밖 — 실행 가드가 현재 값 불일치로 거부해야 한다.
    const p = await createProposal();
    campaignValues.set(p.args.campaignId, 0);
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p)]]));

    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl });

    expect(result).toMatchObject({ executed: 0, executionFailed: 1 });
    const row = await realPrisma.actionProposal.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toContain("현재 값이 기안 때와 다릅니다");
    expect(campaignValues.get(p.args.campaignId)).toBe(0);
  });

  it("같은 rid 의 기안이 둘이면 가장 먼저 만든 1건만 실행, 나머지는 PENDING (duplicate_rid)", async () => {
    const rid = nextRid();
    const first = await createProposal({ rid, createdAt: new Date(Date.now() - 5_000) });
    const second = await createProposal({ rid, args: first.args });
    // 두 기안의 출처 ts 가 다르므로 둘 다 응답하게 둔다.
    const fetchImpl = slackFake(new Map([[first.ts, museMessageFor(first)], [second.ts, museMessageFor({ ...second })]]));
    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl });
    expect(result.executed).toBe(1);
    expect(result.verdicts).toEqual({ duplicate_rid: 1 });
    expect(await statusOf(first.id)).toBe("EXECUTED");
    expect(await statusOf(second.id)).toBe("PENDING_APPROVAL");
  });

  it("슬랙 출처가 없는 기안·사람이 올린 기안·다른 동작은 건드리지 않는다(기록도 없음)", async () => {
    const noSource = await createProposal({ sourceRef: null });
    const human = await realPrisma.actionProposal.create({
      data: {
        requestType: "settlement_amount_update",
        kind: "WRITE",
        status: "PENDING_APPROVAL",
        title: "사람",
        createdBy: "owner-uuid",
        sourceRef: JSON.stringify({ slack: { channelId: CHANNEL, threadTs: "1", messageTs: "1", rid: nextRid() } }),
      },
    });
    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl: slackFake(new Map()) });
    expect(result).toMatchObject({ candidates: 0, recorded: 0, quiet: true });
    expect(await statusOf(noSource.id)).toBe("PENDING_APPROVAL");
    expect(await statusOf(human.id)).toBe("PENDING_APPROVAL");
  });

  it("APPROVED·FAILED 기안은 후보가 아니다", async () => {
    const p = await createProposal();
    await realPrisma.actionProposal.update({ where: { id: p.id }, data: { status: "FAILED" } });
    const result = await runSettlementAutoExecutePass({
      env: BASE_ENV,
      fetchImpl: slackFake(new Map([[p.ts, museMessageFor(p)]])),
    });
    expect(result.candidates).toBe(0);
    expect(await statusOf(p.id)).toBe("FAILED");
    expect(executeCalls).toHaveLength(0);
  });
});

describe("보류 판정 — 다음 회차에 다시 본다", () => {
  it("토큰이 없으면 no_token 으로 PENDING, 같은 보류 판정은 기안당 1건만 기록", async () => {
    const p = await createProposal();
    const env = { ...BASE_ENV, SLACK_BRIDGE_READ_TOKEN: undefined };
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p)]]));
    const first = await runSettlementAutoExecutePass({ env, fetchImpl });
    const second = await runSettlementAutoExecutePass({ env, fetchImpl });
    expect(first.verdicts).toEqual({ no_token: 1 });
    expect(first.quiet).toBe(false);
    expect(second.quiet).toBe(true); // 새 기록이 없으면 빈 회차 — 관측 이력 줄을 남기지 않는다
    expect(await eventsOf(p.id, "SYSTEM_AUTO")).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();

    // 토큰을 넣으면 다음 회차에 실행된다(보류는 확정이 아니다).
    const third = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl });
    expect(third.executed).toBe(1);
    expect(await statusOf(p.id)).toBe("EXECUTED");
  });

  it("슬랙 오류(HTTP 500)는 slack_error 로 PENDING, 다음 회차에 재시도", async () => {
    const p = await createProposal();
    const broken = vi.fn(async () => new Response("", { status: 500 }));
    const first = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl: broken });
    expect(first.verdicts).toEqual({ slack_error: 1 });
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
    const second = await runSettlementAutoExecutePass({
      env: BASE_ENV,
      fetchImpl: slackFake(new Map([[p.ts, museMessageFor(p)]])),
    });
    expect(second.executed).toBe(1);
  });

  it("대조 기준(채널·Muse 신원)이 비었거나 한도 값이 숫자가 아니면 not_configured — 기본값으로 넓히지 않는다", async () => {
    const p = await createProposal();
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p)]]));
    const missing = await runSettlementAutoExecutePass({
      env: { ...BASE_ENV, AGENT_AUTO_EXECUTE_MUSE_APP_ID: "" },
      fetchImpl,
    });
    expect(missing.verdicts).toEqual({ not_configured: 1 });
    const invalid = await runSettlementAutoExecutePass({
      env: { ...BASE_ENV, AGENT_AUTO_EXECUTE_MAX_ABS_DELTA_KRW: "100,000" },
      fetchImpl,
    });
    expect(invalid.verdicts).toEqual({ not_configured: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
  });
});

describe("스위치", () => {
  it("§7 off(미설정) → 아무것도 안 한다", async () => {
    const p = await createProposal();
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p)]]));
    const result = await runSettlementAutoExecutePass({
      env: { ...BASE_ENV, AGENT_AUTO_EXECUTE: undefined },
      fetchImpl,
    });
    expect(result).toMatchObject({ mode: "off", ran: false, quiet: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await realPrisma.actionProposalEvent.count({ where: { proposalId: p.id } })).toBe(1); // 상신 이벤트뿐
  });

  it("§7 AUTO_APPROVE_DISABLED 가 있으면(값 무관) on 이어도 off", async () => {
    const p = await createProposal();
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p)]]));
    const result = await runSettlementAutoExecutePass({
      env: { ...BASE_ENV, AUTO_APPROVE_DISABLED: "0" },
      fetchImpl,
    });
    expect(result).toMatchObject({ mode: "off", ran: false });
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
  });

  it("알 수 없는 값(오타)은 off 로 본다", async () => {
    await createProposal();
    const result = await runSettlementAutoExecutePass({
      env: { ...BASE_ENV, AGENT_AUTO_EXECUTE: "yes" },
      fetchImpl: slackFake(new Map()),
    });
    expect(result.mode).toBe("off");
  });
});

describe("§7 그림자 모드 — 실행하지 않고 기안당 1회만 기록", () => {
  const SHADOW_ENV = { ...BASE_ENV, AGENT_AUTO_EXECUTE: "shadow" };

  it("통과한 기안은 would_execute 기록 1건, 실행 없음 — 두 번 돌려도 1건", async () => {
    const p = await createProposal();
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p)]]));

    const first = await runSettlementAutoExecutePass({ env: SHADOW_ENV, fetchImpl });
    const second = await runSettlementAutoExecutePass({ env: SHADOW_ENV, fetchImpl });

    expect(first).toMatchObject({ mode: "shadow", executed: 0, recorded: 1, verdicts: { would_execute: 1 } });
    expect(second).toMatchObject({ candidates: 0, recorded: 0, quiet: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const shadow = await eventsOf(p.id, "SYSTEM_AUTO_SHADOW");
    expect(shadow).toHaveLength(1);
    expect(shadow[0].note).toContain("verdict=would_execute");
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
    expect(executeCalls).toHaveLength(0);
    expect(await eventsOf(p.id, "SYSTEM_AUTO")).toHaveLength(0);
  });

  it("탈락 사유도 기안당 1건 기록한다(오너가 왜 수동으로 남았는지 볼 수 있게)", async () => {
    const p = await createProposal({ args: defaultArgs({ expectedCurrentKrw: 0, newAmountKrw: 900_000 }) });
    await runSettlementAutoExecutePass({ env: SHADOW_ENV, fetchImpl: slackFake(new Map()) });
    await runSettlementAutoExecutePass({ env: SHADOW_ENV, fetchImpl: slackFake(new Map()) });
    const shadow = await eventsOf(p.id, "SYSTEM_AUTO_SHADOW");
    expect(shadow).toHaveLength(1);
    expect(shadow[0].note).toContain("verdict=over_delta");
  });

  it("그림자 판정 건수로 하루 한도를 센다(MAX_PER_DAY=1 → 둘째는 daily_limit)", async () => {
    const a = await createProposal();
    const b = await createProposal();
    const fetchImpl = slackFake(new Map([[a.ts, museMessageFor(a)], [b.ts, museMessageFor(b)]]));
    const result = await runSettlementAutoExecutePass({
      env: { ...SHADOW_ENV, AGENT_AUTO_EXECUTE_MAX_PER_DAY: "1" },
      fetchImpl,
    });
    expect(result.verdicts).toEqual({ would_execute: 1, daily_limit: 1 });
    // 다음 회차에도 오늘 그림자 판정 1건이 남아 있어 한도가 유지된다.
    const c = await createProposal();
    const next = await runSettlementAutoExecutePass({
      env: { ...SHADOW_ENV, AGENT_AUTO_EXECUTE_MAX_PER_DAY: "1" },
      fetchImpl: slackFake(new Map([[c.ts, museMessageFor(c)]])),
    });
    expect(next.verdicts).toEqual({ daily_limit: 1 });
  });
});

describe("§7 단일 실행 — 회차 두 개가 겹치면 하나만 돈다", () => {
  it("동시에 두 회차를 돌리면 한쪽은 잠금에 막혀 아무것도 안 하고, 실행은 1회", async () => {
    const p = await createProposal();
    const fetchImpl = slackFake(new Map([[p.ts, museMessageFor(p)]]));

    const [r1, r2] = await Promise.all([
      runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl }),
      runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl }),
    ]);

    expect([r1.lockBusy, r2.lockBusy].sort()).toEqual([false, true]);
    expect(r1.executed + r2.executed).toBe(1);
    expect(executeCalls).toHaveLength(1);
    expect(await statusOf(p.id)).toBe("EXECUTED");
  });
});

describe("멈춘 승인 정리", () => {
  it("SYSTEM_AUTO 가 승인하고 10분 넘게 APPROVED 인 기안 → FAILED(자동 실행 중단)", async () => {
    const old = new Date(Date.now() - STUCK_APPROVED_MS - 60_000);
    const stuck = await realPrisma.actionProposal.create({
      data: {
        requestType: "settlement_amount_update",
        kind: "WRITE",
        status: "APPROVED",
        title: "stuck",
        createdBy: "AGENT_WORKER",
        updatedAt: old,
      },
    });
    await realPrisma.actionProposalEvent.create({
      data: { proposalId: stuck.id, fromStatus: "PENDING_APPROVAL", toStatus: "APPROVED", actor: "SYSTEM_AUTO", createdAt: old },
    });
    // 사람이 승인해 멈춘 기안·방금 승인된 기안은 건드리지 않는다.
    const human = await realPrisma.actionProposal.create({
      data: { requestType: "settlement_amount_update", kind: "WRITE", status: "APPROVED", title: "h", createdBy: "AGENT_WORKER", updatedAt: old },
    });
    await realPrisma.actionProposalEvent.create({
      data: { proposalId: human.id, fromStatus: "PENDING_APPROVAL", toStatus: "APPROVED", actor: "owner-uuid", createdAt: old },
    });
    const fresh = await realPrisma.actionProposal.create({
      data: { requestType: "settlement_amount_update", kind: "WRITE", status: "APPROVED", title: "f", createdBy: "AGENT_WORKER" },
    });
    await realPrisma.actionProposalEvent.create({
      data: { proposalId: fresh.id, fromStatus: "PENDING_APPROVAL", toStatus: "APPROVED", actor: "SYSTEM_AUTO" },
    });

    const result = await runSettlementAutoExecutePass({ env: BASE_ENV, fetchImpl: slackFake(new Map()) });

    expect(result).toMatchObject({ swept: 1, quiet: false });
    const row = await realPrisma.actionProposal.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toBe("자동 실행 중단");
    expect(await statusOf(human.id)).toBe("APPROVED");
    expect(await statusOf(fresh.id)).toBe("APPROVED");
  });
});

describe("묵은 기안", () => {
  it("만든 지 24시간이 넘은 대기 기안은 자동 실행하지 않는다(스위치를 켠 순간 묵은 기안이 실행되지 않게)", async () => {
    const p = await createProposal({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    const result = await runSettlementAutoExecutePass({
      env: BASE_ENV,
      fetchImpl: slackFake(new Map([[p.ts, museMessageFor(p)]])),
    });
    expect(result.candidates).toBe(0);
    expect(await statusOf(p.id)).toBe("PENDING_APPROVAL");
  });
});
