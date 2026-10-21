// [캘린더수집] 오너가 캘린더에 직접 적은 일정 제목 → 의도(종류·셀러·딜 후보·회차) 변환.
// 순수 함수: DB·IO 없음. 사전(InboundDictionary)은 호출자가 넘긴다.
import type {
  InboundDictionary,
  InboundKind,
  ParseFailure,
  ParsedCalendarIntent,
  TitleHints,
} from "./types";

/** 제목 속 회차("2차"/"2 차") 정규식 — 파서와 LLM 힌트 근거 검증이 공유한다. */
export const ROUND_RE = /(\d+)\s*차/;
/** 제목 속 종류 키워드 — 파서와 LLM 힌트 근거 검증이 공유한다. */
export const DEPOSIT_RE = /입금/;
export const PAYOUT_RE = /지급|송금|정산금/;
/** 제목 속 공급사 지급 표지(자사몰 공급사 지급 칸을 고를 때). */
export const SUPPLIER_RE = /공급사|업체|벤더/;
/**
 * 이름 매칭 전에 걷어낼 키워드 전부 — 위 세 정규식에서 만든다(키워드를 한 곳에서만 고치게).
 * ⛔ 리터럴로 다시 적지 말 것: 종류 판정에 키워드를 더하고 여기를 빠뜨리면 그 낱말이 브랜드 토큰으로 남는다.
 */
export const KEYWORD_STRIP_RE = new RegExp(
  [DEPOSIT_RE, PAYOUT_RE, SUPPLIER_RE].map((re) => re.source).join("|"),
  "g",
);

/** NFC + 공백·기호 제거 + 소문자. */
export function normalizeToken(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

// 구분자: 공백·×·/·-, 그리고 단독 x/X(영문 단어 안의 x 는 쪼개지 않는다).
const SPLIT_RE = /[\s×/\-]+|(?<![A-Za-z])[xX](?![A-Za-z])/u;
const MIN_LEN = 2;

function nameMatches(token: string, name: string): boolean {
  if (token.length < MIN_LEN || name.length < MIN_LEN) return false;
  return token === name || token.includes(name) || name.includes(token);
}

/** 셀러 매칭: 정확 일치가 유일하면 우선, 아니면 포함 일치 집합이 유일해야 한다. */
function matchSeller(
  tokens: string[],
  dict: InboundDictionary,
): { id: string; usedTokens: Set<string> } | "none" | "ambiguous" {
  const exact = new Set<string>();
  const any = new Set<string>();
  for (const seller of dict.sellers) {
    for (const raw of seller.names) {
      const name = normalizeToken(raw);
      for (const t of tokens) {
        if (!nameMatches(t, name)) continue;
        any.add(seller.id);
        if (t === name) exact.add(seller.id);
      }
    }
  }
  const pool = exact.size === 1 ? exact : any;
  if (pool.size === 0) return "none";
  if (pool.size > 1) return "ambiguous";
  const id = [...pool][0];
  const seller = dict.sellers.find((s) => s.id === id)!;
  const used = new Set<string>();
  for (const raw of seller.names) {
    const name = normalizeToken(raw);
    for (const t of tokens) if (nameMatches(t, name)) used.add(t);
  }
  return { id, usedTokens: used };
}

function brandIdentity(deal: InboundDictionary["deals"][number]): string {
  const first = deal.brandNames.map(normalizeToken).find((n) => n.length > 0);
  return (
    first ||
    normalizeToken(deal.partnerName ?? "") ||
    normalizeToken(deal.dealName)
  );
}

/** 브랜드 매칭: 맞은 딜 전부. 서로 다른 브랜드 정체성이 2개 이상이면 모호. */
function matchBrand(
  tokens: string[],
  dict: InboundDictionary,
): { dealIds: string[] } | "none" | "ambiguous" {
  const hit: InboundDictionary["deals"] = [];
  for (const deal of dict.deals) {
    const names = [...deal.brandNames, deal.dealName, deal.partnerName ?? ""]
      .map(normalizeToken)
      .filter((n) => n.length > 0);
    if (tokens.some((t) => names.some((n) => nameMatches(t, n))))
      hit.push(deal);
  }
  if (hit.length === 0) return "none";
  const identities = new Set(hit.map(brandIdentity));
  if (identities.size > 1) return "ambiguous";
  return { dealIds: hit.map((d) => d.id) };
}

export function parseCalendarTitle(
  summary: string,
  dict: InboundDictionary,
  hints?: TitleHints,
): { ok: true; intent: ParsedCalendarIntent } | ParseFailure {
  let text = summary.normalize("NFC");

  // 회차: "2차" / "2 차"
  let round: number | null = null;
  const roundMatch = ROUND_RE.exec(text);
  if (roundMatch) {
    round = Number(roundMatch[1]);
    text = text.replace(roundMatch[0], " ");
  }

  // 종류·공급사 키워드는 이름 매칭 전에 걷어낸다.
  let kind: InboundKind | null = null;
  if (DEPOSIT_RE.test(text)) kind = "deposit";
  else if (PAYOUT_RE.test(text)) kind = "payout";
  const supplierHint = SUPPLIER_RE.test(text);
  text = text.replace(KEYWORD_STRIP_RE, " ");

  const titleTokens = text
    .split(SPLIT_RE)
    .map(normalizeToken)
    .filter((t) => t.length > 0);

  const useHints = hints !== undefined;
  const sellerTokens =
    useHints && hints.sellerHint
      ? [normalizeToken(hints.sellerHint)]
      : titleTokens;
  const brandPool =
    useHints && hints.brandHint
      ? [normalizeToken(hints.brandHint)]
      : titleTokens;

  const seller = matchSeller(sellerTokens, dict);
  if (seller === "none") return { ok: false, reason: "no_seller" };
  if (seller === "ambiguous") return { ok: false, reason: "ambiguous_seller" };

  // 셀러에 쓴 토큰은 브랜드 후보에서 뺀다.
  const brandTokens = brandPool.filter((t) => !seller.usedTokens.has(t));
  const brand = matchBrand(brandTokens, dict);
  if (brand === "none") return { ok: false, reason: "no_brand" };
  if (brand === "ambiguous") return { ok: false, reason: "ambiguous_brand" };

  return {
    ok: true,
    intent: {
      kind: kind ?? hints?.kind ?? "campaign",
      sellerId: seller.id,
      dealIds: brand.dealIds,
      round: round ?? hints?.round ?? null,
      supplierHint,
      matchedBy: useHints ? "llm" : "rule",
    },
  };
}
