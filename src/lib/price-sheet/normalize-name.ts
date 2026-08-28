/**
 * 제품명·옵션명 정규화 — 추출 단계에서 한 번만 적용한다(경로 A·B 공용).
 *
 * 왜 필요한가(실사고 2026-08-01): 엑셀 가격표는 **한 셀 안에서 줄바꿈으로 스펙을
 * 나열**하는 것이 관례다. 실제 시트의 제품명 15/16 행이 이 형태였다:
 *
 *   "1. 스노우 펄 실버 네크리스\r\n(실버925+18k골드 밀스도금\r\n+핵진주\r\n체인 40cm"
 *
 * 이 값이 그대로 딜명이 되면 **딜 목록·발주서·캠페인명 등 그 이름을 쓰는 모든 표면**
 * 으로 줄바꿈이 번진다. 특히 묶음 반영은 하위딜명을 `상위딜명 - 제품명` 으로 조합하므로
 * 이름 한가운데가 끊긴다.
 *
 * 선행 번호(`1. `)도 같은 이유로 뗀다 — 가격표 **안에서만** 의미 있는 순번이라 딜명에
 * 남을 이유가 없고, 순서가 바뀌면 딜명까지 흔들린다.
 *
 * ⚠️ **원본 셀은 보존된다.** `rawCells` 에 손대지 않으므로 검수 화면의 "원본 셀"
 * 툴팁에서 언제든 원문을 확인할 수 있다 — 정규화는 표시·저장용 값에만 건다.
 */

/**
 * 선행 번호 접두 — `1. ` / `12) ` 형태만 뗀다.
 *
 * ⚠️ 구분자 뒤 **공백을 필수**로 둔다. 없으면 `2.5mm 테니스팔찌` 의 `2.` 를 번호로
 * 오인해 `5mm 테니스팔찌` 가 된다(이 시트에 실제로 있는 제품명이다).
 */
const LEADING_INDEX_RE = /^\s*\d{1,3}[.)]\s+/;

/** 줄바꿈·탭 등 모든 공백류. 셀 안 줄바꿈을 한 칸 공백으로 접는다. */
const WHITESPACE_RUN_RE = /\s+/g;

/**
 * 이름 한 줄로 접기. null·빈 문자열은 null 로 통일한다
 * (빈 문자열이 남으면 `missingRequiredField` 판정이 갈린다).
 */
export function normalizeItemName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const collapsed = raw.replace(WHITESPACE_RUN_RE, " ").trim();
  if (!collapsed) return null;
  const withoutIndex = collapsed.replace(LEADING_INDEX_RE, "").trim();
  // 번호만 있고 이름이 없는 셀("3.")은 번호를 떼면 빈 값이 된다 — 그때는 원본을
  // 남긴다(이름이 사라지는 것보다 이상한 이름이 검수에 걸리는 편이 낫다).
  return withoutIndex || collapsed;
}
