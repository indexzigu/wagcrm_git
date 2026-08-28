import { CrmDashboard } from "@/components/crm/crm-dashboard";
import { TrackingParamCapture } from "@/components/crm/tracking-param-capture";
import { getDashboardData } from "@/lib/dashboard-data";
import { isMobileUserAgent } from "@/lib/mobile-user-agent";
import { headers } from "next/headers";
import { connection } from "next/server";

/**
 * 모바일 "업무 처리" 탭 (v3.2) — /pipeline 과 동일 데이터·컴포넌트를 재사용하고
 * 모바일 뷰 모드만 tasks 로 고정한다. 데스크탑 UA 로 접근하면 CrmDashboard 의
 * 데스크탑 분기가 그대로 렌더된다(모바일 전용 프롭이라 무영향).
 *
 * /pipeline 과 동일하게 use cache 래퍼를 걷어낸 동적 표면이다(2026-07-12 ISR write
 * churn 제거 — cache-policy.ts CRM_DYNAMIC_SURFACES 참조). 상위 세그먼트의
 * loading.tsx 가 Suspense 경계를 제공한다.
 */
export default async function PipelineTasksPage() {
  // /pipeline 과 동일: new Date() 프리렌더 실행 방지를 위해 요청 시점 렌더로 표시(Next 16).
  await connection();
  // /pipeline 과 동일한 모바일 경량 로드(mobileLite) — 이 화면도 모바일에선 조회 전용이라
  // 마스터데이터 소비처가 없다. 판정 정본은 src/lib/mobile-user-agent.ts(클라와 동일 정규식).
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
        mobilePipelineMode="tasks"
      />
    </>
  );
}
