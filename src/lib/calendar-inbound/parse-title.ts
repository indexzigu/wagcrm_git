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
 * ⛔ replace 전용 — `.test`/`.exec` 금지(g 플래그라 lastIndex 가 남아 다음 호출 결과가 바뀐다).
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

function nameMatches(token: string, name: string, opts: { wholeNameOnly?: boolean } = {}): boolean {
  if (token.length < MIN_LEN || name.length < MIN_LEN) return false;
  if (opts.wholeNameOnly) return token.includes(name);
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

/**
 * 브랜드 매칭: 맞은 딜 전부. 서로 다른 브랜드 정체성이 2개 이상이면 모호.
 * `wholeNameOnly` = 힌트(LLM) 경로 — 힌트가 등록 이름 **전체 이상**일 때만 맞는 것으로 본다. 이름 조각(예: 「브랜드」
 * 라는 낱말)이 등록 이름 일부와 겹친다고 그 브랜드로 기안하면 엉뚱한 브랜드가 된다. 제목 토큰 경로는 기존 그대로.
 */
function matchBrand(
  tokens: string[],
  dict: InboundDictionary,
  opts: { wholeNameOnly?: boolean } = {},
): { dealIds: string[] } | "none" | "ambiguous" {
  const hit: InboundDictionary["deals"] = [];
  for (const deal of dict.deals) {
    const names = [...deal.brandNames, deal.dealName, deal.partnerName ?? ""]
      .map(normalizeToken)
      .filter((n) => n.length > 0);
    if (tokens.some((t) => names.some((n) => nameMatches(t, n, opts))))
      hit.push(deal);
  }
  if (hit.length === 0) return "none";
  const identities = new Set(hit.map(brandIdentity));
  if (identities.size > 1) return "ambiguous";
  return { dealIds: hit.map((d) => d.id) };
}

type Span = {
  start: number;
  end: number;
  /** 같은 대상끼리만 구간을 합칠 수 있다: 셀러는 id, 브랜드는 브랜드 정체성. */
  key: string;
  seller: boolean;
  sellerId?: string;
  dealIds: string[];
};

/**
 * 붙여 쓴 제목("샘플셀러테스트브랜드") 보조 패스: 토큰 매칭이 실패했을 때만 쓴다.
 * 토큰 안에서만 사전 이름의 부분 문자열을 찾는다(토큰 사이 \n 은 이름에 없어 경계를 못 넘는다).
 * - 긴 이름부터 구간을 확정하고, 겹치는 짧은 일치는 버린다(셀러 별칭이 브랜드명의 일부인 경우).
 * - 같은 길이로 다른 대상이 같은 구간을 다투면 유일하지 않은 것이므로 실패한다.
 * - 셀러·브랜드 모두 유일해야 성공한다. 하나라도 아니면 null(호출자가 기존 실패 사유를 낸다).
 */
function matchGlued(
  joined: string,
  dict: InboundDictionary,
): { sellerId: string; dealIds: string[] } | null {
  const cands: Span[] = [];
  const find = (name: string, make: (start: number) => Span) => {
    if (name.length < MIN_LEN) return;
    for (
      let i = joined.indexOf(name);
      i >= 0;
      i = joined.indexOf(name, i + 1)
    ) {
      cands.push({ ...make(i), start: i, end: i + name.length });
    }
  };
  for (const seller of dict.sellers) {
    for (const raw of seller.names) {
      find(normalizeToken(raw), () => ({
        start: 0,
        end: 0,
        key: `S:${seller.id}`,
        seller: true,
        sellerId: seller.id,
        dealIds: [],
      }));
    }
  }
  for (const deal of dict.deals) {
    const names = [...deal.brandNames, deal.dealName, deal.partnerName ?? ""];
    for (const raw of names) {
      find(normalizeToken(raw), () => ({
        start: 0,
        end: 0,
        key: `B:${brandIdentity(deal)}`,
        seller: false,
        dealIds: [deal.id],
      }));
    }
  }

  cands.sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const chosen: Span[] = [];
  for (const c of cands) {
    const overlaps = chosen.filter((x) => c.start < x.end && x.start < c.end);
    if (overlaps.length === 0) {
      chosen.push({ ...c, dealIds: [...c.dealIds] });
      continue;
    }
    const sameSpan = overlaps.find(
      (x) => x.start === c.start && x.end === c.end && x.key === c.key,
    );
    if (sameSpan) {
      for (const id of c.dealIds)
        if (!sameSpan.dealIds.includes(id)) sameSpan.dealIds.push(id);
      continue;
    }
    // 더 긴(또는 같은 길이로 먼저 확정된) 일치와 겹침. 같은 길이의 다른 대상이면 모호.
    if (
      overlaps.some(
        (x) => x.end - x.start === c.end - c.start && x.key !== c.key,
      )
    )
      return null;
  }

  const sellerIds = new Set(
    chosen.filter((x) => x.seller).map((x) => x.sellerId!),
  );
  const brandKeys = new Set(chosen.filter((x) => !x.seller).map((x) => x.key));
  if (sellerIds.size !== 1 || brandKeys.size !== 1) return null;
  // 이름이 닿은 토큰은 고른 구간들로 빈틈없이 덮여야 한다: 남는 글자가 있으면
  // ("하나로마트" 속 "하나") 우연 일치일 수 있어 확신하지 않는다.
  let offset = 0;
  for (const token of joined.split("\n")) {
    const end = offset + token.length;
    const inside = chosen.filter((x) => x.start >= offset && x.end <= end);
    if (inside.length > 0) {
      const covered = inside.reduce((n, x) => n + (x.end - x.start), 0);
      if (covered !== token.length) return null;
    }
    offset = end + 1;
  }
  // 토큰 패스와 같은 규칙: 고른 브랜드 정체성의 딜은 이름 구간이 이기지 않았어도 전부 포함한다.
  const identity = [...brandKeys][0].slice(2);
  return {
    sellerId: [...sellerIds][0],
    dealIds: dict.deals
      .filter((d) => brandIdentity(d) === identity)
      .map((d) => d.id),
  };
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

  let sellerId: string;
  let dealIds: string[];

  const seller = matchSeller(sellerTokens, dict);
  let failure: ParseFailure | null = null;
  let brand: ReturnType<typeof matchBrand> = "none";
  if (seller === "none") failure = { ok: false, reason: "no_seller" };
  else if (seller === "ambiguous")
    failure = { ok: false, reason: "ambiguous_seller" };
  else {
    // 셀러에 쓴 토큰은 브랜드 후보에서 뺀다.
    const brandTokens = brandPool.filter((t) => !seller.usedTokens.has(t));
    brand = matchBrand(brandTokens, dict, { wholeNameOnly: useHints && Boolean(hints.brandHint) });
    if (brand === "none") failure = { ok: false, reason: "no_brand" };
    else if (brand === "ambiguous")
      failure = { ok: false, reason: "ambiguous_brand" };
  }

  if (failure === null) {
    sellerId = (seller as { id: string }).id;
    dealIds = (brand as { dealIds: string[] }).dealIds;
  } else {
    // 힌트(LLM 근거) 경로는 힌트 문자열이 근거라 제목 전체 탐색을 하지 않는다.
    // 모호(ambiguous_*)는 실패로 둔다: 보조 패스가 뒤집으면 확신 있는 오답이 된다.
    const retryable =
      failure.reason === "no_seller" || failure.reason === "no_brand";
    const glued =
      useHints || !retryable ? null : matchGlued(titleTokens.join("\n"), dict);
    if (!glued) return failure;
    sellerId = glued.sellerId;
    dealIds = glued.dealIds;
  }

  return {
    ok: true,
    intent: {
      kind: kind ?? hints?.kind ?? "campaign",
      sellerId,
      dealIds,
      round: round ?? hints?.round ?? null,
      supplierHint,
      matchedBy: useHints ? "llm" : "rule",
    },
  };
}
