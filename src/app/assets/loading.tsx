import { Skeleton } from "@/components/ui/skeleton";
import { CrmShell } from "@/components/crm/crm-shell";

/**
 * /assets/{price-sheets,katalk,inbox} 공용 로딩 — 하위 화면이 전부 「카드 하나 + 목록」이라 그 꼴만
 * 그린다(옛 허브 3카드 격자는 허브가 사라져 어느 화면과도 맞지 않았다). 페이지 머리는 없다(2026-10-21
 * 오너 방침) — 본문과 같은 자리에서 카드가 시작해 로딩→본문 전환에 내용 시작선이 움직이지 않는다.
 */
export default function AssetsSectionLoading() {
  return (
    <CrmShell>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-ambient">
          <div className="flex shrink-0 items-center justify-end border-b border-border bg-card px-5 py-2">
            <Skeleton className="h-9 w-48 rounded-lg" />
          </div>
          <div className="flex flex-col divide-y divide-border/60">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </CrmShell>
  );
}
