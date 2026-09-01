/**
 * 세금계산서 수취 메일 스캔 — IMAP 부수효과를 이 파일 하나에 가둔다.
 *
 * ## ⚠️ 운영 메일함이다 — 읽기 외의 어떤 흔적도 남기지 않는다
 *
 * - `openBox` 를 **`readOnly=true`** 로 연다. `imap-simple` 의 `openBox` 는 항상 read-write 라
 *   하위 `connection.imap.openBox(name, true, cb)` 를 직접 쓴다.
 * - 모든 fetch 는 `markSeen: false`.
 * - ⛔ `addFlags`·`moveMessage`·`deleteMessage` 를 **부르지 않는다.**
 *   (선례 `order-converter/api/fetch-emails` 는 `\Seen` 을 찍는다 — 그 코드를 복사하지 말 것.)
 *
 * ## 첨부는 국세청 **보안메일 HTML** 이다 (실물 샘플로 확정, 2026-08-04)
 *
 * 표준 XML 이 그 HTML 안에 **암호화돼** 들어 있고, 비밀번호는 우리 사업자등록번호 10자리다.
 * 봉투 해체·복호는 `nts-secure-mail.ts` 가 담당한다.
 *
 * 그래도 **못 읽은 첨부는 버리지 않는다** — 발행처(ASP)마다 형식이 다를 수 있고, 국세청이
 * 형식을 바꿀 수도 있다. 파싱하지 못한 첨부의 파일명·MIME·크기·정체를
 * `unparsedAttachments` 로 실어 보내 관측 가능하게 둔다(P0 No Silent Failure).
 */

import imaps from "imap-simple";
import { simpleParser } from "mailparser";
import { Readable } from "stream";
import { parseEtaxInvoiceXml, type ParsedEtaxInvoice } from "./etax-xml";
import { describeAttachment, type AttachmentKind } from "./attachment-kind";
import { resolveImapConfig, resolveMailCredentials, toNfc } from "@/lib/mail-config";
import {
  isNtsSecureMailHtml,
  parseNtsSecureMailHtml,
  verifyNtsPassword,
  openNtsAttachments,
} from "./nts-secure-mail";

/** 제목으로 후보를 좁히는 힌트. 넓게 잡고 판정은 첨부가 한다. */
const SUBJECT_HINTS = ["세금계산서", "계산서", "전자세금"] as const;

/**
 * ⛔ 제목 힌트만으로 거르면 **국세청이 직접 보내는 발급 안내가 통째로 사라진다.**
 *
 * 실사고(2026-08-05, 오너 제보): 수취가 끝난 계산서가 보드에서 「미수취(스캔에 없음)」로
 * 표시됐다. 원인은 스캔·복호·대조 어디도 아니고 **헤더 단계의 제목 필터**였다 — 국세청
 * 직발송 메일의 실측 제목은 `공급받는자상호 (공급자상호->공급받는자상호)` 형식이라
 * 「계산서」가 한 글자도 없다. 위 힌트는 ASP 발송분(`[전자세금계산서] 발행 안내` 등)만
 * 상정하고 만들어졌다.
 *
 * 발신 도메인은 제목 문구와 달리 발행처 사정으로 바뀌지 않으므로 여기를 두 번째 관문으로
 * 둔다. 판정은 여전히 첨부가 한다 — 이 관문은 **후보를 놓치지 않기 위한 것**이지
 * 통과시키기 위한 것이 아니다.
 */
const SENDER_HINTS = ["hometax.go.kr", "nts.go.kr"] as const;

/**
 * 오너가 실제로 쓰는 전용 편지함 이름(2026-08-03 확인).
 * env 설정 없이도 바로 맞도록 기본값으로 둔다 — 설정을 잊어 INBOX 를 훑는 일이 없게.
 *
 * ℹ️ 구글로 옮긴 뒤에도 **같은 이름 그대로다**(2026-09-01 오너 확인 — Gmail 에 같은 이름의
 * 라벨을 만들고 국세청 메일을 그리로 분류해 뒀다). Gmail 은 라벨을 IMAP 폴더로 노출하므로
 * 아래 정확 일치 규칙이 그대로 맞는다.
 */
const DEFAULT_BOX_NAME = "세금계산서";

