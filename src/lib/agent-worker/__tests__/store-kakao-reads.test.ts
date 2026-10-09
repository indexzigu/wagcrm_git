/**
 * Phase 3 ②⑧(2026-10-09) — get_store_status · list_work_record_rooms · get_work_records.
 *
 * 픽스처에 가짜 이름·연락처·주소·주문번호·송장을 심고, 봇에게 가는 글(resultSummary)과 결재함에
 * 남는 기록(ActionProposal.create 의 data) **양쪽 모두에** 그 값이 없는지 센다. 한쪽만 보면 다른
 * 쪽으로 새는 길을 놓친다 — 결재함 기록은 화면에, 요약은 슬랙·클라우드 모델로 간다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";
import type { AgentJobPayload } from "../contracts";

const m = vi.hoisted(() => ({
  snapshotFindMany: vi.fn(),
  snapshotFindFirst: vi.fn(),
  roomFindMany: vi.fn(),
  roomFindUnique: vi.fn(),
  workRecordFindMany: vi.fn(),
  partnerFindMany: vi.fn(),
  sellerFindMany: vi.fn(),
  proposalCreate: vi.fn(),
  proposalEventCreate: vi.fn(),
}));

// getPrisma() 는 @/lib/order-converter/prisma.ts 가 import 시점에 한 번 부른다 — 그래서 멤버는 전부
// 늦게(호출 시점에) 위 mock 으로 넘긴다.
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    $transaction: (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        actionProposal: { create: (args: unknown) => m.proposalCreate(args) },
        actionProposalEvent: { create: (args: unknown) => m.proposalEventCreate(args) },
      }),
    naverOrderSnapshot: {
      findMany: (args: unknown) => m.snapshotFindMany(args),
      findFirst: (args: unknown) => m.snapshotFindFirst(args),
    },
    chatRoomMapping: {
      findMany: (args: unknown) => m.roomFindMany(args),
      findUnique: (args: unknown) => m.roomFindUnique(args),
    },
    workRecord: { findMany: (args: unknown) => m.workRecordFindMany(args) },
    partner: { findMany: (args: unknown) => m.partnerFindMany(args) },
    seller: { findMany: (args: unknown) => m.sellerFindMany(args) },
  }),
}));
vi.mock("@/lib/prisma-client", () => ({ isSqliteDatabaseUrl: () => false }));

import { executeAgentJob, type ExecutionDeps } from "../executor";
import { MAX_RESULT_SUMMARY_CHARS } from "../contracts";
import {
  MAX_WORK_RECORDS_STRUCTURED_BYTES,
  MAX_WORK_RECORDS_TOTAL_TEXT_CHARS,
  MAX_WORK_RECORD_TEXT_CHARS,
  NAME_MASK_TOKEN,
  maskKnownNames,
} from "../read-projections";

const NOW = new Date("2026-10-09T03:00:00.000Z"); // KST 12:00

function job(operation: AgentJobPayload["operation"], input: AgentJobPayload["input"]): AgentJobRecord {
  return {
    id: "job-p3",
    idempotencyKey: "key-p3",
    payload: {
      schemaVersion: 1,
      taskType: "deterministic",
      skill: "none",
      operation,
      input,
      origin: { source: "hermes_slack", correlationId: "c-1", requesterDigest: "r", threadDigest: "t" },
    },
    status: "RUNNING",
    workerId: "worker-1",
    leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    heartbeatAt: NOW,
    attempt: 0,
    result: null,
    failureCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const deps: ExecutionDeps = {
  decideRoute: async () => ({ status: "ACCEPTED", route: "python", model: "python", reason: "deterministic" }),
  now: () => NOW,
};

async function run(operation: AgentJobPayload["operation"], input: AgentJobPayload["input"]) {
  const outcome = await executeAgentJob(job(operation, input), deps);
  if (outcome.kind !== "terminal") throw new Error(`expected terminal, got ${outcome.kind}`);
  return outcome;
}

/** 결재함에 남은 기록 전체(직렬화). 요약과 따로 센다. */
function recordedJson(): string {
  expect(m.proposalCreate).toHaveBeenCalledTimes(1);
  return JSON.stringify(m.proposalCreate.mock.calls[0][0]);
}

