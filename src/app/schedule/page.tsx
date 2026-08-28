import { MobileCalendarHome } from "@/components/mobile/mobile-calendar-home";
import { getScheduleGapBriefing } from "@/lib/schedule-gap-briefing";
import { getCalendarMonthCampaigns } from "@/lib/mobile-calendar-data";
import { headers } from "next/headers";
import { getAuthContext } from "@/lib/auth-context";
import { LandingLogin } from "@/components/auth/landing-login";

function isMobileUserAgent(userAgent: string | null) {
  if (!userAgent) return false;
  return /Android|iPhone|iPad|iPod|Mobile|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
}

export default async function SchedulePage() {
  const auth = await getAuthContext();

  if (!auth) {
    return <LandingLogin />;
  }

  const headerStore = await headers();
  const isMobileRequest = isMobileUserAgent(headerStore.get("user-agent"));
  
  // Mobile Is Not Desktop Parity: /schedule is specifically for the mobile calendar tab.
  if (!isMobileRequest) {
    return <div>Desktop users should use the sidebar calendar instead.</div>;
  }

  // #149 리뷰 후속: 파이프라인 스냅샷 읽기 제거 — 자금 칩은 #149에서 홈 정산 카드로
  // 이관됐고, 이 탭의 잔여 소비는 도달 불가능한 폴백뿐이었다(캘린더 월 데이터가 정본).
  const now = new Date();
  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const gapBriefing = await getScheduleGapBriefing(now);
  const mobileCampaigns = await getCalendarMonthCampaigns(year, monthIndex + 1);

  return (
    <div className="flex flex-col min-h-screen bg-slate-50 pb-[calc(env(safe-area-inset-bottom)+3.5rem)]">
      <main className="flex-1 overflow-y-auto">
        <MobileCalendarHome
          gapBriefing={gapBriefing}
          initialYear={year}
          initialMonthIndex={monthIndex}
          initialCampaigns={mobileCampaigns}
        />
      </main>
    </div>
  );
}
