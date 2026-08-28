/**
 * 홈택스가 받는 **자유 텍스트 칸의 바이트 상한** SSOT (순수·의존성 0).
 *
 * ## 왜 글자 수가 아니라 바이트인가
 *
 * 홈택스는 입력 검증을 **바이트**로 한다. 종전 이 레포는 비고를 `length <= 200`
 * (글자 수)으로만 잘랐는데, 한글은 한 글자가 여러 바이트라 그 캡을 통과한 문자열이
 * 바이트 상한은 훌쩍 넘는다 — 캡이 있는데도 홈택스가 거부하는 상태였다.
 *
 * ## 상한 100byte의 근거 (오너 실측 2026-08-08 · 티켓 T-025)
 *
 * 헬퍼가 건별발급 폼을 채운 뒤 **오너가 발급 버튼을 누르는 순간** 홈택스가 화면 상단에
 * 100byte 초과 오류를 띄웠다. 종전 주석이 *"실제 상한이 확인되면 이 값과 주석을 그
 * 근거로 교체한다"* 고 예고해 둔 바로 그 교체다(`tax-invoice-builder.ts`).
 *
 * ⚠️ **오류가 어느 칸을 가리켰는지까지는 화면에서 갈리지 않았다.** 그래서 우리가
 * 채우는 자유 텍스트 칸(품목명·품목 비고)에 **전부** 같은 캡을 건다 — 한 칸만 고치면
 * 나머지 칸이 같은 이유로 다시 튕길 때 원인을 처음부터 다시 찾게 된다.
 *
 * ## 왜 UTF-8로 세는가 (보수적으로 센다)
 *
 * 홈택스가 어느 인코딩으로 바이트를 세는지는 확인되지 않았다. 한글은 EUC-KR에서 2바이트,
 * UTF-8에서 3바이트이므로 **UTF-8로 세면 어느 쪽 기준에서도 상한을 넘지 않는다.**
 * 반대로 잡으면(2바이트로 세면) 상대가 UTF-8 기준일 때 그대로 거부당한다 — 틀렸을 때의
 * 대가가 비대칭이라(거부 = 오너가 홈택스 앞에서 멈춤) 짧은 쪽으로 기운다.
 * 정확한 인코딩이 확인되면 이 함수 하나만 고치면 된다.
 */

/** 홈택스 자유 텍스트 칸의 바이트 상한(오너 실측 2026-08-08). */
export const HOMETAX_TEXT_MAX_BYTES = 100;

const encoder = new TextEncoder();

/** UTF-8 바이트 수. 위 주석대로 **보수적인** 척도다. */
export function countHometaxBytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * `maxBytes` 안에 들어가도록 자른다 — 잘렸으면 `marker`를 **붙인 상태로도** 상한을
 * 지킨다(마커까지 포함해 센다).
 *
 * ⛔ 바이트 단위로 잘라 놓고 문자열을 다시 만들지 말 것 — 한글 한 글자가 여러 바이트라
 * 중간에서 자르면 깨진 문자가 남는다. 그래서 **글자 단위로 붙여 가며** 바이트를 센다
 * (서로게이트 쌍이 쪼개지지 않도록 `Array.from` 으로 코드포인트 단위 순회).
 *
 * 잘렸다는 사실을 표시하는 이유: 조용히 자르면 오너가 그 값을 **전체 내역으로 오독**한다.
 */
export function truncateToHometaxBytes(
  text: string,
  marker: string,
  maxBytes: number = HOMETAX_TEXT_MAX_BYTES,
): string {
  if (countHometaxBytes(text) <= maxBytes) return text;

  // 마커 자체가 상한을 넘으면 붙일 자리가 없다 — 이때는 마커 없이 본문만 자른다
  // (마커를 우선해 본문을 통째로 날리는 것이 더 나쁘다).
  const markerBytes = countHometaxBytes(marker);
  const budget = markerBytes < maxBytes ? maxBytes - markerBytes : maxBytes;
  const suffix = markerBytes < maxBytes ? marker : "";

  let kept = "";
  let used = 0;
  for (const char of Array.from(text)) {
    const size = countHometaxBytes(char);
    if (used + size > budget) break;
    kept += char;
    used += size;
  }
  return kept + suffix;
}