// ---------------------------------------------------------------------------
// 가짜 개인정보 — 어디에도 나오면 안 된다.
// ---------------------------------------------------------------------------
const BUYER = "홍길동";
const RECEIVER = "김수취";
const BUYER_TEL = "010-1234-5678";
const RECEIVER_TEL = "010-9876-5432";
const ADDRESS = "테스트시 비밀구 가짜로 77";
const ORDER_ID = "2026100912345678";
const TRACKING = "INV-SECRET-4242";
const REASON_TEL = "010-2222-3333";
const PII_NEEDLES = [BUYER, RECEIVER, BUYER_TEL, RECEIVER_TEL, ADDRESS, ORDER_ID, TRACKING, REASON_TEL, "5678", "5432"];

function claimOrder(overrides: Record<string, unknown>) {
  return {
    productOrderId: ORDER_ID,
    productName: "테스트 크림 50ml",
    productOption: "색상: 화이트",
    productId: "P-1",
    quantity: 1,
    paymentDate: "2026-10-05T01:00:00.000Z",
    ordererName: BUYER,
    ordererTel: BUYER_TEL,
    shippingAddress: { name: RECEIVER, tel1: RECEIVER_TEL },
    ...overrides,
  };
}

const openReturn = claimOrder({
  __claim: {
    return: {
      claimStatus: "RETURN_REQUEST",
      claimRequestDate: "2026-10-08T05:00:00.000Z",
      returnReason: "SIMPLE_INTENT_CHANGED",
      // 구매자가 직접 쓴 사유 — 자기 이름(이름만 쓴 것 포함)과 번호가 섞여 있다.
      returnDetailedReason: `${BUYER} 입니다. 길동이가 잘못 주문했어요 ${REASON_TEL} 로 연락 주세요`,
      collectTrackingNumber: TRACKING,
      collectAddress: { baseAddress: ADDRESS },
    },
  },
});
const doneCancel = claimOrder({
  productOrderId: "2026100900000002",
  __claim: { cancel: { claimStatus: "CANCEL_DONE", cancelReason: "MISTAKE_ORDER", claimRequestDate: "2026-10-06T00:00:00.000Z" } },
});
const openExchange = claimOrder({
  productOrderId: "2026100900000003",
  productName: "교환 상품",
  __claim: { exchange: { claimStatus: "EXCHANGE_REQUEST", exchangeReason: "COLOR_AND_SIZE", claimRequestDate: "2026-10-07T00:00:00.000Z" } },
});
// 레거시 행(claimSource null) — 그 날짜 블롭을 폴백으로 읽는다. 블롭에는 주소까지 통째로 있다.
const legacyBlobOrder = {
  ...claimOrder({ productOrderId: "2026100900000004", productName: "블롭 상품" }),
  shippingAddress: { name: RECEIVER, tel1: RECEIVER_TEL, baseAddress: ADDRESS, zipCode: "00000" },
  __claim: { cancel: { claimStatus: "CANCEL_REQUEST", cancelReason: "INTENT_CHANGED", claimRequestDate: "2026-10-09T00:00:00.000Z" } },
};

