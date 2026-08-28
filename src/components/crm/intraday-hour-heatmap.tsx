"use client";
// 보조뷰 C-1 — 가시 구간의 1시간 히트맵 + 시간대 매출 숫자(확정 설계).
// "색만으로 추이가 약해 숫자를 병기한다"가 채택 근거이므로 **숫자를 빼지 말 것**.
import { buildHourlyCells, type Viewport } from "@/lib/intraday-chart";

type Props = {
  points: Array<{ startMs: number; orders: number; revenue: number }>;
  viewport: Viewport;
};

/**
 * 만원 단위 축약 — 표 안에 24칸이 들어가야 해서 원 단위는 자리 부족이다.
 * 주문은 있는데 매출이 0인 시간대(전액 할인 등)도 `0` 을 찍는다 — 칸에 색은 있는데 숫자만
 * 비면 "색만으로는 약해서 숫자를 병기한다"는 이 뷰의 존재 이유가 그 칸에서 깨진다.
 */
export function formatManwon(revenue: number, hasOrders = false): string {
  if (revenue <= 0) return hasOrders ? "0" : "";
  const manwon = revenue / 10000;
  if (manwon >= 100) return `${Math.round(manwon)}`;
  if (manwon >= 10) return `${manwon.toFixed(0)}`;
  return manwon.toFixed(1);
}

/**
 * 농도 — 최댓값 대비 비율을 알파로 쓴다. **단일 hue 의 순차 스케일**이라
 * P8 §4 가 막는 "좋고 나쁨이 없는 범주의 무지개"가 아니다(같은 지표의 크기 인코딩).
 * 0 은 완전 투명 — 주문 없는 시간대가 옅은 색으로 남으면 "적게 팔렸다"로 오독된다.
 *
 * ⚠️ **상한 0.42 는 대비 때문이다**(P8 §5 표면 종속, 직접 계산):
 * 셀 배경은 `--chart-1`(#0A3D62)를 흰 카드 위에 알파로 얹은 값이라 알파가 오를수록 어두워진다.
 * - 본문색 `--primary`(네이비) 텍스트: α=0.42 에서 4.87:1 ✅ · α=0.5 에서 4.04:1 ❌
 * - 흰 텍스트로 뒤집어도 α≈0.70 이상에서야 4.5:1 을 넘는다
 * → **0.45~0.70 은 두 색 모두 미달인 사각지대**다. 그래서 색을 뒤집는 대신 **사각지대에
 * 들어가지 않게 상한을 자른다**. 종전 0.12~0.80 램프는 중간 농도 전 구간이 미달이었다
 * (slate-500 은 α=0.12 에서 이미 3.84:1). 상한을 올리고 싶으면 대비를 다시 계산할 것.
 */
export function resolveCellAlpha(orders: number, maxOrders: number): number {
  if (orders <= 0 || maxOrders <= 0) return 0;
  return 0.1 + (orders / maxOrders) * 0.32;
}

export function IntradayHourHeatmap({ points, viewport }: Props) {
  const cells = buildHourlyCells(points, viewport);
  const maxOrders = Math.max(0, ...cells.map((c) => c.orders));
  const total = cells.reduce((sum, c) => sum + c.orders, 0);

  if (total === 0) {
    return (
      <p className="text-[11px] text-slate-500">이 구간에는 주문이 없습니다.</p>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-muted-foreground">시간대별 (보이는 구간)</p>
        <p className="text-[11px] text-slate-500">숫자 = 매출(만원)</p>
      </div>
      {/* 24칸 가로 스크롤 — 좁은 패널에서 칸이 뭉개지지 않게 자기 컨테이너 안에서만 넘친다. */}
      <div className="overflow-x-auto">
        <div className="flex min-w-[560px] gap-[2px]">
          {cells.map((cell) => (
            <div key={cell.hour} className="flex-1 text-center">
              <div
                className="flex h-9 items-center justify-center rounded-md text-[10px] font-semibold tabular-nums"
                style={{
                  backgroundColor: `color-mix(in srgb, var(--chart-1) ${resolveCellAlpha(cell.orders, maxOrders) * 100}%, transparent)`,
                  // 알파 상한이 0.42 라 전 구간에서 네이비 텍스트가 4.5:1 을 넘는다
                  // (위 resolveCellAlpha 주석의 실측). 색 전환 분기는 두지 않는다.
                  color: "var(--primary)",
                }}
                title={`${cell.hour}시 · 주문 ${cell.orders}건 · 매출 ${cell.revenue.toLocaleString()}원`}
              >
                {formatManwon(cell.revenue, cell.orders > 0)}
              </div>
              <div className="mt-0.5 text-[9px] text-slate-500 tabular-nums">{cell.hour}</div>
            </div>
          ))}
        </div>
      </div>
      {/* 시각 표에 도달하지 못하는 경로를 위한 전체 데이터(P0 접근성) */}
      <ul className="sr-only" aria-label="시간대별 주문·매출">
        {cells
          .filter((c) => c.orders > 0)
          .map((c) => (
            <li key={c.hour}>
              {c.hour}시 · 주문 {c.orders}건 · 매출 {c.revenue.toLocaleString()}원
            </li>
          ))}
      </ul>
    </div>
  );
}
