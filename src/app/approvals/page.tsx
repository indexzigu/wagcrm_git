import * as React from "react";
import { CrmShell } from "@/components/crm/crm-shell";
import { ApprovalHub } from "@/components/crm/approvals/approval-hub";
import { HubSkeleton } from "@/components/crm/approvals/hub-states";

/**
 * 결재함 — 봇·화면에서 올라온 기안을 결재하고 봇의 조회 결과·작업 기록을 보는 화면
 * (Plan 2 Task 4).
 *
 * ⚠️ `export const dynamic` 을 붙이지 말 것 — 이 앱은 `cacheComponents` 를 켠 Next 16
 * 이라 그 지시자와 함께 쓸 수 없다.
 *
 * `ApprovalHub` 는 `useSearchParams`(`useFilterParams`)를 쓰는 클라이언트 컴포넌트라
 * **Suspense 경계가 필수**다 — 없으면 빌드가 막힌다. fallback 은 탭바+카드 자리를
 * 그대로 예약하는 허브 스켈레톤이다(`loading.tsx` 와 같은 것을 쓴다).
 */
export default function ApprovalsPage() {
  return (
    <CrmShell
      title="결재함"
      description="봇과 화면에서 올린 기안을 결재하고, 봇의 조회 결과와 작업 기록을 봅니다"
    >
      <div className="px-5 pb-5 pt-5 md:px-8">
        <div className="flex flex-col rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
          <React.Suspense fallback={<HubSkeleton />}>
            <ApprovalHub />
          </React.Suspense>
        </div>
      </div>
    </CrmShell>
  );
}
