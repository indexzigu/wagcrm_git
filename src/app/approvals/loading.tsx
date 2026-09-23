import { Skeleton } from "@/components/ui/skeleton";
import { CrmShell } from "@/components/crm/crm-shell";
import { HubSkeleton } from "@/components/crm/approvals/hub-states";

/**
 * 결재함 로딩 — `settlement/loading.tsx` 와 같은 형태(셸 + 컨테이너 + 스켈레톤).
 * 본문 스켈레톤은 `page.tsx` 의 Suspense fallback 과 **같은 컴포넌트**를 쓴다 —
 * 두 벌로 갈리면 로딩→본문 전환에서 높이가 튄다(P8 Layout Stability).
 */
export default function ApprovalsLoading() {
  return (
    <CrmShell title={<Skeleton className="h-6 w-24" />} description="">
      <div className="px-5 pb-5 pt-5 md:px-8">
        <div className="flex flex-col rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
          <HubSkeleton />
        </div>
      </div>
    </CrmShell>
  );
}
