import { redirect } from "next/navigation";

/**
 * 「자동화 및 알림」 설정 화면은 은퇴했다 — 알림 크론·알림센터 해체(2026-07-24) 뒤로
 * 이 화면의 토글 3종(셀러 무응답 · 정산 지연 · 정체 상태)을 읽는 백엔드가 없었고,
 * `GET /api/settings/reminders` 가 `scheduleThresholds` 만 돌려줘 렌더 중 구 필드를
 * 역참조하다 화면이 깨졌다. 살아 있는 설정(일정 확보 기준일)은 운영 정책 화면이 소유한다.
 *
 * 경로를 지우지 않고 리다이렉트로 남기는 이유: 북마크·옛 딥링크가 404 로 떨어지지 않게
 * 하기 위해서다. 선례는 `src/app/assistant/page.tsx` · `src/app/settings/page.tsx`.
 *
 * ⚠️ API `/api/settings/reminders` 는 은퇴 대상이 아니다 — 운영 정책 화면
 * (`operations-settings-client.tsx`)이 일정 확보 기준일을 그 경로로 읽고 쓴다.
 */
export default function ReminderSettingsPage() {
  redirect("/settings/operations");
}
