// 송장 회신 메일 매칭 SSOT — 「이 메일이 이 주문캠페인의 송장 회신인가」의 규칙을 한 곳에 둔다.
//
// 소비처 둘이 같은 규칙을 쓴다:
//  · 수동 버튼 `order-converter/api/fetch-emails`(송장회신 — 찾으면 첨부를 돌려주고 읽음 처리)
//  · 크론 `api/cron/scan-invoice-replies`(감지만 — **읽기 전용**, 흔적을 남기지 않는다)
// 규칙이 라우트 안에 인라인으로 있던 것을 그대로 옮겼다. ⛔ 크론 쪽에 사본을 다시 만들지 말 것 —
// 한쪽만 고치면 「버튼은 찾는데 크론은 못 본다(또는 그 반대)」가 조용히 생긴다.
//
// 메일 서버 좌표·편지함 순회 정책은 `src/lib/mail-config.ts` 소관이고(⛔ 여기서 호스트·편지함
// 이름을 다시 적지 말 것), 한국어 비교 정규화는 `src/lib/text-normalize.ts` 소관이다.

import type { ImapSimple } from 'imap-simple';
import { simpleParser, type ParsedMail } from 'mailparser';
import { Readable } from 'stream';
import { isOwnSenderAddress, orderMailboxesForScan, type MailboxDescriptor } from '@/lib/mail-config';
import { normalizeForCompare } from '@/lib/text-normalize';
import { resolveReplyRule, type OrderBrand } from './order-brand';
import { extractTrackingMapByReply, type TrackingData } from './order-parser';

/** 회신을 찾는 메일 조회 창(일). 수동 버튼과 크론이 같은 값을 쓴다. */
export const REPLY_SCAN_WINDOW_DAYS = 7;

/** 발주 메일 본문에 숨겨 보내는 캠페인 태그의 여는 부분. */
export const REPLY_REF_TAG_OPEN = '[YGRD-REF:';

/** 이 캠페인의 태그 접두(닫는 `]` 앞의 `|…` 꼬리는 비교하지 않는다). */
export function replyRefTagPrefix(campaignId: string | null | undefined): string {
  return `${REPLY_REF_TAG_OPEN}${campaignId}`;
}

/**
 * 헤더 조회 옵션 — `markSeen:false` 라 node-imap 이 `BODY.PEEK[HEADER]` 로 요청한다(읽음 표시 없음).
 * 호출마다 새 객체를 준다(라이브러리가 옵션을 건드려도 다음 호출에 새지 않게).
 */
export function replyHeaderFetchOptions(): { bodies: string[]; markSeen: false; struct: true } {
  return { bodies: ['HEADER'], markSeen: false, struct: true };
}

export function replyScanSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - REPLY_SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** 이 캠페인 태그가 본문에 든 메일을 서버에서 고속 검색하는 조건. */
export function replyTagSearchCriteria(campaignId: string | null | undefined, since: Date): unknown[] {
  return [['SINCE', since], ['BODY', replyRefTagPrefix(campaignId)]];
}

/**
 * 캠페인을 가리지 않고 **우리 태그가 든** 메일을 찾는 조건 — 여러 캠페인을 한 번에 보는 크론용.
 * 캠페인 구분은 본문 단계(`pickReplyAttachment`)가 같은 규칙으로 한다.
 */
export function replyAnyTagSearchCriteria(since: Date): unknown[] {
  return [['SINCE', since], ['BODY', REPLY_REF_TAG_OPEN]];
}

/** 조회 창 안의 전 메일 헤더 검색 조건(제목·발신자 매칭용). */
export function replyHeaderSearchCriteria(since: Date): unknown[] {
  return [['SINCE', since]];
}

export interface ReplyMatchCriteria {
  campaignId: string | null | undefined;
  /** 허용 발신 도메인(`@a.example.com` 꼴). 비면 도메인 조건을 걸지 않는다(종전 동작). */
  allowedDomains: string[];
  /** 셀러명 핵심부(괄호 앞, 공백 제거). */
  coreSellerName: string;
  /** 발주 요청일 YYMMDD 목록(`deriveReplySentDates`). 비거나 없으면 날짜 조건 통과. */
  sentDates: readonly string[] | null | undefined;
}

/**
 * 매칭 기준. 허용 도메인 = 거래처 설정(F4-②) + 발주서 수신 주소의 도메인.
 */
