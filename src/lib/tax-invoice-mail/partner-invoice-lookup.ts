/**
 * 거래처 등록 기안을 위한 **계산서 찾기** — 순수 함수(메일함 접속은 호출부가 한다).
 *
 * 무엇인가: 결재함의 「거래처 등록」 기안 하나를 놓고, 메일함에서 읽은 계산서 중 그 거래처와
 * 주고받은 것을 골라 사업자 정보(대표자·주소·업태·종목·이메일, 필요하면 사업자번호)를 모은다.
 * 채울지 말지는 `lib/agent/partner-enrichment.ts` 가 정한다 — 여기는 「찾은 값」만 낸다.
 *
 * 거래 상대 = 계산서의 두 당사자 중 **우리가 아닌 쪽**이다. 공급사가 우리에게 끊은 계산서면
 * 공급자, 우리가 브랜드사에 끊은 계산서(월정산 브랜드몰 등)면 공급받는자다. 둘 다 우리가
 * 아니면 우리 계산서가 아니므로 버린다.
 *
 * 찾는 순서:
 * 1. 기안에 사업자번호가 있으면 **사업자번호로만** 찾는다. 상호로 넓히지 않는다 — 번호가 있는데
 *    상호가 같은 다른 사업자를 붙이는 것이 가장 나쁜 결과다.
 * 2. 없으면 상호로 찾는다. 법인 표기(「(주)」·「주식회사」 등)와 공백·대소문자만 걷어내고
 *    **완전히 같을 때만** 같다고 본다(포함 관계는 쓰지 않는다 — 「왜그」가 「왜그컴퍼니」를 잡는다).
 *    상호가 같은 사업자번호가 둘 이상이면 고르지 않는다(`AMBIGUOUS`).
 *
 * 값은 칸마다 **가장 최근 계산서**에서 고른다(작성일 → 메일 수신 시각 순). 주소·담당 이메일은
 * 바뀔 수 있어 옛 계산서보다 새 계산서가 맞다. 최근 계산서에 비어 있는 칸만 그 이전 계산서로 채운다.
 *
 * ⛔ 반환값에는 대표자·주소·이메일이 들어 있다 — 로그·봇 응답·커밋에 남기지 말 것(P0).
 */
import type { PartnerEnrichment, PartnerEnrichmentField } from "@/lib/agent/partner-enrichment";
import type { EtaxPartyDetail, ParsedEtaxInvoice } from "./etax-xml";
import { normalizeEtaxBusinessNumber } from "./etax-xml";

/** 메일 한 통에서 이 모듈이 쓰는 부분 — `ScannedTaxMail` 의 부분집합(테스트가 메일함 없이 만든다). */
export type LookupMail = {
  receivedAt: string;
  parsed: ParsedEtaxInvoice | null;
};

export type PartnerInvoiceTarget = {
  /** 기안의 상호 */
  name: string;
  /** 기안의 사업자번호(없으면 null) */
  businessNumber: string | null;
};

export type PartnerInvoiceMatchBy = "BUSINESS_NUMBER" | "NAME";

export type PartnerInvoiceLookup =
  | {
      status: "FOUND";
      matchedBy: PartnerInvoiceMatchBy;
      /** 계산서에 적힌 거래 상대의 사업자번호·상호 */
      counterpart: { businessNumber: string; name: string | null };
      /** 칸마다 고른 값. 사업자번호는 늘 들어 있다. */
      values: PartnerEnrichment;
      /** 근거가 된 계산서 수와 그중 가장 최근 작성일 */
      invoiceCount: number;
      latestWrittenDate: string | null;
    }
  | { status: "NOT_FOUND" }
  | { status: "AMBIGUOUS"; candidates: { businessNumber: string; name: string | null }[] };

type Counterpart = {
  businessNumber: string;
  name: string | null;
  detail: EtaxPartyDetail;
  writtenDate: string | null;
  receivedAt: string;
};

/** 계산서에서 우리가 아닌 쪽을 꺼낸다. 우리 계산서가 아니면 null. */
function counterpartOf(mail: LookupMail, ourBusinessNumber: string): Counterpart | null {
  const parsed = mail.parsed;
  if (!parsed) return null;
  const base = { writtenDate: parsed.writtenDate, receivedAt: mail.receivedAt };
  if (parsed.invoiceeBusinessNumber === ourBusinessNumber && parsed.invoicerBusinessNumber) {
    return {
      ...base,
      businessNumber: parsed.invoicerBusinessNumber,
      name: parsed.invoicerName,
      detail: parsed.invoicerDetail,
    };
  }
  if (parsed.invoicerBusinessNumber === ourBusinessNumber && parsed.invoiceeBusinessNumber) {
    return {
      ...base,
      businessNumber: parsed.invoiceeBusinessNumber,
      name: parsed.invoiceeName,
      detail: parsed.invoiceeDetail,
    };
  }
  return null;
}

