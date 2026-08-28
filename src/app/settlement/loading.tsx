import { Skeleton } from "@/components/ui/skeleton";
import { CrmShell } from "@/components/crm/crm-shell";

export default function SettlementLoading() {
  return (
    <CrmShell
      title={<Skeleton className="h-6 w-32" />}
      description=""
    >
      <div className="flex min-h-[calc(100dvh+1px)] md:min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        {/* Statistics Summary Bar Skeleton */}
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200/60 bg-white/80 px-4 py-2.5 shadow-soft-sm backdrop-blur-sm shrink-0">
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="flex items-center gap-1.5">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-12" />
          </div>
        </div>

        {/* Table Card Container Skeleton */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
          {/* Top Bar Skeleton */}
          <section className="flex min-h-12 shrink-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border/70 px-5 py-3 bg-white/40">
            <div className="flex flex-wrap items-center gap-3.5">
              <Skeleton className="h-5 w-24 shrink-0" />
              <Skeleton className="h-9 w-20 rounded-lg" />
              <Skeleton className="h-9 w-28 rounded-lg" />
            </div>
            <div className="flex items-center gap-3">
              <Skeleton className="h-9 w-48 rounded-lg" />
              <Skeleton className="h-9 w-24 rounded-lg" />
              <Skeleton className="h-9 w-20 rounded-lg" />
            </div>
          </section>

          {/* List Skeleton */}
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-10 rounded-full" />
              </div>
              <div className="rounded-xl border border-border/60 bg-white/50 p-4 space-y-4">
                <div className="flex gap-4 border-b border-slate-100 pb-2">
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 flex-1" />
                </div>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex gap-4 items-center">
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
