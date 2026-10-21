// [캘린더수집] 「캘린더에서 가져오기」 결과 토스트 문구 — 순수 함수(화면이 import 한다).
// 설계 §7: 「기안 N건 올림 · 해석 못 함 M건 · 이미 처리 K건」.
import type { ScanSummary } from "./scan";

/** 가져오기가 이미 도는 중일 때(단일 실행 잠금에 걸림) 안내. */
export const INBOUND_SCAN_BUSY_MESSAGE = "이미 가져오는 중입니다. 잠시 뒤 다시 눌러 주세요.";

export type InboundScanToast = {
  message: string;
  tone: "success" | "warning" | "info";
  /** 기안을 1건 이상 올렸다 — 토스트에 「결재함 열기」 버튼을 단다. */
  openApprovals: boolean;
};

/**
 * 세 칸은 0 이어도 늘 싣는다 — 「0건」도 「읽긴 읽었다」는 답이다.
 * - 이미 처리 = 같은 지문·결정 대기 기안이 있어 건너뛴 것 + 바꿀 칸이 없어 기안 없이 끝난 것.
 *   CRM 이 만든 일정(`crmOwned`)은 세지 않는다 — 오너가 적은 일정이 아니라 매번 수십 건이 「처리」로 보인다.
 * - 다음에 이어서 = 회차 상한(기안 수·시간)에 걸려 이번에 손대지 않은 것. 있을 때만.
 * - 해석 대기 = 규칙으로 못 풀어 모델 해석을 기다리는 것(다음 가져오기에서 이어서 푼다). 있을 때만.
 * - 처리 실패 = 한 건 처리 중 예외. 있을 때만, 주의 톤 — 조용히 삼키면 「다 됐다」로 읽힌다.
 */
export function formatInboundScanToast(s: ScanSummary): InboundScanToast {
  // 다른 회차(크론 또는 다른 탭)가 도는 중 — 이번 회차는 아무것도 하지 않았다. 숫자 0건을 보이면 「읽었는데 없었다」로 읽힌다.
  if (s.skipped === "busy") return { message: INBOUND_SCAN_BUSY_MESSAGE, tone: "info", openApprovals: false };
  const parts = [
    `기안 ${s.proposed}건 올림`,
    `해석 못 함 ${s.skippedUnparsed}건`,
    `이미 처리 ${s.alreadyHandled + s.adoptedNoop}건`,
  ];
  if (s.dropped > 0) parts.push(`다음에 이어서 ${s.dropped}건`);
  if (s.awaitingHint > 0) parts.push(`해석 대기 ${s.awaitingHint}건`);
  if (s.errors > 0) parts.push(`처리 실패 ${s.errors}건`);
  return { message: parts.join(" · "), tone: s.errors > 0 ? "warning" : "success", openApprovals: s.proposed > 0 };
}
