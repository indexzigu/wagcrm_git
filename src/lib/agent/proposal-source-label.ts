import { CALENDAR_INBOUND_CREATED_BY } from "@/lib/calendar-inbound/ref";

// 기안 출처 이름 — 결재함 출처 배지(`source-badge.tsx`)와 결재 대기 텔레그램 알림(서버)이 함께 쓴다.
// 종전 위치는 배지 컴포넌트 파일이었다 — 서버 라이브러리가 UI 컴포넌트 파일을 import 하지 않게 여기로 옮겼다.

/**
 * 배지에 적히는 그 말 — 배지를 못 쓰는 자리(텔레그램 알림 같은 평문)가 쓴다.
 * ⛔ 라벨을 그쪽에서 다시 쓰지 말 것: 출처 이름이 바뀌면 한쪽만 낡는다.
 */
export function sourceLabelOf(createdBy: string): string {
  if (createdBy === "AGENT_WORKER") return "슬랙봇";
  if (createdBy === "AGENT") return "어시스턴트";
  if (createdBy === CALENDAR_INBOUND_CREATED_BY) return "캘린더";
  return "직접";
}
