import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImapSimple } from 'imap-simple';
import {
  MAX_CAMPAIGNS_PER_RUN,
  persistInvoiceReplyDetections,
  runInvoiceReplyScan,
  scanInvoiceRepliesReadOnly,
  selectInvoiceReplyTargets,
  type InvoiceReplyScanDb,
  type InvoiceReplyTarget,
} from '../invoice-reply-scan';
import { createFakeReplyImap, type FakeMail } from './fixtures/fake-reply-imap';

/**
 * 송장 회신 도착 감지(크론 scan-invoice-replies) — 대상 선정 · 읽기 전용 스캔 · 멱등 저장.
 * 메일 서버·DB 는 전부 가짜다(실접속 0). 주소·이름은 허구.
 */

const NOW = new Date('2026-10-06T05:00:00Z'); // KST 14:00
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3600_000);

type Campaign = {
  id: string;
  isActive: boolean;
  template: string | null;
  sellerName: string;
  toEmail: string | null;
  tasks: Array<{ date: string; status: string }>;
};

function fakeDb(input: {
  poGroups?: Array<{ campaignId: string; count: number; first: Date; last: Date }>;
  registrations?: Array<{ campaignId: string; createdAt: Date; successCount: number; skipCount: number }>;
  campaigns?: Campaign[];
}) {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    orderFulfillmentState: {
      groupBy: vi.fn(async () =>
        (input.poGroups ?? []).map((g) => ({
          campaignId: g.campaignId,
          _count: { _all: g.count },
          _min: { poRequestedAt: g.first },
          _max: { poRequestedAt: g.last },
        })),
      ),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    orderActionLog: {
      findMany: vi.fn(async () => input.registrations ?? []),
      create: vi.fn(),
    },
    orderCampaign: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        (input.campaigns ?? []).filter((c) => args.where.id.in.includes(c.id)),
      ),
      update: vi.fn(),
    },
    invoiceReplyDetection: {
      findUnique: vi.fn(async (args: { where: { orderCampaignId_messageId: { orderCampaignId: string; messageId: string } } }) => {
        const key = args.where.orderCampaignId_messageId;
        return rows.find((r) => r.orderCampaignId === key.orderCampaignId && r.messageId === key.messageId) ?? null;
      }),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        rows.push(args.data);
        return args.data;
      }),
    },
  };
  return { db: db as unknown as InvoiceReplyScanDb & typeof db, rows };
}

const campaign = (id: string, over: Partial<Campaign> = {}): Campaign => ({
  id,
  isActive: true,
  template: 'brand-a',
  sellerName: `셀러${id}`,
  toEmail: 'orders@brand-a.example.com',
  tasks: [{ date: '2026-10-06', status: 'EMAILED' }],
  ...over,
});

