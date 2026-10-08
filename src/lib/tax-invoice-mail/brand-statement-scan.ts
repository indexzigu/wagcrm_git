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
import imaps from "imap-simple";
import {
  isAllMailbox,
  isOwnSenderAddress,
  resolveImapConfig,
  resolveMailCredentials,
  type MailboxDescriptor,
} from "@/lib/mail-config";
import { SUPPLIER } from "@/lib/tax-invoice-builder";
import { fetchBodiesByUid, parseMime } from "./mail-scan";
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
    return { box, sinceDays, headerScanned: headers.length, candidates: candidates.length, unparsed, statements };
  } finally {
    connection.end();
  }
}
