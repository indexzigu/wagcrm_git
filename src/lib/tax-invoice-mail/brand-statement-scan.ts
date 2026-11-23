/**
 * 브랜드 정산서 메일 **읽기 전용** 스캔(T-242) — 본문을 `brand-statement.ts` 로 해석한다.
 *
 * 왜 「전체보관함」인가: 정산서는 계산서 편지함(`TAX_INVOICE_MAIL_BOX`)이 아니라 받은편지함·사용자
 * 라벨(발주 관리 등)에 흩어져 오고, 오너가 읽고 보관하면 **전체보관함에만** 남는다(메일함 실측
 * 2026-10-08). 한 편지함으로 모두를 보려면 전체보관함이 유일하다 — 없으면(구글 아닌 서버) 받은편지함.
 * 편지함 판정은 `mail-config.ts` 가 소유한다(⛔ 여기서 이름 목록을 다시 만들지 말 것).
 *
 * ⛔ 읽기만 한다: `openBox(…, readOnly=true)` · `markSeen: false`.
 * ⛔ 본문(셀러 실명·매출)을 로그로 남기지 않는다(P0) — 실패는 개수와 사유 코드만.
 */
import { createHash } from "node:crypto";
import imaps, { type ImapSimple } from "imap-simple";
import {
  isAllMailbox,
  isOwnSenderAddress,
  resolveImapConfig,
  resolveMailCredentials,
  type MailCredentials,
  type MailboxDescriptor,
} from "@/lib/mail-config";
import { toNfc } from "@/lib/text-normalize";
import { SUPPLIER } from "@/lib/tax-invoice-builder";
import { fetchBodiesByUid, parseMime } from "./mail-scan";
import { isWorkbookContainer, MAX_STATEMENT_ATTACHMENT_BYTES } from "./statement-pivot-xls";
import {
  isSettlementStatementSubject,
  parseSettlementStatement,
  type ParsedSettlementStatement,
} from "./brand-statement";

export type ScannedBrandStatement = ParsedSettlementStatement & {
  /** 메일 받은 시각(ISO) */
  receivedAt: string;
};

export type BrandStatementScanResult = {
  box: string;
  sinceDays: number;
  headerScanned: number;
  /** 제목이 정산서처럼 보인 메일 수 */
  candidates: number;
  /** 그중 두 형식 어느 쪽으로도 못 읽은 수 — 형식 변경 신호 */
  unparsed: number;
  /** 상한(`maxMessages`)에 걸려 읽지 않은 후보 수 — 0 이 아니면 「정산서 한 통뿐」을 믿을 수 없다 */
  truncated: number;
  statements: ScannedBrandStatement[];
};

/** getBoxes() 트리 → 편지함 서술자(이름 + 특수용도 속성). */
function describeBoxes(tree: Record<string, unknown>, prefix = ""): MailboxDescriptor[] {
  const found: MailboxDescriptor[] = [];
  for (const key of Object.keys(tree)) {
    const node = tree[key] as { attribs?: string[]; children?: Record<string, unknown>; delimiter?: string };
    const name = prefix + key;
    found.push({ name, attribs: node?.attribs ?? [] });
    if (node?.children) found.push(...describeBoxes(node.children, name + (node.delimiter ?? "/")));
  }
  return found;
}

