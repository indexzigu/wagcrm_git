import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto px-5 pb-5 pt-5 md:px-8">
      <div className="dashboard-section-gap">
        {/* KPI Cards skeleton grid */}
        <div className="dashboard-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="relative overflow-hidden rounded-[var(--radius-3xl)] border border-white/40 bg-white/60 p-6 backdrop-blur-xl"
            >
              <Skeleton className="mb-2 h-3 w-24" />
              <Skeleton className="mb-4 h-10 w-36" />
              <div className="space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-3/4" />
              </div>
            </div>
          ))}
        </div>

        {/* Chart section skeleton */}
        <div className="rounded-lg border border-border/70 bg-white p-6">
          <Skeleton className="mb-2 h-5 w-40" />
          <Skeleton className="mb-4 h-3 w-64" />
          <Skeleton className="h-[280px] w-full" />
        </div>

        {/* Campaign summary skeleton */}
        <div className="rounded-lg border border-border/70 bg-white p-6">
          <Skeleton className="mb-4 h-4 w-36" />
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-20" />
            ))}
          </div>
        </div>

        {/* Performance section skeleton */}
        <div className="rounded-lg border border-border/70 bg-white p-6">
          <Skeleton className="mb-4 h-4 w-28" />
          <div className="performance-grid">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-3">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