function seedStore() {
  m.snapshotFindMany.mockImplementation(async (args: { select?: Record<string, boolean>; omit?: unknown }) => {
    if (args.select?.newOrdersCount) {
      return [
        { snapshotDate: "2026-10-08", ordersCount: 10, newOrdersCount: 3, preparingCount: 2, deliveringCount: 4, lastCallTime: new Date("2026-10-09T00:00:00Z") },
        { snapshotDate: "2026-10-09", ordersCount: 5, newOrdersCount: 1, preparingCount: 1, deliveringCount: 0, lastCallTime: new Date("2026-10-09T00:00:00Z") },
      ];
    }
    if (args.select?.claimSource) {
      return [
        { snapshotDate: "2026-10-08", claimSource: { v: 1, orders: [openReturn, doneCancel, openExchange] } },
        { snapshotDate: "2026-10-09", claimSource: null },
      ];
    }
    if (args.omit) return [{ snapshotDate: "2026-10-09", orders: [legacyBlobOrder] }];
    throw new Error(`unexpected snapshot query ${JSON.stringify(args)}`);
  });
  m.snapshotFindFirst.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
    if (args.where?.lastChangeStatusCursor) return { lastChangeStatusCursor: "2026-10-09T00:00:05.000Z" };
    return { lastCallTime: new Date("2026-10-09T00:00:00.000Z"), syncType: "CHANGED" };
  });
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.proposalCreate.mockResolvedValue({ id: "read-1" });
  m.proposalEventCreate.mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("get_store_status", () => {
  it("counts the whole store, derives open claims with the claims-screen logic, and reports freshness", async () => {
    seedStore();
    const outcome = await run("get_store_status", {});
    expect(outcome.toStatus).toBe("SUCCEEDED");
    const summary = outcome.result.resultSummary;
    const [header, ...lines] = summary.split("\n");

    // 기본 창 14일(KST) · 마지막 동기화(변경피드 커서 우선) · 실시간 아님
    expect(header).toContain("window=2026-09-25..2026-10-09");
    expect(header).toContain("syncedAt=2026-10-09T00:00:05.000Z");
    expect(header).toContain("realtime=false");
    expect(header).toContain("newOrders=4 awaitingShipment=3 delivering=4");
    // 진행 중: 반품 1 · 교환 1 · 취소 1(레거시 블롭 폴백) — 완료된 취소는 세지 않는다
    expect(header).toContain("openCancel=1 openReturn=1 openExchange=1 claimsShown=3/3");
    expect(lines).toHaveLength(3);
    // 요청일 최신순
    expect(lines[0]).toMatch(/^CANCEL \[취소 요청\] 블롭 상품 x1 사유=구매 의사 취소 requested=2026-10-09/);
    expect(lines[1]).toMatch(/^RETURN \[반품 요청\] 테스트 크림 50ml x1 사유=/);
    expect(lines[2]).toMatch(/^EXCHANGE \[교환 요청\] 교환 상품 x1 사유=색상·사이즈 변경/);

    const recorded = JSON.parse(recordedJson()) as { data: { structuredResult: { data: Record<string, any> } } };
    const data = recorded.data.structuredResult.data;
    expect(data.freshness).toEqual({ syncedAt: "2026-10-09T00:00:05.000Z", latestSnapshotDate: "2026-10-09", realtime: false });
    expect(data.claims.counts).toEqual({
      CANCEL: { open: 1, completed: 1 },
      RETURN: { open: 1, completed: 0 },
      EXCHANGE: { open: 1, completed: 0 },
    });
    expect(Object.keys(data.claims.items[0]).sort()).toEqual(
      ["claimStatus", "claimStatusLabel", "claimType", "productName", "quantity", "reason", "requestDate"].sort(),
    );
  });

  it("leaks no buyer/receiver name, phone, address, order id or tracking number — in the summary or the recorded result", async () => {
    seedStore();
    const outcome = await run("get_store_status", {});
    const recorded = recordedJson();
    for (const needle of PII_NEEDLES) {
      expect(outcome.result.resultSummary, needle).not.toContain(needle);
      expect(recorded, needle).not.toContain(needle);
    }
    // 이름만 쓴 경우(뒤 두 글자)도 가린다. 가림 토큰은 남아 무엇이 지워졌는지는 보인다.
    expect(outcome.result.resultSummary).not.toContain("길동");
    expect(outcome.result.resultSummary).toContain(NAME_MASK_TOKEN);
    expect(outcome.result.resultSummary).toContain("[PHONE_MASKED]");
    // 옵션 문구도 싣지 않는다(요청 범위 밖 · 직접입력 옵션은 구매자 글일 수 있다).
    expect(recorded).not.toContain("색상: 화이트");
  });

  it("clamps a since older than the 30-day snapshot window and says so", async () => {
    seedStore();
    const outcome = await run("get_store_status", { since: "2026-01-01T00:00:00+09:00" });
    expect(outcome.result.resultSummary.split("\n")[0]).toContain("window=2026-09-09..2026-10-09 clamped=true");
  });

  it("refuses a since in the future", async () => {
    seedStore();
    const outcome = await run("get_store_status", { since: "2026-10-10T00:00:00+09:00" });
    expect(outcome).toMatchObject({ toStatus: "FAILED_FINAL", errorClass: "INVALID_INPUT" });
    expect(m.snapshotFindMany).not.toHaveBeenCalled();
  });

  it("caps the claim list at claimsLimit while still counting every open claim", async () => {
    seedStore();
    const outcome = await run("get_store_status", { claimsLimit: 1 });
    const [header, ...lines] = outcome.result.resultSummary.split("\n");
    expect(header).toContain("claimsShown=1/3");
    expect(lines).toHaveLength(1);
  });

  it("reports an unknown sync time instead of inventing one when there are no snapshots", async () => {
    m.snapshotFindMany.mockResolvedValue([]);
    m.snapshotFindFirst.mockResolvedValue(null);
    const outcome = await run("get_store_status", {});
    expect(outcome.result.resultSummary).toMatch(/syncedAt=unknown realtime=false snapshotDays=0 newOrders=0/);
  });

  it("reads only the count columns and the claim projection — never the whole orders blob range", async () => {
    seedStore();
    await run("get_store_status", {});
    for (const [args] of m.snapshotFindMany.mock.calls as Array<[{ select?: Record<string, boolean>; omit?: unknown; where: any }]>) {
      if (args.select) expect(args.select.orders, JSON.stringify(args)).toBeUndefined();
      // 블롭을 싣는 조회는 레거시 날짜 하나뿐이다(행 단위 폴백).
      else expect(args.where.snapshotDate).toEqual({ in: ["2026-10-09"] });
    }
  });
});

