/**
 * 봇 정산 대조용 형제 스캔(`scanStatementMailsWithAttachments`) — 가짜 IMAP 연결만 쓴다(실메일함에 닿지 않는다).
 * 고정하는 것:
 *  ① 읽기 전용(openBox readOnly · markSeen:false)
 *  ② 헤더 관문(정산서 제목 · 우리 발신 아님)이 **본문 조회보다 먼저** — 본문 UID 에 거른 것만. 셀러 이름은 거름이
 *     아니라 순서(`priority`)다
 *  ③ 우선도 → 최근 순 상한 + 넘친 수는 truncated · 표 첨부 크기 상한 초과는 oversized · CFB 껍데기만 같은 문서는 표 아님
 *  ④ 시간 예산 — 헤더 단계 초과는 MAIL_FETCH_FAILED, 본문 단계 초과는 timedOut · 넘긴 연결은 destroy, 정상은 end
 *  ⑤ 소켓 'error' 이벤트에 듣는 쪽이 붙어 있다(처리 안 된 오류로 죽지 않게)
 *  ⑤ 메일 설정 없음 → MAIL_NOT_CONFIGURED
 */
import { describe, expect, it, vi } from "vitest";
import type { ImapSimple } from "imap-simple";
import * as XLSX from "xlsx";
import { SUPPLIER } from "@/lib/tax-invoice-builder";
import { isSpreadsheetAttachment, scanStatementMailsWithAttachments } from "./brand-statement-scan";

type FakeMail = { uid: number; date: Date; subject: string; from: string; attachments: Buffer[]; names?: string[] };

function cfb(streams: Record<string, Buffer>): Buffer {
  const container = XLSX.CFB.utils.cfb_new();
  for (const [name, data] of Object.entries(streams)) XLSX.CFB.utils.cfb_add(container, name, data);
  return Buffer.from(XLSX.CFB.write(container, { type: "buffer" }) as Uint8Array);
}
/** 이름 없는 CFB — 표(Workbook 스트림)와 .doc 류(WordDocument 스트림). */
const WORKBOOK = cfb({ Workbook: Buffer.alloc(16, 1) });
const WORD_DOC = cfb({ WordDocument: Buffer.alloc(16, 1) });

const BODY = `브랜드A 정산내역서

파트너 정보 파트너명 ${SUPPLIER.name}

프로모션 정보 프로모션명 26년 10월 가나다 공구

세금계산서 발행 정산방식 정산월 최종정산금 발행주체

총 매출 10월 1,000,000 브랜드A

판매 수수료 10월 450,000 ${SUPPLIER.name}`;

