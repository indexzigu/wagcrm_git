/**
 * 거래처 등록 기안의 **계산서 보강** 규칙 SSOT — client-safe 순수 모듈(Prisma·node 무의존).
 *
 * 무엇인가: 봇이 올린 「거래처 등록」 기안은 대화에서 받은 값(대개 상호와 종류)만 담는다.
 * 결재함에서 승인하기 전에 메일함의 계산서를 찾아 대표자·주소·업태·종목·이메일(필요하면
 * 사업자번호까지)을 채워 함께 저장한다(오너 지시 2026-10-15). 찾기는
 * `tax-invoice-mail/partner-invoice-lookup.ts`, 저장은 `approve-proposal.ts` 가 한다.
 *
 * 규칙 — **빈 칸만 채운다.** 기안에 이미 있는 값은 계산서 값과 달라도 바꾸지 않는다:
 * - 기안 값은 오너가 대화로 직접 준 값일 수 있다(계산서의 담당자 이메일보다 우선한다).
 * - 거래처 자동입력은 기존 값을 덮지 않는다는 데이터 계약(P7 「Partner Autofill Name Guard」)과
 *   같은 방향이다. 다른 값은 화면이 「기안 값 유지」로 보여 주고 오너가 판단한다.
 *
 * ⛔ 이 모듈이 다루는 값(대표자·주소·이메일)은 개인정보다 — 로그·봇 응답·커밋에 남기지 말 것.
 */

/** 계산서로 채울 수 있는 칸. 순서가 곧 화면 순서다. */
export const PARTNER_ENRICHMENT_FIELDS = [
  "businessNumber",
  "ceoName",
  "businessType",
  "businessItem",
  "address",
  "representativeEmail",
] as const;

export type PartnerEnrichmentField = (typeof PARTNER_ENRICHMENT_FIELDS)[number];

/** 승인 요청에 실어 보내는 보강 값. 칸마다 선택이고, 없는 칸은 건드리지 않는다. */
export type PartnerEnrichment = Partial<Record<PartnerEnrichmentField, string>>;

/** 화면 라벨 — 결재 카드의 거래처 블록(`proposal-payload-preview.tsx`)과 같은 낱말을 쓴다. */
export const PARTNER_ENRICHMENT_LABELS: Record<PartnerEnrichmentField, string> = {
  businessNumber: "사업자번호",
  ceoName: "대표자",
  businessType: "업태",
  businessItem: "종목",
  address: "주소",
  representativeEmail: "대표 이메일",
};

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** 같은 값인지 — 사업자번호는 숫자만, 나머지는 공백 차이를 무시한다. */
function sameValue(field: PartnerEnrichmentField, left: string, right: string): boolean {
  if (field === "businessNumber") return left.replace(/\D/g, "") === right.replace(/\D/g, "");
  const squash = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (field === "representativeEmail") return squash(left).toLowerCase() === squash(right).toLowerCase();
  return squash(left) === squash(right);
}

export type PartnerEnrichmentRow = {
  field: PartnerEnrichmentField;
  /** 계산서에서 찾은 값 */
  invoiceValue: string;
  /** 기안에 이미 있던 값(없으면 null) */
  proposedValue: string | null;
  /**
   * FILL = 기안이 비어 있어 채운다 · SAME = 기안과 같다 · KEEP = 기안 값과 달라 기안 값을 유지한다 ·
   * INVALID = 기안은 비었지만 계산서 값이 거래처 칸의 형식(길이 등)을 넘어 저장할 수 없다
   */
  outcome: "FILL" | "SAME" | "KEEP" | "INVALID";
};

export type PartnerEnrichmentPlan = {
  rows: PartnerEnrichmentRow[];
  /** 승인 때 실을 값 — `outcome === "FILL"` 인 칸만 */
  fills: PartnerEnrichment;
};

/**
 * 기안의 거래처(`args.partner`)와 계산서에서 찾은 값을 맞대 칸마다 결과를 정한다.
 * 계산서에 없는 칸은 줄을 만들지 않는다.
 */
export function planPartnerEnrichment(
  proposedPartner: Record<string, unknown>,
  invoiceValues: PartnerEnrichment,
  /** 서버가 계약 검사(`partner-enrichment-schema.ts`)를 넘긴다. 없으면 전부 받아들인다. */
  isAcceptable: (field: PartnerEnrichmentField, value: string) => boolean = () => true,
): PartnerEnrichmentPlan {
  const rows: PartnerEnrichmentRow[] = [];
  const fills: PartnerEnrichment = {};
  for (const field of PARTNER_ENRICHMENT_FIELDS) {
    const invoiceValue = textOf(invoiceValues[field]);
    if (!invoiceValue) continue;
    const proposedValue = textOf(proposedPartner[field]);
    const outcome: PartnerEnrichmentRow["outcome"] = proposedValue !== null
      ? sameValue(field, proposedValue, invoiceValue)
        ? "SAME"
        : "KEEP"
      : isAcceptable(field, invoiceValue)
        ? "FILL"
        : "INVALID";
    if (outcome === "FILL") fills[field] = invoiceValue;
    rows.push({ field, invoiceValue, proposedValue, outcome });
  }
  return { rows, fills };
}

/**
 * 승인 시점에 보강 값을 기안의 거래처에 합친다 — **빈 칸만** 채우고 새 객체를 돌려준다.
 * 화면이 계산한 뒤 기안이 바뀌었어도(재기안 등) 이 함수가 다시 「빈 칸만」을 보장한다.
 */
export function applyPartnerEnrichment(
  proposedPartner: Record<string, unknown>,
  enrichment: PartnerEnrichment,
): { partner: Record<string, unknown>; filled: PartnerEnrichmentField[] } {
  const partner: Record<string, unknown> = { ...proposedPartner };
  const filled: PartnerEnrichmentField[] = [];
  for (const field of PARTNER_ENRICHMENT_FIELDS) {
    const value = textOf(enrichment[field]);
    if (!value || textOf(partner[field]) !== null) continue;
    partner[field] = field === "businessNumber" ? value.replace(/\D/g, "") : value;
    filled.push(field);
  }
  return { partner, filled };
}