/** 위 이름이 안 보일 때(개명·계정 변경) 이 문자열이 든 편지함으로 자동 탐지한다. */
const BOX_NAME_HINT = "계산서";

export interface UnparsedAttachment {
  filename: string | null;
  contentType: string | null;
  size: number | null;
  /** 매직바이트로 판별한 정체(내용은 해석하지 않는다) */
  kind: AttachmentKind;
  /** 열려면 비밀번호가 필요해 보이는가 — 오너 확인: 통상 우리 사업자번호를 쓴다 */
  passwordSuspected: boolean;
}

export interface ScannedTaxMail {
  uid: number;
  box: string;
  /** ⚠️ 셀러 상호가 들어올 수 있다 — 로그·추적 파일에 남기지 말 것(P0). */
  subject: string;
  fromAddress: string;
  receivedAt: string;
  /** 표준 XML 첨부 파싱 결과. 없으면 폴백 경로다. */
  parsed: ParsedEtaxInvoice | null;
  /** 계산서로 해석하지 못한 첨부들 — 형식 조사의 원천 */
  unparsedAttachments: UnparsedAttachment[];
}

export interface ScanTaxMailOptions {
  /**
   * 국세청 보안메일 첨부를 여는 비밀번호 = **우리 사업자등록번호 10자리**(헤더 HintKey 가 명시).
   * 호출부가 `SUPPLIER.businessNumber` 를 넘긴다 — 이 모듈이 상수를 직접 import 하지 않는 이유는
   * 순수 스캔 계층을 도메인 상수에 묶지 않기 위해서다.
   */
  invoicePassword: string;
  /** 조회 창(일). 기본 90일. */
  sinceDays?: number;
  /** 편지함 이름. 미지정이면 env → 자동탐지 → INBOX 순. */
  boxName?: string;
  /**
   * 본문 다운로드 상한(과다 egress·시간 방지).
   *
   * ⚠️ 종전 기본값 80 은 **관문이 고장 나 있던 시절의 수치**다 — 제목 힌트만 쓰던
   * 때는 후보가 20여 통뿐이라 80 이 넉넉해 보였다. 발신처 관문을 열자 실메일함 1년치
   * 후보가 그 상한을 넘겼고, 그대로 뒀으면 잘린 통수만큼 조용히 「미수취」가 됐을 것이다
   * (`truncated` 로 표면화되긴 하지만, 애초에 안 잘리는 게 맞다).
   */
  maxMessages?: number;
}

export interface ScanTaxMailResult {
  box: string;
  /** 헤더까지 훑은 통수 */
  headerScanned: number;
  /** 제목·발신처 관문을 통과한 후보 수 */
  candidates: number;
  /**
   * 편지함에 있었지만 관문에서 걸러 **본문을 열지도 않은** 통수.
   *
   * 위 실사고가 조용했던 이유가 이 수치의 부재다 — 걸러진 메일은 아무 흔적도 남기지
   * 않아, 화면은 "폴더를 다 봤는데 없다"와 "필터가 먼저 버렸다"를 구분할 수 없었다.
   * 전용 폴더에서 이 값이 크면 관문이 무언가를 계속 놓치고 있다는 신호다.
   */
  skippedByFilter: number;
  /** 상한에 걸려 본문을 못 읽은 수. 0 이 아니면 화면이 "전부 봤다"고 말하면 안 된다. */
  truncated: number;
  mails: ScannedTaxMail[];
}

function toBuffer(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) return body;
  return Buffer.from(String(body ?? ""), "utf8");
}

async function parseMime(body: unknown) {
  const stream = new Readable();
  stream.push(toBuffer(body));
  stream.push(null);
  return simpleParser(stream);
}

/** 편지함 트리를 평탄화한다. */
function flattenBoxes(boxes: Record<string, unknown>, prefix = ""): string[] {
  const names: string[] = [];
  for (const key of Object.keys(boxes)) {
    const node = boxes[key] as { children?: Record<string, unknown>; delimiter?: string };
    const full = prefix + key;
    names.push(full);
    if (node?.children) {
      names.push(...flattenBoxes(node.children, full + (node.delimiter ?? "/")));
    }
  }
  return names;
}

