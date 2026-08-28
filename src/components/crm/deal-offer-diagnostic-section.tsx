"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  MANUAL_ROW_IDS,
  type OfferDiagnosis,
  type OfferRowId,
  type OfferVerdict,
} from "@/lib/offer/offer-diagnostic";

/**
 * 딜 상세 "오퍼 진단" 섹션 (C2 M2).
 *
 * 지원하는 판단: **"이 오퍼가 팔릴 구조인가"**. 바로 위 표현 관리(C1)가
 * "이 표현을 써도 되는가"를 보는 것과 **다른 축**이다 — 합법이어도 안 팔리는
 * 오퍼가 있고, 그건 카피로 못 고친다.
 *
 * 규율을 화면에서도 지킨다: **점수는 커버리지 100% 일 때만** 보여주고(모르는
 * 것을 0점으로 뭉개지 않는다), 미충족 행에는 **그 행을 뒤집을 구체 수정**을
 * 붙인다. `UNKNOWN` 은 실패가 아니라 "확인 안 됨"이다.
 *
 * 수동 4행(M3)은 여기서 바로 답할 수 있다 — 확인함/미충족/모름 3택. 자동 행과
 * 달리 "부분 충족"을 두지 않는다(운영자에게 물으면 판단이 흐려진다).
 */

type DiagnosticResponse = OfferDiagnosis & {
  dealId: string;
  dealName: string;
  resolvedFromParent: boolean;
  priceSnapshotDate: string | null;
};

const VERDICT_META: Record<
  OfferVerdict,
  { label: string; badge: string; order: number }
> = {
  // order: 낮은 것이 위로 — 고쳐야 할 것이 먼저 보여야 한다.
  FAIL: {
    label: "미충족",
    badge: "bg-status-urgent-bg text-status-urgent-text",
    order: 0,
  },
  PARTIAL: {
    label: "부분 충족",
    badge: "bg-status-caution-bg text-status-caution-text",
    order: 1,
  },
  UNKNOWN: {
    label: "확인 안 됨",
    badge: "bg-muted text-muted-foreground",
    order: 2,
  },
  PASS: {
    label: "충족",
    badge: "bg-status-success-bg text-foreground",
    order: 3,
  },
  NA: {
    label: "해당 없음",
    badge: "bg-muted text-muted-foreground",
    order: 4,
  },
};

/** 알 수 없는 verdict 가 와도 정렬·배지가 깨지지 않게 맨 뒤로 보낸다. */
const UNKNOWN_VERDICT_ORDER = 99;

function metaOf(verdict: OfferVerdict) {
  return (
    VERDICT_META[verdict] ?? {
      label: String(verdict),
      badge: "bg-muted text-muted-foreground",
      order: UNKNOWN_VERDICT_ORDER,
    }
  );
}

function isDiagnosticResponse(body: unknown): body is DiagnosticResponse {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as { rows?: unknown; coverage?: unknown };
  return (
    Array.isArray(candidate.rows) &&
    typeof candidate.coverage === "object" &&
    candidate.coverage !== null
  );
}

const MANUAL_ROW_SET = new Set<OfferRowId>(MANUAL_ROW_IDS);

/** 수동 행 3택. PARTIAL 은 의도적으로 없다. */
const ANSWER_CHOICES = [
  { verdict: "PASS" as const, label: "확인함" },
  { verdict: "FAIL" as const, label: "미충족" },
  { verdict: "UNKNOWN" as const, label: "모름" },
];

