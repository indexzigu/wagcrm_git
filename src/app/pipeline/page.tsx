import { CrmDashboard } from "@/components/crm/crm-dashboard";
import { TrackingParamCapture } from "@/components/crm/tracking-param-capture";
import { getDashboardData } from "@/lib/dashboard-data";
import { isMobileUserAgent } from "@/lib/mobile-user-agent";
import { headers } from "next/headers";
import { connection } from "next/server";

// /pipeline 은 운영자의 라이브 실행 보드라 카드 드래그(=campaign status write)로 자기
// 캐시를 자기가 깨는 고빈도 mutation 표면이다 — 서버 ISR 캐시가 read 로 상각되기 전에
// 다음 mutation 이 와서, 캐시 이득 없이 재생성 비용만 반복된다(write:read 역전). use cache
// 래퍼(getCachedDashboardData)를 걷어내고 getDashboardData 를 직접 호출 → loading.tsx
// (Suspense 경계) 위에서 PPR 동적 렌더(정적 셸 + 요청당 스트리밍)로 전환한다. 이 표면의
// ISR write 를 제거하고 총 렌더 수도 줄여 Fluid CPU 도 함께 절감. 신선도는 클라이언트
// TanStack Query(useCampaigns)가 이어받는다. cache-policy.ts 의 CRM_DYNAMIC_SURFACES(pipeline) 참조.
export default async function PipelinePage() {
  // getDashboardData 내부의 new Date() 가 정적 프리렌더 때 실행되지 않도록 이 렌더를
  // 요청 시점 렌더로 표시한다(Next 16). loading.tsx 정적 셸 + 요청당 스트리밍은 유지.
  await connection();
  // 모바일 캠페인 탭은 조회 전용이라 마스터데이터(딜·셀러 등)를 쓰는 진입점이 없다 —
  // 요청당 동적 렌더 표면이므로 UA 로 경량 로드(mobileLite)를 골라 탭 진입 비용을 줄인다.
  // 판정 정본은 클라이언트 useIsMobile 과 동일 정규식(src/lib/mobile-user-agent.ts) —
  // 서버=모바일·클라=데스크톱 불일치가 생기면 데스크톱 UI 가 빈 마스터데이터를 받는다.
  const headerStore = await headers();
  const isMobileRequest = isMobileUserAgent(headerStore.get("user-agent"));
  const data = await getDashboardData({
    workspace: "pipeline",
    scope: isMobileRequest ? "mobileLite" : "full",
  });
  return (
    <>
      <TrackingParamCapture />
      <CrmDashboard
        initialData={data}
        lockedStageFilter="PROGRESS"
        createDefaultStatus="PREPARATION"
      />
    </>
  );
}