/**
 * 세금계산서 전용 편지함을 고른다.
 * 오너가 같은 계정에서 세금계산서 메일을 **전용 폴더로 분리 관리**하고 있으므로,
 * INBOX 전수 스캔이 아니라 그 폴더만 여는 것이 기본이다(비용·오탐 모두 줄어든다).
 *
 * ⚠️ 돌려주는 값은 **서버가 준 원문 이름**이다(정규화한 값이 아니다) — `openBox` 는 서버
 * 어휘로 열어야 하므로, 비교만 정규화하고 반환은 원문을 유지한다.
 */
export function pickTaxInvoiceBox(boxNames: readonly string[], configured?: string | null): string {
  const want = configured ? toNfc(configured) : null;
  if (want) {
    const exact = boxNames.find((name) => toNfc(name) === want);
    if (exact) return exact;
  }
  // 정확 일치를 부분 일치보다 먼저 본다 — '계산서' 가 든 폴더가 둘 이상이면(예: '세금계산서
  // 보관', '계산서_2025') 부분 일치는 어느 것을 집을지가 편지함 나열 순서에 좌우된다.
  const fallbackExact = boxNames.find(
    (name) => toNfc(name) === DEFAULT_BOX_NAME,
  );
  if (fallbackExact) return fallbackExact;
  const hinted = boxNames.find((name) =>
    toNfc(name).includes(BOX_NAME_HINT),
  );
  return hinted ?? "INBOX";
}

/**
 * ⚠️ **제목도 정규화하고 비교한다.** 편지함 이름과 같은 축이고(위 `toNfc`), 이쪽은 형태를
 * 구글이 아니라 **보낸 사람**이 정하므로 실측으로 미리 걸러낼 수도 없다. 놓쳤을 때의 대가가
 * 조용한 「미수취」라 비대칭이다 — 2026-08-05 실사고가 정확히 이 관문의 실패였다.
 */
export function isTaxInvoiceSubject(subject: string): boolean {
  const normalized = toNfc(subject);
  return SUBJECT_HINTS.some((hint) => normalized.includes(hint));
}

/** 국세청 직발송인가. 헤더의 `From` 원문(표시이름 + 주소)을 그대로 받는다. */
export function isTaxInvoiceSender(from: string): boolean {
  const lowered = from.toLowerCase();
  return SENDER_HINTS.some((hint) => lowered.includes(hint));
}

/**
 * 이 메일을 본문까지 열어 볼 후보로 삼을 것인가.
 * 제목 **또는** 발신처 중 하나만 맞아도 후보다 — 어느 한쪽이 형식을 바꿔도 살아남게.
 */
export function isTaxInvoiceCandidate(subject: string, from: string): boolean {
  return isTaxInvoiceSubject(subject) || isTaxInvoiceSender(from);
}

/**
 * 전용 편지함을 읽기 전용으로 스캔해 계산서 후보를 돌려준다.
 *
 * 자격증명은 기존 발주서 경로와 **같은 계정·같은 변수**(`SMTP_USER`/`SMTP_PASS`)를 쓴다 —
 * 신규 의존성도 신규 인증도 없다. 접속할 서버는 `src/lib/mail-config.ts` 가 소유한다
 * (⛔ 여기에 호스트를 다시 적지 말 것 — 세 소비처가 갈라져 계정 이전이 반쪽이 된다).
 */