export function buildReplyMatchCriteria(input: {
  campaignId?: string | null;
  brandEmailDomains?: readonly string[] | null;
  toEmail?: string | null;
  sellerName?: string | null;
  sentDates?: readonly string[] | null;
}): ReplyMatchCriteria {
  const allowedDomains: string[] = [...(input.brandEmailDomains ?? [])];
  if (input.toEmail) {
    for (const email of input.toEmail.split(',').map((e) => e.trim())) {
      const parts = email.split('@');
      if (parts.length === 2) {
        const domain = '@' + parts[1];
        if (!allowedDomains.includes(domain)) allowedDomains.push(domain);
      }
    }
  }
  const sellerName = input.sellerName ?? '';
  const coreSellerName = sellerName ? sellerName.split('(')[0].trim().replace(/\s+/g, '') : '';
  return { campaignId: input.campaignId, allowedDomains, coreSellerName, sentDates: input.sentDates };
}

export interface ReplyHeader {
  uid: number;
  date: Date | null;
  subject: string;
  fromAddress: string;
  /** `Message-ID` 헤더. 없으면 null — 크론이 편지함#UID 로 대체한다. */
  messageId: string | null;
}

type HeaderMessage = {
  attributes: { uid: number; date?: Date };
  parts: Array<{ which: string; body: unknown }>;
};

/** 헤더 조회 결과 1건을 읽는다. 헤더 파트가 없으면 null. */
export async function readReplyHeader(message: HeaderMessage): Promise<ReplyHeader | null> {
  const headerPart = message.parts.find((part) => part.which === 'HEADER');
  if (!headerPart) return null;

  let subject = '';
  let fromAddress = '';
  let messageId: string | null = null;

  const body = headerPart.body as unknown;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    const record = body as Record<string, string[] | undefined>;
    subject = record.subject?.[0] || record.Subject?.[0] || '';
    fromAddress = record.from?.[0] || record.From?.[0] || '';
    messageId = record['message-id']?.[0] || record['Message-ID']?.[0] || null;
  } else {
    const parsedHeader = await parseMailBody(body);
    fromAddress = parsedHeader.from?.value[0]?.address || '';
    subject = parsedHeader.subject || '';
    messageId = parsedHeader.messageId || null;
  }

  const date = message.attributes.date instanceof Date ? message.attributes.date : null;
  return { uid: message.attributes.uid, date, subject, fromAddress, messageId: messageId?.trim() || null };
}

/**
 * 헤더 단계 후보 판정 — 본문을 받아 볼 가치가 있는가.
 *
 * 후보 = 우리가 보낸 메일이 아니고, (허용 도메인 발신 이거나 제목 점수 2↑) 이거나 서버 태그 검색에
 * 걸렸다. 제목 점수 = 회사명 · 셀러명 · 발주 요청일 중 몇 개가 제목에 있나.
 */
export function isReplyHeaderCandidate(
  header: { subject: string; fromAddress: string },
  criteria: ReplyMatchCriteria,
  options: { loginUser: string; taggedInImap: boolean },
): boolean {
  const { subject, fromAddress } = header;

  let domainMatched = criteria.allowedDomains.length === 0;
  if (!domainMatched) {
    domainMatched = criteria.allowedDomains.some((domain) => fromAddress.toLowerCase().includes(domain.toLowerCase()));
  }

  // ⚠️ 한글은 **비교 전에 정규화한다**(`text-normalize` 주석 참조) — 제목의 형태는
  //    보낸 사람이 정하므로, 안 맞추면 눈에 같은 글자가 조용히 안 걸린다.
  const normalizedSubject = normalizeForCompare(subject);
  const hasOurCompanyName = normalizedSubject.includes('와이그라운드');
  const hasSeller = criteria.coreSellerName && normalizedSubject.includes(normalizeForCompare(criteria.coreSellerName));

  let hasSentDate = false;
  if (criteria.sentDates && criteria.sentDates.length > 0) {
    hasSentDate = criteria.sentDates.some((dateStr) => {
      const shortDate = dateStr.length === 6 ? dateStr.substring(2) : dateStr;
      return normalizedSubject.includes(dateStr) || normalizedSubject.includes(shortDate);
    });
  } else {
    hasSentDate = true;
  }

  const matchScore = (hasOurCompanyName ? 1 : 0) + (hasSeller ? 1 : 0) + (hasSentDate ? 1 : 0);

  // 내가 발송한 메일(원본)은 제외 — 판정은 `mail-config` 가 소유한다
  // (자사 도메인 · 로그인 계정 · 옛 사업자 계정 세 갈래. 사유는 그 함수 주석).
  const isMyOwnMail = isOwnSenderAddress(fromAddress, options.loginUser);
  const subjectMatched = !isMyOwnMail && (domainMatched || matchScore >= 2);
  const hasTagInImap = options.taggedInImap && !isMyOwnMail;
  return subjectMatched || hasTagInImap;
}

