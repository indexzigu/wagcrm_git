"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export const STEP_COLORS = [
  "bg-slate-200",
  "bg-amber-300",
  "bg-blue-400",
  "bg-green-500",
];

export type StepMetricCardProps = {
  label: string;
  value: string;
  levels: readonly string[];
  onSave: (value: string) => Promise<void>;
};

// 노션 데이터 숫자 접두사(예: '3.홍보+활성')를 정제하여 한글만 표출해 주는 헬퍼 함수
export function cleanScoreLabel(val: string | null | undefined): string {
  if (!val) return "미입력";
  return val.replace(/^\d+\.\s*/, "");
}

/** "N.라벨" 의 숫자 접두사. 없으면 null(= 미입력) */
export function scorePrefix(val: string | null | undefined): number | null {
  if (!val) return null;
  const m = val.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 저장값 → 단계 인덱스. **접두사 우선, 정확 일치는 폴백**이다.
 * 라벨 문구가 개정돼도 기존 저장값이 같은 단계로 계속 매칭되게 한다
 * (`seller-fit.ts` 의 점수 판정도 접두사만 읽으므로 화면과 계산이 같은 기준을 쓴다).
 */
export function matchLevelIndex(levels: readonly string[], value: string): number {
  const exact = levels.indexOf(value);
  if (exact >= 0) return exact;
  const n = scorePrefix(value);
  if (n === null) return -1;
  return levels.findIndex((l) => scorePrefix(l) === n);
}

export function StepMetricCard({
  label,
  value,
  levels,
  onSave,
}: StepMetricCardProps) {
  // 단계 매칭은 **숫자 접두사**로 한다 — 정확 문자열 매칭이면 라벨 문구를 한 번만 고쳐도
  // 기존 저장값("1.5개미만" 등)이 전부 -1 이 되어 화면엔 '미입력'으로 뜨는데 점수 합산
  // (`seller-fit.ts`)은 접두사만 읽어 계속 1점을 센다 — **화면과 계산이 갈린다.**
  // 2026-08-04 광고 반응 문구 개정에서 실제로 걸린 함정이라 여기서 원천 차단한다.
  const activeIndex = matchLevelIndex(levels, value);

  async function handleClick(index: number) {
    const newValue = levels[index];
    if (newValue === value) return;
    try {
      await onSave(newValue);
    } catch {
      // silent
    }
  }

  return (
    <div className="rounded-lg border border-border/70 bg-white/90 p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <TooltipProvider>
        <div className="mt-2 flex items-center gap-1">
          {levels.map((level, idx) => (
            <Tooltip key={level}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => handleClick(idx)}
                  className={`h-4 flex-1 rounded-sm transition-colors ${
                    idx <= activeIndex
                      ? STEP_COLORS[activeIndex]
                      : "bg-slate-100 hover:bg-slate-200"
                  }`}
                />
              </TooltipTrigger>
              <TooltipContent side="top" align="center" className="text-[10px] px-2 py-1 bg-slate-900 text-white font-medium shadow-overlay">
                {cleanScoreLabel(level)}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
      <div className="mt-1 text-[10px] text-muted-foreground text-center truncate" title={cleanScoreLabel(value)}>
        {activeIndex >= 0 ? cleanScoreLabel(levels[activeIndex]) : "미입력"}
      </div>
    </div>
  );
}
