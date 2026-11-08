/**
 * 게시 후 광고 표기 점검 — 셀러가 올린 캠페인 게시물 캡션에 경제적 이해관계 표기(광고·협찬·
 * 제품 제공)가 있는지, 「더 보기」로 접히기 전 앞부분에 있는지 판정한다.
 *
 * 왜(설계 정본: docs/private/specs/2026-11-08-post-ad-disclosure-check.md): 업로드 **전** 문안은
 * claim-gate `checkText` 와 content-guide 「첫 줄 #광고」가 보지만, 업로드 **후** 실제 캡션은 아무도
 * 안 봤다. 추천·보증 심사지침은 표기를 「본문 첫 부분(첫 줄·첫 해시태그), 더 보기 전에 보이는 곳」에
 * 두라고 하고, 묻히면 벤더도 책임 선상에 선다.
 *
 * - **순수 함수다**(Prisma 무의존) — 화면이 클라이언트에서 계산한다. 쓰기·발송 없음.
 * - 판정은 guidance 이며 법률 자문이 아니다. 최종 판단은 운영자.
 *
 * 한글 광고 낱말 목록이 이 레포에 셋 있다 — 갈라지는 이유(통일 금지):
 * ① `seller-analysis/metrics.ts` `isAdPost` = 「광고 게시물인가」(셀러 분석, 넓게 잡는다 — `#제공` 포함)
 * ② `content-guide.ts` `AD_TAG_PATTERN` = 「생성기 출력에 단독 #광고가 있나」(사내 문안 규칙)
 * ③ 여기 = 「표기가 **인정될 만한가**」 — 모호한 말(`#제공` 단독·맨글 광고·소정의)은 인정하지 않는다.
 * 영문 해시태그 경계 규칙만은 질문이 같아 ①의 정규식을 공유한다.
 */
import { AUTO_NOTE_PREFIX } from "@/lib/reference-enrich";
import { parsePostNote } from "@/lib/campaign-performance-report";
import { AD_HASHTAG_EN } from "@/lib/seller-analysis/metrics";

export type AdDisclosureKind =
  | "OK"
  | "LATE"
  | "ENGLISH_ONLY"
  | "DENIAL"
  | "MISSING"
  | "NO_CAPTION";

export interface AdDisclosureResult {
  kind: AdDisclosureKind;
  /** 오너가 셀러에게 수정을 요청할 후보인가(OK·판정불가가 아닌 넷). */
  needsAction: boolean;
  /** 가장 앞에서 찾은 한글 표기 원문(없으면 영문 표기, 그것도 없으면 null). */
  found: string | null;
  /** 찾은 부인 표현 원문. */
  denial: string | null;
}

/**
 * 피드에서 접히기 전 보이는 머리 — 인스타그램 접힘 근사치(**미확인 가정**, 실측 아님).
 * 사진·캐러셀은 두 줄, 릴스·영상은 한 줄 뒤에 「더 보기」가 붙고, 줄이 길면 약 125자에서 접힌다.
 */
export const VISIBLE_HEAD_CHARS = 125;
const VISIBLE_HEAD_LINES_FEED = 2;
const VISIBLE_HEAD_LINES_REEL = 1;
const REEL_MEDIA_TYPES = new Set(["reel", "video"]);

// 해시태그는 태그 **시작**이 표기 낱말이면 인정한다(#유료광고포함·#광고#협찬·#광고ad 가 실제 표기다).
// 뒤에 붙으면 다른 뜻이 되는 접미만 막는다(#광고비·#광고문의·#협찬문의).
// 접미는 태그에 **붙은** 것만 본다 — 「#광고 주말 특가」의 띄어 쓴 「주말」은 다른 낱말이다.
// 단 「없·문의·대행」은 띄어 써도 뜻이 뒤집힌다(#광고 없는 후기 · #협찬 문의 · #광고 대행).
const EXCLUDED_SUFFIX =
  "(?!(?:비|주|판|문의|모델|촬영|없|대행|회사|제안|효과)|\\s+(?:없|문의|대행))";
