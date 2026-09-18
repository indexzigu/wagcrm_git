"use client";
// 콘텐츠별 반응 표 — "이 콘텐츠를 올린 뒤 주문·매출이 어땠나"에 숫자로 답한다.
// 설계 정본: docs/private/specs/2026-07-25-content-order-correlation-design.md 「개정(2026-09-18)」.
//
// ⛔ 인과를 말하지 않는다 — 앞뒤 **건수·금액만** 적는다(배수·증감률·"효과" 문구 금지, 오너 확정
//    설계의 「자동 인과 판정 제외」). 같은 시간대에 다른 콘텐츠·외부 요인이 겹칠 수 있다.
// 콘텐츠 유형은 범주라 색이 아니라 아이콘으로 구분한다(P8 §4). 막대 색은 차트의 10분 주문
// 계열(`--chart-4`)과 같은 지표라 같은 색이다 — 신규 hue 0.
import type { ContentEvent } from "@/lib/content-order-correlation";
import type { ReactionRow } from "@/lib/content-reaction";
import { EVENT_ICON, EVENT_TYPE_LABEL } from "./content-event-icon";

type Row = ReactionRow<ContentEvent>;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ms → "M.D HH:mm"(KST). */
function formatKstStamp(ms: number): string {
  const kst = new Date(ms + KST_OFFSET_MS);
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mm = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${kst.getUTCMonth() + 1}.${kst.getUTCDate()} ${hh}:${mm}`;
}

/** "12건 → 41건" — 말할 수 없는 쪽은 0건이 아니라 "기록 없음"이다. */
export function formatReactionOrders(row: Row): string {
  if (row.before === null && row.after === null) return "기록 없음";
  const side = (t: Row["before"]) => (t === null ? "기록 없음" : `${t.orders.toLocaleString()}건`);
  return `${side(row.before)} → ${side(row.after)}`;
}

/** "스토리 3건" · 유형이 섞이면 "스토리 외 2건". */
export function formatReactionLabel(row: Row): string {
  const first = EVENT_TYPE_LABEL[row.members[0].type];
  const sameType = row.members.every((m) => m.type === row.members[0].type);
  return sameType ? `${first} ${row.members.length}건` : `${first} 외 ${row.members.length - 1}건`;
}

export function ContentReactionTable({
  rows,
  selectedKey,
  onSelect,
}: {
  rows: Row[];
  selectedKey: string | null;
  onSelect: (row: Row | null) => void;
}) {
  if (rows.length === 0) return null;
  const peak = Math.max(1, ...rows.map((r) => r.after?.orders ?? 0));
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-xs font-semibold text-foreground">콘텐츠별 반응</p>
        <p className="text-[11px] text-slate-500">발행 직전 3시간 → 직후 3시간 주문 · 직후 매출</p>
      </div>
      <ul className="max-h-[296px] divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/60">
        {rows.map((row) => {
          const selected = row.key === selectedKey;
          const Icon = EVENT_ICON[row.members[0].type];
          return (
            <li key={row.key}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(selected ? null : row)}
                className={`grid w-full grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_auto] items-center gap-3 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring ${
                  selected ? "bg-slate-100/80" : "hover:bg-slate-50"
                }`}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{formatReactionLabel(row)}</span>
                  </span>
                  <span className="block text-[11px] tabular-nums text-slate-500">
                    {formatKstStamp(row.postedMs)}
                    {row.members.length > 1 ? "부터" : ""}
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="shrink-0 text-xs tabular-nums text-foreground">
                      {formatReactionOrders(row)}
                    </span>
                    {row.afterPartial && row.after !== null && (
                      <span className="shrink-0 rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-600">
                        집계 중
                      </span>
                    )}
                    {/* row.after === null("기록 없음")이면 진행바를 렌더하지 않는다 — 폭 0%는
                        실제 0건과 시각적으로 구분되지 않아 "모른다"를 "없다"로 위조한다
                        (ss-ux-designer 검토 P1, 설계서 「v2 2단계 ⓑ」가 이미 잡았던 결함의 재발). */}
                    {row.after !== null && (
                      <span aria-hidden className="h-1.5 min-w-6 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${(row.after.orders / peak) * 100}%`,
                            backgroundColor: "var(--chart-4)",
                          }}
                        />
                      </span>
                    )}
                  </span>
                  {row.overlapCount > 0 && (
                    <span className="block text-[11px] text-slate-500">
                      앞뒤 3시간 안에 다른 콘텐츠 {row.overlapCount}건
                    </span>
                  )}
                </span>
                <span className="text-right text-xs tabular-nums text-foreground">
                  {row.after === null ? "" : `${row.after.revenue.toLocaleString()}원`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-slate-500">
        1시간 안에 올린 콘텐츠는 한 줄로 묶습니다. 아침 발행은 직전이 새벽이라 차이가 크게 보일 수
        있고, 다른 콘텐츠와 겹친 줄은 같은 주문이 양쪽에 잡힙니다. 줄을 누르면 차트에서 그 구간을
        보여줍니다.
      </p>
    </div>
  );
}