export async function scanTaxInvoiceMails(
  options: ScanTaxMailOptions,
): Promise<ScanTaxMailResult> {
  const { sinceDays = 90, maxMessages = 400, invoicePassword } = options;

  const credentials = resolveMailCredentials();
  if (!credentials) {
    throw new Error("메일 서버(IMAP) 연동 정보가 설정되어 있지 않습니다.");
  }

  const connection = await imaps.connect({
    imap: resolveImapConfig(credentials, { authTimeout: 10_000 }),
  });

  try {
    const boxes = await connection.getBoxes();
    const boxName = pickTaxInvoiceBox(
      flattenBoxes(boxes as Record<string, unknown>),
      options.boxName ?? process.env.TAX_INVOICE_MAIL_BOX ?? null,
    );

    // ★ read-only. imap-simple 의 openBox 는 rw 로만 열기 때문에 하위 imap 을 직접 쓴다.
    await new Promise<void>((resolve, reject) => {
      connection.imap.openBox(boxName, true, (err: Error | null) =>
        err ? reject(err) : resolve(),
      );
    });

    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const headers = await connection.search([["SINCE", since]], {
      bodies: ["HEADER"],
      markSeen: false,
      struct: true,
    });

    const candidates: { uid: number; subject: string; from: string; date: Date }[] = [];
    let skippedByFilter = 0;
    for (const message of headers) {
      const headerPart = message.parts.find((part) => part.which === "HEADER");
      if (!headerPart) continue;

      let subject = "";
      let from = "";
      const body = headerPart.body as unknown;
      if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
        const record = body as Record<string, string[] | undefined>;
        subject = record.subject?.[0] ?? record.Subject?.[0] ?? "";
        from = record.from?.[0] ?? record.From?.[0] ?? "";
      } else {
        const parsedHeader = await parseMime(body);
        subject = parsedHeader.subject ?? "";
        from = parsedHeader.from?.text ?? "";
      }

      if (isTaxInvoiceCandidate(subject, from)) {
        candidates.push({
          uid: message.attributes.uid,
          subject,
          from,
          date: message.attributes.date as Date,
        });
      } else {
        skippedByFilter += 1;
      }
    }

    candidates.sort((a, b) => b.date.getTime() - a.date.getTime());
    const targets = candidates.slice(0, maxMessages);

    const mails: ScannedTaxMail[] = [];
    for (const candidate of targets) {
      const full = await connection.search([["UID", candidate.uid]], {
        bodies: [""],
        markSeen: false,
      });
      const whole = full?.[0]?.parts.find((part) => part.which === "");
      if (!whole) continue;

      const parsedMail = await parseMime(whole.body);
      let parsed: ParsedEtaxInvoice | null = null;
      const unparsed: UnparsedAttachment[] = [];

      for (const attachment of parsedMail.attachments ?? []) {
        const filename = attachment.filename ?? null;
        const content = toBuffer(attachment.content);

        // ① 국세청 보안메일 HTML — **실측상 이게 주 경로다**. 표준 XML 이 이 안에 암호화돼
        //    들어 있고, 비밀번호는 우리 사업자등록번호다.
        const asText = content.toString("utf8");
        if (isNtsSecureMailHtml(asText)) {
          const envelope = parseNtsSecureMailHtml(asText);
          if (envelope) {
            const passwordOk = verifyNtsPassword(envelope, invoicePassword);
            if (passwordOk) {
              try {
                for (const opened of openNtsAttachments(envelope, invoicePassword)) {
                  const inner = parseEtaxInvoiceXml(opened.content);
                  if (inner && !parsed) {
                    parsed = inner;
                    break;
                  }
                }
              } catch (error) {
                // 삼키지 않는다 — 복호 실패는 관측 가치가 있다(형식 변경 신호).
                console.warn("[tax-invoice-mail] 보안메일 복호 실패:", (error as Error).message);
              }
            }
            if (!parsed) {
              unparsed.push({
                filename,
                contentType: attachment.contentType ?? null,
                size: typeof attachment.size === "number" ? attachment.size : null,
                kind: "NTS_SECURE_MAIL_HTML",
                // 비밀번호가 안 맞으면 우리 앞 계산서가 아닐 가능성이 크다(다른 사업자 앞).
                passwordSuspected: !passwordOk,
              });
            }
            continue;
          }
        }

        // ② 평문 표준 XML. 파일명·MIME 을 게이트로 쓰지 않는다 — 발행처가 XML 을
        //    octet-stream 으로 붙이면 표준 첨부를 통째로 놓친다.
        const candidateParsed = parseEtaxInvoiceXml(content);
        if (candidateParsed && !parsed) {
          parsed = candidateParsed;
          continue;
        }

        const described = describeAttachment(content, filename, candidateParsed !== null);
        unparsed.push({
          filename,
          contentType: attachment.contentType ?? null,
          size: typeof attachment.size === "number" ? attachment.size : null,
          kind: described.kind,
          passwordSuspected: described.passwordSuspected,
        });
      }

      mails.push({
        uid: candidate.uid,
        box: boxName,
        subject: candidate.subject,
        fromAddress: candidate.from,
        receivedAt: candidate.date.toISOString(),
        parsed,
        unparsedAttachments: unparsed,
      });
    }

    return {
      box: boxName,
      headerScanned: headers.length,
      candidates: candidates.length,
      skippedByFilter,
      truncated: Math.max(0, candidates.length - targets.length),
      mails,
    };
  } finally {
    connection.end();
  }
}