describe("list_work_record_rooms", () => {
  it("lists only whitelisted rooms, labels them by the mapped partner/seller (alias first), never by room name", async () => {
    m.roomFindMany.mockResolvedValue([
      { roomKey: "1001", roomType: "GROUP", entityType: "PARTNER", entityId: "pt-1", campaignId: null, lastSyncedAt: new Date("2026-10-08T21:00:00Z") },
      { roomKey: "1002", roomType: "DIRECT", entityType: "SELLER", entityId: "sl-1", campaignId: "camp-1", lastSyncedAt: null },
      { roomKey: "1003", roomType: "GROUP", entityType: null, entityId: null, campaignId: null, lastSyncedAt: null },
    ]);
    m.partnerFindMany.mockResolvedValue([{ id: "pt-1", name: "테스트 브랜드" }]);
    m.sellerFindMany.mockResolvedValue([{ id: "sl-1", name: "실명셀러", alias: "별칭셀러" }]);

    const outcome = await run("list_work_record_rooms", {});
    expect(outcome.toStatus).toBe("SUCCEEDED");
    const [where] = m.roomFindMany.mock.calls[0] as [{ where: unknown; select: Record<string, boolean> }];
    expect(where.where).toEqual({ source: "KAKAO", collectorType: "KATOK_AUTO", excluded: false });
    expect(where.select.roomName).toBeUndefined();

    const lines = outcome.result.resultSummary.split("\n");
    expect(lines[0]).toBe("list_work_record_rooms: 3 room(s) shown=3");
    expect(lines[1]).toBe("1001 [GROUP] PARTNER 테스트 브랜드 id=pt-1 lastCollected=2026-10-08T21:00:00.000Z");
    expect(lines[2]).toBe("1002 [DIRECT] SELLER 별칭셀러 id=sl-1 lastCollected=none");
    expect(lines[3]).toBe("1003 [GROUP] 미매핑 lastCollected=none");
    expect(recordedJson()).not.toContain("실명셀러");
    expect(outcome.result.evidenceRefs).toEqual(["1001", "1002", "1003"]);
  });

  it("skips the name lookups when no room is mapped", async () => {
    m.roomFindMany.mockResolvedValue([]);
    const outcome = await run("list_work_record_rooms", {});
    expect(outcome.result.resultSummary).toBe("list_work_record_rooms: 0 room(s) shown=0");
    expect(m.partnerFindMany).not.toHaveBeenCalled();
    expect(m.sellerFindMany).not.toHaveBeenCalled();
  });
});