function rawMime(mail: FakeMail): string {
  const boundary = "BOUNDARY-1";
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(BODY).toString("base64")}\r\n`,
    ...mail.attachments.map(
      (content, index) => {
        const name = mail.names?.[index] ?? `s${index}.xls`;
        return `--${boundary}\r\nContent-Type: application/octet-stream; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${content.toString("base64")}\r\n`;
      },
    ),
  ];
  return [
    `Message-ID: <m${mail.uid}@example.com>`,
    `Date: ${mail.date.toUTCString()}`,
    `From: ${mail.from}`,
    `Subject: =?UTF-8?B?${Buffer.from(mail.subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    ...parts,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function fakeConnection(mailbox: FakeMail[], options: { bodyNeverResolves?: boolean; headerNeverResolves?: boolean } = {}) {
  const calls = {
    openBox: [] as Array<[string, boolean]>,
    searches: [] as Array<{ criteria: unknown[][]; markSeen: unknown }>,
    ended: 0,
    destroyed: 0,
    errorListeners: 0,
  };
  const connection = {
    getBoxes: async () => ({ INBOX: {} }),
    on: (event: string) => {
      if (event === "error") calls.errorListeners += 1;
      return connection;
    },
    imap: {
      openBox: (name: string, readOnly: boolean, cb: (error: Error | null) => void) => {
        calls.openBox.push([name, readOnly]);
        cb(null);
      },
      destroy: () => {
        calls.destroyed += 1;
      },
    },
    end: () => {
      calls.ended += 1;
    },
    search: async (criteria: unknown[][], fetchOptions: { markSeen?: unknown }) => {
      calls.searches.push({ criteria, markSeen: fetchOptions.markSeen });
      const [key, ...args] = criteria[0] as [string, ...unknown[]];
      if (key === "SINCE") {
        if (options.headerNeverResolves) return new Promise(() => undefined);
        return mailbox.map((mail) => ({
          attributes: { uid: mail.uid, date: mail.date },
          parts: [{ which: "HEADER", body: { subject: [mail.subject], from: [mail.from] } }],
        }));
      }
      if (options.bodyNeverResolves) return new Promise(() => undefined);
      const wanted = new Set(args.map((arg) => Number(arg)));
      return mailbox
        .filter((mail) => wanted.has(mail.uid))
        .map((mail) => ({ attributes: { uid: mail.uid }, parts: [{ which: "", body: rawMime(mail) }] }));
    },
  };
  return { connection: connection as unknown as ImapSimple, calls };
}

function deps(connection: ImapSimple) {
  return {
    resolveCredentials: () => ({ user: "inbox@example.com", pass: "x" }) as never,
    connect: vi.fn(async () => connection),
    now: () => Date.now(),
  };
}

const OPTIONS = {
  since: new Date("2026-09-28T00:00:00.000Z"),
  before: new Date("2026-12-07T00:00:00.000Z"),
  priority: (header: { subject: string; from: string }) => (header.subject.includes("가나다") ? 2 : 0),
  maxMessages: 2,
  maxAttachmentBytes: 64,
  budgetMs: 5_000,
};

function statementMail(uid: number, day: number, overrides: Partial<FakeMail> = {}): FakeMail {
  return {
    uid,
    date: new Date(Date.UTC(2026, 10, day)),
    subject: `[브랜드A] 10월 가나다님 정산서 ${uid}`,
    from: "brand@brand-a.example.com",
    attachments: [WORKBOOK],
    ...overrides,
  };
}

describe("scanStatementMailsWithAttachments", () => {
  it("읽기 전용 · 헤더 관문 뒤 우선도→최근 순 상한만 본문 조회 · 넘친 수와 큰 첨부를 센다", async () => {
    const big = Buffer.concat([WORKBOOK, Buffer.alloc(100)]);
    const mailbox = [
      statementMail(1, 1),
      statementMail(2, 5, { attachments: [WORKBOOK, big], names: ["a.xls", "b.xls"] }),
      statementMail(3, 9, { subject: "[브랜드A] 10월 마감정산서" }), // 셀러 이름 없음 — 거르지 않고 순서만 뒤로
      statementMail(5, 11, { subject: "[브랜드A] 가나다님 발주서" }), // 정산서 제목 아님
      statementMail(6, 12, { from: "inbox@example.com" }), // 우리 회신
    ];
    const { connection, calls } = fakeConnection(mailbox);
    const result = await scanStatementMailsWithAttachments({ ...OPTIONS, maxAttachmentBytes: 64 + WORKBOOK.length }, deps(connection));
    if (!result.ok) throw new Error(`expected ok: ${result.code}`);

    expect(calls.openBox).toEqual([["INBOX", true]]);
    expect(calls.searches.every((search) => search.markSeen === false)).toBe(true);
    const bodySearch = calls.searches.find((search) => (search.criteria[0] as unknown[])[0] === "UID")!;
    // 우선도 2 인 1·2 가 먼저(최근 순 2 → 1), 우선도 0 인 3 은 상한(2통)에 걸린다.
    expect((bodySearch.criteria[0] as unknown[]).slice(1).map(Number).sort()).toEqual([1, 2]);

    expect(result.candidates).toBe(3);
    expect(result.truncated).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.mails.map((mail) => mail.uid)).toEqual([2, 1]);
    const second = result.mails.find((mail) => mail.uid === 2)!;
    expect(second.spreadsheets).toHaveLength(1);
    expect(second.oversized).toBe(1);
    expect(second.messageKey).toMatch(/^[0-9a-f]{32}$/);
    expect(second.statement?.counterpartyLabel).toBe("브랜드A");
    expect(calls.ended).toBe(1);
    expect(calls.destroyed).toBe(0);
    expect(calls.errorListeners).toBe(1);
  });

  it("셀러 이름이 제목에 없는 정산서도 후보다(본문 판정은 호출부)", async () => {
    const { connection } = fakeConnection([statementMail(1, 1, { subject: "[브랜드A] 26년 10월 마감정산서" })]);
    const result = await scanStatementMailsWithAttachments(OPTIONS, deps(connection));
    if (!result.ok) throw new Error(`expected ok: ${result.code}`);
    expect(result.mails.map((mail) => mail.uid)).toEqual([1]);
  });

  it("이름 없는 첨부: CFB 안에 Workbook 이 있으면 표, .doc 류(WordDocument)면 표 아님", async () => {
    const { connection } = fakeConnection([
      statementMail(1, 1, { attachments: [WORD_DOC], names: ["noname"] }),
      statementMail(2, 2, { attachments: [WORKBOOK], names: ["noname"] }),
    ]);
    const result = await scanStatementMailsWithAttachments({ ...OPTIONS, maxAttachmentBytes: 1024 * 1024 }, deps(connection));
    if (!result.ok) throw new Error(`expected ok: ${result.code}`);
    const byUid = new Map(result.mails.map((mail) => [mail.uid, mail]));
    expect(byUid.get(1)).toMatchObject({ spreadsheets: [], oversized: 0 });
    expect(byUid.get(2)!.spreadsheets).toHaveLength(1);
    expect(isSpreadsheetAttachment({ filename: "정산.XLS", content: Buffer.from("x") })).toBe(true);
    expect(isSpreadsheetAttachment({ filename: "보고.doc", content: WORD_DOC })).toBe(false);
    expect(isSpreadsheetAttachment({ filename: null, content: WORKBOOK })).toBe(true);
  });

  it("헤더 관문을 지난 메일이 없으면 본문을 받지 않는다", async () => {
    const { connection, calls } = fakeConnection([statementMail(1, 1, { subject: "[브랜드A] 가나다님 발주서" })]);
    const result = await scanStatementMailsWithAttachments(OPTIONS, deps(connection));
    expect(result).toEqual({ ok: true, candidates: 0, truncated: 0, timedOut: false, mails: [] });
    expect(calls.searches.some((search) => (search.criteria[0] as unknown[])[0] === "UID")).toBe(false);
  });

  it("본문 단계에서 예산을 넘기면 timedOut(실패 아님), 헤더 단계면 MAIL_FETCH_FAILED — 연결은 닫는다", async () => {
    const slowBody = fakeConnection([statementMail(1, 1)], { bodyNeverResolves: true });
    const timed = await scanStatementMailsWithAttachments({ ...OPTIONS, budgetMs: 50 }, deps(slowBody.connection));
    expect(timed).toEqual({ ok: true, candidates: 1, truncated: 0, timedOut: true, mails: [] });
    expect(slowBody.calls).toMatchObject({ destroyed: 1, ended: 0 });

    const slowHeader = fakeConnection([statementMail(1, 1)], { headerNeverResolves: true });
    const failed = await scanStatementMailsWithAttachments({ ...OPTIONS, budgetMs: 50 }, deps(slowHeader.connection));
    expect(failed).toEqual({ ok: false, code: "MAIL_FETCH_FAILED" });
    expect(slowHeader.calls).toMatchObject({ destroyed: 1, ended: 0 });
  });

  it("연결 실패는 고정 코드, 메일 설정이 없으면 MAIL_NOT_CONFIGURED(연결하지 않음)", async () => {
    const connect = vi.fn(async () => {
      throw new Error("server said something");
    });
    const failed = await scanStatementMailsWithAttachments(OPTIONS, {
      resolveCredentials: () => ({ user: "u", pass: "p" }) as never,
      connect,
      now: () => Date.now(),
    });
    expect(failed).toEqual({ ok: false, code: "MAIL_FETCH_FAILED" });

    const neverConnect = vi.fn();
    const missing = await scanStatementMailsWithAttachments(OPTIONS, {
      resolveCredentials: () => null,
      connect: neverConnect,
      now: () => Date.now(),
    });
    expect(missing).toEqual({ ok: false, code: "MAIL_NOT_CONFIGURED" });
    expect(neverConnect).not.toHaveBeenCalled();
  });
});
