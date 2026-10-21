// [캘린더수집] 구글 캘린더 일정 → CRM 기안 변환 기능의 공용 타입.
// 순수 모듈(파서)과 DB 모듈(사전 적재·힌트 추출)이 함께 쓴다.

export type InboundKind = "campaign" | "deposit" | "payout";

export type InboundDictionary = {
  sellers: { id: string; names: string[] }[];
  deals: {
    id: string;
    brandNames: string[];
    dealName: string;
    partnerName: string | null;
  }[];
};

/** LLM 보조 단계가 내는 힌트. 문자열 힌트만 내고 DB id 는 고르지 않는다. */
export type TitleHints = {
  sellerHint: string | null;
  brandHint: string | null;
  round: number | null;
  kind: InboundKind | null;
};

export type ParsedCalendarIntent = {
  kind: InboundKind;
  sellerId: string;
  /** 브랜드로 맞은 딜 후보(같은 브랜드의 여러 딜 포함). 고르는 일은 다음 단계 몫. */
  dealIds: string[];
  round: number | null;
  supplierHint: boolean;
  matchedBy: "rule" | "llm";
};

export type ParseFailure = {
  ok: false;
  reason: "no_seller" | "no_brand" | "ambiguous_seller" | "ambiguous_brand";
};
