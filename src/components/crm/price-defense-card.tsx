"use client";

import * as React from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * 최저가 방어 카드 — 알림센터 해체(2026-07-24 오너 확정)의 대체 표면.
 *
 * 종전 PRICE_VIOLATION 알림이 유일하게 나르던 신호를 홈 대시보드 상시 카드로
 * 옮긴다. 매일 도는 상시 감시라 위반 0건이어도 숨기지 않고(시스템 레이더와
 * 같은 논리) "확인이 돌았고 문제없음"을 조용한 한 줄로 보여준다 — 데이터
 * 점검 카드의 0건 미렌더는 "드문 사람 실수"에 맞는 처리라 여기엔 맞지 않다
 * (ss-ux 판정).
 *
 * 데이터 점검과 탭으로 묶을 때(오너 2026-07-24), 탭 배지에 위반 수를 실으려면
 * 데이터가 탭 레벨에서 필요하다 → fetch 를 `usePriceOverview` 훅으로 분리하고
 * 표현부를 `PriceDefenseBody`(카드·제목 없는 bare) 로 분리했다. `PriceDefenseCard`
 * 는 그 둘을 조립한 풀폭 버전으로, 종전 사용처·계약 테스트와 동일하게 동작한다.
 */

export type PriceOverview = {
  monitoredCount: number;
  latestSnapshotDate: string | null;
  counts: { ok: number; tie: number; violated: number; review: number; noData: number };
  violations: Array<{
    dealId: string;
    campaignId: string | null;
    dealName: string;
    campaignLabel: string | null;
    gap: number | null;
    snapshotDate: string;
  }>;
};

// 판정 분포 범례 — 좋고 나쁨이 있는 축이므로 심각도 토큰만 탄다(P8).
// 정상은 money-in 계열이 아니라 ok 시맨틱 전용 emerald 텍스트 토큰을 쓰지 않고
// 도트로만 표현한다(텍스트는 전부 무채색 — 색은 도트 캐리어에만).
const LEGEND: Array<{ key: keyof PriceOverview["counts"]; label: string; dotClass: string }> = [
  { key: "ok", label: "정상", dotClass: "bg-emerald-600" },
  { key: "tie", label: "동가", dotClass: "bg-slate-400" },
  { key: "violated", label: "위반", dotClass: "bg-status-urgent" },
  { key: "review", label: "검토", dotClass: "bg-status-caution" },
  { key: "noData", label: "데이터 없음", dotClass: "bg-slate-300" },
];

function formatWon(value: number): string {
  return `${value.toLocaleString("ko-KR")}원`;
}

export interface PriceOverviewState {
  data: PriceOverview | null;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

// 최저가 현황 fetch 훅 — 풀폭 카드와 탭 패널이 공유한다. 탭 레벨에서 쓰면
// 위반 수가 탭 배지로 반응형 반영된다(fetch 완료 전 0 → 완료 후 실수치).
export function usePriceOverview(): PriceOverviewState {
  const [data, setData] = React.useState<PriceOverview | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);

  const refetch = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/price-monitoring/overview");
      if (!res.ok) throw new Error(`overview ${res.status}`);
      setData(await res.json());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}

// 판정 분포 범례 — 카드 헤더/탭 패널 어디서도 재사용.
export function PriceDefenseLegend({ counts }: { counts: PriceOverview["counts"] }) {
  return (
    <span className="flex items-center gap-2.5 text-[11px] text-muted-foreground flex-wrap">
      {LEGEND.filter((l) => counts[l.key] > 0).map((l) => (
        <span key={l.key} className="flex items-center gap-1 whitespace-nowrap">
          <span className={cn("size-1.5 rounded-full", l.dotClass)} aria-hidden />
          {l.label} <b className="font-semibold text-slate-600">{counts[l.key]}</b>
        </span>
      ))}
    </span>
  );
}