const KO_HASHTAG = new RegExp(
  `#(?:유료\\s?광고|광고|제품\\s?협찬|협찬|제품\\s?제공)${EXCLUDED_SUFFIX}`,
  "gu",
);
// 맨글은 서술형·괄호형만 인정한다 — 맨 「광고」 단독은 「광고에서 본 제품」과 구분이 안 된다.
const KO_PLAIN = new RegExp(
  [
    "광고\\s*입니다",
    "유료\\s*광고",
    "광고\\s*포함",
    "[\\[(【]\\s*광고\\s*[\\])】]",
    "광고\\s*[/·,]\\s*협찬",
    `제품\\s*협찬`,
    `(?<![#\\p{L}])협찬(?!\\s*(?:문의|아(?:님|닙|닌|니)))`,
    "제품\\s*제공",
    "제공\\s*받",
    "원고료",
    "경제적\\s*대가",
  ].join("|"),
  "gu",
);
// 부인 표현 — 금지 표현 사전(`banned-phrase-seed.ts` 「광고성 부인」)과 정규식을 공유하지 않는다.
// 화면의 금지 표현 판정은 시드가 아니라 `BannedPhraseRule` **DB 행**을 읽으므로 시드 공유는 거짓
// 동기화이고, 여기는 「협찬 아니고 광고입니다」·「#광고 내돈내산으로 써보고」를 부인으로 보지 않도록
// 판정이 다르다(DB 규칙은 문안 경고라 넓게 잡는 것이 맞다).
// 「아닙니다·아닌 후기」 같은 존댓말·관형형도 부인이다. 「제공받지 않았」은 제공 표기처럼 보여도 부인이다.
const STRONG_DENIAL =
  /(?:(?:광고|협찬)\s*아(?:님|닙|닌(?!가)|니(?![고라가냐긴]))|(?:제공|협찬)\s*(?:을\s*)?받지\s*않|#(?:광고|협찬)\s*없)/gu;
const WEAK_DENIAL = /내돈\s*내산/gu;

function firstMatch(text: string, pattern: RegExp): { text: string; index: number } | null {
  let best: { text: string; index: number } | null = null;
  for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))) {
    if (m.index === undefined || m[0].length === 0) continue;
    if (!best || m.index < best.index) best = { text: m[0], index: m.index };
  }
  return best;
}

function earliest(
  ...hits: ({ text: string; index: number } | null)[]
): { text: string; index: number } | null {
  return hits.reduce<{ text: string; index: number } | null>(
    (best, h) => (h && (!best || h.index < best.index) ? h : best),
    null,
  );
}

/** 앞 공백을 걷어낸 캡션에서 「더 보기」 전에 보이는 끝 위치(배타). */
export function visibleHeadEnd(caption: string, mediaType?: string | null): number {
  const lines = mediaType && REEL_MEDIA_TYPES.has(mediaType) ? VISIBLE_HEAD_LINES_REEL : VISIBLE_HEAD_LINES_FEED;
  let end = caption.length;
  let seen = 0;
  for (let i = 0; i < caption.length; i++) {
    if (caption[i] !== "\n") continue;
    seen += 1;
    if (seen === lines) {
      end = i;
      break;
    }
  }
  return Math.min(end, VISIBLE_HEAD_CHARS);
}

export function checkAdDisclosure(
  caption: string | null | undefined,
  options: { mediaType?: string | null } = {},
): AdDisclosureResult {
  const text = (caption ?? "").replace(/^\s+/, "");
  if (text.trim() === "") {
    return { kind: "NO_CAPTION", needsAction: false, found: null, denial: null };
  }

  const ko = earliest(firstMatch(text, KO_HASHTAG), firstMatch(text, KO_PLAIN));
  const en = firstMatch(text, AD_HASHTAG_EN);
  const strong = firstMatch(text, STRONG_DENIAL);
  const weak = firstMatch(text, WEAK_DENIAL);
  const headEnd = visibleHeadEnd(text, options.mediaType);
  const found = ko?.text ?? en?.text ?? null;

  const result = (kind: AdDisclosureKind, denial: string | null = null): AdDisclosureResult => ({
    kind,
    needsAction: kind !== "OK" && kind !== "NO_CAPTION",
    found,
    denial,
  });

  // 대가를 받은 캠페인 게시물에서 광고·협찬 부인은 표기가 있어도 기만적 표시다.
  if (strong) return result("DENIAL", strong.text);
  if (ko && ko.index < headEnd) return result("OK");
  // 「내돈내산」은 셀러 서사로 흔해 머리에 한글 표기가 있으면 부인으로 보지 않는다.
  if (weak) return result("DENIAL", weak.text);
  if (ko) return result("LATE");
  if (en) return result("ENGLISH_ONLY");
  return result("MISSING");
}