describe('selectInvoiceReplyTargets — 발주요청은 했고 송장 등록이 덜 끝난 활성 캠페인', () => {
  it('송장등록 성공+건너뜀이 발주요청 주문 수에 닿은 캠페인은 뺀다', async () => {
    const { db } = fakeDb({
      poGroups: [
        { campaignId: 'oc-done', count: 3, first: ago(30), last: ago(30) },
        { campaignId: 'oc-partial', count: 5, first: ago(30), last: ago(20) },
      ],
      registrations: [
        { campaignId: 'oc-done', createdAt: ago(10), successCount: 2, skipCount: 1 },
        { campaignId: 'oc-partial', createdAt: ago(10), successCount: 2, skipCount: 0 },
      ],
      campaigns: [campaign('oc-done'), campaign('oc-partial')],
    });

    const selection = await selectInvoiceReplyTargets(db, NOW);

    expect(selection.targets.map((t) => t.orderCampaignId)).toEqual(['oc-partial']);
    expect(selection.skippedRegistered).toBe(1);
  });

  it('발주요청보다 앞선 등록 기록은 세지 않는다(지난 차수의 등록)', async () => {
    const { db } = fakeDb({
      poGroups: [{ campaignId: 'oc-1', count: 2, first: ago(5), last: ago(5) }],
      registrations: [{ campaignId: 'oc-1', createdAt: ago(50), successCount: 10, skipCount: 0 }],
      campaigns: [campaign('oc-1')],
    });
    expect((await selectInvoiceReplyTargets(db, NOW)).targets).toHaveLength(1);
  });

  it('마감(비활성) 캠페인은 뺀다', async () => {
    const { db } = fakeDb({
      poGroups: [{ campaignId: 'oc-closed', count: 1, first: ago(5), last: ago(5) }],
      campaigns: [campaign('oc-closed', { isActive: false })],
    });
    const selection = await selectInvoiceReplyTargets(db, NOW);
    expect(selection.targets).toEqual([]);
    expect(selection.skippedInactive).toBe(1);
  });

  it('상한을 넘으면 최근 발주부터 남기고 빠진 수를 알린다', async () => {
    const ids = Array.from({ length: MAX_CAMPAIGNS_PER_RUN + 3 }, (_, i) => `oc-${i}`);
    const { db } = fakeDb({
      poGroups: ids.map((id, i) => ({ campaignId: id, count: 1, first: ago(100 - i), last: ago(100 - i) })),
      campaigns: ids.map((id) => campaign(id)),
    });
    const selection = await selectInvoiceReplyTargets(db, NOW);
    expect(selection.targets).toHaveLength(MAX_CAMPAIGNS_PER_RUN);
    expect(selection.droppedByCap).toBe(3);
    expect(selection.targets[0].orderCampaignId).toBe(ids[ids.length - 1]);
  });

  it('제목 매칭용 발주 요청일은 수동 버튼과 같은 규칙(EMAILED·PENDING 작업일)', async () => {
    const { db } = fakeDb({
      poGroups: [{ campaignId: 'oc-1', count: 1, first: ago(5), last: ago(5) }],
      campaigns: [campaign('oc-1', { tasks: [{ date: '2026-10-05', status: 'PENDING' }, { date: '2026-10-04', status: 'COMPLETED' }] })],
    });
    expect((await selectInvoiceReplyTargets(db, NOW)).targets[0].sentDates).toEqual(['261005']);
  });

  it('발주요청이 없으면 아무것도 읽지 않는다', async () => {
    const { db } = fakeDb({});
    const selection = await selectInvoiceReplyTargets(db, NOW);
    expect(selection.targets).toEqual([]);
    expect(db.orderCampaign.findMany).not.toHaveBeenCalled();
  });
});

const target = (id: string, over: Partial<InvoiceReplyTarget> = {}) => ({
  orderCampaignId: id,
  template: 'brand-a',
  sellerName: '테스트셀러',
  toEmail: 'orders@brand-a.example.com',
  sentDates: ['261006'],
  lastPoRequestedAt: ago(3),
  brand: null,
  ...over,
});

const reply = (uid: number, over: Partial<FakeMail> = {}): FakeMail => ({
  uid,
  date: ago(1),
  from: 'Shipping <ship@brand-a.example.com>',
  subject: '송장 회신 드립니다',
  bodyText: '송장 첨부합니다.',
  attachmentRows: [
    { orderId: '2026100611111111', tracking: '600000000001' },
    { orderId: '2026100622222222', tracking: '600000000002' },
  ],
  attachmentName: '테스트셀러_송장.xlsx',
  ...over,
});