// bare 표현부 — Card·제목 없이 로딩/위반목록/안심문구/오류만. 탭 패널이 직접 소비한다.
export function PriceDefenseBody({ data, loading, error, refetch }: PriceOverviewState) {
  if (loading) {
    return (
      <div className="space-y-2 pt-1" aria-hidden>
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-2.5 py-1">
            <span className="size-1.5 shrink-0 rounded-full bg-muted animate-pulse" />
            <span className="h-3.5 rounded bg-muted animate-pulse" style={{ width: `${64 - i * 18}%` }} />
          </div>
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-2 pt-1 text-xs text-slate-500">
        최저가 현황을 불러오지 못했습니다.
        <button
          type="button"
          onClick={refetch}
          className="rounded-md border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
        >
          다시 시도
        </button>
      </div>
    );
  }
  if (data && data.violations.length > 0) {
    return (
      <ul className="stagger-fade-in">
        {data.violations.map((v) => (
          <li key={`${v.dealId}:${v.campaignId ?? ""}`} className="border-b border-slate-100 last:border-b-0">
            <Link
              href={v.campaignId ? `/pipeline?peek=${v.campaignId}` : `/deals?selected=${v.dealId}`}
              className="group flex items-center gap-2.5 py-2 px-1 transition-colors hover:bg-muted/40 rounded-md"
            >
              <span className="size-[7px] shrink-0 rounded-full bg-status-urgent" aria-hidden />
              <span className="min-w-0 truncate text-[13px] font-semibold text-slate-700 group-hover:text-[var(--primary)]">
                {v.dealName}
              </span>
              {v.campaignLabel && <span className="shrink-0 text-[11px] text-muted-foreground">{v.campaignLabel}</span>}
              <span className="ml-auto shrink-0 text-[12px] font-bold text-status-urgent-text tabular-nums">
                {v.gap !== null && v.gap > 0 ? `1위보다 ${formatWon(v.gap)} 비쌈` : "최저가 이탈"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="flex items-center gap-2.5 pt-1 text-xs text-slate-600">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 text-[12px] font-bold border border-emerald-100">
        ✓
      </span>
      전 딜 최저가 이상 없음
      <span className="text-[11px] text-slate-400">
        모니터링 {data?.monitoredCount ?? 0}딜
        {data?.latestSnapshotDate ? ` · ${data.latestSnapshotDate} 스냅샷` : ""}
      </span>
    </div>
  );
}

// 풀폭 카드 — 종전 사용처·계약 테스트와 동일 동작. (대시보드 홈은 데이터 점검과
// 탭으로 묶으면서 이 풀폭 버전 대신 bare 표현부를 직접 쓴다.)
export function PriceDefenseCard() {
  const state = usePriceOverview();
  const { data, loading, error } = state;

  // 모니터링 대상이 아예 없으면 카드 자체를 접는다 — 기능을 안 쓰는 동안
  // 빈 카드가 자리를 차지하는 것이 유일하게 무의미한 경우다.
  if (!loading && !error && data && data.monitoredCount === 0) return null;

  return (
    <Card className="border-black/5 bg-white/85 shadow-soft-sm">
      <CardContent className="px-4 py-3">
        <div className="flex items-center gap-2 pb-2 border-b border-slate-100 flex-wrap">
          <ShieldCheck className={cn("size-4.5", data && data.counts.violated > 0 ? "text-status-urgent" : "text-emerald-600")} />
          <h3 className="text-sm font-bold text-[var(--primary)] tracking-tight">최저가 점검</h3>
          {data && data.counts.violated > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-status-urgent/10 px-1 text-[10px] font-bold text-status-urgent-text border border-status-urgent/20">
              {data.counts.violated}
            </span>
          )}
          {data && <span className="ml-auto">{<PriceDefenseLegend counts={data.counts} />}</span>}
        </div>
        <div className="pt-1.5">
          <PriceDefenseBody {...state} />
        </div>
      </CardContent>
    </Card>
  );
}
