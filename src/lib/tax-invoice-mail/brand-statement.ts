/**
 * 브랜드 정산서 메일 본문 → 「예상 계산서」(T-242). **client-safe 순수 모듈**.
 *
 * 월정산 브랜드는 계산서가 오가기 전에 정산 메일을 먼저 보낸다(메일함 실측 2026-10-08,
 * docs/private/specs/2026-10-08-invoice-mail-engine-facts.md):
 * - 「마감정산서」(표): 「총 매출 9월 1,247,700 <브랜드>」 · 「판매 수수료 9월 561,465 <우리>」 행과
 *   「<지급자> ▶<수령자> 686,235 10월 20일(화)」 대금 행. 작성일 = 그 달 말일(본문이 「말일자로」 요청).
 * - 「자사몰 정산내역서」(평문): 블록마다 「<발행자> → <수령자> 세금계산서 발행일자 : YYYY-MM-DD」 ·
 *   「발행 시 금액(vat포함) : N원」 · 「<지급자> → <수령자> 대금 지급 일자 : YYYY-MM-DD」. 이월분이
 *   있으면 한 메일에 블록이 여러 개다. ⚠️ 발행자가 **셀러 본인**인 정산서도 온다 — 그 계산서는 우리
 *   것이 아니다(`direction: null`).
 *
 * 첨부(xlsx)는 읽지 않는다 — 비밀번호가 걸린 경우가 있어 본문이 유일한 공통 경로다.
 * 금액은 VAT 포함(두 형식 모두 「vat포함」 합계와 일치함을 실측으로 확인).
 *
 * ⛔ 이 값은 **기대치**다. 계산서 기록의 근거는 여전히 발급 메일(승인번호)이고, 정산서는 「어느
 * 메일이 이 캠페인 것인가」를 금액으로 가르는 데만 쓴다(`campaign-invoices.ts`).
 * ⛔ 정산서 본문에는 셀러 실명·매출이 들어 있다 — 로그·커밋·PR 에 남기지 말 것(P0).
 */
import type { InvoiceDirection } from "../campaign-invoices";
import { normalizeForCompare, toNfc } from "../text-normalize";

export type StatementFormat = "CLOSING_TABLE" | "OWN_MALL_NOTICE";

/** 정산서가 예고한 계산서 한 장. */
export type StatementInvoice = {
  /** 우리 기준 방향 — 우리가 발행 = ISSUE, 우리가 받음 = RECEIVE, 우리와 무관(셀러 직접 발행) = null */
  direction: InvoiceDirection | null;
  issuerLabel: string;
  /** 작성일(KST "YYYY-MM-DD") — 「몇 월분」은 이 날의 달이다(오너 확정 2026-10-08) */
  writtenDate: string;
  yearMonth: string;
  /** VAT 포함 합계 */
  totalAmount: number;
  /** 대금 지급 예정일 — 못 읽었으면 null */
  dueDate: string | null;
};

export type ParsedSettlementStatement = {
  format: StatementFormat;
  /** 프로모션명(표) 또는 제목의 대괄호 라벨(평문) — 캠페인 대조에 쓴다 */
  promotionLabel: string | null;
  /**
   * 정산서를 보낸 브랜드(우리 거래 상대) 표기 — 표는 우리 아닌 발행 주체·대금 당사자, 평문은 발행 줄의
   * 우리 아닌 쪽. 같은 셀러가 다른 브랜드와도 공구하므로 셀러 이름만으로 대조하면 남의 정산서가 붙는다
   * (코드 리뷰 2026-10-09). 못 읽으면 null — 대조하지 않는다.
   */
  counterpartyLabel: string | null;
  subject: string;
  invoices: StatementInvoice[];
};

/** 정산서 메일일 수 있는 제목인가 — 본문을 받기 전 헤더 단계 거름망. */
export function isSettlementStatementSubject(subject: string): boolean {
  const text = normalizeForCompare(subject);
  return text.includes("정산서") || text.includes("정산내역서");
}

