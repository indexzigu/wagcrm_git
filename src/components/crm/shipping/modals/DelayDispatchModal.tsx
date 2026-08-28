import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UndispatchedOrderRow } from '@/lib/order-converter/undispatched-orders';
import { buildDelayDispatchLog, type OrderActionLogInput } from '@/lib/order-converter/action-log';

// 발송지연 안내 모달 — 확정 UX 스펙(2단계 확인) 구현.
//
// 이 흐름의 끝은 "고객에게 취소 불가능한 문자/네이버 알림이 즉시 발송되는" 네이버 /delay API다.
// 그래서 ① 기본값 전체 미선택(능동 선택 강제) ② Step 2 caution 배너로 발송 사실 고지
// ③ 실행 버튼에 건수 강제 노출 ④ 결과 화면 자동 닫힘 금지(운영자가 직접 확인 후 닫기)로
// 오발송·재알림 리스크를 UI 계층에서 막는다. 클레임 진행 건은 체크박스 자체를 잠근다(하드룰).

type DelayDispatchModalProps = {
  campaign: { id: string; name: string };
  onClose: () => void;
  addToast: (msg: string, type: 'info' | 'success' | 'error') => void;
  /** 감사 로그 기록(order-dashboard의 logOrderAction 재사용, fire-and-forget) */
  onLog: (input: OrderActionLogInput) => void;
  /** 실행 완료 후 스냅샷 갱신 반영 */
  refreshNow: () => void;
  /** busyActions in-flight 가드 (키: delayDispatch:${campaign.id}) — 실행 중 재제출 차단 */
  isBusy: boolean;
  setBusy: (busy: boolean) => void;
};

const DELAY_REASONS = [
  { value: 'PRODUCT_PREPARE', label: '상품준비중' },
  { value: 'CUSTOMER_REQUEST', label: '고객요청' },
  { value: 'CUSTOM_BUILD', label: '주문제작' },
  { value: 'RESERVED_DISPATCH', label: '예약발송' },
  { value: 'OVERSEA_DELIVERY', label: '해외배송' },
  { value: 'ETC', label: '기타' },
] as const;

const SKIP_REASON_LABELS: Record<string, string> = {
  CLAIM_IN_PROGRESS: '클레임 진행중',
  NOT_FOUND_OR_NO_STATUS: '주문 상태 확인 불가',
  DELIVERING: '이미 배송중',
  DELIVERED: '이미 배송완료',
  PURCHASE_DECIDED: '구매확정',
  DISPATCHED: '이미 발송처리됨',
  DISPATCH_WAIT: '발송대기 상태',
  CANCELED: '취소됨',
  RETURNED: '반품됨',
  EXCHANGED: '교환됨',
  // 키는 네이버 productOrderStatus 실제 enum과 일치해야 한다(route가 skip 사유로 원시 상태값을 그대로 넣음).
  PAYMENT_WAITING: '결제대기',
  CANCELED_BY_NOPAYMENT: '미결제취소',
};

const skipReasonLabel = (reason?: string) =>
  reason ? SKIP_REASON_LABELS[reason] ?? reason : '사유 미상';

// ---- KST 날짜 헬퍼 (스냅샷 필드가 +09:00 ISO라 KST 달력일 기준으로 계산) ----
const KST_MS = 9 * 60 * 60 * 1000;
const kstDayIndex = (iso: string | number): number =>
  Math.floor((new Date(iso).getTime() + KST_MS) / 86400000);
const kstTodayStr = (): string => new Date(Date.now() + KST_MS).toISOString().slice(0, 10);
const kstDateStrPlusDays = (days: number): string =>
  new Date(Date.now() + KST_MS + days * 86400000).toISOString().slice(0, 10);
const fmtMd = (iso: string | null): string => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const d = new Date(t + KST_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};
const fmtKoreanDate = (dateStr: string): string => {
  const [, m, d] = dateStr.split('-');
  if (!m || !d) return dateStr;
  return `${parseInt(m, 10)}월 ${parseInt(d, 10)}일`;
};