/** 전체보관함, 없으면 받은편지함. */
export function pickStatementBox(boxes: readonly MailboxDescriptor[]): string {
  return boxes.find(isAllMailbox)?.name ?? "INBOX";
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export async function scanBrandStatementMails(options: {
  sinceDays: number;
  maxMessages?: number;
}): Promise<BrandStatementScanResult> {
  const { sinceDays, maxMessages = 200 } = options;
  const credentials = resolveMailCredentials();
  if (!credentials) throw new Error("메일 서버(IMAP) 연동 정보가 설정되어 있지 않습니다.");

  const connection = await imaps.connect({ imap: resolveImapConfig(credentials, { authTimeout: 10_000 }) });
  try {
    const box = pickStatementBox(describeBoxes((await connection.getBoxes()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      connection.imap.openBox(box, true, (err: Error | null) => (err ? reject(err) : resolve()));
    });

    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    // 헤더 읽기는 계산서 스캔(`scanTaxInvoiceMails`)과 같은 방식이다 — 그쪽이 한국어 제목 디코딩을
    // 운영에서 검증했다(객체로 오면 그대로, 원문으로 오면 MIME 해석).
    const headers = await connection.search([["SINCE", since]], {
      bodies: ["HEADER"],
      markSeen: false,
    });

    const candidates: Array<{ uid: number; date: Date }> = [];
    for (const message of headers) {
      const part = message.parts.find((p) => p.which === "HEADER");
      if (!part) continue;
      let subject = "";
      let from = "";
      const body = part.body as unknown;
      if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
        const record = body as Record<string, string[] | undefined>;
        subject = record.subject?.[0] ?? record.Subject?.[0] ?? "";
        from = record.from?.[0] ?? record.From?.[0] ?? "";
      } else {
        const parsedHeader = await parseMime(body);
        subject = parsedHeader.subject ?? "";
        from = parsedHeader.from?.text ?? "";
      }
      // 우리가 보낸 회신(「RE: …정산서」)은 정산서가 아니다.
      if (!isSettlementStatementSubject(subject) || isOwnSenderAddress(from, credentials.user)) continue;
      candidates.push({ uid: message.attributes.uid, date: message.attributes.date as Date });
    }
    candidates.sort((a, b) => b.date.getTime() - a.date.getTime());
    const targets = candidates.slice(0, maxMessages);
    const bodies = await fetchBodiesByUid(connection, targets.map((t) => t.uid));

    const statements: ScannedBrandStatement[] = [];
    let unparsed = 0;
    for (const target of targets) {
      if (!bodies.has(target.uid)) continue;
      const mail = await parseMime(bodies.get(target.uid));
      const text = mail.text || (typeof mail.html === "string" ? stripHtml(mail.html) : "");
      const parsed = parseSettlementStatement({ subject: mail.subject ?? "", text, ourName: SUPPLIER.name });
      if (!parsed) {
        unparsed += 1;
        continue;
      }
      statements.push({ ...parsed, receivedAt: (mail.date ?? target.date).toISOString() });
    }
    return {
      box,
      sinceDays,
      headerScanned: headers.length,
      candidates: candidates.length,
      unparsed,
      truncated: candidates.length - targets.length,
      statements,
    };
  } finally {
    connection.end();
  }
}

// ---------------------------------------------------------------------------
// 봇 정산 대조(get_settlement_reconciliation v1) — 첨부까지 받는 **형제** 스캔
// ---------------------------------------------------------------------------
// ⛔ 위 `scanBrandStatementMails`(크론·정산 화면이 쓴다)의 동작은 바꾸지 않는다 — 그쪽은 본문만 보고 첨부를 버린다.
// 이 함수는 같은 편지함·같은 읽기 전용 규칙(readOnly · markSeen:false)으로, 고른 몇 통만 첨부째 받는다.

/**
 * 표 첨부로 볼 확장자(파일 이름은 판정에만 쓰고 결과에 싣지 않는다). .xlsx 도 표로 센다 — v1 리더가 읽지 않으므로
 * 「못 읽은 첨부」(일부만 확인)로 드러난다(조용히 「표 없음」이 되지 않게).
 */
const SPREADSHEET_NAME_RE = /\.xlsx?$/;

export type StatementAttachmentMail = {
  uid: number;
  /** sha256(Message-ID) 앞 32자 — 메일을 가리키는 불투명 키(제목·보낸 사람을 싣지 않으려고) */
  messageKey: string;
  receivedAt: Date;
  /** 본문 해석 결과 — 못 읽었으면 null(호출부가 「못 본 후보」로 센다) */
  statement: ParsedSettlementStatement | null;
  /** 표 첨부 원본(크기 상한 이하만). ⛔ 구매자 정보가 든 시트가 있다 — 밖으로 내보내지 말 것 */
  spreadsheets: Buffer[];
  /** 크기 상한을 넘어 버린 표 첨부 수 */
  oversized: number;
};

export type StatementAttachmentScanResult =
  | {
      ok: true;
      /** 헤더 관문(정산서 제목 · 우리 발신 아님)을 지난 메일 수 */
      candidates: number;
      /** 상한(`maxMessages`)에 걸려 본문을 받지 않은 후보 수 */
      truncated: number;
      /** 시간 예산 안에 본문을 다 받지 못했다 */
      timedOut: boolean;
      mails: StatementAttachmentMail[];
    }
  | { ok: false; code: "MAIL_NOT_CONFIGURED" | "MAIL_FETCH_FAILED" };

export type StatementAttachmentScanDeps = {
  resolveCredentials: () => MailCredentials | null;
  connect: (credentials: MailCredentials) => Promise<ImapSimple>;
  now: () => number;
};

const defaultAttachmentScanDeps: StatementAttachmentScanDeps = {
  resolveCredentials: resolveMailCredentials,
  connect: (credentials) => imaps.connect({ imap: resolveImapConfig(credentials, { authTimeout: 10_000 }) }),
  now: () => Date.now(),
};

type Timed<T> = { done: true; value: T } | { done: false };

/** 남은 예산 안에 끝나면 값, 아니면 「못 끝냄」. 늦게 끝난 쪽의 실패는 삼킨다(연결은 finally 가 닫는다). */
async function withinBudget<T>(work: Promise<T>, remainingMs: number): Promise<Timed<T>> {
  work.catch(() => undefined);
  if (remainingMs <= 0) return { done: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), remainingMs);
  });
  try {
    return await Promise.race([work.then((value): Timed<T> => ({ done: true, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readHeader(body: unknown): { subject: string; from: string } | null {
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    const record = body as Record<string, string[] | undefined>;
    return {
      subject: record.subject?.[0] ?? record.Subject?.[0] ?? "",
      from: record.from?.[0] ?? record.From?.[0] ?? "",
    };
  }
  return null;
}

/**
 * 표 첨부인가 — 이름이 .xls/.xlsx 이거나, 이름이 없어도 CFB 안에 Workbook 스트림이 있는 것(엑셀 통합 문서).
 * CFB 머리만으로는 표로 보지 않는다 — .doc·.hwp·.msg 도 같은 껍데기다(그런 메일은 「표 없음」이지 「못 읽음」이 아니다).
 * 크기 상한을 넘는 이름 없는 CFB 는 열어 보지 않는다(표로 세지 않는다).
 */
export function isSpreadsheetAttachment(
  attachment: { filename?: string | null; content?: unknown },
  maxBytes: number = MAX_STATEMENT_ATTACHMENT_BYTES,
): boolean {
  const name = toNfc(attachment.filename ?? "").trim().toLowerCase();
  if (SPREADSHEET_NAME_RE.test(name)) return true;
  const content = attachment.content;
  return Buffer.isBuffer(content) && content.length <= maxBytes && isWorkbookContainer(content);
}

function messageKeyOf(messageId: string | undefined, uid: number, date: Date): string {
  const source = messageId?.trim() || `uid:${uid}:${date.toISOString()}`;
  return createHash("sha256").update(source).digest("hex").slice(0, 32);
}

/**
 * 정산서 메일을 **첨부째** 읽는다(읽기 전용). 순서가 계약이다:
 *  ① 헤더만 받는다(기간 `since`~`before`).
 *  ② 헤더로 거른다 — 정산서 제목(`isSettlementStatementSubject`) · 우리가 보낸 회신 아님. 그것뿐이다: 셀러 이름이
 *     본문(프로모션명)에만 있는 정산서도 있어서, 「이 캠페인 것인가」는 본문 판정(호출부)이 정한다(코드 리뷰 2026-11-23).
 *  ③ 호출부 `priority`(제목·보낸 사람 표시에 셀러·거래처 이름이 있나) 높은 순, 같으면 최근 순으로 `maxMessages` 통만
 *     본문을 받는다 — 순서만 정하고 거르지 않는다. 넘친 후보는 `truncated` 로 센다(조용히 버리지 않는다).
 *  ④ 본문을 해석하고 표 첨부만 남긴다(크기 상한 초과는 `oversized` 로 세고 버린다).
 * 시간 예산(`budgetMs`)은 연결부터 잰다 — 헤더 단계까지 못 끝내면 MAIL_FETCH_FAILED, 본문 단계에서 넘기면 `timedOut`.
 * 예산을 넘긴 연결은 응답을 기다리지 않고 소켓째 끊는다(`imap.destroy()`); 정상 종료는 `end()`.
 * ⛔ 실패는 고정 코드만 돌려준다(오류 문구에 서버 응답·제목이 섞일 수 있다). console.* 를 쓰지 않는다.
 */
export async function scanStatementMailsWithAttachments(
  options: {
    since: Date;
    before: Date;
    /** 본문을 받을 순서의 우선도(클수록 먼저) — 거름이 아니다 */
    priority: (header: { subject: string; from: string }) => number;
    maxMessages: number;
    maxAttachmentBytes: number;
    budgetMs: number;
  },
  deps: StatementAttachmentScanDeps = defaultAttachmentScanDeps,
): Promise<StatementAttachmentScanResult> {
  const credentials = deps.resolveCredentials();
  if (!credentials) return { ok: false, code: "MAIL_NOT_CONFIGURED" };
  const deadline = deps.now() + options.budgetMs;
  const remaining = () => deadline - deps.now();

  const connecting = deps.connect(credentials);
  const connected = await withinBudget(connecting, remaining()).catch(() => null);
  if (!connected || !connected.done) {
    // 예산을 넘겨 늦게 붙은 연결도 끊는다(열린 채 남기지 않는다).
    connecting
      .then((late) => {
        late.on("error", () => undefined);
        late.imap.destroy();
      })
      .catch(() => undefined);
    return { ok: false, code: "MAIL_FETCH_FAILED" };
  }
  const connection = connected.value;
  // 소켓 오류가 처리되지 않은 'error' 이벤트로 프로세스를 죽이지 않게(결과는 각 단계의 실패로 드러난다).
  connection.on("error", () => undefined);
  let abandoned = false;
  try {
    const headerPhase = await withinBudget(
      (async () => {
        const box = pickStatementBox(describeBoxes((await connection.getBoxes()) as Record<string, unknown>));
        await new Promise<void>((resolve, reject) => {
          connection.imap.openBox(box, true, (err: Error | null) => (err ? reject(err) : resolve()));
        });
        return connection.search(
          [
            ["SINCE", options.since],
            ["BEFORE", options.before],
          ],
          { bodies: ["HEADER"], markSeen: false },
        );
      })(),
      remaining(),
    ).catch(() => null);
    if (!headerPhase || !headerPhase.done) {
      abandoned = headerPhase !== null;
      return { ok: false, code: "MAIL_FETCH_FAILED" };
    }

    const candidates: Array<{ uid: number; date: Date; priority: number }> = [];
    for (const message of headerPhase.value) {
      const part = message.parts.find((p) => p.which === "HEADER");
      if (!part) continue;
      let header = readHeader(part.body);
      if (!header) {
        const parsedHeader = await parseMime(part.body);
        header = { subject: parsedHeader.subject ?? "", from: parsedHeader.from?.text ?? "" };
      }
      if (!isSettlementStatementSubject(header.subject)) continue;
      if (isOwnSenderAddress(header.from, credentials.user)) continue;
      candidates.push({
        uid: message.attributes.uid,
        date: message.attributes.date as Date,
        priority: options.priority({ subject: header.subject, from: header.from }),
      });
    }
    candidates.sort((a, b) => b.priority - a.priority || b.date.getTime() - a.date.getTime());
    const targets = candidates.slice(0, options.maxMessages);
    const truncated = candidates.length - targets.length;
    if (targets.length === 0) return { ok: true, candidates: 0, truncated: 0, timedOut: false, mails: [] };

    const bodyPhase = await withinBudget(fetchBodiesByUid(connection, targets.map((t) => t.uid)), remaining()).catch(() => null);
    if (!bodyPhase) return { ok: false, code: "MAIL_FETCH_FAILED" };
    if (!bodyPhase.done) {
      abandoned = true;
      return { ok: true, candidates: candidates.length, truncated, timedOut: true, mails: [] };
    }

    const mails: StatementAttachmentMail[] = [];
    let timedOut = false;
    for (const target of targets) {
      if (remaining() <= 0) {
        timedOut = true;
        break;
      }
      if (!bodyPhase.value.has(target.uid)) continue;
      const mail = await parseMime(bodyPhase.value.get(target.uid));
      const text = mail.text || (typeof mail.html === "string" ? stripHtml(mail.html) : "");
      const statement = parseSettlementStatement({ subject: mail.subject ?? "", text, ourName: SUPPLIER.name });
      const sheets = (mail.attachments ?? []).filter((a) => isSpreadsheetAttachment(a, options.maxAttachmentBytes));
      const fitting = sheets.filter((a) => Buffer.isBuffer(a.content) && a.content.length <= options.maxAttachmentBytes);
      const receivedAt = mail.date ?? target.date;
      mails.push({
        uid: target.uid,
        messageKey: messageKeyOf(mail.messageId, target.uid, receivedAt),
        receivedAt,
        statement,
        spreadsheets: fitting.map((a) => a.content),
        oversized: sheets.length - fitting.length,
      });
    }
    return { ok: true, candidates: candidates.length, truncated, timedOut, mails };
  } finally {
    // 예산을 넘겨 응답이 아직 오는 중이면 끊고, 아니면 정상 종료.
    if (abandoned) connection.imap.destroy();
    else connection.end();
  }
}
