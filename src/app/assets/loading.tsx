import { Skeleton } from "@/components/ui/skeleton";
import { CrmShell } from "@/components/crm/crm-shell";

export default function AssetsHubLoading() {
  return (
    <CrmShell
      title={<Skeleton className="h-6 w-32" />}
      description=""
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-4 rounded-2xl border border-white/70 bg-white/60 p-5 shadow-soft-sm">
              <Skeleton className="size-11 rounded-xl" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </CrmShell>
  );
}