describe('scanInvoiceRepliesReadOnly — 메일함에 흔적을 남기지 않는다', () => {
  it('편지함은 읽기 전용(EXAMINE)으로만 열고, 모든 조회가 markSeen:false, 쓰기 호출 0', async () => {
    const { connection, log } = createFakeReplyImap({ INBOX: [reply(1)], 라벨: [reply(2)] });

    await scanInvoiceRepliesReadOnly(connection as unknown as ImapSimple, [target('oc-1'), target('oc-2', { sellerName: '없는셀러', toEmail: 'x@other.example.com' })], {
      loginUser: 'me@example.com',
      now: NOW,
    });

    expect(log.readOnlyOpens.length).toBeGreaterThan(0);
    expect(log.readOnlyOpens.every((open) => open.readOnly === true)).toBe(true);
    expect(connection.openBox).not.toHaveBeenCalled(); // imap-simple SELECT 경로
    expect(log.searchOptions.length).toBeGreaterThan(0);
    expect(log.searchOptions.every((o) => o.markSeen === false)).toBe(true);
    for (const write of [connection.addFlags, connection.delFlags, connection.moveMessage, connection.deleteMessage]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('회신을 찾으면 주문번호 키·건수·다시 열 좌표를 남긴다(송장번호는 남기지 않는다)', async () => {
    const { connection } = createFakeReplyImap({ INBOX: [reply(7, { messageId: '<reply-7@brand-a.example.com>' })] });

    const scan = await scanInvoiceRepliesReadOnly(connection as unknown as ImapSimple, [target('oc-1')], {
      loginUser: 'me@example.com',
      now: NOW,
    });

    expect(scan.detections).toHaveLength(1);
    const [found] = scan.detections;
    expect(found).toMatchObject({
      orderCampaignId: 'oc-1',
      messageId: '<reply-7@brand-a.example.com>',
      mailbox: 'INBOX',
      uid: 7,
      parsedTrackingCount: 2,
      parseFailed: false,
    });
    expect(found.trackingOrderKeys.sort()).toEqual(['2026100611111111', '2026100622222222']);
    expect(JSON.stringify(found)).not.toContain('600000000001');
  });

  it('다른 캠페인 태그가 든 회신은 이 캠페인 것으로 잡지 않는다(수동 버튼과 같은 규칙)', async () => {
    const { connection } = createFakeReplyImap({
      INBOX: [reply(1, { bodyText: '회신 [YGRD-REF:oc-other|x]' })],
    });
    const scan = await scanInvoiceRepliesReadOnly(connection as unknown as ImapSimple, [target('oc-1')], {
      loginUser: 'me@example.com',
      now: NOW,
    });
    expect(scan.detections).toEqual([]);
    expect(scan.unresolved).toBe(1);
  });

  it('이 캠페인 태그가 있으면 발신 도메인이 달라도 잡는다', async () => {
    const { connection } = createFakeReplyImap({
      INBOX: [reply(1, { from: 'cs@unrelated.example.net', bodyText: '회신 [YGRD-REF:oc-1|x]' })],
    });
    const scan = await scanInvoiceRepliesReadOnly(connection as unknown as ImapSimple, [target('oc-1')], {
      loginUser: 'me@example.com',
      now: NOW,
    });
    expect(scan.detections.map((d) => d.orderCampaignId)).toEqual(['oc-1']);
  });

  it('우리가 보낸 메일(발주서 원본)은 회신으로 잡지 않는다', async () => {
    const { connection } = createFakeReplyImap({
      INBOX: [reply(1, { from: 'Ops <me@example.com>', bodyText: '발주서 [YGRD-REF:oc-1|x]' })],
    });
    const scan = await scanInvoiceRepliesReadOnly(connection as unknown as ImapSimple, [target('oc-1')], {
      loginUser: 'me@example.com',
      now: NOW,
    });
    expect(scan.detections).toEqual([]);
  });

  it('캠페인마다 가장 최근 회신 1통 — 한 세션에서 여러 캠페인을 함께 본다', async () => {
    const { connection, log } = createFakeReplyImap({
      INBOX: [
        reply(1, { date: ago(5) }),
        reply(2, { date: ago(1) }),
        reply(3, { from: 'cs@brand-b.example.com', bodyText: '[YGRD-REF:oc-2|y]' }),
      ],
    });
    const scan = await scanInvoiceRepliesReadOnly(
      connection as unknown as ImapSimple,
      [target('oc-1'), target('oc-2', { toEmail: 'orders@brand-b.example.com', sellerName: '다른셀러' })],
      { loginUser: 'me@example.com', now: NOW },
    );
    const byCampaign = Object.fromEntries(scan.detections.map((d) => [d.orderCampaignId, d.uid]));
    expect(byCampaign).toEqual({ 'oc-1': 2, 'oc-2': 3 });
    expect(connection.getBoxes).toHaveBeenCalledTimes(1);
    expect(log.readOnlyOpens.filter((o) => o.name === 'INBOX')).toHaveLength(1);
  });

  it('본문 상한에 걸리면 그만 받고 알린다', async () => {
    const mails = Array.from({ length: 6 }, (_, i) => reply(i + 1, { attachmentRows: undefined }));
    const { connection, log } = createFakeReplyImap({ INBOX: mails });
    const scan = await scanInvoiceRepliesReadOnly(connection as unknown as ImapSimple, [target('oc-1')], {
      loginUser: 'me@example.com',
      now: NOW,
      maxBodies: 4,
    });
    expect(scan.bodyCapHit).toBe(true);
    expect(scan.bodiesFetched).toBe(4);
    expect(log.bodyFetchUids.flat()).toHaveLength(4);
  });

  it('편지함 하나가 열리지 않아도 나머지를 본다', async () => {
    const { connection } = createFakeReplyImap({ INBOX: [], 라벨: [reply(4)] }, { failOpen: ['INBOX'] });
    const scan = await scanInvoiceRepliesReadOnly(connection as unknown as ImapSimple, [target('oc-1')], {
      loginUser: 'me@example.com',
      now: NOW,
    });
    expect(scan.mailboxErrors).toBe(1);
    expect(scan.detections.map((d) => d.uid)).toEqual([4]);
  });

  it('첨부를 못 읽어도 감지는 남기되 건수 0', async () => {
    const { connection } = createFakeReplyImap({ INBOX: [reply(9, { attachmentRows: [] })] });
    const scan = await scanInvoiceRepliesReadOnly(connection as unknown as ImapSimple, [target('oc-1')], {
      loginUser: 'me@example.com',
      now: NOW,
    });
    expect(scan.detections[0]).toMatchObject({ uid: 9, parsedTrackingCount: 0 });
  });
});

describe('persistInvoiceReplyDetections — 같은 메일은 한 번만', () => {
  const detection = {
    orderCampaignId: 'oc-1',
    messageId: '<reply-7@brand-a.example.com>',
    mailbox: 'INBOX',
    uid: 7,
    receivedAt: ago(1),
    parsedTrackingCount: 2,
    trackingOrderKeys: ['a', 'b'],
    parseFailed: false,
  };

  it('재실행은 유니크 키로 건너뛴다', async () => {
    const { db, rows } = fakeDb({});
    expect(await persistInvoiceReplyDetections(db, [detection])).toMatchObject({ created: 1, alreadyKnown: 0 });
    expect(await persistInvoiceReplyDetections(db, [detection])).toMatchObject({ created: 0, alreadyKnown: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].trackingOrderKeys).toBe('["a","b"]');
  });

  it('동시 실행이 먼저 넣었으면(P2002) 실패가 아니다', async () => {
    const { db } = fakeDb({});
    db.invoiceReplyDetection.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    expect(await persistInvoiceReplyDetections(db, [detection])).toMatchObject({ created: 0, alreadyKnown: 1, writeFailures: 0 });
  });
});

describe('runInvoiceReplyScan', () => {
  beforeEach(() => {
    vi.stubEnv('SMTP_USER', 'me@example.com');
    vi.stubEnv('SMTP_PASS', 'test-app-password');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('대상이 없으면 메일 서버에 붙지 않는다', async () => {
    const { db } = fakeDb({});
    const connect = vi.fn();
    const summary = await runInvoiceReplyScan({ db, now: NOW, connect });
    expect(connect).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ skippedNoTargets: true, targets: 0 });
    expect(summary.failed).toBeUndefined();
  });

  it('자격증명이 없으면 실행 실패로 드러낸다(「회신 0건」으로 보이지 않게)', async () => {
    vi.stubEnv('SMTP_PASS', '');
    const { db } = fakeDb({
      poGroups: [{ campaignId: 'oc-1', count: 1, first: ago(3), last: ago(3) }],
      campaigns: [campaign('oc-1')],
    });
    const summary = await runInvoiceReplyScan({ db, now: NOW, connect: vi.fn(), resolveBrand: async () => null });
    expect(summary.failed).toBe(true);
  });

  it('감지 → 저장, 재실행은 멱등, 메일·주문 쓰기 0, 로그에 주소·송장번호 없음', async () => {
    const logs: string[] = [];
    const spies = (['log', 'warn', 'error', 'info'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      }),
    );
    const { db, rows } = fakeDb({
      poGroups: [{ campaignId: 'oc-1', count: 2, first: ago(3), last: ago(3) }],
      campaigns: [campaign('oc-1', { sellerName: '테스트셀러' })],
    });
    const { connection } = createFakeReplyImap({ INBOX: [reply(7)] });
    const deps = { db, now: NOW, connect: async () => connection as unknown as ImapSimple, resolveBrand: async () => null };

    const first = await runInvoiceReplyScan(deps);
    const second = await runInvoiceReplyScan(deps);

    expect(first).toMatchObject({ targets: 1, detected: 1, created: 1, alreadyKnown: 0 });
    expect(second).toMatchObject({ detected: 1, created: 0, alreadyKnown: 1 });
    expect(rows).toHaveLength(1);
    expect(connection.end).toHaveBeenCalledTimes(2);
    expect(connection.addFlags).not.toHaveBeenCalled();
    expect(db.orderActionLog.create).not.toHaveBeenCalled();
    expect(db.orderFulfillmentState.update).not.toHaveBeenCalled();
    expect(db.orderFulfillmentState.upsert).not.toHaveBeenCalled();
    expect(db.orderCampaign.update).not.toHaveBeenCalled();
    const joined = logs.join('\n') + JSON.stringify(first);
    expect(joined).not.toContain('@brand-a.example.com');
    expect(joined).not.toContain('600000000001');
    spies.forEach((spy) => spy.mockRestore());
  });
});
