import { connection } from "next/server";
import { CalendarPageClient } from "./calendar-page-client";
import { getScheduleGapBriefing } from "@/lib/schedule-gap-briefing";

export const metadata = {
  title: "캘린더 | WAG CRM",
};

export default async function CalendarPage() {
  // 매출 공백 브리핑은 getScheduleGapBriefing() 내부에서 new Date()(현재 시각)를
  // 읽는다. Next 16 Cache Components는 서버 컴포넌트가 현재 시각을 읽기 전에
  // Request 데이터 접근을 요구하므로 connection()으로 동적 렌더를 명시한다.
  await connection();
  // 대시보드와 동일 소스 — 요약 스트립 + 그리드 틴트용 스냅샷.
  const briefing = await getScheduleGapBriefing();
  return <CalendarPageClient briefing={briefing} />;
}
