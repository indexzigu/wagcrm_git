import { decrypt } from "@/lib/encryption";

/**
 * 주민등록번호 변경의 **감사 로그 항목**을 만든다.
 *
 * ⚠️ 이전 값이 열리지 않아도 저장을 막지 않는다 (2026-08-13 실사고):
 * 셀프호스팅 컷오버로 `ENCRYPTION_KEY` 가 갈리자, 감사 로그를 만들려고 **기존
 * 암호문을 `decrypt()` 로 복호화하던 저장 경로가 그대로 throw** 해서
 * `PATCH /api/sellers/[id]` 가 500 이 됐다. 그 결과 오너가 **올바른 값을
 * 재입력하는 것조차 불가능**했다 — 고장난 값을 고치려는 행위가 그 고장난 값에
 * 막힌 것이다. 부가 기능(감사 로그)이 주 기능(저장)을 죽여서는 안 된다.
 *
 * 그렇다고 조용히 넘기지도 않는다. 못 연 경우와 "원래 값이 없던" 경우는
 * 감사 기록상 전혀 다른 사건이므로 {@link UNDECRYPTABLE_MARK} 로 구분해 남긴다.
 */

/** 감사 로그 표기 — 앞 6자리(생년월일)만 남기고 뒤는 가린다. */
function mask(plain: string): string {
  return `${plain.slice(0, 6)}-*******`;
}

/**
 * 이전 값이 현재 키로 열리지 않을 때 "이전 값" 자리에 남기는 표식.
 * `null`("값 없음")과 반드시 구분돼야 한다 — 그래야 나중에 감사 로그만 보고도
 * 키 사고가 있었다는 사실을 재구성할 수 있다.
 */
export const UNDECRYPTABLE_MARK = "(복호화 불가)";

export type ResidentNumberAuditEntry = {
  fieldLabel: string;
  curVal: string | null;
  val: string | null;
};

/**
 * 변경이 없으면 `null`, 있으면 감사 항목을 돌려준다.
 *
 * @param currentCipher DB 에 저장돼 있던 값(암호문). 없으면 `null`/`undefined`.
 * @param nextPlain     새로 저장할 평문. 지우는 경우 `null`/빈 문자열.
 */
export function buildResidentNumberAuditEntry(
  currentCipher: string | null | undefined,
  nextPlain: string | null | undefined,
): ResidentNumberAuditEntry | null {
  const next = nextPlain ? nextPlain : null;

  if (!currentCipher) {
    // 이전 값 없음 → 새 값이 있을 때만 변경이다.
    return next === null ? null : { fieldLabel: "주민등록번호", curVal: null, val: mask(next) };
  }

  let current: string | null;
  try {
    current = decrypt(currentCipher);
  } catch {
    // 못 열었다 = 이전 값이 무엇이었는지 알 수 없다. 같은 값인지 판정할 수 없으므로
    // 항상 변경으로 기록한다(모르는 것을 "변경 없음"으로 단정하지 않는다).
    return { fieldLabel: "주민등록번호", curVal: UNDECRYPTABLE_MARK, val: next ? mask(next) : null };
  }

  const currentNormalized = current ? current : null;
  if (currentNormalized === next) return null;

  return {
    fieldLabel: "주민등록번호",
    curVal: currentNormalized ? mask(currentNormalized) : null,
    val: next ? mask(next) : null,
  };
}