/** 법인 표기 — 같은 회사를 계산서는 「(주)왜그」, 대화는 「왜그」로 적는다. */
const CORPORATE_MARKERS = /\(주\)|㈜|주식회사|\(유\)|유한회사|\(재\)|재단법인|\(사\)|사단법인/g;

/** 상호 비교용 정규화. 완전 일치 비교에만 쓴다. */
export function normalizePartnerName(value: string): string {
  return value
    .normalize("NFC")
    .replace(CORPORATE_MARKERS, "")
    .replace(/[\s()[\]·.,-]/g, "")
    .toLowerCase();
}

/** 최근 계산서가 앞에 오게 — 작성일(없으면 뒤로), 같으면 수신 시각. */
function byRecency(left: Counterpart, right: Counterpart): number {
  const leftDate = left.writtenDate ?? "";
  const rightDate = right.writtenDate ?? "";
  if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
  return right.receivedAt.localeCompare(left.receivedAt);
}

const DETAIL_FIELD: Record<Exclude<PartnerEnrichmentField, "businessNumber">, keyof EtaxPartyDetail> = {
  ceoName: "ceoName",
  businessType: "businessType",
  businessItem: "businessItem",
  address: "address",
  representativeEmail: "email",
};

/** 칸마다 가장 최근 계산서의 값을 고른다(그 계산서에 비어 있으면 이전 계산서). */
function pickLatestValues(sorted: readonly Counterpart[]): PartnerEnrichment {
  const values: PartnerEnrichment = { businessNumber: sorted[0].businessNumber };
  for (const [field, detailKey] of Object.entries(DETAIL_FIELD) as [
    Exclude<PartnerEnrichmentField, "businessNumber">,
    keyof EtaxPartyDetail,
  ][]) {
    const found = sorted.find((item) => item.detail[detailKey] !== null);
    if (found) values[field] = found.detail[detailKey] ?? undefined;
  }
  return values;
}

function found(matchedBy: PartnerInvoiceMatchBy, matches: readonly Counterpart[]): PartnerInvoiceLookup {
  const sorted = [...matches].sort(byRecency);
  const latestName = sorted.find((item) => item.name !== null)?.name ?? null;
  return {
    status: "FOUND",
    matchedBy,
    counterpart: { businessNumber: sorted[0].businessNumber, name: latestName },
    values: pickLatestValues(sorted),
    invoiceCount: sorted.length,
    latestWrittenDate: sorted[0].writtenDate,
  };
}

/**
 * 기안 하나에 맞는 계산서를 찾는다.
 *
 * @param ourBusinessNumber 우리 사업자번호(`SUPPLIER.businessNumber`) — 거래 상대를 가르는 기준
 */
export function findPartnerInvoiceInfo(input: {
  mails: readonly LookupMail[];
  ourBusinessNumber: string;
  target: PartnerInvoiceTarget;
}): PartnerInvoiceLookup {
  const counterparts = input.mails
    .map((mail) => counterpartOf(mail, input.ourBusinessNumber))
    .filter((item): item is Counterpart => item !== null);

  const targetNumber = normalizeEtaxBusinessNumber(input.target.businessNumber);
  if (targetNumber) {
    const matches = counterparts.filter((item) => item.businessNumber === targetNumber);
    return matches.length > 0 ? found("BUSINESS_NUMBER", matches) : { status: "NOT_FOUND" };
  }

  const targetName = normalizePartnerName(input.target.name);
  if (targetName.length === 0) return { status: "NOT_FOUND" };
  const matches = counterparts.filter(
    (item) => item.name !== null && normalizePartnerName(item.name) === targetName,
  );
  if (matches.length === 0) return { status: "NOT_FOUND" };

  const distinctNumbers = [...new Set(matches.map((item) => item.businessNumber))];
  if (distinctNumbers.length > 1) {
    return {
      status: "AMBIGUOUS",
      candidates: distinctNumbers.map((businessNumber) => ({
        businessNumber,
        name: matches.find((item) => item.businessNumber === businessNumber)?.name ?? null,
      })),
    };
  }
  return found("NAME", matches);
}