export interface ReplyAttachment {
  filename?: string;
  content: Buffer;
}

export type ReplyBodyVerdict =
  | { kind: 'other-campaign' }
  | { kind: 'no-attachment' }
  | { kind: 'match'; attachment: ReplyAttachment; hasMyRefTag: boolean };

/**
 * 본문 단계 판정 — 이 메일의 첨부 중 회신 엑셀을 고른다.
 *
 * - 본문에 다른 캠페인 태그만 있으면 다른 상품의 회신이다(건너뜀).
 * - 첨부는 xlsx/xls/csv 이고 파일명에 셀러명이 있어야 한다 — 단 이 캠페인 태그가 있으면 양식이
 *   달라도 받는다.
 */
export function pickReplyAttachment(
  parsed: { text?: string | null; html?: string | false | null; attachments?: readonly ReplyAttachment[] },
  criteria: ReplyMatchCriteria,
): ReplyBodyVerdict {
  const textBody = parsed.text || '';
  const htmlBody = parsed.html || '';
  const refTagPrefix = replyRefTagPrefix(criteria.campaignId);
  const containsAnyRefTag = textBody.includes(REPLY_REF_TAG_OPEN) || htmlBody.includes(REPLY_REF_TAG_OPEN);
  const hasMyRefTag = textBody.includes(refTagPrefix) || htmlBody.includes(refTagPrefix);

  if (containsAnyRefTag && !hasMyRefTag) return { kind: 'other-campaign' };

  for (const attachment of parsed.attachments ?? []) {
    const fileName = attachment.filename || '';
    // ⚠️ 맥에서 온 첨부는 **파일명이 NFD 인 것이 상시 조건**이라 여기가 특히 위험하다.
    const normalizedFilename = normalizeForCompare(fileName);
    const isExcelOrCsv = fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.csv');
    const hasSellerName = criteria.coreSellerName
      ? normalizedFilename.includes(normalizeForCompare(criteria.coreSellerName))
      : true;
    if (isExcelOrCsv && (hasSellerName || hasMyRefTag)) {
      return { kind: 'match', attachment, hasMyRefTag };
    }
  }
  return { kind: 'no-attachment' };
}

/** 원문(헤더 또는 전체 MIME)을 파싱한다. */
export async function parseMailBody(raw: unknown): Promise<ParsedMail> {
  let buffer = raw;
  if (typeof buffer === 'string') buffer = Buffer.from(buffer, 'utf8');
  const stream = new Readable();
  stream.push(buffer as Buffer);
  stream.push(null);
  return simpleParser(stream);
}

/**
 * 회신 엑셀 → 주문번호별 송장. 브랜드 회신 규칙(F4 Phase 2 §5단계)으로 서버가 파싱한다.
 * 실패하면 throw — 호출부가 삼키지 말고 처분한다.
 */
export function parseReplyTracking(content: Buffer, brand: OrderBrand | null): Record<string, TrackingData> {
  const reply = resolveReplyRule(brand);
  // Buffer → ArrayBuffer 뷰. 정확한 바이트 범위만 전달.
  const ab = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  return extractTrackingMapByReply(ab, reply);
}

/**
 * 편지함 전수 나열 → 제외·순서는 `mail-config` 가 판정한다.
 * ⛔ 여기서 이름 목록을 다시 만들지 말 것: 종전 인라인 목록은 다음메일의 **띄어쓴** 한국어
 *    이름만 알고 있어서 구글의 `휴지통`·`보낸편지함`·`전체보관함` 이 하나도 안 걸렸다.
 */
export async function listReplyMailboxes(connection: Pick<ImapSimple, 'getBoxes'>): Promise<string[]> {
  const boxesInfo = await connection.getBoxes();
  const discovered: MailboxDescriptor[] = [];
  const extractBoxes = (boxObj: any, prefix = '') => {
    for (const key of Object.keys(boxObj)) {
      const boxName = prefix + key;
      discovered.push({ name: boxName, attribs: boxObj[key]?.attribs ?? [] });
      if (boxObj[key].children) {
        extractBoxes(boxObj[key].children, boxName + boxObj[key].delimiter);
      }
    }
  };
  extractBoxes(boxesInfo);
  return orderMailboxesForScan(discovered);
}
