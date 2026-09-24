import {
  formatFollowerCount,
  calculateBarWidth,
} from "@/lib/partner-seller-display";

type FollowerBarCellProps = {
  count: number | null | undefined;
};

// 값과 막대를 즉시 그린다 — P8 「데이터는 즉시 렌더」. 행마다 0→N 으로 세던 카운트업은
// 가드레일 4(홈 KPI 전용 예외) 밖이었고 모션 줄이기 설정도 무시했다(2026-09-24 점검).
export function FollowerBarCell({ count }: FollowerBarCellProps) {
  const value = count ?? 0;

  return (
    <div className="flex w-[150px] shrink-0 items-center gap-2">
      <span className="inline-block w-[68px] shrink-0 text-xs tabular-nums text-right select-none">
        {formatFollowerCount(value)}
      </span>
      <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-slate-100">
        <div
          className="absolute inset-y-0 left-0 rounded-sm bg-emerald-400"
          style={{ width: `${calculateBarWidth(value)}%` }}
        />
      </div>
    </div>
  );
}
