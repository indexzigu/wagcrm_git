/**
 * 브랜드 정산서 메일 본문 → 「예상 계산서」(T-242). **client-safe 순수 모듈**.
 *
 * 월정산 브랜드는 계산서가 오가기 전에 정산 메일을 먼저 보낸다(메일함 실측 2026-10-08,
 * docs/private/specs/2026-10-08-invoice-mail-engine-facts.md):
 * - 「마감정산서」(표): 「총 매출 9월 1,247,700 <브랜드>」 · 「판매 수수료 9월 561,465 <우리>」 행과
 *   「<지급자> ▶<수령자> 686,235 10월 20일(화)」 대금 행. 작성일 = 그 달 말일(본문이 「말일자로」 요청).
 * - 「자사몰 정산내역서」(평문): 블록마다 「<발행자> → <수령자> 세금계산서 발행일자 : YYYY-MM-DD」 ·
 *   「발행 시 금액(vat포함) : N원」 · 「<지급자> → <수령자> 대금 지급 일자 : YYYY-MM-DD」. 이월분이
 *   있으면 한 메일에 블록이 여러 개다. ⚠️ 발행자 자리에 우리 상호 대신 **공구·셀러 이름**이 적혀 오는
 *   정산서가 있다 — 그것도 우리 계산서다. 브랜드는 셀러와 직접 계산서를 주고받지 않으므로 브랜드 글에서
 *   특정되지 않은 상대는 우리다(오너 확정 2026-10-09, T-250; 종전 「셀러 직접 발행 = null」 해석 폐기).
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
  /**
   * 우리 기준 방향 — 우리가 발행 = ISSUE, 우리가 받음 = RECEIVE, 두 이름 다 우리(상호·공구 이름)가 아니라
   * 판단 불가 = null(평문 형식만 — 표 형식은 발행주체가 우리·별칭이 아니면 브랜드로 보고 RECEIVE).
   * ⛔ null 을 「셀러 직접 발행」으로 읽지 말 것 — 브랜드는 셀러와 직접 계산서를 주고받지 않는다
   * (오너 확정 2026-10-09, T-250).
   */
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

/**
 * 브랜드 글에서 각 이름이 「우리」일 증거. 브랜드는 셀러와 직접 계산서를 주고받지 않으므로, 브랜드가 보낸
 * 글에서 우리 상호도 브랜드도 아닌 이름(공구·셀러 이름)은 우리를 가리킨다(오너 확정 2026-10-09, T-250).
 * 종전에는 그런 줄을 「셀러 직접 발행 = 우리 계산서 아님(direction null)」으로 버렸고, 운영에서 9월분
 * 정산서 한 통이 그렇게 버려져 예상 금액·자동 기록 대상에서 빠진 채 달이 열려 있었다.
 *
 * - sellerMarks: 「○○님」 — 브랜드가 셀러를 부르는 표기. 같은 이름이 「○○ 담당자」로도 나오면(브랜드 담당자)
 *   셀러 표기로 치지 않는다.
 * - bracketPieces: 제목 대괄호 라벨과 `_` 조각(`[우리상사_라마바]`) — 평문 형식의 공구 라벨. 브랜드 이름이
 *   섞여 올 수 있어(`[브랜드_라마바]`) 등급이 낮다.
 * - brandMarks: 제목 대괄호 뒤 첫 낱말(`[총약사] 뉴트리원 자사몰 …`) — 브랜드 자신의 표기. 대괄호 안
 *   이름과 같으면(「[라마바] 라마바 공구 …」) 브랜드가 아니다. 별칭에 섞여도 우리로 읽지 않는다
 *   (스펙 리뷰 2026-10-09: 이 제외가 없으면 양쪽이 별칭이 되어 다시 null).
 */
type AliasEvidence = {
  ourName: string;
  sellerMarks: ReadonlySet<string>;
  bracketPieces: ReadonlySet<string>;
  brandMarks: ReadonlySet<string>;
};

const LABEL_CHARS = "[^\\s[\\]()「」_→▶*]+";

function collectAliasEvidence(input: { subject: string; text: string; ourName: string }): AliasEvidence {
  const sellerMarks = new Set<string>();
  const brandMarks = new Set<string>();
  const bracketPieces = new Set<string>();
  const both = `${input.subject} ${input.text}`;
  const staff = new Set<string>();
  for (const match of both.matchAll(new RegExp(`(${LABEL_CHARS})\\s*담당자`, "g"))) {
    // 「브랜드A님 담당자」는 「님」까지 잡히므로 떼어 낸다.
    const label = normalizeForCompare(match[1].replace(/님$/, ""));
    if (label) staff.add(label);
  }
  for (const match of both.matchAll(new RegExp(`(${LABEL_CHARS})님`, "g"))) {
    const label = normalizeForCompare(match[1]);
    if (label && !staff.has(label)) sellerMarks.add(label);
  }
  const bracket = /\[([^\]]+)\]\s*([^\s[\]()「」_→▶*]+)?/.exec(input.subject);
  if (bracket) {
    // 띄어쓰기가 있는 라벨(「[라마바 공구]」)은 낱말로도 쪼갠다 — 뒤따르는 「라마바」가 브랜드로 오인되지 않게(T-251).
    const pieces = bracket[1].split("_").flatMap((part) => [part, ...part.split(/\s+/)]);
    for (const piece of [bracket[1], ...pieces]) {
      const label = normalizeForCompare(piece.trim());
      if (label) bracketPieces.add(label);
    }
    // 대괄호 뒤 첫 낱말 = 브랜드. 단 대괄호 안 이름과 같으면(「[라마바] 라마바 공구 …」) 브랜드가 아니다.
    const afterBracket = normalizeForCompare(bracket[2] ?? "");
    if (afterBracket && !bracketPieces.has(afterBracket)) brandMarks.add(afterBracket);
  }
  return { ourName: input.ourName, sellerMarks, bracketPieces, brandMarks };
}

