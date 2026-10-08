import React from 'react';
import type { PurchaseOrderMissingField, PurchaseOrderPreviewRow } from '@/lib/order-converter/purchase-order-rows';
import { StatusDot } from '@/components/crm/status-dot';

/**
 * 발주요청 창 2단계의 미리보기 표(발주 자동화 2단계, ss-ux 검토 2026-10-06 반영).
 *
 * - 전화·주소 원문은 열로 만들지 않는다 — 브랜드사에 보내기 전 판단할 것은 「비었는가」뿐이라 빈 칸인
 *   행에만 「연락처 없음」 같은 글자 배지를 붙인다(색만으로 구분하지 않는다).
 * - 정상 행은 무채색, 빈 칸이 있는 행만 주의(caution) 틴트 — 「주의가 필요한 소수에만 색」(P8 §1).
 * - 「발주확인」 열은 대개 전부 같은 값이라 색 없이 글자만 둔다.
 * - 표는 키보드로도 스크롤할 수 있게 포커스 가능한 영역(region)이다.
 */

export type PurchaseOrderPreviewSummary = {
  lineCount: number;
  quantityTotal: number;
  needsConfirmCount: number;
  missingCount: number;
};

/** 이보다 많으면 표 높이 상한 아래로 행이 숨을 수 있어 스크롤 안내를 붙인다(1280×1000 실렌더 기준 약 10행). */
const PREVIEW_VISIBLE_HINT_ROWS = 8;

const MISSING_LABEL: Record<PurchaseOrderMissingField, string> = {
  recipient: '수취인 없음',
  phone: '연락처 없음',
  address: '주소 없음',
};

export function PurchaseOrderPreview({
  rows,
  summary,
}: {
  rows: PurchaseOrderPreviewRow[];
  summary: PurchaseOrderPreviewSummary;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-700 tabular-nums" data-testid="po-preview-summary">
        상품주문 {summary.lineCount.toLocaleString('ko-KR')}건 · 수량 합계 {summary.quantityTotal.toLocaleString('ko-KR')}개 ·
        발주확인 {summary.needsConfirmCount.toLocaleString('ko-KR')}건
        {/* 상태는 붙여 쓴 한 낱말 + 점(상태 낱말 기준 ①③, 오너 확정 2026-10-08). 무엇을 확인하는지는
            설명창이 말한다 — 이 요약 줄은 버튼·링크 안이 아니라 설명창 트리거를 둘 수 있다. */}
        {summary.missingCount > 0 && (
          <>
            {' · '}
            <StatusDot
              tone="caution"
              label={`확인대기 ${summary.missingCount.toLocaleString('ko-KR')}건`}
              hint="수취인·연락처·주소 중 빈 칸이 있는 줄입니다. 아래 표에서 주의 표시된 줄을 확인하세요."
              className="align-middle font-semibold"
              testId="po-preview-missing"
            />
          </>
        )}
      </p>
      <div
        role="region"
        aria-label="발주서 미리보기 표"
        tabIndex={0}
        className="max-h-[40dvh] overflow-auto [scrollbar-gutter:stable] rounded-xl border border-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <table className="w-full min-w-[560px] text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50">
            <tr className="text-left text-[11px] font-bold text-slate-500">
              <th scope="col" className="px-3 py-2">수취인</th>
              <th scope="col" className="px-3 py-2">옵션</th>
              <th scope="col" className="px-3 py-2 text-right">수량</th>
              <th scope="col" className="px-3 py-2">배송메시지</th>
              <th scope="col" className="px-3 py-2">발주확인</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const flagged = row.missing.length > 0;
              return (
                <tr
                  key={row.productOrderId || `${row.orderId}-${row.optionName}`}
                  className={`border-t border-slate-100 align-top ${flagged ? 'bg-status-caution-bg' : ''}`}
                >
                  <td className="px-3 py-2">
                    <div className="text-[13px] font-semibold text-slate-900">{row.recipientName || '—'}</div>
                    {flagged && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {row.missing.map((m) => (
                          <span
                            key={m}
                            className="rounded-md border border-status-caution px-1.5 py-0.5 text-[10px] font-semibold text-status-caution-text"
                          >
                            {MISSING_LABEL[m]}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{row.optionName || '—'}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${row.quantity > 1 ? 'font-bold text-slate-900' : 'text-slate-700'}`}>
                    {row.quantity.toLocaleString('ko-KR')}
                  </td>
                  <td className="px-3 py-2 text-slate-600 break-words">{row.shippingMemo || ''}</td>
                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{row.needsConfirm ? '확인 전' : '확인됨'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* 표 높이 상한(40dvh) 아래로 숨은 행이 있을 수 있다 — 스크롤 가능하다는 단서를 글자로 남긴다. */}
      {rows.length > PREVIEW_VISIBLE_HINT_ROWS && (
        <p className="text-[11px] text-slate-500">표를 스크롤하면 전체 {rows.length.toLocaleString('ko-KR')}건을 볼 수 있습니다.</p>
      )}
    </div>
  );
}
