import { Skeleton } from "@/components/ui/skeleton";
import { CrmShell } from "@/components/crm/crm-shell";

export default function SellersLoading() {
  return (
    <CrmShell>
      <div className="flex min-h-[calc(100dvh+1px)] md:min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-ambient">
          {/* Top Bar Skeleton */}
          <div className="crm-topbar flex flex-col gap-4 border-b border-border px-5 py-3 md:flex-row md:items-center md:justify-between shrink-0 bg-card">
            <div className="flex flex-1 items-center gap-3">
              <Skeleton className="h-9 w-full sm:max-w-xs rounded-lg" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 w-24 rounded-lg" />
            </div>
          </div>
          {/* Table Area Skeleton */}
          <div className="flex-1 overflow-y-auto p-5">
            <div className="rounded-xl border border-border bg-card shadow-soft-sm overflow-hidden">
              <div className="border-b border-border bg-muted/60 p-4 flex gap-4">
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 flex-1" />
              </div>
              <div className="p-4 space-y-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex gap-4 items-center">
                    <Skeleton className="h-5 flex-1" />
                    <Skeleton className="h-5 flex-1" />
                    <Skeleton className="h-5 flex-1" />
                    <Skeleton className="h-5 flex-1" />
                    <Skeleton className="h-5 flex-1" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </CrmShell>
  );
}
