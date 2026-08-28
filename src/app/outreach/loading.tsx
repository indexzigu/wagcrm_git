import { Skeleton } from "@/components/ui/skeleton";
import { CrmShell } from "@/components/crm/crm-shell";

export default function OutreachLoading() {
  return (
    <CrmShell
      title={<Skeleton className="h-6 w-32" />}
      description=""
    >
      <div className="flex min-h-[calc(100dvh+1px)] md:min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
          {/* Filters Bar Skeleton */}
          <div className="crm-topbar flex flex-col gap-4 border-b border-border/70 px-5 py-3 md:flex-row md:items-center md:justify-between shrink-0 bg-white/40">
            <div className="flex flex-1 items-center gap-3">
              <Skeleton className="h-9 w-full sm:max-w-xs rounded-lg" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 w-32 rounded-lg" />
              <Skeleton className="h-9 w-24 rounded-lg" />
            </div>
          </div>
          {/* Kanban Board Area Skeleton */}
          <div className="flex-1 overflow-y-auto p-5">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start pb-6">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-5 border border-border/60 bg-white/50 rounded-2xl p-5 shadow-soft-sm">
                  <div className="pb-3 border-b border-border/60">
                    <Skeleton className="h-5 w-24 mb-2" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <div className="flex flex-col gap-3">
                    {Array.from({ length: 2 }).map((_, j) => (
                      <div key={j} className="border border-border/60 bg-white rounded-xl p-4 shadow-xs space-y-3">
                        <div className="flex justify-between items-start">
                          <Skeleton className="h-4 w-28" />
                          <Skeleton className="h-4 w-12" />
                        </div>
                        <Skeleton className="h-3 w-36" />
                        <div className="flex justify-between items-center pt-2">
                          <Skeleton className="h-3 w-20" />
                          <Skeleton className="h-6 w-14 rounded-full" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </CrmShell>
  );
}
