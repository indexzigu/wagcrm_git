import { Skeleton } from "@/components/ui/skeleton";
import { CrmShell } from "@/components/crm/crm-shell";

export default function AssetsLoading() {
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

          {/* Grid Area Skeleton */}
          <div className="flex-1 overflow-y-auto p-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="flex flex-col items-center p-4 border border-border bg-card rounded-xl shadow-xs space-y-3">
                  <Skeleton className="size-12 rounded-lg" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-3 w-12" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </CrmShell>
  );
}
