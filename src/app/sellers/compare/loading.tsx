import { Skeleton } from "@/components/ui/skeleton";

// [셀러분석] 셀러 비교표 로딩 — 라벨 열 + 셀러 열 4개 모양의 뼈대(실제 표와 같은 폭 규칙).
export default function SellerCompareLoading() {
  return (
    <div className="flex flex-col gap-4 px-5 py-6 md:px-8" aria-busy="true" aria-label="셀러 비교표 불러오는 중">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-6 w-28" />
      </div>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
        {Array.from({ length: 9 }).map((_, row) => (
          <div key={row} className="flex gap-3 border-b border-slate-100 px-3 py-3 last:border-b-0">
            <Skeleton className="h-4 w-32 shrink-0" />
            {Array.from({ length: 4 }).map((__, col) => (
              <Skeleton key={col} className="h-4 min-w-[112px] flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
