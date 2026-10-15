/**
 * **코드값 → 화면 낱말** — `docs/agents/product-ux.md` P2 「화면 문구 기준」 ③의 구현체.
 *
 * 라벨 표(`campaignStatusLabels` 등)를 거쳐도 표에 없는 값이 오면 종전에는 `표[x] ?? x` 로
 * 영문 코드(`PRICE_SHEET`)가 그대로 화면에 갔다. 이 함수는 그 마지막 갈래만 정한다:
 * - 표에 있으면 표의 낱말.
 * - 값이 없으면(null·빈 문자열) 「—」.
 * - 표에 없고 **영문 코드 모양**(`/^[A-Za-z0-9_]+$/`)이면 「—」 — 코드는 오너가 읽을 수 없다.
 * - 표에 없고 한글 저장값(「응답없음」처럼 폼이 저장한 낱말)이면 그대로.
 *
 * ⚠️ 표에 없는 코드가 「—」로 보이면 **표에 그 코드를 등록하는 것이 수정**이다(③). 이 함수는
 * 등록이 늦을 때 코드가 새지 않게 막는 마지막 칸이지, 등록을 대신하지 않는다.
 * 화면에 이미 「모를 때」 낱말이 있으면(결재함 「알 수 없는 액션」) `unknown` 으로 넘겨 그 낱말로 맞춘다.
 * ⛔ 저장 시점(활동 기록 `fieldName` 처럼 DB 에 남는 값)에는 쓰지 말 것 — 「—」가 영구히 남아
 * 무엇이었는지 잃는다. 화면에 그리는 시점에만 쓴다.
 */

const CODE_SHAPE = /^[A-Za-z0-9_]+$/;

/** 값이 없거나 표에 없는 영문 코드일 때 화면에 내는 글자(값 없음 표기). */
export const NO_LABEL = "—";

export function displayLabel(
  table: Readonly<Record<string, string>>,
  code: string | null | undefined,
  unknown: string = NO_LABEL,
): string {
  if (code == null || code === "") return unknown;
  if (Object.hasOwn(table, code)) return table[code];
  return CODE_SHAPE.test(code) ? unknown : code;
}
