/**
 * 계산서 품목명 ↔ 캠페인 라벨 대조 SSOT — client-safe 순수 모듈.
 *
 * 두 소비처가 같은 규칙을 쓴다: 발행 자동 확정(`issuance-match.ts` 의 `pickByLineItems`)과 월정산 계산서
 * 판정(`campaign-invoices.ts` 의 전액 판정, 2026-10-14). 원래 `issuance-match.ts` 안의 모듈 비공개 함수였고,
 * 두 번째 사본을 만들지 않으려고 여기로 옮겼다(동작은 그대로).
 */
import { toNfc } from "@/lib/text-normalize";

/**
 * 품목명 대조용 접기 — 공백·기호를 지우고 소문자로 접는다. 계산서와 CRM 이 같은 이름을
 * 띄어쓰기·괄호만 다르게 적는 경우가 흔해서다.
 *
 * 🔴 **`toNfc` 를 먼저 태운다.** 한쪽(품목명)은 **메일 첨부의 계산서 XML** 에서 오고 다른
 * 쪽(캠페인 라벨)은 우리 DB 에서 온다 — 형태가 갈리면 눈에 같은 이름이 안 맞아 후보
 * 좁히기가 조용히 실패한다(편지함 이름·엑셀 헤더와 같은 축, 2026-09-02).
 *
 * ⚠️ 이름이 `normalizeForCompare` 가 아닌 것은 의도다 — `text-normalize` 의 그것은 기호를
 * 남기므로 **계약이 다르다**. 같은 이름으로 두면 grep 이 서로 다른 답을 준다(실측: 정의가
 * 3개였다).
 */
function foldLabelForMatch(raw: string): string {
  return toNfc(raw).replace(/[\s\-_/·,.()[\]{}]/g, "").toLowerCase();
}

/**
 * 캠페인 라벨에서 **식별 토큰**을 뽑는다. 2자 미만은 우연 일치가 너무 흔해 버린다.
 *
 * ⚠️ 불용어 목록을 두지 않는 것은 **의도**다. 이 점수는 절대 문턱이 아니라 후보 사이의
 * **상대 판별자**로만 쓰이므로(아래 `pickByLabelTokens`), 「회차」·「광고」처럼 모든 후보가
 * 공유하는 토큰은 전 후보의 점수를 똑같이 올려 순위를 바꾸지 못한다. 순위를 가르는 것은
 * 결국 그 캠페인에만 있는 토큰이다 — 목록을 손으로 관리하면 오히려 그게 표류한다.
 */
function identityTokens(label: string): string[] {
  // 쪼개기 전에 NFC 로 맞춘다 — 구분자 매칭이 형태에 좌우되지 않게.
  // ⚠️ **아래 `length >= 2` 때문은 아니다.** 그 필터는 `foldLabelForMatch`(내부에 NFC) 를
  //    거친 뒤에 걸리므로 선행 정규화가 없어도 토큰 집합은 같다 — 실측으로 확인했고,
  //    종전 주석은 그 순서를 잘못 읽어 「없으면 토큰이 갈린다」고 적고 있었다.
  return toNfc(label)
    .split(/[\s\-_/·,.()[\]{}×xX]+/)
    .map((token) => foldLabelForMatch(token))
    .filter((token) => token.length >= 2);
}

/** 품목명들을 한 덩어리로 이어 붙인다(정규화 후, 줄 사이는 `|`). 이름이 없으면 빈 문자열. */
export function lineItemNamesHaystack(names: ReadonlyArray<string | null | undefined>): string {
  return names
    .filter((name): name is string => Boolean(name))
    .map((name) => foldLabelForMatch(name))
    .join("|");
}

/** 라벨의 식별 토큰 중 품목명 덩어리에 들어 있는 개수 — 0 이면 그 라벨을 지목하지 않은 것이다. */
export function scoreLabelAgainstLineItems(label: string, haystack: string): number {
  if (haystack.length === 0) return 0;
  return identityTokens(label).filter((token) => haystack.includes(token)).length;
}

/**
 * 품목명으로 후보를 좁힌다. **유일한 최고 점수**일 때만 채택한다 — 동점·무신호면 `null`.
 * 조용히 하나를 고르지 않는다.
 */
export function pickByLabelTokens<T>(
  candidates: readonly T[],
  labelOf: (candidate: T) => string,
  haystack: string,
): T | null {
  if (haystack.length === 0) return null;

  let best: T | null = null;
  let bestScore = 0;
  let tied = false;

  for (const candidate of candidates) {
    const score = scoreLabelAgainstLineItems(labelOf(candidate), haystack);
    if (score === 0) continue;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }

  return tied ? null : best;
}