function flatten(text: string): string {
  return toNfc(text).replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function toAmount(raw: string): number | null {
  const value = Number(raw.replace(/,/g, ""));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function lastDayOfMonth(year: number, month: number): string {
  // Date.UTC 의 일 0 = 앞 달 말일.
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function isValidYmd(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isOurs(label: string, ourName: string): boolean {
  const ours = normalizeForCompare(ourName);
  return ours.length > 0 && normalizeForCompare(label).includes(ours);
}

/** 「26년 9월」 → { year: 2026, month: 9 }. 제목을 먼저 보고 없으면 본문. */
function findHeaderYearMonth(...texts: string[]): { year: number; month: number } | null {
  for (const text of texts) {
    const match = /(\d{2})년\s*(\d{1,2})월/.exec(text);
    if (!match) continue;
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) return { year: 2000 + Number(match[1]), month };
  }
  return null;
}

function parseClosingTable(subject: string, text: string, ourName: string): ParsedSettlementStatement | null {
  const header = findHeaderYearMonth(subject, text);
  if (!header) return null;
  const promotion = /프로모션명\s+(.+?)\s+세금계산서\s*발행/.exec(text)?.[1]?.trim() ?? null;

  // 대금 행: 「<지급자> ▶<수령자> 686,235 10월 20일」
  const payment = /([^\s▶]+)\s*▶\s*([^\s▶]+)\s+([\d,]+)\s+(\d{1,2})월\s*(\d{1,2})일/.exec(text);

  const invoices: StatementInvoice[] = [];
  const rowRe = /(총\s*매출|판매\s*수수료)\s+(\d{1,2})월\s+([\d,]+)\s+([^\s]+)/g;
  for (const row of text.matchAll(rowRe)) {
    const month = Number(row[2]);
    const amount = toAmount(row[3]);
    if (month < 1 || month > 12 || amount === null) continue;
    // 머리글은 「26년 9월」처럼 그 정산의 달을 말한다. 행의 달이 머리글 달보다 뒤면 작년 것이다
    // (「26년 1월」 정산서의 「12월」 행 = 2025-12).
    const year = month > header.month ? header.year - 1 : header.year;
    const writtenDate = lastDayOfMonth(year, month);
    let dueDate: string | null = null;
    if (payment) {
      const dueMonth = Number(payment[4]);
      const dueYear = dueMonth < month ? year + 1 : year;
      const candidate = `${dueYear}-${pad2(dueMonth)}-${pad2(Number(payment[5]))}`;
      dueDate = isValidYmd(candidate) ? candidate : null;
    }
    invoices.push({
      direction: isOurs(row[4], ourName) ? "ISSUE" : "RECEIVE",
      issuerLabel: row[4],
      writtenDate,
      yearMonth: writtenDate.slice(0, 7),
      totalAmount: amount,
      dueDate,
    });
  }
  if (invoices.length === 0) return null;
  const counterpartyLabel =
    invoices.find((invoice) => invoice.direction === "RECEIVE")?.issuerLabel ??
    (payment ? [payment[1], payment[2]].find((label) => !isOurs(label, ourName)) ?? null : null);
  return { format: "CLOSING_TABLE", promotionLabel: promotion, counterpartyLabel, subject, invoices };
}

function parseOwnMallNotice(subject: string, text: string, ourName: string): ParsedSettlementStatement | null {
  const issueRe = /([^\s*→]+)\s*→\s*([^\s*→]+)\s*세금계산서\s*발행\s*일자\s*:\s*(\d{4}-\d{2}-\d{2})/g;
  const anchors = [...text.matchAll(issueRe)];
  const invoices: StatementInvoice[] = [];
  anchors.forEach((anchor, index) => {
    const start = anchor.index ?? 0;
    const end = index + 1 < anchors.length ? (anchors[index + 1].index ?? text.length) : text.length;
    const block = text.slice(start, end);
    const writtenDate = anchor[3];
    const amount = /발행\s*시\s*금액\s*\(\s*vat\s*포함\s*\)\s*:\s*([\d,]+)\s*원/i.exec(block);
    const total = amount ? toAmount(amount[1]) : null;
    if (!isValidYmd(writtenDate) || total === null) return;
    const due = /대금\s*지급\s*일자\s*:\s*(\d{4}-\d{2}-\d{2})/.exec(block)?.[1] ?? null;
    const issuer = anchor[1];
    const recipient = anchor[2];
    invoices.push({
      direction: isOurs(issuer, ourName) ? "ISSUE" : isOurs(recipient, ourName) ? "RECEIVE" : null,
      issuerLabel: issuer,
      writtenDate,
      yearMonth: writtenDate.slice(0, 7),
      totalAmount: total,
      dueDate: due && isValidYmd(due) ? due : null,
    });
  });
  if (invoices.length === 0) return null;
  const promotionLabel = /\[([^\]]+)\]/.exec(subject)?.[1]?.trim() ?? null;
  // 발행 줄 「<발행자> → <수령자>」에서 브랜드 = 우리가 받으면 발행자, 그 밖(우리·셀러가 발행)엔 수령자.
  const first = anchors[0];
  const counterpartyLabel = first ? (isOurs(first[2], ourName) ? first[1] : first[2]) : null;
  return { format: "OWN_MALL_NOTICE", promotionLabel, counterpartyLabel, subject, invoices };
}

/**
 * 정산서 메일 한 통을 읽는다. 두 형식 어느 쪽도 아니면 null(조용히 고르지 않는다).
 * `ourName` 은 우리 상호(`SUPPLIER.name`) — 발행자가 우리인지 가르는 유일한 키다.
 */
export function parseSettlementStatement(input: {
  subject: string;
  text: string;
  ourName: string;
}): ParsedSettlementStatement | null {
  const subject = flatten(input.subject);
  const text = flatten(input.text);
  if (/최종\s*정산금/.test(text) && /발행\s*주체/.test(text)) {
    return parseClosingTable(subject, text, input.ourName);
  }
  if (/세금계산서\s*발행\s*일자\s*:/.test(text)) {
    return parseOwnMallNotice(subject, text, input.ourName);
  }
  return null;
}
