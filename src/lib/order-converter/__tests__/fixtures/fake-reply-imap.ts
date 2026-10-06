import { EventEmitter } from 'events';
import { vi } from 'vitest';
import * as XLSX from 'xlsx';

/**
 * 송장 회신 스캔 테스트용 가짜 IMAP — 실제 메일 서버에 붙지 않는다.
 *
 * 무엇을 기록하나: 편지함을 **어떻게** 열었는지(읽기 전용 EXAMINE 인가, imap-simple 의 SELECT 인가),
 * 검색 옵션의 `markSeen`, 그리고 쓰기 계열 호출(`addFlags` 등)이 있었는지. 크론의 「흔적 0」 계약을
 * 이 기록으로 단언한다. 주소·이름은 전부 허구(example.com)다.
 */

export interface FakeMail {
  uid: number;
  date: Date;
  from: string;
  subject: string;
  messageId?: string;
  bodyText: string;
  /** 첨부 엑셀의 (주문번호, 송장번호) 행. 없으면 첨부 없음. */
  attachmentRows?: Array<{ orderId: string; tracking: string }>;
  attachmentName?: string;
}

function xlsxBase64(rows: Array<{ orderId: string; tracking: string }>): string {
  const sheet = XLSX.utils.json_to_sheet(
    rows.map((row) => ({ 상품주문번호: row.orderId, 택배사: 'CJ대한통운', 송장번호: row.tracking })),
  );
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
  const out = XLSX.write(book, { type: 'base64', bookType: 'xlsx' }) as string;
  return out.replace(/(.{76})/g, '$1\r\n');
}

export function rawMime(mail: FakeMail): string {
  const head = [
    `From: ${mail.from}`,
    `To: ops@example.com`,
    `Subject: =?UTF-8?B?${Buffer.from(mail.subject, 'utf8').toString('base64')}?=`,
    `Message-ID: ${mail.messageId ?? `<m${mail.uid}@example.com>`}`,
    'MIME-Version: 1.0',
  ];
  if (!mail.attachmentRows) {
    return [...head, 'Content-Type: text/plain; charset=utf-8', '', mail.bodyText].join('\r\n');
  }
  const name = mail.attachmentName ?? 'reply.xlsx';
  // 한글 파일명은 RFC 2231 로 싣는다(브랜드사가 보내는 실제 꼴과 같다).
  const encoded = encodeURIComponent(name);
  return [
    ...head,
    'Content-Type: multipart/mixed; boundary="BOUNDARY"',
    '',
    '--BOUNDARY',
    'Content-Type: text/plain; charset=utf-8',
    '',
    mail.bodyText,
    '--BOUNDARY',
    `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name*=UTF-8''${encoded}`,
    `Content-Disposition: attachment; filename*=UTF-8''${encoded}`,
    'Content-Transfer-Encoding: base64',
    '',
    xlsxBase64(mail.attachmentRows),
    '--BOUNDARY--',
    '',
  ].join('\r\n');
}

export function createFakeReplyImap(
  mailboxes: Record<string, FakeMail[]>,
  options: {
    failOpen?: string[];
    /** 헤더 검색이 영영 응답하지 않는다(소켓이 조용히 끊긴 상태). */
    hangOnSearch?: boolean;
    /** 헤더 검색 도중 연결 객체가 'error' 이벤트를 내고 응답하지 않는다. */
    emitErrorOnSearch?: boolean;
    /** 이 편지함은 열리지만 헤더 검색(SEARCH)이 서버 오류로 거절된다. */
    failSearch?: string[];
    /** 이 편지함은 열리고 검색도 되지만 본문 받기(UID FETCH)가 서버 오류로 거절된다. */
    failBodyFetch?: string[];
  } = {},
) {
  const log = {
    readOnlyOpens: [] as Array<{ name: string; readOnly: boolean }>,
    searchOptions: [] as Array<Record<string, unknown>>,
    bodyFetchUids: [] as number[][],
  };
  let current = '';

  // imap-simple 의 연결 객체는 EventEmitter 다 — 'error' 리스너가 없으면 emit 이 throw 한다(실물과 같다).
  const emitter = new EventEmitter();
  const connection = Object.assign(emitter, {
    getBoxes: vi.fn(async () =>
      Object.fromEntries(Object.keys(mailboxes).map((name) => [name, { attribs: [], delimiter: '/', children: null }])),
    ),
    // imap-simple 의 openBox 는 SELECT(read-write) — 크론은 이것을 부르면 안 된다.
    openBox: vi.fn(async () => {
      throw new Error('read-write openBox must not be used by the cron');
    }),
    imap: {
      openBox: vi.fn((name: string, readOnly: boolean, cb: (err: Error | null, box?: unknown) => void) => {
        log.readOnlyOpens.push({ name, readOnly });
        if (options.failOpen?.includes(name)) return cb(new Error('open failed'));
        current = name;
        cb(null, { messages: { total: mailboxes[name]?.length ?? 0 } });
      }),
    },
    search: vi.fn(async (criteria: unknown[][], fetchOptions: Record<string, unknown>) => {
      log.searchOptions.push(fetchOptions);
      if (options.hangOnSearch) return new Promise<never>(() => {});
      if (options.emitErrorOnSearch) {
        emitter.emit('error', new Error('socket closed'));
        return new Promise<never>(() => {});
      }
      const mails = mailboxes[current] ?? [];
      const first = criteria[0] as [string, ...unknown[]];
      if (first[0] === 'UID') {
        if (options.failBodyFetch?.includes(current)) throw new Error('fetch failed');
        const uids = first.slice(1) as number[];
        log.bodyFetchUids.push(uids);
        return mails
          .filter((mail) => uids.includes(mail.uid))
          .map((mail) => ({ attributes: { uid: mail.uid, date: mail.date }, parts: [{ which: '', body: rawMime(mail) }] }));
      }
      if (options.failSearch?.includes(current)) throw new Error('search failed');
      const bodyNeedle = criteria.find((c) => c[0] === 'BODY')?.[1] as string | undefined;
      const hits = bodyNeedle ? mails.filter((mail) => mail.bodyText.includes(bodyNeedle)) : mails;
      return hits.map((mail) => ({
        attributes: { uid: mail.uid, date: mail.date },
        parts: [
          {
            which: 'HEADER',
            body: {
              subject: [mail.subject],
              from: [mail.from],
              ...(mail.messageId === undefined ? { 'message-id': [`<m${mail.uid}@example.com>`] } : mail.messageId ? { 'message-id': [mail.messageId] } : {}),
            },
          },
        ],
      }));
    }),
    // 쓰기 계열 — 하나라도 불리면 계약 위반.
    addFlags: vi.fn(),
    delFlags: vi.fn(),
    moveMessage: vi.fn(),
    deleteMessage: vi.fn(),
    end: vi.fn(),
  });

  return { connection, log };
}
