import { DashboardHome } from "@/components/crm/dashboard-home";
import { MobileHomeView } from "@/components/mobile/mobile-home-view";
import {
  getCachedDesktopDashboardData,
  getCachedMobileSettlementCampaigns,
} from "@/lib/cached-crm-data";
import { headers } from "next/headers";
import { getAuthContext } from "@/lib/auth-context";
import { LandingLogin } from "@/components/auth/landing-login";

function isMobileUserAgent(userAgent: string | null) {
  if (!userAgent) return false;
  return /Android|iPhone|iPad|iPod|Mobile|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
}

export default async function Home() {
  const auth = await getAuthContext();

  if (!auth) {
    return <LandingLogin />;
  }

  const headerStore = await headers();
  const isMobileRequest = isMobileUserAgent(headerStore.get("user-agent"));

  if (isMobileRequest) {
    // 정산 대기(입금·지급) 지표 — 카드가 실제로 소비하는 필드만 select하는 전용
    // 경량 스냅샷(#149 code-review 후속). 기존 getCachedDashboardData("pipeline")
    // kitchen-sink(9개 병렬 쿼리+deep include) 소비를 대체해 pipeline 태그 무효화
    // 시 재계산 비용을 줄인다. 데스크톱 데이터와 병렬로 읽어 캐시 미스 시에도
    // TTFB에 왕복을 더하지 않는다.
    const [data, settlementCampaigns] = await Promise.all([
      getCachedDesktopDashboardData(),
      getCachedMobileSettlementCampaigns(),
    ]);
    return <MobileHomeView initialData={data} campaigns={settlementCampaigns} />;
  }

  const data = await getCachedDesktopDashboardData();

  return <DashboardHome initialData={data} />;
}