/** 발송기한 그룹: 0=기한 경과, 1=임박(D-1~D-0), 2=나머지(기한 미상 포함) */
function dueGroup(row: UndispatchedOrderRow, todayIdx: number): { group: 0 | 1 | 2; overdueDays: number } {
  if (!row.shippingDueDate) return { group: 2, overdueDays: 0 };
  const dueIdx = kstDayIndex(row.shippingDueDate);
  if (isNaN(dueIdx)) return { group: 2, overdueDays: 0 };
  const diff = todayIdx - dueIdx; // 양수 = 경과 일수
  if (diff > 0) return { group: 0, overdueDays: diff };
  if (diff >= -1) return { group: 1, overdueDays: 0 }; // D-0(오늘)·D-1(내일)
  return { group: 2, overdueDays: 0 };
}

type Step = 'select' | 'confirm' | 'running' | 'result';

interface ExecResult {
  successCount: number;
  failCount: number;
  skipCount: number;
  failed: Array<{ productOrderId?: string; reason?: string }>;
  skipped: Array<{ productOrderId?: string; reason?: string }>;
  firstFailReason: string | null;
}

const EXEC_CHUNK_SIZE = 20;

const inputCls =
  'w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-blue-500 transition-[border-color,box-shadow] shadow-soft-sm';
const labelCls = 'block text-xs font-bold text-slate-600 mb-1.5';

