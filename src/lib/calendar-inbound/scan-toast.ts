// [캘린더수집] 「캘린더에서 가져오기」 결과 토스트 문구 — 순수 함수(화면이 import 한다).
// 설계 §7: 「기안 N건 올림 · 해석 못 함 M건 · 이미 처리 K건」.
import type { ScanSummary } from "./scan";

export type InboundScanToast = { message: string; tone: "success" | "warning" };

/**
 * 세 칸은 0 이어도 늘 싣는다 — 「0건」도 「읽긴 읽었다」는 답이다.
 * - 이미 처리 = 같은 지문·결정 대기 기안이 있어 건너뛴 것 + 바꿀 칸이 없어 기안 없이 끝난 것.
 *   CRM 이 만든 일정(`crmOwned`)은 세지 않는다 — 오너가 적은 일정이 아니라 매번 수십 건이 「처리」로 보인다.
 * - 다음에 이어서 = 회차 상한(기안·해석 도우미 호출)에 걸려 이번에 손대지 않은 것. 있을 때만.
 * - 처리 실패 = 한 건 처리 중 예외. 있을 때만, 주의 톤 — 조용히 삼키면 「다 됐다」로 읽힌다.
 */
export function formatInboundScanToast(s: ScanSummary): InboundScanToast {
  const parts = [
    `기안 ${s.proposed}건 올림`,
    `해석 못 함 ${s.skippedUnparsed}건`,
    `이미 처리 ${s.alreadyHandled + s.adoptedNoop}건`,
  ];
  const later = s.dropped + s.hintDeferred;
  if (later > 0) parts.push(`다음에 이어서 ${later}건`);
  if (s.errors > 0) parts.push(`처리 실패 ${s.errors}건`);
  return { message: parts.join(" · "), tone: s.errors > 0 ? "warning" : "success" };
}
