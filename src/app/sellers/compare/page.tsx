// [셀러분석] 셀러 비교표 — 후보 2~8명을 한 화면에 나란히 놓고 「누구에게 먼저 제안할지」를 고르는 화면.
// 설계 정본: docs/private/specs/2026-11-08-seller-reach-similar-compare.md §3 (로컬 서고).
// 값·행 정의·최고값 판정은 src/lib/seller-comparison-rows.ts(순수), 읽기는 src/lib/seller-comparison.ts.
import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, X } from "lucide-react";
import { getCachedSellerComparison } from "@/lib/cached-crm-data";
import {
  SELLER_COMPARE_MIN,
  buildComparisonTable,
  normalizeComparisonIds,
  sellerCompareHref,
  type ComparisonCell,
  type ComparisonTable,
} from "@/lib/seller-comparison-rows";
import SellerCompareLoading from "./loading";

export const metadata: Metadata = {
  title: "셀러 비교",
  robots: { index: false, follow: false },
};

type SearchParams = Promise<{ ids?: string | string[] }>;

// cacheComponents(Next 16) 규칙: 루트는 정적 셸만 — 동적 IO(searchParams·DB)는 Suspense 자식에서 수행
export default function SellerComparePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<SellerCompareLoading />}>
      <SellerCompare searchParams={searchParams} />
    </Suspense>
  );
}

async function SellerCompare({ searchParams }: { searchParams: SearchParams }) {
  const { ids: rawIds } = await searchParams;
  const normalized = normalizeComparisonIds(rawIds);
  const data =
    normalized.ids.length > 0
      ? await getCachedSellerComparison(normalized.ids.join(","))
      : { sellers: [], droppedCount: 0 };
  const droppedCount = normalized.droppedCount + data.droppedCount;

  // 요청당 1회 서버 렌더되는 async RSC 라 이 렌더 안에서 결정적이다(상대 경과일 라벨용).
  // eslint-disable-next-line react-hooks/purity
  const now = new Date(Date.now());

  return (
    <div data-print-root className="flex flex-col gap-4 px-5 py-6 md:px-8">
      <div className="flex flex-col gap-2">
        <Link
          href="/sellers"
          className="no-print inline-flex w-fit items-center gap-1 text-xs text-slate-500 hover:text-slate-800"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> 셀러 목록
        </Link>
        <h1 className="text-lg font-bold text-slate-900">셀러 비교</h1>
        {droppedCount > 0 && (
          <p role="status" className="no-print text-xs text-slate-500">
            셀러 {droppedCount}명은 찾지 못해 뺐습니다
          </p>
        )}
      </div>

      {data.sellers.length < SELLER_COMPARE_MIN ? (
        <div className="flex flex-col items-start gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-5">
          <p className="text-sm text-slate-700">비교하려면 셀러 목록에서 2명 이상 고르세요</p>
          <Link href="/sellers" className="text-sm font-medium text-primary hover:underline">
            셀러 목록으로 가기
          </Link>
        </div>
      ) : (
        <ComparisonGrid
          table={buildComparisonTable(data.sellers, now)}
          ids={data.sellers.map((s) => s.id)}
        />
      )}
    </div>
  );
}

function CellValue({ cell }: { cell: ComparisonCell }) {
  const tone = cell.isBest
    ? "font-semibold text-slate-900"
    : cell.isReason
      ? "text-slate-500"
      : "text-slate-600";
  return (
    <>
      <span className={`block text-xs tabular-nums ${tone}`}>
        {cell.text}
        {cell.isBest && <span className="sr-only"> 최고</span>}
      </span>
      {cell.subText && <span className="block text-[10px] text-slate-500">{cell.subText}</span>}
    </>
  );
}

function ComparisonGrid({ table, ids }: { table: ComparisonTable; ids: string[] }) {
  const columnCount = table.columns.length;
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">셀러 {columnCount}명 비교표. 각 행의 가장 높은 값에 최고 표시</caption>
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 align-top">
            <th
              scope="col"
              className="sticky left-0 z-10 w-32 min-w-32 bg-slate-50 px-3 py-3 text-[12px] font-medium text-slate-500"
            >
              항목
            </th>
            {table.columns.map((col) => {
              const remaining = ids.filter((id) => id !== col.id);
              return (
                <th key={col.id} scope="col" className="min-w-[112px] px-3 py-3 font-normal">
                  <div className="flex items-start justify-between gap-1">
                    <Link
                      href={`/sellers/${encodeURIComponent(col.id)}`}
                      className="text-[13px] font-semibold text-slate-900 hover:underline"
                    >
                      {col.displayName}
                    </Link>
                    <Link
                      href={sellerCompareHref(remaining)}
                      aria-label={`${col.displayName} 빼기`}
                      className="no-print -m-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                    >
                      <X className="size-3.5" aria-hidden />
                    </Link>
                  </div>
                  {col.riskFlags.length > 0 && (
                    <ul className="mt-1.5 flex flex-wrap gap-1">
                      {col.riskFlags.map((flag) => (
                        <li
                          key={flag.key}
                          title={flag.reason}
                          className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
                            flag.severity === "danger"
                              ? "border-status-urgent/30 bg-status-urgent-bg text-status-urgent-text"
                              : "border-status-caution/30 bg-status-caution-bg text-status-caution-text"
                          }`}
                        >
                          <AlertTriangle className="size-3" aria-hidden />
                          {flag.label}
                        </li>
                      ))}
                    </ul>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        {table.sections.map((section) => (
          <tbody key={section.key} className={section.internal ? "print:hidden" : undefined}>
            {section.key !== "score" && (
              <tr className="border-b border-slate-200 bg-slate-50">
                <th
                  scope="colgroup"
                  colSpan={columnCount + 1}
                  className="sticky left-0 bg-slate-50 px-3 py-1.5 text-[12px] font-semibold text-slate-700"
                >
                  {section.label}
                  {section.internal && <span className="ml-1 font-normal text-slate-500">(내부 전용)</span>}
                </th>
              </tr>
            )}
            {section.rows.map((row) => (
              <tr key={row.key} className="border-b border-slate-100 align-top last:border-slate-200">
                <th
                  scope="row"
                  className="sticky left-0 z-10 w-32 min-w-32 border-r border-slate-100 bg-white px-3 py-2.5 text-[12px] font-medium text-slate-600"
                >
                  {row.label}
                  {row.note && <span className="mt-0.5 block text-[10px] font-normal text-slate-500">{row.note}</span>}
                </th>
                {row.cells.map((cell, index) => (
                  <td key={table.columns[index].id} className="px-3 py-2.5">
                    <CellValue cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