export default function DelayDispatchModal({
  campaign,
  onClose,
  addToast,
  onLog,
  refreshNow,
  isBusy,
  setBusy,
}: DelayDispatchModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [step, setStep] = useState<Step>('select');

  const [rows, setRows] = useState<UndispatchedOrderRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [reason, setReason] = useState<string>('PRODUCT_PREPARE');
  const [dueDateStr, setDueDateStr] = useState<string>('');
  const [detailedReason, setDetailedReason] = useState<string>('');
  const [filter, setFilter] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [result, setResult] = useState<ExecResult | null>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setLoadError(null);
    fetch(`/order-converter/api/campaigns/${encodeURIComponent(campaign.id)}/undispatched-orders`)
      .then(async (r) => {
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          throw new Error(data.error || '미발송 주문을 불러오지 못했습니다.');
        }
        return r.json();
      })
      .then((d) => {
        if (!cancelled) setRows(Array.isArray(d.rows) ? d.rows : []);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [campaign.id]);

  // 오늘(KST) 달력일 인덱스 — 렌더 중 Date.now() 호출(react-hooks/purity)을 피해 마운트 시 1회 고정.
  // 모달은 열 때마다 새로 마운트되므로 자정 경계 오차는 실무상 무시 가능.
  const [todayIdx] = useState(() => kstDayIndex(Date.now()));

  // 정렬 고정: 기한 경과 → 임박(D-1~D-0) → 나머지. 그룹 내에서는 기한 오름차순 → 결제일 오름차순.
  const sortedRows = useMemo(() => {
    if (!rows) return [];
    return [...rows].sort((a, b) => {
      const ga = dueGroup(a, todayIdx);
      const gb = dueGroup(b, todayIdx);
      if (ga.group !== gb.group) return ga.group - gb.group;
      const dueA = a.shippingDueDate ? new Date(a.shippingDueDate).getTime() : Number.MAX_SAFE_INTEGER;
      const dueB = b.shippingDueDate ? new Date(b.shippingDueDate).getTime() : Number.MAX_SAFE_INTEGER;
      if (dueA !== dueB) return dueA - dueB;
      const payA = a.paymentDate ? new Date(a.paymentDate).getTime() : 0;
      const payB = b.paymentDate ? new Date(b.paymentDate).getTime() : 0;
      return payA - payB;
    });
  }, [rows, todayIdx]);

  const filterText = filter.trim().toLowerCase();
  const filteredRows = useMemo(
    () =>
      filterText
        ? sortedRows.filter((r) => (r.productOption || '').toLowerCase().includes(filterText))
        : sortedRows,
    [sortedRows, filterText],
  );

  // 전체선택 대상: 클레임 진행(하드룰 제외) + 이미 안내된 건(어떤 전체선택에도 미포함)을 뺀 것
  const bulkSelectable = (list: UndispatchedOrderRow[]) =>
    list.filter((r) => !r.claimInProgress && !r.alreadyDelayed).map((r) => r.productOrderId);

  const toggleRow = (row: UndispatchedOrderRow) => {
    if (row.claimInProgress) return; // 하드룰: 클레임 진행 건은 선택 불가
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(row.productOrderId)) next.delete(row.productOrderId);
      else next.add(row.productOrderId);
      return next;
    });
  };

  const selectAll = (list: UndispatchedOrderRow[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of bulkSelectable(list)) next.add(id);
      return next;
    });
  };

  const clearAll = () => setSelected(new Set());

  const selectedRows = useMemo(
    () => sortedRows.filter((r) => selected.has(r.productOrderId)),
    [sortedRows, selected],
  );
  const renotifyCount = selectedRows.filter((r) => r.alreadyDelayed).length;
  const reasonLabel = DELAY_REASONS.find((r) => r.value === reason)?.label ?? reason;

  const canProceed =
    selectedRows.length > 0 && !!dueDateStr && detailedReason.trim().length > 0;

  const execute = async () => {
    if (isBusy || selectedRows.length === 0) return; // in-flight 가드: 실행 중 재제출 차단
    setBusy(true);
    setStep('running');
    setProgress({ done: 0, total: selectedRows.length });

    // 발송예정일: 스냅샷 shippingDueDate 실측 포맷과 동일한 KST 말일시(ISO +09:00)로 보낸다.
    const dispatchDueDate = `${dueDateStr}T23:59:59.000+09:00`;
    const requests = selectedRows.map((r) => ({
      productOrderId: r.productOrderId,
      dispatchDueDate,
      delayedDispatchReason: reason,
      dispatchDelayedDetailedReason: detailedReason.trim(),
    }));

    const agg: ExecResult = {
      successCount: 0,
      failCount: 0,
      skipCount: 0,
      failed: [],
      skipped: [],
      firstFailReason: null,
    };

    try {
      for (let i = 0; i < requests.length; i += EXEC_CHUNK_SIZE) {
        const chunk = requests.slice(i, i + EXEC_CHUNK_SIZE);
        try {
          const res = await fetch('/order-converter/api/naver/delay-dispatch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests: chunk }),
          });
          if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            const chunkReason = errData.error || '서버 오류';
            agg.failCount += chunk.length;
            if (!agg.firstFailReason) agg.firstFailReason = chunkReason;
            for (const c of chunk) agg.failed.push({ productOrderId: c.productOrderId, reason: chunkReason });
            continue;
          }
          const data = await res.json();
          agg.successCount += data.successCount || 0;
          agg.failCount += data.failCount || 0;
          agg.skipCount += data.skipCount || 0;
          if (Array.isArray(data.failed)) agg.failed.push(...data.failed);
          if (Array.isArray(data.skipped)) agg.skipped.push(...data.skipped);
          if (!agg.firstFailReason && data.firstFailReason) agg.firstFailReason = data.firstFailReason;
        } catch {
          agg.failCount += chunk.length;
          if (!agg.firstFailReason) agg.firstFailReason = '네트워크 오류';
          for (const c of chunk) agg.failed.push({ productOrderId: c.productOrderId, reason: '네트워크 오류' });
        }
        setProgress({ done: Math.min(i + chunk.length, requests.length), total: requests.length });
      }

      setResult(agg);
      setStep('result');

      // 감사 로그(발송예정일·사유를 details에 보존) + 스냅샷 갱신 반영
      onLog(
        buildDelayDispatchLog({
          campaign,
          successCount: agg.successCount,
          failCount: agg.failCount,
          skipCount: agg.skipCount,
          failed: agg.failed,
          skipped: agg.skipped,
          firstFailReason: agg.firstFailReason,
          dispatchDueDate,
          delayedDispatchReason: reason,
        }),
      );
      refreshNow();

      // 토스트: 전체 성공 시 무음(모달 결과 화면이 확인) — 실패 1건 이상일 때만 에러 토스트 1개
      if (agg.failCount > 0) {
        addToast(
          `발송지연 안내 실패 ${agg.failCount}건${agg.firstFailReason ? ` (${agg.firstFailReason})` : ''}: 결과 화면을 확인하세요.`,
          'error',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const running = step === 'running';

  if (!isMounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
      <div
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity"
        onClick={() => !running && onClose()}
      />
      <div className="bg-white rounded-2xl shadow-overlay relative w-full max-w-xl flex flex-col max-h-[85vh] animate-in fade-in zoom-in-95 duration-200">
        {/* 헤더 */}
        <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-white rounded-t-2xl shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <svg className="w-5 h-5 text-slate-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              발송지연 안내
            </h2>
            <p className="text-xs text-slate-500 mt-0.5 truncate">{campaign.name}</p>
          </div>
          {!running && (
            <button
              onClick={onClose}
              className="text-slate-500 hover:text-slate-600 p-2 rounded-full hover:bg-slate-100 transition-colors shrink-0"
              aria-label="닫기"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Step 1: 대상·조건 */}
        {step === 'select' && (
          <>
            <div className="p-5 pb-3 space-y-3 shrink-0 border-b border-slate-100">
              {/* ① 조건 바 — 리스트 스크롤 중에도 고정 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls} htmlFor="delay-reason">지연 사유</label>
                  <select
                    id="delay-reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className={inputCls}
                  >
                    {DELAY_REASONS.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls} htmlFor="delay-due-date">발송예정일</label>
                  <input
                    id="delay-due-date"
                    type="date"
                    value={dueDateStr}
                    min={kstTodayStr()}
                    max={kstDateStrPlusDays(90)}
                    onChange={(e) => setDueDateStr(e.target.value)}
                    className={inputCls}
                  />
                </div>
              </div>
              <div>
                <label className={labelCls} htmlFor="delay-detail">상세 사유</label>
                <textarea
                  id="delay-detail"
                  rows={2}
                  value={detailedReason}
                  onChange={(e) => setDetailedReason(e.target.value)}
                  placeholder="예: 주문량 증가로 출고가 지연되고 있습니다."
                  className={`${inputCls} resize-none`}
                />
                <p className="mt-1 px-1 text-[10px] text-slate-500">고객에게 그대로 노출됩니다.</p>
              </div>
              {/* ② 옵션 필터 */}
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="옵션으로 검색"
                className={inputCls}
              />
              {/* ④ 리스트 헤더 — 선택 카운트 + 전체선택/해제 */}
              <div className="flex items-center justify-between text-xs">
                <span className="font-bold text-slate-700 tabular-nums">{selected.size.toLocaleString()}건 선택됨</span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => selectAll(sortedRows)}
                    className="text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                  >
                    전체 선택
                  </button>
                  {filterText && (
                    <button
                      type="button"
                      onClick={() => selectAll(filteredRows)}
                      className="text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                    >
                      필터 결과 전체 선택
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={clearAll}
                    className="text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                  >
                    전체 해제
                  </button>
                </div>
              </div>
            </div>

            {/* ③ 대상 주문 리스트 (최대 영역, 스크롤) */}
            <div className="flex-1 min-h-[160px] overflow-y-auto px-5 py-3">
              {loadError ? (
                <div className="text-sm text-destructive bg-white p-4 rounded-xl border border-destructive/20">{loadError}</div>
              ) : rows === null ? (
                <div className="text-sm text-slate-500 p-4 text-center">미발송 주문을 불러오는 중...</div>
              ) : filteredRows.length === 0 ? (
                <div className="text-sm text-slate-500 italic p-4 text-center">
                  {sortedRows.length === 0 ? '이 캠페인에 미발송 주문이 없습니다.' : '필터와 일치하는 옵션이 없습니다.'}
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {filteredRows.map((row) => {
                    const g = dueGroup(row, todayIdx);
                    const checked = selected.has(row.productOrderId);
                    return (
                      <li key={row.productOrderId}>
                        <label
                          className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                            row.claimInProgress
                              ? 'border-slate-100 bg-slate-50/50 cursor-not-allowed'
                              : checked
                                ? 'border-blue-200 bg-blue-50/40 cursor-pointer'
                                : 'border-slate-200 bg-white hover:bg-slate-50 cursor-pointer'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={row.claimInProgress}
                            onChange={() => toggleRow(row)}
                            className="mt-0.5 w-4 h-4 text-blue-600 bg-white border-slate-300 rounded focus:ring-focus-ring focus:ring-2 disabled:opacity-40 shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span
                                className="text-[13px] font-medium text-slate-700"
                                title={row.receiverName && row.receiverName !== row.ordererName ? `수령인 ${row.receiverName}` : undefined}
                              >
                                {row.ordererName || row.receiverName || '—'}
                              </span>
                              <span className="text-[11px] text-slate-500 tabular-nums">{row.quantity}개</span>
                              {row.alreadyDelayed && (
                                <span
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-medium"
                                  title="이미 발송지연 안내가 등록된 주문: 다시 등록하면 고객이 알림을 또 받습니다"
                                >
                                  안내됨 · {fmtMd(row.shippingDueDate)} 예정
                                </span>
                              )}
                              {row.claimInProgress && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--status-urgent-bg)] text-[var(--status-urgent-text)] font-bold">
                                  클레임 진행중
                                </span>
                              )}
                            </div>
                            <p className="text-[12px] text-slate-500 truncate mt-0.5" title={row.productOption || undefined}>
                              {row.productOption || row.productName || '옵션 정보 없음'}
                            </p>
                          </div>
                          <div className="shrink-0 text-right text-[11px] leading-5">
                            <div className="text-slate-500 tabular-nums">결제 {fmtMd(row.paymentDate)}</div>
                            {g.group === 0 ? (
                              <div
                                className="font-bold tabular-nums text-[var(--status-urgent-text)] border-b border-dotted border-[var(--status-urgent-text)] cursor-help inline-block"
                                title={`기한 ${g.overdueDays}일 경과`}
                              >
                                기한 {fmtMd(row.shippingDueDate)}
                              </div>
                            ) : g.group === 1 ? (
                              <div className="font-semibold tabular-nums text-[var(--status-caution-text)]">
                                기한 {fmtMd(row.shippingDueDate)}
                              </div>
                            ) : (
                              <div className="text-slate-500 tabular-nums">기한 {fmtMd(row.shippingDueDate)}</div>
                            )}
                          </div>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="p-5 border-t border-slate-100 bg-slate-50 rounded-b-2xl flex justify-end items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2 text-sm text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 font-bold transition-colors"
              >
                취소
              </button>
              <button
                type="button"
                disabled={!canProceed}
                onClick={() => setStep('confirm')}
                className="px-5 py-2 text-sm text-primary-foreground bg-primary rounded-lg hover:bg-primary/95 font-bold shadow-soft-md transition-[background-color,opacity] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                다음
              </button>
            </div>
          </>
        )}

        {/* Step 2: 확인 */}
        {step === 'confirm' && (
          <>
            <div className="p-5 space-y-4 overflow-y-auto">
              {/* ① caution 톤 배너 */}
              <div className="rounded-xl border border-amber-200 bg-[var(--status-caution-bg)] p-4">
                <h3 className="text-sm font-bold text-[var(--status-caution-text)]">
                  지연 안내, 지금 고객에게 전송됩니다
                </h3>
                <p className="text-[13px] text-[var(--status-caution-text)] mt-1.5 leading-relaxed">
                  선택한 {selectedRows.length.toLocaleString()}건에 발송예정일 {fmtKoreanDate(dueDateStr)} 안내가
                  문자·네이버 알림으로 즉시 나갑니다. 이 알림은 취소할 수 없고, 같은 건에 다시 등록하면
                  고객이 알림을 또 받습니다.
                </p>
              </div>

              {/* ② 읽기 전용 요약 + 대상 변경 */}
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <span className="text-sm text-slate-700">
                    대상 <span className="font-bold tabular-nums">{selectedRows.length.toLocaleString()}건</span>
                    <span className="text-slate-300 mx-1.5">·</span>사유 <span className="font-bold">{reasonLabel}</span>
                    <span className="text-slate-300 mx-1.5">·</span>발송예정일 <span className="font-bold">{fmtKoreanDate(dueDateStr)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setStep('select')}
                    className="text-xs text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                  >
                    대상 변경
                  </button>
                </div>
                {renotifyCount > 0 && (
                  <p className="text-[12px] font-semibold text-[var(--status-caution-text)] mt-2">
                    재알림 대상 {renotifyCount.toLocaleString()}건 포함
                  </p>
                )}
                <p className="text-[12px] text-slate-500 mt-2 whitespace-pre-wrap break-words">
                  상세 사유: {detailedReason.trim()}
                </p>
              </div>
            </div>

            <div className="p-5 border-t border-slate-100 bg-slate-50 rounded-b-2xl flex justify-end items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setStep('select')}
                className="px-5 py-2 text-sm text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 font-bold transition-colors"
              >
                이전
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={execute}
                className="px-5 py-2 text-sm text-primary-foreground bg-primary rounded-lg hover:bg-primary/95 font-bold shadow-soft-md transition-[background-color,opacity] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                지연 안내 {selectedRows.length.toLocaleString()}건 등록
              </button>
            </div>
          </>
        )}

        {/* 실행 중: 모달 내부 진행 표시 */}
        {step === 'running' && (
          <div className="p-8">
            <p className="text-sm font-bold text-slate-700 text-center mb-4">
              지연 안내 등록 중… <span className="tabular-nums">{progress.done.toLocaleString()}/{progress.total.toLocaleString()}건</span>
            </p>
            <div className="relative h-2 w-full bg-slate-100 rounded-full overflow-hidden">
              <div
                className="absolute top-0 left-0 h-full w-full origin-left rounded-full bg-primary transition-transform duration-300"
                style={{ transform: `scaleX(${progress.total > 0 ? progress.done / progress.total : 0})` }}
              />
            </div>
            <p className="text-[11px] text-slate-500 text-center mt-3">창을 닫지 마세요. 처리 결과가 이 화면에 표시됩니다.</p>
          </div>
        )}

        {/* 결과: 같은 모달 내 상태 전환 — 자동 닫힘 금지 */}
        {step === 'result' && result && (
          <>
            <div className="p-5 space-y-4 overflow-y-auto">
              <div className="text-center py-3">
                <p className="text-xl font-bold tabular-nums">
                  <span className="text-slate-900">성공 {result.successCount.toLocaleString()}건</span>
                  <span className="text-slate-300 mx-2">/</span>
                  <span className={result.failCount > 0 ? 'text-destructive' : 'text-slate-300'}>
                    실패 {result.failCount.toLocaleString()}건
                  </span>
                  <span className="text-slate-300 mx-2">/</span>
                  <span className={result.skipCount > 0 ? 'text-slate-500' : 'text-slate-300'}>
                    스킵 {result.skipCount.toLocaleString()}건
                  </span>
                </p>
              </div>

              {result.failed.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold text-destructive mb-1.5">실패 {result.failed.length.toLocaleString()}건</h4>
                  <ul className="space-y-1 max-h-40 overflow-y-auto rounded-xl border border-destructive/20 bg-white p-3">
                    {result.failed.map((f, i) => (
                      <li key={i} className="text-[11px] text-slate-600 font-mono">
                        {f.productOrderId ? `${f.productOrderId}: ` : ''}{f.reason || '사유 미상'}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {result.skipped.length > 0 && (
                <div>
                  <h4 className="text-xs font-bold text-slate-500 mb-1.5">스킵 {result.skipped.length.toLocaleString()}건</h4>
                  <ul className="space-y-1 max-h-40 overflow-y-auto rounded-xl border border-slate-200 bg-white p-3">
                    {result.skipped.map((s, i) => (
                      <li key={i} className="text-[11px] text-slate-500 font-mono">
                        {s.productOrderId ? `${s.productOrderId}: ` : ''}{skipReasonLabel(s.reason)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="p-5 border-t border-slate-100 bg-slate-50 rounded-b-2xl flex justify-end shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2 text-sm text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 font-bold transition-colors"
              >
                닫기
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