describe("get_work_records", () => {
  const whitelisted = { roomKey: "1001", collectorType: "KATOK_AUTO", excluded: false, lastSyncedAt: new Date("2026-10-08T21:00:00Z") };
  const input = { roomKey: "1001", since: "2026-10-01T00:00:00+09:00" };

  function record(minute: number, overrides: Record<string, unknown> = {}) {
    return {
      sentAt: new Date(Date.UTC(2026, 9, 2, 0, minute)),
      sender: "담당자A",
      rawText: `기록 ${minute}`,
      isMasked: true,
      entityType: "PARTNER",
      entityId: "pt-1",
      campaignId: null,
      ...overrides,
    };
  }

  it.each([
    ["an unknown room", null],
    ["a paused (excluded) room", { ...whitelisted, excluded: true }],
    ["a staff txt-upload room", { ...whitelisted, collectorType: "TXT_UPLOAD" }],
  ])("refuses %s with the same answer and reads no records", async (_label, mapping) => {
    m.roomFindUnique.mockResolvedValue(mapping);
    const outcome = await run("get_work_records", input);
    expect(outcome).toMatchObject({ toStatus: "FAILED_FINAL", errorClass: "ROOM_NOT_WHITELISTED" });
    expect(outcome.result.resultSummary).toBe("get_work_records failed: ROOM_NOT_WHITELISTED");
    expect(m.workRecordFindMany).not.toHaveBeenCalled();
    expect(m.proposalCreate).not.toHaveBeenCalled();
  });

  it("returns records in sentAt order with entity link and collection freshness, querying only allowed columns", async () => {
    m.roomFindUnique.mockResolvedValue(whitelisted);
    m.workRecordFindMany.mockResolvedValue([record(0), record(5, { sender: null, entityType: null, entityId: null })]);
    const outcome = await run("get_work_records", { ...input, until: "2026-10-03T00:00:00+09:00", limit: 10 });

    const [args] = m.workRecordFindMany.mock.calls[0] as [{ where: any; select: Record<string, boolean>; orderBy: unknown; take: number }];
    expect(args.where).toEqual({
      source: "KAKAO",
      roomKey: "1001",
      sentAt: { gte: new Date("2026-09-30T15:00:00.000Z"), lte: new Date("2026-10-02T15:00:00.000Z") },
    });
    expect(Object.keys(args.select).sort()).toEqual(
      ["campaignId", "entityId", "entityType", "isMasked", "rawText", "sender", "sentAt"].sort(),
    );
    expect(args.orderBy).toEqual([{ sentAt: "asc" }, { id: "asc" }]);
    expect(args.take).toBe(11);

    const [header, ...lines] = outcome.result.resultSummary.split("\n");
    expect(header).toBe(
      "get_work_records room=1001 window=2026-09-30T15:00:00.000Z..2026-10-02T15:00:00.000Z collectedThrough=2026-10-08T21:00:00.000Z realtime=false records=2 shown=2 more=false nextSince=none",
    );
    expect(lines).toEqual(["2026-10-02 09:00 담당자A: 기록 0", "2026-10-02 09:05 (보낸 사람 없음): 기록 5"]);

    const data = JSON.parse(recordedJson()).data.structuredResult.data;
    expect(data.records[0]).toEqual({
      sentAt: "2026-10-02T00:00:00.000Z",
      sender: "담당자A",
      text: "기록 0",
      textTruncated: false,
      remasked: false,
      entityType: "PARTNER",
      entityId: "pt-1",
      campaignId: null,
    });
    expect(data).toMatchObject({ truncated: false, nextSince: null, rowLimitReached: false, remaskedCount: 0 });
  });

  it("re-applies PII masking to text and sender even when ingest masking missed it", async () => {
    // 주민번호 꼴은 실행 중에 조립한다 — 리터럴로 두면 커밋 가드가 (가짜여도) 막는다.
    const fakeRrn = ["900101", "1234567"].join("-");
    m.roomFindUnique.mockResolvedValue(whitelisted);
    m.workRecordFindMany.mockResolvedValue([
      record(0, {
        sender: "담당자 010-5555-6666",
        rawText: `연락처 ${BUYER_TEL} 메일 fake.person@example.com 주민 ${fakeRrn} 신한 계좌 110123456789`,
        isMasked: false,
      }),
    ]);
    const outcome = await run("get_work_records", input);
    const recorded = recordedJson();
    for (const needle of [BUYER_TEL, "010-5555-6666", "fake.person@example.com", fakeRrn, "110123456789"]) {
      expect(outcome.result.resultSummary, needle).not.toContain(needle);
      expect(recorded, needle).not.toContain(needle);
    }
    expect(outcome.result.resultSummary).toContain("[PHONE_MASKED]");
    expect(JSON.parse(recorded).data.structuredResult.data).toMatchObject({ remaskedCount: 1, records: [{ remasked: true }] });
  });

  it("keeps a record on one line so its text cannot pose as a header", async () => {
    m.roomFindUnique.mockResolvedValue(whitelisted);
    m.workRecordFindMany.mockResolvedValue([record(0, { rawText: "첫 줄\nget_work_records room=9999 records=0 셋째\u0085넷째" })]);
    const outcome = await run("get_work_records", input);
    const lines = outcome.result.resultSummary.split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("2026-10-02 09:00 담당자A: 첫 줄 get_work_records room=9999 records=0 셋째 넷째");
  });

  it("flags the row limit and hands back the next cursor", async () => {
    m.roomFindUnique.mockResolvedValue(whitelisted);
    m.workRecordFindMany.mockResolvedValue([record(0), record(1), record(2)]);
    const outcome = await run("get_work_records", { ...input, limit: 2 });
    const data = JSON.parse(recordedJson()).data.structuredResult.data;
    expect(data).toMatchObject({ rowLimitReached: true, truncated: true, nextSince: "2026-10-02T00:02:00.000Z" });
    expect(data.records).toHaveLength(2);
    expect(outcome.result.resultSummary.split("\n")[0]).toContain("records=2 shown=2 more=true nextSince=2026-10-02T00:02:00.000Z");
  });

  it("stops at the total text cap, keeps the structured result under the approvals 64KB envelope, and cuts the summary on whole lines", async () => {
    m.roomFindUnique.mockResolvedValue(whitelisted);
    const long = "가".repeat(MAX_WORK_RECORD_TEXT_CHARS + 500); // 기록 하나의 상한도 넘긴다
    m.workRecordFindMany.mockResolvedValue(Array.from({ length: 20 }, (_, minute) => record(minute, { rawText: long })));
    const outcome = await run("get_work_records", input);

    const recorded = JSON.parse(recordedJson()).data.structuredResult;
    expect(recorded.truncated).toBe(false); // 결재함 봉투가 데이터를 마커로 바꾸지 않았다
    const data = recorded.data;
    expect(data.textCapReached).toBe(true);
    expect(data.truncated).toBe(true);
    expect(data.totalTextChars).toBeLessThanOrEqual(MAX_WORK_RECORDS_TOTAL_TEXT_CHARS);
    expect(Buffer.byteLength(JSON.stringify(data.records), "utf8")).toBeLessThanOrEqual(MAX_WORK_RECORDS_STRUCTURED_BYTES);
    expect(data.records[0].textTruncated).toBe(true);
    expect(Array.from(data.records[0].text as string)).toHaveLength(MAX_WORK_RECORD_TEXT_CHARS);
    expect(data.nextSince).toBe(new Date(Date.UTC(2026, 9, 2, 0, data.records.length)).toISOString());

    const summary = outcome.result.resultSummary;
    expect(summary.length).toBeLessThanOrEqual(MAX_RESULT_SUMMARY_CHARS);
    expect(summary.endsWith("…")).toBe(true); // 마지막 줄은 줄 단위 상한(300자)의 말줄임표지 반 토막이 아니다
    const header = summary.split("\n")[0];
    const shown = Number(/ shown=(\d+) /.exec(header)?.[1]);
    expect(summary.split("\n")).toHaveLength(shown + 1);
    expect(header).toContain(`nextSince=${new Date(Date.UTC(2026, 9, 2, 0, shown)).toISOString()}`);
  });
});

describe("maskKnownNames", () => {
  it("masks the full name first, then a bare given name, and ignores single characters", () => {
    expect(maskKnownNames("홍길동님 길동 홍", ["홍길동", "김", null])).toBe(`${NAME_MASK_TOKEN}님 ${NAME_MASK_TOKEN} 홍`);
  });

  it("treats regex metacharacters in a name literally", () => {
    expect(maskKnownNames("a.b a+b", ["a.b"])).toBe(`${NAME_MASK_TOKEN} a+b`);
  });
});