/**
 * 점검 입력 — **자동수집 캡션만** 돌려준다. `parsePostNote` 는 접두 없는 오너 수기 메모도
 * caption 으로 돌려주는데, 그것을 점검하면 메모마다 「표기 없음」이 뜬다.
 */
export function autoCaptionFromNotes(notes: string | null | undefined): string | null {
  if (!notes || !notes.startsWith(AUTO_NOTE_PREFIX)) return null;
  return parsePostNote(notes).caption;
}

/** 배지 낱말 — 네 사유 공통(사유는 설명창이 맡는다). 상태 낱말이라 붙여 쓴다. */
export const AD_DISCLOSURE_LABEL = "광고표기미흡";

const HINT_BY_KIND: Partial<Record<AdDisclosureKind, string>> = {
  MISSING: "게시물 본문에서 광고·협찬 표기를 찾지 못했습니다.",
  LATE: "광고 표기가 「더 보기」를 눌러야 보이는 뒤쪽에 있습니다. 처음 화면에 보이는 앞부분에 있어야 합니다.",
  ENGLISH_ONLY: "영문 표기(#ad 등)만 있고 한글 광고·협찬 표기가 없습니다.",
  DENIAL: "「광고 아님」·「내돈내산」 같은 문구가 있습니다. 대가를 받은 게시물과 맞지 않습니다.",
};

/** 카드 설명창 문구. 조치 대상이 아니면 null. */
export function adDisclosureHint(result: AdDisclosureResult): string | null {
  const reason = HINT_BY_KIND[result.kind];
  if (!result.needsAction || !reason) return null;
  // 구분 기호로 잇지 않는다 — 사유 문장의 마침표 뒤에 「 · 」가 오면 조각처럼 읽힌다.
  const found = result.denial
    ? `찾은 문구: 「${result.denial}」`
    : result.found
      ? `찾은 표기: 「${result.found}」`
      : null;
  return found ? `${reason} ${found} (최근 수집한 본문 기준)` : `${reason} (최근 수집한 본문 기준)`;
}

/** 본문 미수집 건만 있을 때 머리 줄 낱말 — 침묵이 「전부 정상」으로 읽히지 않게. */
export const AD_DISCLOSURE_UNCHECKED_LABEL = "광고표기미점검";

const NOT_LEGAL_ADVICE = "참고용 점검이며 법률 판단이 아닙니다.";

/** 피드 머리 집계 — 조치 대상 수 · 본문 미수집 수 · 점검한 수. */
export interface AdDisclosureSummary {
  flagged: number;
  unchecked: number;
  checked: number;
}

/** 피드 머리 설명창 문구 — 무엇을 셌는지·못 본 것이 몇 건인지까지(0건이 통과로 오독되지 않게). */
export function adDisclosureSummaryHint(summary: AdDisclosureSummary): string {
  const parts: string[] = [];
  if (summary.flagged > 0) {
    parts.push(
      `본문을 수집한 등록 게시물 ${summary.checked}건 중 ${summary.flagged}건의 광고 표기가 부족합니다. 카드의 「${AD_DISCLOSURE_LABEL}」에서 사유를 볼 수 있습니다.`,
    );
  }
  if (summary.unchecked > 0) {
    parts.push(`본문을 수집하지 못한 등록 게시물 ${summary.unchecked}건은 점검하지 못했습니다.`);
  }
  parts.push(NOT_LEGAL_ADVICE);
  return parts.join(" ");
}

export function summarizeAdDisclosure(results: AdDisclosureResult[]): AdDisclosureSummary {
  const unchecked = results.filter((r) => r.kind === "NO_CAPTION").length;
  return {
    flagged: results.filter((r) => r.needsAction).length,
    unchecked,
    checked: results.length - unchecked,
  };
}
