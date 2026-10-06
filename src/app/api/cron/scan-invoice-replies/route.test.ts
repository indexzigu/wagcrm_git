import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeReplyImap } from "@/lib/order-converter/__tests__/fixtures/fake-reply-imap";

/**
 * 크론 라우트 `scan-invoice-replies` — 인증 · 레이더 기록 · 읽기 전용 · 「감지만」 계약.
 * 메일 서버·DB·네이버는 전부 가짜다(실접속 0). 주소는 허구(example.com).
 */

const state = vi.hoisted(() => ({
  db: null as any,
  imap: null as any,
  connectCalls: 0,
  naverCalls: 0,
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: () => state.db }));
vi.mock("imap-simple", () => ({
  default: {
    connect: vi.fn(async () => {
      state.connectCalls += 1;
      if (!state.imap) throw new Error("connect refused");
      return state.imap;
    }),
  },
}));
vi.mock("@/lib/order-converter/order-brand", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/order-converter/order-brand")>()),
  resolveOrderBrand: async () => null,
}));
// 네이버 경로 — 불리면 계약 위반(1단계는 네이버 요청 0건).
vi.mock("@/lib/order-converter/naver-commerce-api", () =>
  new Proxy({}, { get: () => () => { state.naverCalls += 1; throw new Error("naver must not be called"); } }),
);
vi.mock("@/lib/order-converter/naver-order-sync", () =>
  new Proxy({}, { get: () => () => { state.naverCalls += 1; throw new Error("naver must not be called"); } }),
);

import { GET } from "./route";

const SECRET = "test-cron-secret";
const NOW = Date.now();
const ago = (hours: number) => new Date(NOW - hours * 3600_000);

function makeDb(withTarget: boolean) {
  const rows: Array<Record<string, unknown>> = [];
  return {
    rows,
    systemTaskStatus: { upsert: vi.fn(async () => ({})) },
    systemTaskLog: { create: vi.fn(async () => ({})) },
    orderFulfillmentState: {
      groupBy: vi.fn(async () =>
        withTarget
          ? [{ campaignId: "oc-1", _count: { _all: 2 }, _min: { poRequestedAt: ago(4) }, _max: { poRequestedAt: ago(4) } }]
          : [],
      ),
      update: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    orderActionLog: { findMany: vi.fn(async () => []), create: vi.fn() },
    orderCampaign: {
      findMany: vi.fn(async () => [
        {
          id: "oc-1",
          isActive: true,
          template: "brand-a",
          sellerName: "테스트셀러",
          toEmail: "orders@brand-a.example.com",
          tasks: [],
        },
      ]),
      update: vi.fn(),
    },
    invoiceReplyDetection: {
      findUnique: vi.fn(async ({ where }: any) =>
        rows.find(
          (r) =>
            r.orderCampaignId === where.orderCampaignId_messageId.orderCampaignId &&
            r.messageId === where.orderCampaignId_messageId.messageId,
        ) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        rows.push(data);
        return data;
      }),
    },
  };
}

const replyMail = {
  uid: 11,
  date: ago(1),
  from: "Shipping <ship@brand-a.example.com>",
  subject: "송장 회신",
  bodyText: "첨부합니다",
  attachmentRows: [{ orderId: "2026100633333333", tracking: "700000000001" }],
  attachmentName: "테스트셀러_송장.xlsx",
};

function call(auth: string | null = `Bearer ${SECRET}`) {
  return GET(
    new Request("http://localhost/api/cron/scan-invoice-replies", {
      headers: auth ? { authorization: auth } : {},
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("SMTP_USER", "me@example.com");
  vi.stubEnv("SMTP_PASS", "test-app-password");
  state.connectCalls = 0;
  state.naverCalls = 0;
  state.imap = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("scan-invoice-replies 크론 라우트", () => {
  it("인증 없으면 401 이고 메일·DB 를 건드리지 않는다", async () => {
    state.db = makeDb(true);
    const res = await call(null);
    expect(res.status).toBe(401);
    expect(state.connectCalls).toBe(0);
    expect(state.db.orderFulfillmentState.groupBy).not.toHaveBeenCalled();
    expect(state.db.systemTaskStatus.upsert).not.toHaveBeenCalled();
  });

  it("틀린 시크릿도 401", async () => {
    state.db = makeDb(true);
    expect((await call("Bearer wrong")).status).toBe(401);
  });

  it("감지를 남기고 레이더에 SUCCESS 를 기록한다 — 읽기 전용·네이버 0·작업기록 0", async () => {
    state.db = makeDb(true);
    const fake = createFakeReplyImap({ INBOX: [replyMail] });
    state.imap = fake.connection;

    const res = await call();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ targets: 1, detected: 1, created: 1 });
    expect(body.failed).toBeUndefined();
    expect(state.db.rows).toHaveLength(1);

    const statuses = state.db.systemTaskStatus.upsert.mock.calls.map((c: any[]) => c[0].update.status);
    expect(statuses).toEqual(["RUNNING", "SUCCESS"]);
    expect(state.db.systemTaskStatus.upsert.mock.calls[0][0].where).toEqual({ jobKey: "scan-invoice-replies" });

    // 읽기 전용 — EXAMINE 만, markSeen:false 만, 쓰기 0
    expect(fake.log.readOnlyOpens.every((o) => o.readOnly === true)).toBe(true);
    expect(fake.connection.openBox).not.toHaveBeenCalled();
    expect(fake.log.searchOptions.every((o) => o.markSeen === false)).toBe(true);
    expect(fake.connection.addFlags).not.toHaveBeenCalled();
    expect(fake.connection.moveMessage).not.toHaveBeenCalled();
    expect(fake.connection.deleteMessage).not.toHaveBeenCalled();

    // 감지만 — 송장 등록·네이버·작업 기록·발주 상태 쓰기 0
    expect(state.naverCalls).toBe(0);
    expect(state.db.orderActionLog.create).not.toHaveBeenCalled();
    expect(state.db.orderFulfillmentState.update).not.toHaveBeenCalled();
    expect(state.db.orderFulfillmentState.upsert).not.toHaveBeenCalled();
    expect(state.db.orderFulfillmentState.updateMany).not.toHaveBeenCalled();
    expect(state.db.orderCampaign.update).not.toHaveBeenCalled();
  });

  it("재실행은 같은 메일을 다시 쌓지 않는다", async () => {
    state.db = makeDb(true);
    state.imap = createFakeReplyImap({ INBOX: [replyMail] }).connection;

    await call();
    const second = await (await call()).json();

    expect(second).toMatchObject({ detected: 1, created: 0, alreadyKnown: 1 });
    expect(state.db.rows).toHaveLength(1);
  });

  it("대상이 없으면 메일 서버에 붙지 않고 SUCCESS", async () => {
    state.db = makeDb(false);
    const body = await (await call()).json();
    expect(state.connectCalls).toBe(0);
    expect(body).toMatchObject({ skippedNoTargets: true });
    const statuses = state.db.systemTaskStatus.upsert.mock.calls.map((c: any[]) => c[0].update.status);
    expect(statuses).toEqual(["RUNNING", "SUCCESS"]);
  });

  it("메일 서버에 못 붙으면 failed 를 선언해 레이더를 ERROR 로 만든다", async () => {
    state.db = makeDb(true);
    state.imap = null; // connect 가 throw
    const body = await (await call()).json();
    expect(body.failed).toBe(true);
    const last = state.db.systemTaskStatus.upsert.mock.calls.at(-1)[0];
    expect(last.update.status).toBe("ERROR");
  });
});