/** 이 이름이 우리일 증거 등급 — 3 상호 · 2 「○○님」 · 1 대괄호 조각 · 0 모름 · -1 브랜드 표기(제목 대괄호 뒤 첫 낱말). */
function usScore(label: string, ev: AliasEvidence): number {
  if (isOurs(label, ev.ourName)) return 3;
  const key = normalizeForCompare(label);
  if (ev.brandMarks.has(key)) return -1;
  if (ev.sellerMarks.has(key)) return 2;
  if (ev.bracketPieces.has(key)) return 1;
  return 0;
}

/**
 * 「<발행자> → <수령자>」 한 줄의 방향 — 우리일 증거가 더 강한 쪽이 우리다. 브랜드로 특정된 쪽(-1)이 있으면
 * 나머지 쪽이 우리다(오너 규칙 그대로 — 모르는 이름(0)이어도). 같으면(둘 다 모르는 이름, 둘 다 같은 등급의
 * 별칭) 지어내지 않는다(null). 우리 상호가 적힌 쪽은 어떤 별칭보다 먼저다(코드 리뷰 2026-10-09: 제목
 * 대괄호에 브랜드 이름이 섞여도 「브랜드 → 우리상사」가 뒤집히지 않게).
 */
function resolveDirection(issuer: string, recipient: string, ev: AliasEvidence): InvoiceDirection | null {
  const issuerScore = usScore(issuer, ev);
  const recipientScore = usScore(recipient, ev);
  if (issuerScore > recipientScore && issuerScore >= 0) return "ISSUE";
  if (recipientScore > issuerScore && recipientScore >= 0) return "RECEIVE";
  return null;
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

  const rowRe = /(총\s*매출|판매\s*수수료)\s+(\d{1,2})월\s+([\d,]+)\s+([^\s]+)/g;
  const rows = [...text.matchAll(rowRe)];
  // 이 형식의 별칭은 「○○님」뿐이다(제목 대괄호는 브랜드). 「총 매출」 행의 발행주체는 브랜드이므로 인사말
  // 「브랜드A님」이 브랜드를 별칭으로 만들지 않게 뺀다.
  const evidence = collectAliasEvidence({ subject, text, ourName });
  const brandRows = rows.filter((row) => /총\s*매출/.test(row[1]) && !isOurs(row[4], ourName)).map((row) => normalizeForCompare(row[4]));
  const aliases = new Set([...evidence.sellerMarks].filter((label) => !brandRows.includes(label)));
  const oursOrAlias = (label: string) => isOurs(label, ourName) || aliases.has(normalizeForCompare(label));
  const invoices: StatementInvoice[] = [];
  for (const row of rows) {
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
      direction: oursOrAlias(row[4]) ? "ISSUE" : "RECEIVE",
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
    (payment ? [payment[1], payment[2]].find((label) => !oursOrAlias(label)) ?? null : null);
  return { format: "CLOSING_TABLE", promotionLabel: promotion, counterpartyLabel, subject, invoices };
}

function parseOwnMallNotice(subject: string, text: string, ourName: string): ParsedSettlementStatement | null {
  const issueRe = /([^\s*→]+)\s*→\s*([^\s*→]+)\s*세금계산서\s*발행\s*일자\s*:\s*(\d{4}-\d{2}-\d{2})/g;
  const anchors = [...text.matchAll(issueRe)];
  // 이 형식은 제목 대괄호가 공구·셀러 라벨이다(브랜드 템플릿) — 우리 대신 그 이름이 발행자로 적혀 온다.
  const evidence = collectAliasEvidence({ subject, text, ourName });
  const directionOf = (issuer: string, recipient: string) => resolveDirection(issuer, recipient, evidence);
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
      // 둘 다 우리(상호·공구 이름)가 아니면 지어내지 않는다(null) — 그 줄은 기대치에서 빠지고 화면이 그대로 보인다.
      direction: directionOf(issuer, recipient),
      issuerLabel: issuer,
      writtenDate,
      yearMonth: writtenDate.slice(0, 7),
      totalAmount: total,
      dueDate: due && isValidYmd(due) ? due : null,
    });
  });
  if (invoices.length === 0) return null;
  const promotionLabel = /\[([^\]]+)\]/.exec(subject)?.[1]?.trim() ?? null;
  // 발행 줄 「<발행자> → <수령자>」에서 브랜드 = 우리가 받으면(RECEIVE) 발행자, 그 밖(ISSUE·판단 불가)엔 수령자.
  const first = anchors[0];
  // 방향을 못 읽었으면(null) 수령자가 우리 별칭일 수 있으므로 브랜드를 지어내지 않는다 — 대조하지 않는다(T-251).
  const firstDirection = first ? directionOf(first[1], first[2]) : null;
  const counterpartyLabel = !first || !firstDirection ? null : firstDirection === "RECEIVE" ? first[1] : first[2];
  return { format: "OWN_MALL_NOTICE", promotionLabel, counterpartyLabel, subject, invoices };
}

/**
 * 정산서 메일 한 통을 읽는다. 두 형식 어느 쪽도 아니면 null(조용히 고르지 않는다).
 * `ourName` 은 우리 상호(`SUPPLIER.name`) — 발행자 판정의 1차 키. 상호가 없으면 공구·셀러 이름(별칭,
 * `collectAliasEvidence`)으로 우리를 가린다.
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