export function DealOfferDiagnosticSection({ dealId }: { dealId: string }) {
  const [data, setData] = useState<DiagnosticResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingRow, setSavingRow] = useState<OfferRowId | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/deals/${dealId}/offer-diagnostic`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "진단을 불러오지 못했습니다");
      }
      // 응답 형태를 믿지 않는다 — rows 가 없는 페이로드(계약 변경·프록시
      // 오류 페이지 등)가 오면 렌더 중 크래시가 나 딜 패널 전체가 죽는다.
      // 여기서 막고 에러로 표시한다.
      const body: unknown = await res.json();
      if (!isDiagnosticResponse(body)) {
        throw new Error("진단 응답 형식이 올바르지 않습니다");
      }
      setData(body);
      setError(null);
    } catch (e) {
      // setError 를 성공 경로에서만 지운다 — catch 뒤에 null 로 덮으면
      // 실패 메시지가 사라진다(C1 M3 에서 실제로 밟은 순서 버그).
      setError(e instanceof Error ? e.message : "진단을 불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  const answerRow = useCallback(
    async (rowId: OfferRowId, verdict: "PASS" | "FAIL" | "UNKNOWN") => {
      setSavingRow(rowId);
      try {
        const res = await fetch(`/api/deals/${dealId}/offer-diagnostic`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rowId, verdict }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? "응답을 저장하지 못했습니다");
        }
        // 저장 후 재조회 — 점수·커버리지가 이 답으로 바뀐다.
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : "응답을 저장하지 못했습니다");
      } finally {
        setSavingRow(null);
      }
    },
    [dealId, load],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data
    ? [...data.rows].sort(
        (a, b) => metaOf(a.verdict).order - metaOf(b.verdict).order,
      )
    : [];
  const actionable = rows.filter(
    (r) => r.verdict === "FAIL" || r.verdict === "PARTIAL",
  ).length;

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">오퍼 진단</h3>
          <p className="text-xs text-muted-foreground">
            가격·구성·근거가 팔릴 구조인지 봅니다. 표현을 다듬기 전에 오퍼를
            먼저 고치는 것이 순서입니다.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
          aria-label="오퍼 진단 다시 계산"
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-4" />
          )}
        </Button>
      </header>

      {error && (
        <p className="rounded-md bg-status-urgent-bg px-3 py-2 text-xs text-status-urgent-text">
          {error}
        </p>
      )}

      {loading && !data && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      )}

      {data && (
        <>
          {/* 점수는 커버리지가 다 찼을 때만 — 미확인이 있으면 커버리지만. */}
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
            aria-live="polite"
          >
            {data.score !== null ? (
              <span className="text-sm font-semibold text-foreground">
                {data.score}/10
              </span>
            ) : (
              <span>미확인 항목이 있어 점수를 내지 않았습니다</span>
            )}
            <span>
              판정 {data.coverage.decided}/{data.coverage.applicable}행
            </span>
            {actionable > 0 ? (
              <span className="text-status-caution-text">
                손볼 항목 {actionable}건
              </span>
            ) : (
              <span>손볼 항목 없음</span>
            )}
            {data.resolvedFromParent && (
              <span>옵션 딜이라 본품 기준으로 판정했습니다</span>
            )}
          </div>

          <ul className="space-y-2">
            {rows.map((row) => {
              const meta = metaOf(row.verdict);
              return (
                <li
                  key={row.id}
                  className="rounded-md border border-border px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-foreground">
                      {row.label}
                    </span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[11px] font-medium",
                        meta.badge,
                      )}
                    >
                      {meta.label}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.reason}
                  </p>
                  {row.fix && (
                    <p className="mt-1 text-xs text-foreground">→ {row.fix}</p>
                  )}
                  {MANUAL_ROW_SET.has(row.id) && (
                    <div
                      className="mt-2 flex flex-wrap items-center gap-1"
                      role="group"
                      aria-label={`${row.label} 운영자 판정`}
                    >
                      {ANSWER_CHOICES.map((choice) => (
                        <Button
                          key={choice.verdict}
                          variant={
                            row.verdict === choice.verdict
                              ? "secondary"
                              : "ghost"
                          }
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          disabled={savingRow === row.id}
                          aria-pressed={row.verdict === choice.verdict}
                          onClick={() => void answerRow(row.id, choice.verdict)}
                        >
                          {choice.label}
                        </Button>
                      ))}
                      {savingRow === row.id && (
                        <Loader2 className="size-3 animate-spin text-muted-foreground" />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
