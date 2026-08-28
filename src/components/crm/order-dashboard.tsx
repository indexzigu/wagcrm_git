'use client';

import React, { useEffect, useState } from 'react';
import { CrmShell } from './crm-shell';
import { Button } from '@/components/ui/button';
import { DataEmpty } from '@/components/ui/empty';
import { PlusIcon, RefreshCw } from 'lucide-react';

type Campaign = {
  id: string;
  name: string;
  template: string;
  sellerName: string;
  toEmail?: string;
  ccEmail?: string;
  tasks: DailyTask[];
  mappings?: any[];
  thumbnailUrl?: string;
  orderConfirmedCount?: number;
  pendingCount?: number;
  shippingCount?: number;
  completedCount?: number;
  totalOrders?: number;
  totalRevenue?: number;
  isActive?: boolean;
  category?: string;
  salePeriod?: string;
};


import { useCampaigns } from '@/hooks/useCampaigns';
import { useNaverProducts } from '@/hooks/useNaverProducts';
import { useToast } from '@/hooks/useToast';
import CampaignCreateModal from './shipping/modals/CampaignCreateModal';
import CampaignEditModal from './shipping/modals/CampaignEditModal';
import EmailSendModal from './shipping/modals/EmailSendModal';
import DelayDispatchModal from './shipping/modals/DelayDispatchModal';
import ProductSelectModal from './shipping/modals/ProductSelectModal';
import SalesReportModal from './shipping/modals/SalesReportModal';
import CampaignInsightsModal from './shipping/modals/CampaignInsightsModal';

import { downloadExcelBlob } from '@/lib/order-converter/export-utils';
import type { TrackingData } from '@/lib/order-converter/order-parser';
import { isNaverProductOrderId } from '@/lib/order-converter/naver-order-id';
import {
  buildConfirmOrderLog,
  buildRequestPoLog,
  buildFetchInvoiceLog,
  buildRegisterInvoiceLog,
  ORDER_ACTION_LABELS,
  type OrderActionLogInput,
  type OrderAction,
  type OrderActionStatus,
} from '@/lib/order-converter/action-log';
import ClaimList from './claim-list';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useClaims } from '@/hooks/useClaims';

type DailyTask = {
  id: string;
  date: string;
  status: string;
};

// 캠페인 카드 배지/요약 바 클릭 시 열리는 클레임 서브뷰 필터.
// 별도 화면(탭)이 아니라 캠페인 맥락 안 서브뷰로 반품/교환을 통합한다(B3).
type ClaimFilter = { kind: 'campaign'; campaignName: string; orderIds?: string[] | null } | { kind: 'unmatched' } | { kind: 'all-in-progress' } | null;

// 송장 지연 상품주문 1건(배송대기 중 발주요청 후 경과 2일↑인 경고 건만). 서버(campaigns-handler)가
// "모든 배송대기"가 아니라 파악이 필요한 경고 건만 골라 카드에 실어 보낸다 — 클릭 시 즉시 팝오버.
type PendingOrderLine = {
  productOrderId: string;
  ordererName: string;
  receiverName: string;
  optionName: string;
  quantity: number;
  paymentDate: string | null;
  poRequestedAt: string | null;
};

// 배송 지연 경고 상품주문 1건(배송중=네이버 DELIVERING 중, 배송 경과가 임계값↑인 건만).
// 서버가 "모든 배송중"이 아니라 파악이 필요한 경고 건만 골라 카드에 실어 보낸다(클릭 시 즉시 팝오버).
// 발송 시각 필드가 스냅샷에 없어, 배송 경과는 결제/주문 시각(paymentDate) 기준(카드 경고와 동일).
type ShippingOrderLine = {
  productOrderId: string;
  ordererName: string;
  receiverName: string;
  optionName: string;
  quantity: number;
  paymentDate: string | null;
};

// 송장 지연 팝오버(배송대기 중 발주요청 후 경과 2일↑인 건). 운영자가 "어떤 건 거래처에 송장을
// 독촉할지" 판단하는 화면이라, "모든 배송대기"가 아니라 파악이 필요한 경고 건만 담는다(서버가 이미
// 걸러 보냄). 핵심 판단값 "발주요청 후 경과일"을 좌측에 크게 세운다. 임계값 2일 = 카드 배송대기
// 경고(pendingDelayDays)와 동일 집합. 데스크톱 카드 전용(P5). 배송 지연 팝오버와 대칭.
function PendingOrdersPopover({ campName, orders, onClose }: { campName: string; orders: PendingOrderLine[]; onClose: () => void }) {
    // eslint-disable-next-line react-hooks/purity
  const now = Date.now(); // 클릭(마운트 후)에만 렌더되므로 하이드레이션 불일치 없음
  const fmtMd = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const elapsedDays = (iso: string | null): number | null =>
    iso ? Math.floor((now - new Date(iso).getTime()) / 86400000) : null;

  return (
    // Radix Popover(포털)로 전환(오너 2026-07-24) — 수제 absolute 배치는 페이지 하단·우측에서 뷰포트
    // 밖으로 잘렸다. 포털+충돌 회피(flip/shift)+available-height 캡으로 어디서 열려도 화면 안에 든다.
    // modal: 구 백드롭과 동일하게 바깥 클릭을 삼켜 카드 아코디언 토글로 번지지 않게 한다.
    <PopoverContent
      align="start"
      sideOffset={8}
      collisionPadding={12}
      aria-label={`${campName} 송장 지연 목록`}
      onClick={(e) => e.stopPropagation()}
      className="flex w-[420px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-overlay max-h-[min(420px,var(--radix-popover-content-available-height))]"
    >
        <div className="flex shrink-0 items-center justify-between px-4 py-2.5 border-b border-slate-100 bg-slate-50/70">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-destructive shrink-0" aria-hidden="true" />
            <span className="text-[12px] font-bold text-slate-700 shrink-0">송장 지연 {orders.length}건</span>
            <span className="text-[11px] text-slate-500 font-medium truncate">발주요청 2일↑ · 송장 독촉 · 오래된 순</span>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-600 p-0.5 shrink-0" aria-label="닫기">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        {orders.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-slate-500">송장 지연 주문이 없습니다.</div>
        ) : (
          <div className="min-h-0 flex-1 max-h-[320px] overflow-y-auto divide-y divide-slate-100">
            {orders.map((o) => {
              const days = elapsedDays(o.poRequestedAt);
              const warn = days != null && days >= 2;
              return (
                <div key={o.productOrderId} className="px-4 py-2.5 flex items-start gap-3">
                  {/* 경과일 — 핵심 판단 값(2일↑ 경고 톤) */}
                  <div className="shrink-0 w-12 flex flex-col items-center pt-0.5">
                    {days != null ? (
                      <span className={`text-[16px] font-black tabular-nums leading-none ${warn ? 'text-destructive' : 'text-slate-700'}`}>{days}<span className="text-[10px] font-bold">일</span></span>
                    ) : (
                      <span className="text-[13px] font-bold text-slate-300 leading-none">·</span>
                    )}
                    <span className={`text-[9px] mt-1 font-semibold ${warn ? 'text-destructive' : 'text-slate-500'}`}>발주경과</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[12px]">
                      <span className="font-bold text-slate-800 truncate">{o.ordererName || '구매자 미상'}</span>
                      {o.receiverName && o.receiverName !== o.ordererName && (
                        <span className="text-slate-500 shrink-0 truncate">→ {o.receiverName}</span>
                      )}
                      <span className="text-slate-300 shrink-0" aria-hidden="true">·</span>
                      <span className="tabular-nums text-slate-500 shrink-0">{o.quantity}개</span>
                    </div>
                    <div className="text-[11px] text-slate-500 truncate mt-0.5">{o.optionName || '옵션 없음'}</div>
                    <div className="text-[10px] text-slate-500 tabular-nums mt-0.5 flex flex-wrap gap-x-2">
                      <span>주문 {o.productOrderId}</span>
                      <span aria-hidden="true">·</span>
                      <span>결제 {fmtMd(o.paymentDate)}</span>
                      <span aria-hidden="true">·</span>
                      <span>발주 {fmtMd(o.poRequestedAt)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </PopoverContent>
  );
}

// 배송 지연 팝오버. 운영자가 "어떤 건이 배송 지연이라 택배사/고객에 확인할지" 판단하는 화면이라,
// "모든 배송중"이 아니라 파악이 필요한 경고 건(배송 경과 5일↑)만 담는다(서버가 이미 걸러 보냄).
// 핵심 판단값인 "배송 경과일"(주문 후 경과)을 좌측에 크게 세운다. 임계값 5일 = 카드 배송중 경고
// (shippingDelayDays)와 동일 집합. 데스크톱 카드 전용(P5). 배송대기 팝오버(PendingOrdersPopover)와 대칭.
// 배송 지연·발주 지연 공용 팝오버. 라벨만 파라미터화(기본값=배송 지연)해 주문확인 후 발주 지연에도 재사용한다.
function DelayOrdersPopover({ campName, orders, onClose, heading = '배송 지연', hint = '5일↑ 배송중 · 택배사/고객 확인 · 오래된 순', elapsedLabel = '배송경과', warnDays = 5 }: { campName: string; orders: ShippingOrderLine[]; onClose: () => void; heading?: string; hint?: string; elapsedLabel?: string; warnDays?: number }) {
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now(); // 클릭(마운트 후)에만 렌더되므로 하이드레이션 불일치 없음
  const fmtMd = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  const elapsedDays = (iso: string | null): number | null =>
    iso ? Math.floor((now - new Date(iso).getTime()) / 86400000) : null;

  return (
    // Radix Popover(포털)로 전환(오너 2026-07-24) — 클리핑 근절 사유는 PendingOrdersPopover 주석 참조
    <PopoverContent
      align="start"
      sideOffset={8}
      collisionPadding={12}
      aria-label={`${campName} ${heading} 목록`}
      onClick={(e) => e.stopPropagation()}
      className="flex w-[420px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-overlay max-h-[min(420px,var(--radix-popover-content-available-height))]"
    >
        <div className="flex shrink-0 items-center justify-between px-4 py-2.5 border-b border-slate-100 bg-slate-50/70">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-2 h-2 rounded-full bg-destructive shrink-0" aria-hidden="true" />
            <span className="text-[12px] font-bold text-slate-700 shrink-0">{heading} {orders.length}건</span>
            <span className="text-[11px] text-slate-500 font-medium truncate">{hint}</span>
          </div>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-600 p-0.5 shrink-0" aria-label="닫기">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        {orders.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-slate-500">{heading} 주문이 없습니다.</div>
        ) : (
          <div className="min-h-0 flex-1 max-h-[320px] overflow-y-auto divide-y divide-slate-100">
            {orders.map((o) => {
              const days = elapsedDays(o.paymentDate);
              const warn = days != null && days >= warnDays;
              return (
                <div key={o.productOrderId} className="px-4 py-2.5 flex items-start gap-3">
                  {/* 경과일 — 핵심 판단 값(5일↑ 경고 톤, 카드 배송중 경고와 동일 기준) */}
                  <div className="shrink-0 w-12 flex flex-col items-center pt-0.5">
                    {days != null ? (
                      <span className={`text-[16px] font-black tabular-nums leading-none ${warn ? 'text-destructive' : 'text-slate-700'}`}>{days}<span className="text-[10px] font-bold">일</span></span>
                    ) : (
                      <span className="text-[13px] font-bold text-slate-300 leading-none">·</span>
                    )}
                    <span className={`text-[9px] mt-1 font-semibold ${warn ? 'text-destructive' : 'text-slate-500'}`}>{elapsedLabel}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[12px]">
                      <span className="font-bold text-slate-800 truncate">{o.ordererName || '구매자 미상'}</span>
                      {o.receiverName && o.receiverName !== o.ordererName && (
                        <span className="text-slate-500 shrink-0 truncate">→ {o.receiverName}</span>
                      )}
                      <span className="text-slate-300 shrink-0" aria-hidden="true">·</span>
                      <span className="tabular-nums text-slate-500 shrink-0">{o.quantity}개</span>
                    </div>
                    <div className="text-[11px] text-slate-500 truncate mt-0.5">{o.optionName || '옵션 없음'}</div>
                    <div className="text-[10px] text-slate-500 tabular-nums mt-0.5 flex flex-wrap gap-x-2">
                      <span>주문 {o.productOrderId}</span>
                      <span aria-hidden="true">·</span>
                      <span>결제 {fmtMd(o.paymentDate)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </PopoverContent>
  );
}

// 판매기간(campEnd) 종료 후 들어온 발주 대상 주문 1건. 발주서엔 실리지만 주문확인 집계엔 미포함 —
// 카드 '판매기간 후 N건' 배지 클릭 시 이 목록으로 어떤 주문인지 보여준다(최신순, 서버 100건 캡).
type PostPeriodOrderLine = {
  productOrderId: string;
  ordererName: string;
  receiverName: string;
  optionName: string;
  quantity: number;
  paymentDate: string | null;
};

// 판매기간 후 주문 팝오버. 핵심 판단값은 "언제 들어왔나"(주문일)라, 좌측에 월/일을 세운다.
// caution 톤(연장 반영 or 마감 확인이 필요한 안내 신호). 데스크톱 카드 전용(P5).
function PostPeriodOrdersPopover({ campName, salePeriod, totalCount, orders, onClose }: { campName: string; salePeriod: string; totalCount: number; orders: PostPeriodOrderLine[]; onClose: () => void }) {
  const fmtMd = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  return (
    // Radix Popover(포털)로 전환(오너 2026-07-24) — 클리핑 근절 사유는 PendingOrdersPopover 주석 참조
    <PopoverContent
      align="start"
      sideOffset={8}
      collisionPadding={12}
      aria-label={`${campName} 판매기간 후 주문 목록`}
      onClick={(e) => e.stopPropagation()}
      className="flex w-[440px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-overlay max-h-[min(440px,var(--radix-popover-content-available-height))]"
    >
        <div className="shrink-0 px-4 py-2.5 border-b border-slate-100 bg-status-caution-bg/60">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2 h-2 rounded-full bg-status-caution shrink-0" aria-hidden="true" />
              <span className="text-[12px] font-bold text-slate-700 shrink-0">판매기간 후 주문 {totalCount.toLocaleString()}건</span>
            </div>
            <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-600 p-0.5 shrink-0" aria-label="닫기">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
          <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
            판매기간({salePeriod || '미상'}) <b>이후</b> 결제된 발주 대상 주문. 발주서엔 실리지만 주문확인 집계엔 미포함.
            이 건들도 회차 성과에 넣으려면 <b>판매관리</b>에서 해당 회차의 종료일을 늘리세요(집계 기간의 정본은 판매관리 일정입니다).
            판매를 끝낼 거면 <b>판매마감</b>으로 확정하세요.
          </div>
        </div>
        {orders.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-slate-500">표시할 주문이 없습니다.</div>
        ) : (
          <div className="min-h-0 flex-1 max-h-[320px] overflow-y-auto divide-y divide-slate-100">
            {orders.map((o) => (
              <div key={o.productOrderId} className="px-4 py-2.5 flex items-start gap-3">
                <div className="shrink-0 w-12 flex flex-col items-center pt-0.5">
                  <span className="text-[13px] font-black tabular-nums leading-none text-status-caution">{fmtMd(o.paymentDate)}</span>
                  <span className="text-[9px] mt-1 font-semibold text-slate-500">주문일</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[12px]">
                    <span className="font-bold text-slate-800 truncate">{o.ordererName || '구매자 미상'}</span>
                    {o.receiverName && o.receiverName !== o.ordererName && (
                      <span className="text-slate-500 shrink-0 truncate">→ {o.receiverName}</span>
                    )}
                    <span className="text-slate-300 shrink-0" aria-hidden="true">·</span>
                    <span className="tabular-nums text-slate-500 shrink-0">{o.quantity}개</span>
                  </div>
                  <div className="text-[11px] text-slate-500 truncate mt-0.5">{o.optionName || '옵션 없음'}</div>
                  <div className="text-[10px] text-slate-500 tabular-nums mt-0.5">주문 {o.productOrderId}</div>
                </div>
              </div>
            ))}
            {totalCount > orders.length && (
              <div className="px-4 py-2 text-center text-[11px] text-slate-500">외 {(totalCount - orders.length).toLocaleString()}건 (최신 {orders.length}건만 표시)</div>
            )}
          </div>
        )}
    </PopoverContent>
  );
}

type OrderActionLogRow = {
  id: string;
  action: OrderAction;
  status: OrderActionStatus;
  successCount: number;
  failCount: number;
  skipCount: number;
  errorMessage: string | null;
  details: { failed?: Array<{ productOrderId?: string; reason?: string }>; skipped?: Array<{ productOrderId?: string; reason?: string }>; fileName?: string } | null;
  actor: string;
  createdAt: string;
};

// 작업 기록 패널 — 4개 액션 버튼(주문확인/발주요청/송장회신/송장등록)의 영속 감사 로그를
// 캠페인 아코디언 상세 최상단에 표시한다. 실사고(중복 송장 실패 미인지) 예방이 목적이므로,
// styleseed 색=의미 규칙대로 '정상'은 회색으로 가라앉히고 실패/부분실패만 색으로 끌어올린다.
// 전역 캐시: 작업 기록은 버튼 액션 외에는 변경되지 않으므로, 아코디언 토글 시 매번 DB를 조회하지 않고 메모리에 캐싱한다.
const actionLogCache = new Map<string, { key: number; data: OrderActionLogRow[] }>();

function CampaignActionLog({ campaignId, refreshKey }: { campaignId: string; refreshKey: number }) {
  const [logs, setLogs] = useState<OrderActionLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const cached = actionLogCache.get(campaignId);
    if (cached && cached.key === refreshKey) {
      setLogs(cached.data);
      return;
    }
    setLogs(null);
    setError(null);
    fetch(`/order-converter/api/action-log?campaignId=${encodeURIComponent(campaignId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('작업 기록을 불러오지 못했습니다.'))))
      .then((d) => {
        if (!cancelled) {
          const fetchedLogs = d.logs ?? [];
          actionLogCache.set(campaignId, { key: refreshKey, data: fetchedLogs });
          setLogs(fetchedLogs);
        }
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [campaignId, refreshKey]);

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}`;
  };

  const statusPill = (status: OrderActionStatus) => {
    if (status === 'OK') return { cls: 'border-slate-200 bg-slate-50 text-slate-500', label: '정상' };
    if (status === 'PARTIAL') return { cls: 'border-amber-200 bg-amber-50 text-amber-700', label: '부분 실패' };
    return { cls: 'border-destructive/25 bg-destructive/5 text-destructive', label: '실패' };
  };

  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-bold text-slate-700">작업 기록</h4>
        {logs && logs.length > 1 && (
          <button onClick={() => setIsExpanded(!isExpanded)} className="text-xs text-slate-500 hover:text-slate-700 font-medium flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring rounded">
            {isExpanded ? '접기' : `전체 보기 (${logs.length})`}
            <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          </button>
        )}
      </div>
      {error ? (
        <div className="text-sm text-destructive bg-white p-4 rounded-xl border border-destructive/20">{error}</div>
      ) : logs === null ? (
        <div className="text-sm text-slate-500 bg-white p-4 rounded-xl border border-slate-100">불러오는 중...</div>
      ) : logs.length === 0 ? (
        <div className="text-sm text-slate-500 italic bg-white p-4 rounded-xl border border-slate-100 text-center">
          아직 기록된 작업이 없습니다. 주문확인·발주요청·송장회신·송장등록 실행 시 여기에 남습니다.
        </div>
      ) : (
        <div className="space-y-1.5">
          {logs.slice(0, isExpanded ? logs.length : 1).map((log) => {
            const pill = statusPill(log.status);
            const failed = log.details?.failed ?? [];
            const skipped = log.details?.skipped ?? [];
            // 색=의미: 카드 테두리·에러문구도 상태 3단계를 그대로 따른다(부분실패가 완전실패로 뭉개지지 않게).
            const cardBorder =
              log.status === 'ERROR' ? 'border-destructive/20' : log.status === 'PARTIAL' ? 'border-amber-200/70' : 'border-slate-200';
            const msgColor =
              log.status === 'ERROR' ? 'text-destructive' : log.status === 'PARTIAL' ? 'text-amber-700' : 'text-slate-500';
            return (
              <div
                key={log.id}
                className={`bg-white rounded-xl border shadow-soft-sm px-4 py-2.5 ${cardBorder}`}
              >
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-[11px] text-slate-500 tabular-nums w-[78px] shrink-0">{fmtTime(log.createdAt)}</span>
                  <span className="text-[13px] font-medium text-slate-700 w-[72px] shrink-0">{ORDER_ACTION_LABELS[log.action] ?? log.action}</span>
                  <span className={`text-[11px] px-2 py-0.5 rounded border ${log.status === 'OK' ? 'font-medium' : 'font-bold'} ${pill.cls}`}>{pill.label}</span>
                  <div className="flex items-center gap-3 text-[12px] tabular-nums ml-auto">
                    {log.successCount > 0 && <span className="text-slate-600">성공 {log.successCount.toLocaleString()}</span>}
                    {log.failCount > 0 && <span className="text-destructive font-bold">실패 {log.failCount.toLocaleString()}</span>}
                    {log.skipCount > 0 && <span className="text-slate-500">스킵 {log.skipCount.toLocaleString()}</span>}
                  </div>
                </div>
                {(log.errorMessage || failed.length > 0 || skipped.length > 0 || log.details?.fileName) && (
                  <div className="mt-1.5 pl-[90px]">
                    {log.errorMessage && (
                      <p className={`text-[12px] ${msgColor}`}>{log.errorMessage}</p>
                    )}
                    {failed.length > 0 && (
                      <details className="mt-1">
                        <summary className="marker:hidden [&::-webkit-details-marker]:hidden text-[11px] font-medium text-destructive underline decoration-destructive/30 underline-offset-2 hover:decoration-destructive/60 cursor-pointer select-none rounded focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none">
                          실패 {failed.length.toLocaleString()}건 자세히
                        </summary>
                        <ul className="mt-1 space-y-0.5">
                          {failed.map((f, i) => (
                            <li key={i} className="text-[11px] text-slate-500 font-mono">
                              {f.productOrderId ? `${f.productOrderId}: ` : ''}{f.reason || '사유 미상'}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {skipped.length > 0 && (
                      <details className="mt-1">
                        <summary className="marker:hidden [&::-webkit-details-marker]:hidden text-[11px] text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-600 hover:decoration-slate-400 cursor-pointer select-none rounded focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none">
                          스킵 {skipped.length.toLocaleString()}건 자세히
                        </summary>
                        <ul className="mt-1 space-y-0.5">
                          {skipped.map((s, i) => (
                            <li key={i} className="text-[11px] text-slate-500 font-mono">
                              {s.productOrderId ? `${s.productOrderId}: ` : ''}{s.reason || '사유 미상'}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {log.details?.fileName && (
                      <p className="text-[11px] text-slate-500 mt-1">파일: {log.details.fileName}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DailyStatusAccordion({ camp }: { camp: any }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const dailyStats = camp.dailyStats || [];
  const tasks = camp.tasks || [];
  const dateSet = new Set<string>([
    ...dailyStats.map((s: any) => s.date),
    ...tasks.map((t: any) => t.date)
  ]);
  const combined = Array.from(dateSet).sort((a, b) => b.localeCompare(a)).map(date => ({
    date,
    stat: dailyStats.find((s: any) => s.date === date) || { orders: 0, revenue: 0 },
    task: tasks.find((t: any) => t.date === date) || null
  }));

  if (combined.length === 0) {
    return (
      <div className="mt-4">
        <h4 className="text-sm font-bold text-slate-700 mb-4">일자별 주문 현황</h4>
        <DataEmpty title="집계된 내역이 없습니다." />
      </div>
    );
  }

  const visibleItems = isExpanded ? combined : combined.slice(0, 1);

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-bold text-slate-700">일자별 주문 현황</h4>
        {combined.length > 1 && (
          <button onClick={() => setIsExpanded(!isExpanded)} className="text-xs text-slate-500 hover:text-slate-700 font-medium flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring rounded">
            {isExpanded ? '접기' : `전체 보기 (${combined.length})`}
            <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
          </button>
        )}
      </div>
      <div className="space-y-3">
        {visibleItems.map((item, idx) => {
          const s = item.stat;
          return (
            <div key={idx} className="bg-white p-4 rounded-xl border border-slate-200 shadow-soft-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
              {/* 좌측: 날짜 / 총주문 / 매출액 */}
              <div className="flex items-center gap-4 shrink-0">
                <span className="font-medium text-slate-700 text-sm w-24 shrink-0 text-center">{item.date}</span>
                <div className="w-px h-4 bg-slate-200 shrink-0"></div>
                
                <div className="flex items-center w-[90px] shrink-0 justify-between">
                  <span className="text-[11px] text-slate-500 font-normal">주문</span>
                  <div className="text-[13px] font-medium text-slate-700 tabular-nums text-right">
                    {(s.orders ?? 0).toLocaleString()}<span className="text-[11px] text-slate-500 ml-0.5 font-normal">건</span>
                  </div>
                </div>
                
                <div className="w-px h-4 bg-slate-200 shrink-0"></div>

                <div className="flex items-center w-[90px] shrink-0 justify-between">
                  <span className="text-[11px] text-slate-500 font-normal">수량</span>
                  <div className="text-[13px] font-medium text-slate-700 tabular-nums text-right">
                    {(s.quantity ?? 0).toLocaleString()}<span className="text-[11px] text-slate-500 ml-0.5 font-normal">개</span>
                  </div>
                </div>
                
                <div className="w-px h-4 bg-slate-200 shrink-0"></div>
                
                <div className="flex items-center w-[130px] shrink-0 justify-between">
                  <span className="text-[11px] text-slate-500 font-normal">매출</span>
                  <div className="text-[13px] font-medium text-slate-700 tabular-nums text-right">
                    {(s.revenue ?? 0).toLocaleString()}<span className="text-[11px] text-slate-500 ml-0.5 font-normal">원</span>
                  </div>
                </div>
              </div>
              
              {/* 우측: 일자별 주문 상태 건수 (주문확인, 배송대기, 배송중, 배송완료) */}
              <div className="flex-1 flex flex-wrap gap-x-4 gap-y-2 md:justify-end items-center mt-2 md:mt-0 px-2 md:px-0">
                <div className="flex items-center w-[130px] shrink-0 justify-between">
                  <span className="text-[11px] text-slate-500 font-normal">주문확인</span>
                  <div className="text-[13px] font-medium text-slate-700 tabular-nums text-right">
                    {(s.newOrderBefore ?? 0).toLocaleString()} / {(s.newOrderAfter ?? 0).toLocaleString()}<span className="text-[11px] text-slate-500 ml-0.5 font-normal">건</span>
                  </div>
                </div>
                <div className="w-px h-3.5 bg-slate-200 hidden md:block"></div>
                <div className="flex items-center w-[90px] shrink-0 justify-between">
                  <span className="text-[11px] text-slate-500 font-normal">배송대기</span>
                  <div className="text-[13px] font-medium text-slate-700 tabular-nums text-right">
                    {(s.pending ?? 0).toLocaleString()}<span className="text-[11px] text-slate-500 ml-0.5 font-normal">건</span>
                  </div>
                </div>
                <div className="w-px h-3.5 bg-slate-200 hidden md:block"></div>
                <div className="flex items-center w-[90px] shrink-0 justify-between">
                  <span className="text-[11px] text-slate-500 font-normal">배송중</span>
                  <div className="text-[13px] font-medium text-slate-700 tabular-nums text-right">
                    {(s.shipping ?? 0).toLocaleString()}<span className="text-[11px] text-slate-500 ml-0.5 font-normal">건</span>
                  </div>
                </div>
                <div className="w-px h-3.5 bg-slate-200 hidden md:block"></div>
                <div className="flex items-center w-[90px] shrink-0 justify-between">
                  <span className="text-[11px] text-slate-500 font-normal">배송완료</span>
                  <div className="text-[13px] font-medium text-slate-700 tabular-nums text-right">
                    {(s.completed ?? 0).toLocaleString()}<span className="text-[11px] text-slate-500 ml-0.5 font-normal">건</span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function OrderDashboard() {
  const { campaigns, isLoading, fetchCampaigns, createCampaign, updateCampaign, deleteCampaign, toggleCampaignStatus, syncMeta, refreshNow, refreshing } = useCampaigns();
  const { naverProducts, isFetchingNaver, fetchNaverProducts } = useNaverProducts();
  const { toasts, addToast, removeToast } = useToast();
  // 캠페인 카드별 배지 카운트 + 상단 요약 바 카운터에 쓰는 클레임 데이터.
  // claim-list.tsx의 ClaimList가 서브뷰로 열렸을 때 내부에서 별도로 다시 마운트하지만,
  // useClaims는 plain fetch 훅이라 두 번 마운트돼도 상태는 독립적이고 무해하다.
  const { claims: allClaims } = useClaims();
  const [claimFilter, setClaimFilter] = useState<ClaimFilter>(null);
  // 드로어(Sheet) 닫힘 애니메이션(~200ms) 동안 claimFilter는 즉시 null이 되지만, 그 사이에도
  // 제목·목록이 마지막 값으로 남아야 빈 패널이 슬라이드아웃되는 잔상이 안 생긴다. 마지막 비-null
  // 필터를 렌더 중 스냅샷으로 유지한다(React 공식 "렌더 중 파생 state 조정" 패턴 — 열릴 때 즉시 반영).
  const [displayedClaimFilter, setDisplayedClaimFilter] = useState<ClaimFilter>(null);
  if (claimFilter && claimFilter !== displayedClaimFilter) setDisplayedClaimFilter(claimFilter);

  const [isMounted, setIsMounted] = useState(false);
  
  // Create Form
  const [, setIsCreating] = useState(false);
  
  // Data Preview State
  const [previewOrders, setPreviewOrders] = useState<any[]>([]);
  const [previewTracking, setPreviewTracking] = useState<Record<string, TrackingData>>({});
  const [previewTab, setPreviewTab] = useState<'orders' | 'tracking'>('orders');
  const [previewInvoiceBuffer, setPreviewInvoiceBuffer] = useState<ArrayBuffer | null>(null);
  const [previewInvoiceFileName, setPreviewInvoiceFileName] = useState<string>('');
  // 미리보기 송장 데이터가 어느 캠페인 것인지 추적 — '확정'(미리보기 탭) 재등록 경로가
  // campaign 식별자 없이 previewTracking만 쓰므로, 감사 로그 귀속을 위해 소스 캠페인을 보관.
  const [previewCampaign, setPreviewCampaign] = useState<{ id: string; name: string } | null>(null);
  // 새 작업 로그 기록 시 증가 — 아코디언 '작업 기록' 패널이 이 값을 구독해 재조회한다.
  const [actionLogRefresh, setActionLogRefresh] = useState(0);
  
  // Progress State for SSE
  const [activeProgress, setActiveProgress] = useState<{campaignId: string, progress: number, message: string} | null>(null);

  // 액션 in-flight 가드 — 같은 캠페인에 송장회신/송장등록이 중복 실행되면 여러 런이
  // 같은 주문을 두고 경쟁해 네이버 발송처리 API에 '9999 주문상태 확인' 실패가 무더기로
  // 찍히는 실사고(2026-07-10, 244건에 실패 107건)가 있었다. 액션·캠페인 단위로 실행 중
  // 키를 잡아 버튼을 잠그고(disabled+스피너), 프로그램적 동시 호출도 조용히 무시한다.
  const [busyActions, setBusyActions] = useState<Record<string, boolean>>({});
  const isActionBusy = (key: string) => !!busyActions[key];
  const setActionBusy = (key: string, busy: boolean) =>
    setBusyActions((prev) => {
      if (busy) return { ...prev, [key]: true };
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  // Accordion State
  const [expandedCampaignId, setExpandedCampaignId] = useState<string | null>(null);
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);
  // 배송대기·배송중 목록 팝오버가 열린 카드 id(각 버킷당 하나만, 서로 배타).
  const [pendingListCampaignId, setPendingListCampaignId] = useState<string | null>(null);
  const [shippingListCampaignId, setShippingListCampaignId] = useState<string | null>(null);
  const [confirmListCampaignId, setConfirmListCampaignId] = useState<string | null>(null);
  const [postPeriodListCampaignId, setPostPeriodListCampaignId] = useState<string | null>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.dropdown-container')) {
        return;
      }
      setOpenDropdownId(null);
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);
  
  // Naver API Form
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<any>(null);

  // Edit Form (Modal)
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);

  // Email Modal State
  const [emailModalCampaignId, setEmailModalCampaignId] = useState<string | null>(null);
  const [emailDefaultTo, setEmailDefaultTo] = useState('');
  const [emailDefaultCc, setEmailDefaultCc] = useState('');
  const [emailDefaultSubject, setEmailDefaultSubject] = useState('');
  const [emailDefaultMessage, setEmailDefaultMessage] = useState('');

  // Sales Report Modal State
  const [salesReportCampaignId, setSalesReportCampaignId] = useState<string | null>(null);
  const [insightsCampaignId, setInsightsCampaignId] = useState<string | null>(null);

  // 발송지연 안내 모달 — 드롭다운(⋮) '발송지연 안내' 진입. 실행 가드는 busyActions(delayDispatch:*).
  const [delayDispatchCampaignId, setDelayDispatchCampaignId] = useState<string | null>(null);

  useEffect(() => {
    setIsMounted(true);
  }, []);


  const openEditModal = (camp: Campaign) => {
    setEditingCampaign(camp);
  };

  // 주문관리 액션 감사 로그 기록(fire-and-forget). 기록 실패가 원 액션(발송처리 등)을
  // 되돌리지 않도록 절대 throw하지 않는다. actor는 서버가 requireAuth로 도출한다.
  const logOrderAction = (input: OrderActionLogInput) => {
    void fetch('/order-converter/api/action-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
      .then(() => setActionLogRefresh((n) => n + 1))
      .catch((e) => console.warn('작업 로그 기록 실패:', e));
  };



  const openEmailModal = (campaignId: string) => {
    const camp = campaigns.find(c => c.id === campaignId);
    setEmailModalCampaignId(campaignId);
    setEmailDefaultTo(camp?.toEmail || '');
    setEmailDefaultCc(camp?.ccEmail || '');
    const sellerName = camp?.sellerName || '';
    const today = new Date();
    const yy = String(today.getFullYear()).slice(-2);
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yy}${mm}${dd}`;
    setEmailDefaultSubject(`[와이그라운드] ${sellerName} ${todayStr} 발주서 보내드립니다.`);
    setEmailDefaultMessage(`안녕하세요,
금일 ${sellerName} 발주서를 첨부하여 전달드립니다.
확인후 회신 부탁드립니다.
감사합니다.`);
  };

  const handleFetchInvoice = async (campaign: Campaign) => {
    const busyKey = `fetchInvoice:${campaign.id}`;
    if (isActionBusy(busyKey)) return; // 이미 이 캠페인 송장회신 진행 중 — 중복 조회 무시(무음)
    setActionBusy(busyKey, true);
    try {
      addToast('송장 회신 메일을 확인 중입니다...', 'info');
      
      // 발주를 요청한 날짜(EMAILED 상태 등)를 추적하여 해당 날짜의 회신만 가져오도록 처리
      const activeTasks = campaign.tasks?.filter(t => t.status === 'EMAILED' || t.status === 'PENDING') || [];
      let sentDates: string[] = [];
      if (activeTasks.length > 0) {
        sentDates = activeTasks.map(t => {
          const d = new Date(t.date);
          const yy = String(d.getFullYear()).slice(-2);
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const dd = String(d.getDate()).padStart(2, '0');
          return `${yy}${mm}${dd}`;
        });
      } else {
        const today = new Date();
        sentDates = [`${String(today.getFullYear()).slice(-2)}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`];
      }

      const res = await fetch('/order-converter/api/fetch-emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          template: campaign.template, 
          sellerName: campaign.sellerName, 
          campaignName: campaign.name, 
          toEmail: campaign.toEmail, 
          campaignId: campaign.id,
          sentDates 
        })
      });
      if (!res.ok) {
        const errorData = await res.json();
        addToast(errorData.error || '회신 메일 확인 실패', 'error');
        logOrderAction(buildFetchInvoiceLog({
          campaign, trackingCount: 0, hadAttachment: false,
          error: errorData.error || '회신 메일 확인 실패',
        }));
        return;
      }
      const data = await res.json();

      if (data.fileData) {
        // Base64 디코딩 (원본 저장/미리보기용 버퍼)
        const binaryString = window.atob(data.fileData);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        // F4 Phase 2 §5단계: 송장 파싱은 서버(fetch-emails)가 브랜드 reply 규칙으로 수행.
        const trackingMap: Record<string, TrackingData> = data.trackingMap ?? {};
        setPreviewTracking(trackingMap);
        setPreviewTab('tracking');
        setPreviewCampaign({ id: campaign.id, name: campaign.name });

        // 다운로드를 위해 버퍼 상태에 저장 (0건이어도 원본 확인용으로 보관)
        setPreviewInvoiceBuffer(bytes.buffer);
        setPreviewInvoiceFileName(data.fileName || '송장회신.xlsx');

        // 파일은 받았어도 송장번호를 못 뽑으면 성공으로 위장하지 말고 이유를 알려준다
        const trackingCount = Object.keys(trackingMap).length;
        if (trackingCount > 0) {
          addToast(`송장 ${trackingCount}건 확보 완료! (${data.fileName || '성공'})`, 'success');
        } else {
          addToast(`메일(${data.fileName || '첨부'})은 받았지만 송장번호를 찾지 못했습니다. 회신 파일에 '송장번호/운송장번호' 컬럼이 없거나 값이 비어 있을 수 있어요. 아래 '저장'으로 원본을 열어 확인하세요.`, 'error');
        }
        logOrderAction(buildFetchInvoiceLog({
          campaign, trackingCount, hadAttachment: true, fileName: data.fileName || '송장회신.xlsx',
        }));
      } else {
        addToast('회신 메일은 찾았지만 첨부 파일이 없습니다.', 'error');
        logOrderAction(buildFetchInvoiceLog({
          campaign, trackingCount: 0, hadAttachment: false,
          error: '회신 메일은 찾았지만 첨부 파일이 없습니다.',
        }));
      }

      fetchCampaigns(true);
    } catch {
      addToast('요청 중 오류가 발생했습니다.', 'error');
      logOrderAction(buildFetchInvoiceLog({
        campaign, trackingCount: 0, hadAttachment: false, error: '요청 중 오류가 발생했습니다.',
      }));
    } finally {
      setActionBusy(busyKey, false);
    }
  };

  const submitTrackingData = async (trackingMap: Record<string, TrackingData>, options: { skipDownload?: boolean, sellerName?: string, campaign?: { id?: string; name: string } } = {}) => {
    // 같은 캠페인 송장등록(발송처리)이 진행 중이면 중복 제출을 무시한다. 카드 업로드
    // 버튼과 미리보기 '발송처리' 버튼이 같은 캠페인을 가리키므로 동일 키로 상호 잠긴다.
    const busyKey = `submitTracking:${options.campaign?.id ?? '__nocampaign__'}`;
    if (isActionBusy(busyKey)) return; // 중복 발송처리 방지(무음) — 버튼도 disabled 처리됨

    const records = Object.keys(trackingMap).map(id => ({
      id,
      courier: trackingMap[id].택배사,
      tracking: trackingMap[id].송장번호
    }));

    if (records.length === 0) {
      addToast('송장번호 데이터가 없습니다.', 'error');
      return;
    }

    // 네이버 제출 대상은 진짜 상품주문번호뿐이다. 발주서 '사은품' 시트는 부모 주문번호에
    // `_02G`를 붙인 가상 번호를 쓰는데(3PL에 사은품 줄을 분리 출고하려는 자체 규약) 네이버엔
    // 없는 번호라, 제출하면 400 '처리 권한이 없는 상품 주문 번호'로 반려된다(2026-07-14·15
    // 실사고: 매 송장등록마다 부분실패 오탐). 사은품은 부모 주문과 송장번호가 같아 동봉
    // 출고되므로 제외해도 실배송에 영향이 없다. 화면·미리보기는 사은품 줄을 그대로 보여주고
    // (오너 확정 2026-07-15), 네이버로 나가는 두 경로 — 일괄등록 엑셀·발송처리 API — 에서만 뺀다.
    const naverRecords = records.filter(r => isNaverProductOrderId(r.id));
    const giftRecords = records.filter(r => !isNaverProductOrderId(r.id));

    if (naverRecords.length === 0) {
      addToast(`송장 ${records.length}건이 모두 네이버 상품주문번호 형식이 아닙니다(사은품 등). 발송처리할 대상이 없습니다.`, 'error');
      return;
    }

    setActionBusy(busyKey, true);
    try {
    const courierMap: Record<string, string> = {
      'CJ대한통운': 'CJGLS', 'CJ택배': 'CJGLS', '롯데택배': 'HYUNDAI', '우체국택배': 'EPOST', '로젠택배': 'KGB', '한진택배': 'HANJIN'
    };

    const dispatchRequests = naverRecords.map(r => ({
      productOrderId: String(r.id).trim(),
      deliveryMethod: 'DELIVERY',
      deliveryCompanyCode: courierMap[r.courier.replace(/\s+/g, '')] || 'CJGLS',
      trackingNumber: String(r.tracking).trim(),
      dispatchDate: new Date().toISOString()
    }));

    addToast(`네이버 스토어에 발송 처리를 요청합니다. (${dispatchRequests.length}건)`, 'info');

    // 1. 배송등록용 엑셀 파일 생성 및 다운로드
    if (!options.skipDownload) {
      try {
        const XLSX = await import('xlsx');
        // 네이버 발송처리 일괄등록 양식이므로 사은품 가상 번호를 넣으면 업로드가 반려된다 —
        // API 제출과 동일하게 naverRecords만 싣는다.
        const excelData = naverRecords.map(r => ({
          '상품주문번호': r.id,
          '배송방법': '택배,등기,소포',
          '택배사': r.courier,
          '송장번호': r.tracking
        }));
        const worksheet = XLSX.utils.json_to_sheet(excelData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, '발송처리');
        
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const sellerStr = options.sellerName ? `_${options.sellerName}` : '';
        XLSX.writeFile(workbook, `네이버_송장등록${sellerStr}_${dateStr}.xls`, { bookType: 'biff8' });
        
        addToast('배송등록용 엑셀 파일 다운로드가 시작되었습니다.', 'success');
      } catch (e) {
        console.error('Excel generation failed:', e);
        addToast('엑셀 파일 생성 중 오류가 발생했습니다.', 'error');
      }
    }

    // 2. 네이버 API 청크 전송 (최대 건수 제한 우회)
    const CHUNK_SIZE = 20;
    let totalSuccess = 0;
    let totalFail = 0;
    let totalSkip = 0;
    let firstFailReason = '';
    let firstSkipReason = '';
    let hadNetworkError = false;
    // 감사 로그 details 용 — 어느 주문이 왜 실패/스킵됐는지 건별로 보존한다(중복 송장 등).
    const allFailed: Array<{ productOrderId?: string; reason?: string }> = [];
    const allSkipped: Array<{ productOrderId?: string; reason?: string }> = [];

    for (let i = 0; i < dispatchRequests.length; i += CHUNK_SIZE) {
      const chunk = dispatchRequests.slice(i, i + CHUNK_SIZE);
      try {
        const res = await fetch('/order-converter/api/naver/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dispatchRequests: chunk })
        });

        if (!res.ok) {
          const errorData = await res.json();
          console.error('Chunk dispatch error:', errorData);
          totalFail += chunk.length; // API 자체 실패도 실패 건수에 반영
          if (!firstFailReason) firstFailReason = errorData.error || '서버 오류';
          // 청크 전체 실패 — 개별 주문 귀속 없이 사유만 있으므로 주문별로 사유를 붙여 보존.
          for (const c of chunk) allFailed.push({ productOrderId: c.productOrderId, reason: errorData.error || '서버 오류' });
          continue;
        }

        const result = await res.json();
        totalSuccess += result.successCount || 0;
        totalFail += result.failCount || 0;
        if (Array.isArray(result.failed)) allFailed.push(...result.failed);
        if (result.failCount && !firstFailReason) {
          firstFailReason = result.firstFailReason || (result.failed?.[0]?.reason ?? '');
          console.warn(`[Chunk ${i}] 발송 실패 내역:`, result.failed);
        }
        if (result.skipCount) {
          totalSkip += result.skipCount;
          if (Array.isArray(result.skipped)) allSkipped.push(...result.skipped);
          if (!firstSkipReason) firstSkipReason = result.skipped?.[0]?.reason || '';
          console.log(`[Chunk ${i}] 스킵된 주문 내역:`, result.skipped);
        }
      } catch (e: any) {
        console.error('Network error during dispatch chunk:', e);
        hadNetworkError = true;
        totalFail += chunk.length; // 네트워크 실패분도 실패로 집계
        if (!firstFailReason) firstFailReason = '네트워크 오류';
        for (const c of chunk) allFailed.push({ productOrderId: c.productOrderId, reason: '네트워크 오류' });
      }
    }

    // 네이버에 제출하지 않은 사은품 줄 — 작업기록(감사 로그)에만 남기고 토스트에는 싣지
    // 않는다(오너 확정 2026-07-15). 매 송장등록마다 반복되는 정상 동작이라 토스트로 알리면
    // 이 수정이 없애려는 '배지 무감각'을 그대로 되풀이하게 되고, 액션당 토스트 1곳 소유·
    // 콜백 무음화 규약과도 어긋난다. 사후 추적은 작업기록 details.skipped가 담당한다.
    const giftSkips = giftRecords.map(g => ({
      productOrderId: g.id,
      reason: '사은품(네이버 미제출)',
    }));

    // 결과를 성공/실패/스킵으로 명확히 구분해 안내한다 — 토스트는 네이버 응답분만 집계한다
    // (사은품 제외분은 위 정책에 따라 의도적으로 빠져 있다).
    let resultMsg = `발송처리 결과: 성공 ${totalSuccess}건`;
    if (totalFail > 0) resultMsg += ` · 실패 ${totalFail}건${firstFailReason ? ` (${firstFailReason})` : ''}`;
    if (totalSkip > 0) resultMsg += ` · 스킵 ${totalSkip}건${firstSkipReason ? ` (${firstSkipReason} 등)` : '(이미 배송중 등)'}`;

    const toastType = (totalFail > 0 || hadNetworkError) ? 'error' : (totalSkip > 0 ? 'info' : 'success');
    addToast(resultMsg, toastType);

    // 송장등록 감사 로그 — 이 실사고(중복 송장 실패 미인지)의 핵심 기록. 부분 실패가
    // failed[]로 여기 보존되어 소유자가 사후 조회할 수 있다. campaign은 호출부가 제공하며
    // (업로드=현재 캠페인 / 미리보기 확정=previewCampaign), 없으면 미상 캠페인으로 남긴다.
    const logCampaign = options.campaign ?? previewCampaign ?? { name: options.sellerName ? `${options.sellerName}` : '(미상 캠페인)' };
    logOrderAction(buildRegisterInvoiceLog({
      campaign: logCampaign,
      successCount: totalSuccess,
      failCount: totalFail,
      // 토스트와 달리 감사 로그에는 사은품 제외분까지 싣는다 — 회신 송장 N건이 어디로
      // 갔는지(제출 vs 사은품 제외) 사후에 전량 대사할 수 있어야 한다. failCount에는
      // 넣지 않으므로 작업기록 배지는 '정상'을 유지한다(deriveCountStatus는 fail만 본다).
      skipCount: totalSkip + giftSkips.length,
      failed: allFailed,
      skipped: [...allSkipped, ...giftSkips],
      firstFailReason: firstFailReason || (hadNetworkError ? '네트워크 오류' : undefined),
      fileName: previewInvoiceFileName || undefined,
    }));

    // 송장등록은 네이버 발송처리(→배송중)로 주문상태를 바꾸므로, stale 스냅샷 캐시를
    // 그대로 반환하는 fetchCampaigns() 대신 refreshNow()로 CHANGED 동기화를 await한 뒤
    // 재조회한다. 그래야 배송대기→배송중 카운트가 즉시 갱신됨.
    refreshNow();
    } finally {
      setActionBusy(busyKey, false);
    }
  };

  const handleInvoiceUpload = async (e: React.ChangeEvent<HTMLInputElement>, campaign: Campaign) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    // 파일 파싱→발송처리까지 한 캠페인 단위로 잠근다. submitTrackingData는 자체 키
    // (submitTracking:*)를 별도로 잡으므로 여기선 업로드 전용 키를 쓴다(자기 자신을 막지 않도록).
    const uploadKey = `uploadInvoice:${campaign.id}`;
    if (isActionBusy(uploadKey) || isActionBusy(`submitTracking:${campaign.id}`)) return;
    setActionBusy(uploadKey, true);
    try {
      addToast('송장 파일을 분석 중입니다...', 'info');
      const buffer = await file.arrayBuffer();

      // F4 Phase 2 §5단계: 파싱을 서버 parse-reply로 이동 — 서버가 브랜드 reply 규칙을 해석한다
      // (클라이언트는 formatAdapter를 몰라 신규 브랜드 회신을 오파싱하던 문제 해소).
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/order-converter/api/campaigns/${campaign.id}/parse-reply`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        addToast(data?.error || '회신 파일 분석에 실패했습니다.', 'error');
        return;
      }
      const trackingMap: Record<string, TrackingData> = data.trackingMap ?? {};
      setPreviewTracking(trackingMap);
      setPreviewTab('tracking');
      setPreviewCampaign({ id: campaign.id, name: campaign.name });

      setPreviewInvoiceBuffer(buffer);
      setPreviewInvoiceFileName(file.name);

      await submitTrackingData(trackingMap, { skipDownload: false, sellerName: campaign.sellerName, campaign: { id: campaign.id, name: campaign.name } });
    } catch (error: any) {
      addToast(error.message, 'error');
    } finally {
      setActionBusy(uploadKey, false);
    }
  };



  const handleDownloadExcel = async (campaignId: string) => {
    const campRef = { id: campaignId, name: campaigns.find(c => c.id === campaignId)?.name ?? campaignId };
    try {
      setActiveProgress({ campaignId, progress: 0, message: '스트림 연결 중...' });
      const res = await fetch(`/order-converter/api/campaigns/${campaignId}/execute/stream?action=download`);
      
      if (!res.ok) {
        throw new Error('서버 통신 오류');
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) return;

      let done = false;
      let partialLine = '';

      while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          const chunk = decoder.decode(value, { stream: true });
          const lines = (partialLine + chunk).split('\n');
          partialLine = lines.pop() || ''; // 마지막 불완전한 라인 보관
          
          for (const line of lines) {
            if (line.trim() === '') continue;
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.error) {
                  addToast(`에러: ${data.error}`, 'error');
                  logOrderAction(buildConfirmOrderLog({ campaign: campRef, fatalError: data.error }));
                  setActiveProgress(null);
                  return;
                }
                if (data.progress !== undefined) {
                  setActiveProgress({ campaignId, progress: data.progress, message: data.message || '' });
                }
                if (data.progress === 100 && data.fileData) {
                  // base64 decode and download
                  const binaryString = window.atob(data.fileData);
                  const len = binaryString.length;
                  const bytes = new Uint8Array(len);
                  for (let i = 0; i < len; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                  }
                  downloadExcelBlob(bytes.buffer, data.fileName);
                  const deferred = data.confirmDeferredCount ?? 0;
                  if (data.confirmFailCount > 0) {
                    // 발주확인이 일부/전체 실패해도 파일은 내려주되, 실패 사실을 명확히 알린다
                    // (과거: 실패가 서버 로그로만 삼켜져 스토어는 발주전인데 파일만 받는 사고)
                    addToast(`⚠️ 발주서 다운로드됨. 스토어 발주확인 실패 ${data.confirmFailCount}건 (성공 ${data.confirmSuccessCount ?? 0}건)${deferred > 0 ? ` · 확인 대기 ${deferred}건` : ''}${data.confirmFirstError ? `: ${data.confirmFirstError}` : ''}`, 'error');
                  } else if (deferred > 0) {
                    // 서버가 잔여분을 자동 재시도(최대 3회)했는데도 네이버가 끝내 확인 못한 잔여 —
                    // 실패는 아니고 네이버 처리 지연이므로 info 톤. 다음 주문확인 때 자연 반영된다.
                    addToast(`발주확인 ${data.confirmSuccessCount ?? 0}건 완료 · ${deferred}건은 네이버 처리 지연으로 대기 중입니다(자동 재시도했으나 미확정). 잠시 후 다시 시도하면 반영됩니다.`, 'info');
                  } else {
                    addToast('발주서가 성공적으로 다운로드 되었습니다.', 'success');
                  }
                  logOrderAction(buildConfirmOrderLog({
                    campaign: campRef,
                    confirmSuccessCount: data.confirmSuccessCount,
                    confirmFailCount: data.confirmFailCount,
                    confirmDeferredCount: deferred,
                    confirmFirstError: data.confirmFirstError,
                  }));
                  // 방금 네이버 발주확인 API를 호출했으므로, stale 캐시를 그대로 반환하는
                  // fetchCampaigns()(서버 SWR: 백그라운드 sync만 트리거) 대신 refreshNow()로
                  // CHANGED 동기화를 await한 뒤 재조회한다. 그래야 발주확인전→후 카운트가 즉시 갱신됨.
                  refreshNow();
                  
                  import('xlsx').then(XLSX => {
                    const workbook = XLSX.read(bytes.buffer, { type: 'array' });
                    if (workbook.SheetNames.length > 0) {
                      const sheetName = workbook.SheetNames[0];
                      const worksheet = workbook.Sheets[sheetName];
                      const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: "" });
                      setPreviewOrders(jsonData as any[]);
                      setPreviewTab('orders');
                    }
                  }).catch(e => console.error("XLSX load error for preview", e));
                  
                  setTimeout(() => setActiveProgress(null), 1000);
                }
              } catch (e) {
                console.error("SSE parse error", e, line);
              }
            }
          }
        }
      }
    } catch (e) {
      console.error(e);
      addToast('요청 중 오류가 발생했습니다.', 'error');
      logOrderAction(buildConfirmOrderLog({
        campaign: campRef,
        fatalError: e instanceof Error ? e.message : '요청 중 오류가 발생했습니다.',
      }));
      setActiveProgress(null);
    }
  };


  // B3: 캠페인 맥락 통합 — matchedCampaignName(claim-derive.ts 경량 매칭) 기준으로
  // 매칭되지 않은 진행중 클레임을 별도로 센다.
  const inProgressClaims = allClaims.filter((c) => !c.isCompleted);
  const inProgressClaimCount = inProgressClaims.length;
  const unmatchedInProgressCount = inProgressClaims.filter((c) => !c.matchedCampaignName).length;

  // 상태 바 '취소/반품' 카운터용 집계. 배송완료가 "정상 종결"이라면 이 값은 "이탈 종결"
  // (취소=발송 전 철회, 반품=수령 후 반송)을 보여준다. 교환(EXCHANGE)은 판매가 유지되는
  // 성격이라 제외하고, 카드 제목 옆 '반품/교환' 진행 배지와 역할을 분리한다.
  // 배송완료처럼 진행/완료 구분 없는 누적 건수이므로 isCompleted를 따지지 않는다.
  const cancelReturnCountByCampaign = allClaims.reduce<Record<string, number>>((acc, c) => {
    if ((c.claimType === 'CANCEL' || c.claimType === 'RETURN') && c.matchedCampaignName) {
      acc[c.matchedCampaignName] = (acc[c.matchedCampaignName] ?? 0) + 1;
    }
    return acc;
  }, {});

  // 제목은 스냅샷(displayedClaimFilter) 기준 — 닫힘 애니메이션 중 제목이 기본값으로 튀지 않게 한다.
  const claimFilterTitle = displayedClaimFilter?.kind === 'campaign'
    ? `${displayedClaimFilter.campaignName}: 반품/교환`
    : displayedClaimFilter?.kind === 'unmatched'
      ? '캠페인 미매칭 반품/교환'
      : displayedClaimFilter?.kind === 'all-in-progress'
        ? '진행중인 반품/교환 전체'
        : undefined;

  // 판매상태는 배지가 아니라 평문 라벨로 표기(2026-07-08 소유자 확정 — 배지 남발 지양)
  const getProductStatusLabel = (status?: string | null) => {
    switch (status) {
      case 'SALE': return '판매중';
      case 'OUTOFSTOCK': return '품절';
      case 'SUSPENDED':
      case 'SUSPENSION': return '판매중지';
      case 'CLOSE': return '판매종료';
      case 'WAIT': return '대기';
      default: return status || '상태 미확인';
    }
  };

  return (
    <CrmShell variant="focus">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
          
          <div className="flex flex-col gap-4 border-b border-border/70 px-5 py-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-[15px] font-bold text-slate-900">주문 관리</h2>
                <p className="text-xs text-slate-500 mt-0.5 font-medium">캠페인별 발주서 변환, 송장 등록 및 배송 상태를 통합적으로 모니터링합니다.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* 반품/교환 처리 큐 입구 — 별도 행이 아니라 툴바 동급 버튼(h-9 규약, 위험색만 유지) */}
                {inProgressClaimCount > 0 && (
                  <button
                    onClick={() => setClaimFilter({ kind: 'all-in-progress' })}
                    className="flex h-9 items-center gap-1.5 rounded-lg border border-destructive/25 bg-white px-3 text-xs font-bold text-destructive transition-colors hover:bg-destructive/5 focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none"
                    title="진행 중인 반품/교환 전체 보기"
                  >
                    반품/교환 {inProgressClaimCount}
                  </button>
                )}
                <span className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-[11px] font-medium text-slate-500">
                  {syncMeta.lastSync ? (
                    <>
                      마지막 동기화{' '}
                      {new Date(syncMeta.lastSync).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    </>
                  ) : (
                    '동기화 대기 중'
                  )}
                  {syncMeta.syncing && <span className="text-primary">· 갱신 중</span>}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg h-9 px-2.5 text-xs"
                  disabled={refreshing}
                  onClick={() => refreshNow()}
                >
                  <RefreshCw className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  className="rounded-lg bg-primary px-3.5 text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/95 h-9 text-xs"
                  onClick={() => {
                    setIsSidebarOpen(true);
                    setIsCreating(false);
                    if (naverProducts.length === 0) fetchNaverProducts();
                  }}
                >
                  <PlusIcon className="size-3.5 mr-1" />
                  캠페인 등록
                </Button>
              </div>
            </div>

          </div>

          <div className="min-h-0 flex-1 overflow-auto bg-[#f8fafc] p-4 md:p-6">
            <div className="space-y-6">

      <CampaignCreateModal
        selectedProduct={selectedProduct}
        onClose={() => {
          setIsCreating(false);
          setSelectedProduct(null);
        }}
        onReselectProduct={() => {
          setSelectedProduct(null);
          setIsCreating(false);
          setIsSidebarOpen(true);
        }}
        onSubmit={async (data) => {
          const res = await createCampaign(data);
          if (res.success) {
            setIsCreating(false);
            setSelectedProduct(null);
            addToast('캠페인이 성공적으로 등록되었습니다.', 'success');
          } else {
            addToast(res.error || '생성에 실패했습니다.', 'error');
          }
        }}
      />

      {/* Modal for Product Selection */}
      <ProductSelectModal
        isOpen={isSidebarOpen}
        naverProducts={naverProducts}
        isFetchingNaver={isFetchingNaver}
        onFetchProducts={fetchNaverProducts}
        onSelectProduct={(p) => {
          setSelectedProduct(p);
          setIsSidebarOpen(false);
          setIsCreating(true);
        }}
        onClose={() => setIsSidebarOpen(false)}
      />

      {/* B3: 반품/교환은 별도 화면이 아니라 우측 드로어(Sheet)로 그 자리에서 연다.
          요약 바 카운터·캠페인 카드 배지·하단 미매칭 세 진입점 모두 claimFilter를 세팅하며,
          페이지 상단으로 점프하는 대신 오버레이로 떠서 카드 목록 맥락(스크롤 위치)을 유지한다.
          claim-list.tsx의 ClaimList를 캠페인/미매칭/전체 필터로 좁혀 재사용한다(내부 title/onClose는
          Sheet가 헤더·닫기를 제공하므로 넘기지 않는다). */}
      <Sheet open={!!claimFilter} onOpenChange={(open) => { if (!open) setClaimFilter(null); }}>
        <SheetContent side="right" className="gap-0 p-0 sm:max-w-2xl">
          <SheetHeader className="border-b border-slate-100">
            <SheetTitle className="text-sm font-bold text-slate-800">{claimFilterTitle ?? '반품/교환'}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4 md:p-6">
            {displayedClaimFilter && (
              <ClaimList
                campaignNameFilter={displayedClaimFilter.kind === 'campaign' ? displayedClaimFilter.campaignName : undefined}
                orderIdsFilter={displayedClaimFilter.kind === 'campaign' ? displayedClaimFilter.orderIds ?? undefined : undefined}
                unmatchedOnly={displayedClaimFilter.kind === 'unmatched'}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {isLoading ? (
        <div className="p-10 text-center text-slate-500 font-bold animate-pulse">데이터를 불러오는 중입니다...</div>
      ) : campaigns.length === 0 ? (
        <div className="bg-white p-10 text-center rounded-2xl shadow-soft-sm border border-slate-200 text-slate-500">
          등록된 캠페인이 없습니다. 우측 상단의 [캠페인 등록] 버튼을 눌러주세요.
        </div>
      ) : (
        <div className="grid gap-6">
          {campaigns.map(camp => (
            <div key={camp.id} className={`bg-white rounded-2xl shadow-soft-sm border border-slate-200 relative transition-opacity ${camp.isActive === false ? 'opacity-60 hover:opacity-100' : ''}`}>
              {/* 카드 상단 (헤더) */}
              <div 
                className={`p-6 flex flex-col md:flex-row gap-6 items-start md:items-center cursor-pointer hover:bg-slate-50 transition-colors relative ${expandedCampaignId === camp.id ? 'rounded-t-2xl' : 'rounded-2xl'}`}
                onClick={() => setExpandedCampaignId(expandedCampaignId === camp.id ? null : camp.id)}
              >
                {/* 더보기(⋮) 드롭다운 */}
                <div className="absolute top-4 right-4 z-20 dropdown-container" onClick={(e) => e.stopPropagation()}>
                  <button 
                    onClick={() => setOpenDropdownId(openDropdownId === camp.id ? null : camp.id)}
                    className="text-slate-500 hover:text-slate-600 p-1 transition-colors"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                    </svg>
                  </button>
                  
                  {openDropdownId === camp.id && (
                    /* w-40: '발송지연 안내'(최장 라벨)가 줄바꿈 없이 들어가는 최소 폭 */
                    <div className="absolute right-0 mt-2 w-40 bg-white rounded-xl shadow-overlay border border-slate-200 py-1.5 overflow-hidden font-medium text-sm animate-in fade-in slide-in-from-top-2">
                      <button 
                        onClick={() => { setSalesReportCampaignId(camp.id); setOpenDropdownId(null); }}
                        className="w-full text-left px-4 py-2.5 text-slate-700 hover:bg-slate-50 hover:text-slate-900 flex items-center gap-2 transition-colors"
                      >
                        <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
                        매출보고
                      </button>
                      <button
                        onClick={() => { setInsightsCampaignId(camp.id); setOpenDropdownId(null); }}
                        className="w-full text-left px-4 py-2.5 text-slate-700 hover:bg-slate-50 hover:text-slate-900 flex items-center gap-2 transition-colors"
                      >
                        <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" /><path strokeLinecap="round" strokeLinejoin="round" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" /></svg>
                        인사이트
                      </button>
                      <button
                        onClick={() => { openEditModal(camp); setOpenDropdownId(null); }}
                        className="w-full text-left px-4 py-2.5 text-slate-700 hover:bg-slate-50 hover:text-slate-900 flex items-center gap-2 transition-colors"
                      >
                        <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        설정
                      </button>
                      <button
                        onClick={() => { setDelayDispatchCampaignId(camp.id); setOpenDropdownId(null); }}
                        className="w-full text-left px-4 py-2.5 text-slate-700 hover:bg-slate-50 hover:text-slate-900 flex items-center gap-2 transition-colors"
                      >
                        <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        발송지연 안내
                      </button>
                      {camp.isActive !== false ? (
                        <button 
                          onClick={() => { toggleCampaignStatus(camp.id, true); setOpenDropdownId(null); }}
                          className="w-full text-left px-4 py-2.5 text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors border-t border-slate-100"
                        >
                          <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                          판매 마감
                        </button>
                      ) : (
                        <button 
                          onClick={() => { toggleCampaignStatus(camp.id, false); setOpenDropdownId(null); }}
                          className="w-full text-left px-4 py-2.5 text-emerald-600 hover:bg-emerald-50 flex items-center gap-2 transition-colors border-t border-slate-100"
                        >
                          <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>
                          마감 취소
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {/* 썸네일 */}
                <div className="w-24 h-24 bg-slate-100 rounded-xl overflow-hidden flex-shrink-0 border border-slate-200 shadow-soft-sm flex items-center justify-center">
                  {camp.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={camp.thumbnailUrl} alt={camp.name} className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-xs text-slate-600 font-bold">No Img</span>
                  )}
                </div>

                <div className="flex-1 pr-8 space-y-3">
                  {/* 1행: 상품 요약 — 배지 대신 평문 메타(카테고리 · 상태 · 기간). 마감은 카드 흐림+평문 "마감" 단일 신호 */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h3 className={`font-bold text-base line-clamp-1 ${camp.isActive === false ? "text-slate-500" : "text-slate-800"}`}>
                      {camp.name}
                    </h3>
                    <span className="text-xs text-slate-500 font-medium">
                      카테고리: {camp.category || "미지정"} · {camp.isActive === false ? "마감" : getProductStatusLabel(camp.productStatus)} · {camp.periodLabel || camp.salePeriod || "기간 정보 없음"}
                    </span>
                    {/* 연결된 판매캠페인들의 기간이 서로 달라 min~max 합성 창을 쓰는 중 — 그 창은 짧게 운영한
                        딜에는 정확하지 않다. 오너 결정(2026-07-15)은 "합성하되 어긋나면 경고". */}
                    {camp.periodMismatch && (
                      <span
                        className="text-[11px] font-semibold text-status-caution bg-status-caution-bg border border-status-caution/30 rounded-full px-2 py-0.5 whitespace-nowrap"
                        title="연결된 판매캠페인들의 기간이 서로 다릅니다. 표시된 기간은 가장 이른 시작 ~ 가장 늦은 종료를 합성한 값이라, 짧게 운영한 딜에는 정확하지 않습니다. 판매관리에서 회차 기간을 확인하세요."
                      >
                        ⚠ 판매캠페인 기간 불일치
                      </span>
                    )}
                    {/* 정산 확정으로 창이 얼었는데 판매관리 일정이 달라진 상태 — 판매관리에서 기간을 고쳐도
                        반영되지 않는다. 조용히 무시하면 운영자가 원인을 알 수 없어 반드시 드러낸다. */}
                    {camp.periodFrozenDrift && (
                      <span
                        className="text-[11px] font-semibold text-status-caution bg-status-caution-bg border border-status-caution/30 rounded-full px-2 py-0.5 whitespace-nowrap"
                        title="정산이 시작돼 집계 기간이 확정된 캠페인입니다. 판매관리에서 기간을 바꿔도 매출 집계에는 반영되지 않습니다(정산 내역과 어긋나지 않게 하기 위함). 기간을 반드시 바꿔야 한다면 정산 상태를 먼저 확인하세요."
                      >
                        ⚠ 정산 확정: 기간 변경 미반영
                      </span>
                    )}
                    {/* 마감취소됐지만 라이브 집계가 비어(조회창 만료) 마감 시점 스냅샷으로 표시 중 — 활성 카드지만
                        수치가 라이브가 아님을 알리는 평문 신호(카드 흐림 없이 메타 톤 유지). */}
                    {camp.isFrozenFallback && (
                      <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5 whitespace-nowrap">
                        마감 시점 스냅샷
                      </span>
                    )}
                    {/* 판매기간 종료 후 들어온 발주 대상 주문 — 발주서엔 실리나 주문확인 집계엔 미포함(기간 스테일 신호).
                        클릭 시 어떤 주문인지 목록 팝오버. */}
                    {camp.isActive !== false && ((camp as any).postPeriodOrderCount ?? 0) > 0 && (
                      // modal: 구 백드롭과 동일하게 바깥 클릭을 삼켜 카드 아코디언 토글로 번지지 않게 한다.
                      // aria-haspopup/expanded는 Radix Trigger가 자동 부여, 토글도 Radix가 수행.
                      <Popover
                        modal
                        open={postPeriodListCampaignId === camp.id}
                        onOpenChange={(open) => {
                          if (open) { setPendingListCampaignId(null); setShippingListCampaignId(null); setConfirmListCampaignId(null); }
                          setPostPeriodListCampaignId(open ? camp.id : null);
                        }}
                      >
                        <span className="inline-flex">
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 rounded-full border border-status-caution/30 bg-status-caution-bg px-2 py-0.5 text-[11px] font-semibold text-status-caution hover:bg-status-caution-bg/70 focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none cursor-pointer"
                              title="판매기간 종료 후 들어온 발주 대상 주문: 클릭해 내역 보기"
                            >
                              ⚠ 판매기간 후 {(camp as any).postPeriodOrderCount}건
                              <svg className={`w-2.5 h-2.5 transition-transform ${postPeriodListCampaignId === camp.id ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                            </button>
                          </PopoverTrigger>
                          <PostPeriodOrdersPopover
                            campName={camp.name}
                            salePeriod={camp.periodLabel || camp.salePeriod || ''}
                            totalCount={(camp as any).postPeriodOrderCount ?? 0}
                            orders={((camp as any).postPeriodOrders ?? []) as PostPeriodOrderLine[]}
                            onClose={() => setPostPeriodListCampaignId(null)}
                          />
                        </span>
                      </Popover>
                    )}
                  </div>

                  {/* 2행: 핵심 성과 + 배송 진행 파이프라인 */}
                  {(() => {
                    const isClosed = camp.isActive === false;
                    const revenue = camp.totalRevenue ?? 0;
                    const orderCnt = (camp as any).distinctOrderCount ?? camp.totalOrders ?? 0;
                    const lineCnt = camp.totalOrders ?? 0;
                    const qty = (camp as any).totalQuantity ?? 0;
                    const nBefore = (camp as any).newOrderBeforeCount ?? 0;
                    const nConfirm = nBefore + ((camp as any).newOrderAfterCount ?? 0);
                    const nPending = camp.pendingCount ?? 0;
                    const nShipping = camp.shippingCount ?? 0;
                    const nCompleted = camp.completedCount ?? 0;
                    const pipeTotal = nConfirm + nPending + nShipping + nCompleted;
                    // 취소·반품 누적 — 서버가 매출·주문과 동일 귀속 기준으로 계산한 productOrderId 목록(교환 제외)을 신뢰한다.
                    // 마감(비활성) 캠페인은 서버가 실시간 귀속을 돌리지 않아 null → claim-derive 경량 매칭으로 폴백.
                    const cancelReturnIds: string[] | null = (camp as any).cancelReturnOrderIds ?? null;
                    // 카드 표시는 취소·반품 "수량"(부분취소 정확 반영·미결제취소 제외). 활성 캠페인은 서버 집계값,
                    // 미백필 과거 마감은 라인수→claim-derive 카운트로 폴백. 드릴다운(orderIds)은 라인 단위 그대로.
                    const cancelReturnQty: number | null = (camp as any).cancelReturnQuantity ?? null;
                    const cancelReturn = cancelReturnQty !== null
                      ? cancelReturnQty
                      : (cancelReturnIds !== null ? cancelReturnIds.length : (cancelReturnCountByCampaign[camp.name] ?? 0));

                    // 지연 상세(서버 집계 일수별 버킷 pendingDelayDays/shippingDelayDays) → 툴팁 문구 + 최장 일수
                    const fmtBuckets = (b: Record<string, number> | undefined) => {
                      const entries = Object.entries(b || {})
                        .map(([d, c]) => [Number(d), c] as [number, number])
                        .sort((a, z) => a[0] - z[0]);
                      const total = entries.reduce((s, [, c]) => s + c, 0);
                      const maxDays = entries.length ? entries[entries.length - 1][0] : 0;
                      return { text: entries.map(([d, c]) => `${d}일 지연 ${c}건`).join(' · '), total, maxDays };
                    };
                    const pendInfo = fmtBuckets((camp as any).pendingDelayDays);
                    const shipInfo = fmtBuckets((camp as any).shippingDelayDays);
                    const confInfo = fmtBuckets((camp as any).confirmDelayDays);

                    // 마지막 주문 상대시간 — "지금도 팔리고 있나" 유입 신호 (하이드레이션 안전: isMounted 후 계산)
                    const lastOrderAt = (camp as any).lastOrderAt as number | null | undefined;
                    let lastOrderRel = '';
                    let lastOrderAbs = '';
                    if (isMounted && lastOrderAt) {
                      const diffMin = Math.floor((Date.now() - lastOrderAt) / 60000);
                      lastOrderRel = diffMin < 60 ? `${Math.max(diffMin, 1)}분 전` : diffMin < 1440 ? `${Math.floor(diffMin / 60)}시간 전` : `${Math.floor(diffMin / 1440)}일 전`;
                      const d = new Date(lastOrderAt);
                      lastOrderAbs = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                    }

                    // 색 계획(기획 확정): primary 불투명도 램프 = 개입 필요도(진할수록 내 일), 완료는 무채색 이탈.
                    // 지연이어도 세그먼트 색은 불변(카드 간 바 문법 고정) — 지연은 라벨 행 빨간 텍스트 채널로만.
                    const segs = [
                      { key: 'confirm', label: '주문확인', val: nConfirm, tone: 'bg-[var(--pipeline-confirm)]', warn: confInfo.total > 0, info: confInfo as null | ReturnType<typeof fmtBuckets>, title: `주문확인 ${nConfirm}건 = 미확인 ${nBefore} + 발주완료 ${nConfirm - nBefore}${confInfo.total > 0 ? `: 발주 지연 ${confInfo.text}` : ''}` },
                      { key: 'pending', label: '배송대기', val: nPending, tone: 'bg-[var(--pipeline-pending)]', warn: pendInfo.total > 0, info: pendInfo, title: `배송대기 ${nPending}건${pendInfo.total > 0 ? `: ${pendInfo.text}` : ''}` },
                      { key: 'shipping', label: '배송중', val: nShipping, tone: 'bg-[var(--pipeline-shipping)]', warn: shipInfo.total > 0, info: shipInfo, title: `배송중 ${nShipping}건${shipInfo.total > 0 ? `: ${shipInfo.text}` : ''}` },
                      { key: 'completed', label: '배송완료', val: nCompleted, tone: 'bg-[var(--pipeline-completed)]', warn: false, info: null, title: `배송완료 ${nCompleted}건` },
                    ];

                    // 바 전용: 주문확인 단계를 미확인(회색=발주확인 대기 큐)·발주완료(네이비)로 시각 분할.
                    // 범례는 segs(4단계 라벨) 유지 — 미확인은 confirm 라벨 앞 caution 텍스트로 별도 노출.
                    const barSegs = [
                      ...(nBefore > 0 ? [{ key: 'unconfirmed', tone: 'bg-[var(--pipeline-unconfirmed)]', val: nBefore, title: `미확인 ${nBefore}건: 주문확인 버튼으로 처리 대기` }] : []),
                      { key: 'confirm', tone: 'bg-[var(--pipeline-confirm)]', val: nConfirm - nBefore, title: `발주완료 ${nConfirm - nBefore}건` },
                      ...segs.slice(1).map((s) => ({ key: s.key, tone: s.tone, val: s.val, title: s.title })),
                    ];

                    // 마감 카드 결산(네이버 정산) — 정산 파이프라인(Track B)이 채우는 필드. 없으면 미표시.
                    const settle = (camp as any).naverSettlement as { settledAmount: number; feeAmount: number; feeBreakdown?: { pay: number; interlock: number; freeInstallment: number } | null; unsettledAmount: number; settledCount: number } | undefined;
                    // 수수료 구성요소 항상 표시(호버 제거) — 결제·매출연동(·무이자할부 있을 때만)
                    const feeParts = settle?.feeBreakdown
                      ? [
                          `결제 ${settle.feeBreakdown.pay.toLocaleString()}`,
                          `매출연동 ${settle.feeBreakdown.interlock.toLocaleString()}`,
                          ...(settle.feeBreakdown.freeInstallment ? [`무이자할부 ${settle.feeBreakdown.freeInstallment.toLocaleString()}`] : []),
                        ].join(' · ')
                      : '';
                    // 수수료율 = 수수료 ÷ 총매출(GMV) — 실입금률보다 직관적
                    const feeRate = settle && revenue > 0 ? (Math.abs(settle.feeAmount) / revenue) * 100 : null;

                    return (
                      <div className="w-full bg-slate-50/60 p-3 rounded-xl border border-slate-200/50 flex flex-wrap items-end gap-x-7 gap-y-3">
                        {/* 좌: 매출 + 아이콘 규모 줄 (필드명 라벨 없이 아이콘+숫자, 의미는 툴팁) */}
                        <div className="flex flex-col w-[200px] shrink-0">
                          <span className="text-[15px] font-bold text-slate-900 tabular-nums leading-none">₩{revenue.toLocaleString()}</span>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[12px] text-slate-700">
                            <span className="inline-flex items-center gap-1" title="주문: 주문번호 기준(한 결제 = 1건)">
                              <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                              <span className="font-semibold tabular-nums">{orderCnt.toLocaleString()}</span>
                            </span>
                            <span className="inline-flex items-center gap-1" title="상품: 상품주문번호 기준(옵션·사은품 포함, 발주서 행 수)">
                              <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                              <span className="font-semibold tabular-nums">{lineCnt.toLocaleString()}</span>
                            </span>
                            <span className="inline-flex items-center gap-1" title="수량: 하위옵션 포함 판매 개수">
                              <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                              <span className="font-semibold tabular-nums">{qty.toLocaleString()}</span>
                            </span>
                            {cancelReturn > 0 && (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setClaimFilter({ kind: 'campaign', campaignName: camp.name, orderIds: cancelReturnIds }); }}
                                className="inline-flex items-center gap-1 text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700 rounded focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none"
                                title={cancelReturnQty !== null ? "취소·반품 수량: 클릭 시 상세(미결제취소 제외)" : "취소·반품 건수: 클릭 시 상세(수량 백필 전 구버전 집계)"}
                              >
                                <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                                <span className="font-semibold tabular-nums">{cancelReturn.toLocaleString()}</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* 우(판매중): 분포 바 + 구간 라벨 + 마지막 주문 */}
                        {!isClosed && (
                          <div className="flex-1 min-w-[300px] flex flex-col gap-1.5" role="group" aria-label="배송 진행 분포">
                            {pipeTotal > 0 ? (
                              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100 divide-x divide-white" aria-hidden="true">
                                {barSegs.filter((s) => s.val > 0).map((s) => (
                                  <div key={s.key} title={s.title} style={{ width: `${(s.val / pipeTotal) * 100}%` }} className={`h-full ${s.tone}`} />
                                ))}
                              </div>
                            ) : (
                              <div className="h-2.5 w-full rounded-full bg-slate-100" aria-hidden="true" />
                            )}
                            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-0.5 text-[12px]">
                              {segs.map((s) => {
                                // 배송대기·배송중은 클릭 시 팝오버로 "파악이 필요한 경고 건만" 펼친다(모든 건 아님) —
                                // 배송대기=발주요청 후 2일↑ 송장 미회신(송장 독촉 대상),
                                // 배송중=배송 경과 5일↑(택배사/고객 확인 대상). 둘 다 지연 경고가 있을 때만 클릭 가능.
                                // 나머지 버킷(주문확인·배송완료)은 확장하지 않는다.
                                const isPendingTrigger = s.key === 'pending' && s.warn;
                                const isShippingTrigger = s.key === 'shipping' && s.warn;
                                const isConfirmTrigger = s.key === 'confirm' && s.warn;
                                const isTrigger = isPendingTrigger || isShippingTrigger || isConfirmTrigger;
                                const isOpen = (isPendingTrigger && pendingListCampaignId === camp.id)
                                  || (isShippingTrigger && shippingListCampaignId === camp.id)
                                  || (isConfirmTrigger && confirmListCampaignId === camp.id);
                                // 팝오버는 한 번에 하나만 — 여는 버킷 외 다른 버킷 팝오버는 닫는다.
                                // Radix 제어형 open이라 토글 대신 목표 상태(open)를 받는다.
                                const setOpenState = (open: boolean) => {
                                  if (s.key === 'pending') {
                                    setShippingListCampaignId(null); setConfirmListCampaignId(null);
                                    setPendingListCampaignId(open ? camp.id : null);
                                  } else if (s.key === 'shipping') {
                                    setPendingListCampaignId(null); setConfirmListCampaignId(null);
                                    setShippingListCampaignId(open ? camp.id : null);
                                  } else {
                                    setPendingListCampaignId(null); setShippingListCampaignId(null);
                                    setConfirmListCampaignId(open ? camp.id : null);
                                  }
                                };
                                const triggerRing = s.key === 'shipping' ? 'focus-visible:ring-[var(--pipeline-shipping)]'
                                  : s.key === 'confirm' ? 'focus-visible:ring-[var(--pipeline-confirm)]'
                                  : 'focus-visible:ring-[var(--pipeline-pending)]';
                                const triggerTitle = s.key === 'shipping' ? '배송 지연 목록: 클릭하면 택배사/고객 확인 대상'
                                  : s.key === 'confirm' ? '발주 지연 목록: 주문확인 후 발주요청/송장 미등록 대상'
                                  : '송장 지연 목록: 클릭하면 송장 독촉 대상';
                                const count = s.warn && s.info ? (
                                  <span className={`tabular-nums font-bold text-destructive border-b border-dotted border-destructive ${isTrigger ? '' : 'cursor-help'}`} title={s.info.text}>{s.val.toLocaleString()}</span>
                                ) : (
                                  <span className={`tabular-nums font-bold ${s.val === 0 ? 'text-slate-300' : 'text-slate-700'}`}>{s.val.toLocaleString()}</span>
                                );
                                return (
                                <span key={s.key} className="inline-flex items-center gap-1">
                                  <span className={`w-2 h-2 rounded-full shrink-0 ${s.tone}`} aria-hidden="true" />
                                  {s.key === 'confirm' && nBefore > 0 && (
                                    <>
                                      <span className="font-semibold text-[var(--status-caution-text)]" title="발주확인 대기: 주문확인 버튼으로 처리">미확인 {nBefore.toLocaleString()}</span>
                                      <span className="text-slate-300" aria-hidden="true">·</span>
                                    </>
                                  )}
                                  {isTrigger ? (
                                    // modal: 구 백드롭과 동일하게 바깥 클릭을 삼켜 카드 아코디언 토글로 번지지 않게 한다.
                                    // aria-haspopup/expanded·토글은 Radix Trigger가 수행.
                                    <Popover modal open={isOpen} onOpenChange={setOpenState}>
                                      <PopoverTrigger asChild>
                                        <button
                                          type="button"
                                          onClick={(e) => e.stopPropagation()}
                                          className={`inline-flex items-center gap-1 -mx-0.5 px-0.5 rounded hover:bg-slate-100/80 focus-visible:ring-2 ${triggerRing} focus:outline-none cursor-pointer`}
                                          title={triggerTitle}
                                        >
                                          <span className="font-medium text-slate-500">{s.label}</span>
                                          {count}
                                          <svg className={`w-2.5 h-2.5 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                                        </button>
                                      </PopoverTrigger>
                                      {/* 지연 강조는 숫자 채널(빨간색+점선 밑줄)로 일원화 — 최장일수 등 상세는
                                          숫자 호버 툴팁(일자별 분포)과 클릭 팝오버(오래된 순)에 온디맨드로 있어,
                                          라벨 행에 '· 최장 N일 지연' 텍스트를 중복 노출하지 않는다(밀집 카드 절제). */}
                                      {s.key === 'pending' && (
                                        <PendingOrdersPopover
                                          campName={camp.name}
                                          orders={((camp as any).pendingOrders ?? []) as PendingOrderLine[]}
                                          onClose={() => setPendingListCampaignId(null)}
                                        />
                                      )}
                                      {s.key === 'shipping' && (
                                        <DelayOrdersPopover
                                          campName={camp.name}
                                          orders={((camp as any).shippingOrders ?? []) as ShippingOrderLine[]}
                                          onClose={() => setShippingListCampaignId(null)}
                                        />
                                      )}
                                      {s.key === 'confirm' && (
                                        <DelayOrdersPopover
                                          campName={camp.name}
                                          orders={((camp as any).confirmOrders ?? []) as ShippingOrderLine[]}
                                          heading="발주 지연"
                                          hint="2일↑ 주문확인 · 발주요청/송장 등록 · 오래된 순"
                                          elapsedLabel="결제경과"
                                          warnDays={2}
                                          onClose={() => setConfirmListCampaignId(null)}
                                        />
                                      )}
                                    </Popover>
                                  ) : (
                                    <>
                                      <span className={`font-medium ${s.val === 0 ? 'text-slate-300' : 'text-slate-500'}`}>{s.label}</span>
                                      {count}
                                    </>
                                  )}
                                </span>
                                );
                              })}
                              {lastOrderRel && (
                                <span className="ml-auto font-medium text-slate-500 tabular-nums whitespace-nowrap" title={`마지막 주문 ${lastOrderAbs}`}>마지막 주문 {lastOrderRel}</span>
                              )}
                            </div>
                          </div>
                        )}

                        {/* 우(마감): 네이버 정산 결산 — 좌측 규모줄과 대칭(실입금 아래 가로 보조줄), 데이터 있을 때만 */}
                        {isClosed && settle && (
                          <div className="flex-1 min-w-[300px] flex flex-col">
                            <div className="flex items-baseline gap-2">
                              <span className="text-[15px] font-bold text-slate-900 tabular-nums">₩{settle.settledAmount.toLocaleString()}</span>
                              <span className="text-[11px] text-slate-500">실입금{settle.settledCount > 0 ? ` · 정산완료 ${settle.settledCount.toLocaleString()}건` : ''}</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2 text-[12px] leading-none">
                              <span className="text-slate-700">수수료 <span className="font-semibold tabular-nums">−₩{Math.abs(settle.feeAmount).toLocaleString()}</span></span>
                              {feeParts && <><span className="text-slate-300">·</span><span className="text-slate-500 tabular-nums">{feeParts}</span></>}
                              {feeRate != null && <><span className="text-slate-300">·</span><span className="text-slate-700">수수료율 <span className="font-semibold tabular-nums">{feeRate.toFixed(1)}%</span></span></>}
                              <span className="text-slate-300">·</span>
                              <span className="text-slate-500 tabular-nums">정산예정 ₩{settle.unsettledAmount.toLocaleString()}</span>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* 3행: 실행 조작 버튼 (Action Buttons) */}
                  <div className="flex flex-wrap gap-2 items-center w-full" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => handleDownloadExcel(camp.id)} className="flex items-center gap-1.5 text-xs bg-white text-emerald-700 hover:bg-emerald-50 font-bold py-1.5 px-3 rounded-lg transition-colors border border-emerald-200 shadow-soft-sm relative overflow-hidden group">
                      <div className="absolute inset-0 bg-emerald-50/50 translate-y-full group-hover:translate-y-0 transition-transform"></div>
                      <span className="bg-emerald-500 text-white text-[9px] px-1 rounded font-black leading-none py-0.5 relative z-10">N</span>
                      <span className="relative z-10">주문확인</span>
                    </button>
                    <button onClick={() => openEmailModal(camp.id)} className="flex items-center gap-1.5 text-xs bg-white text-slate-700 hover:bg-slate-50 font-bold py-1.5 px-3 rounded-lg transition-colors border border-slate-200 shadow-soft-sm">
                      <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                      발주요청
                    </button>
                    <button
                      onClick={() => handleFetchInvoice(camp)}
                      disabled={isActionBusy(`fetchInvoice:${camp.id}`)}
                      className="flex items-center gap-1.5 text-xs bg-white text-slate-700 hover:bg-slate-50 font-bold py-1.5 px-3 rounded-lg transition-colors border border-slate-200 shadow-soft-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white"
                    >
                      {isActionBusy(`fetchInvoice:${camp.id}`) ? (
                        <><RefreshCw className="w-3.5 h-3.5 text-slate-500 animate-spin" />조회 중…</>
                      ) : (
                        <><svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2m-4-1v8m0 0l3-3m-3 3L9 8m-5 5h2.586a1 1 0 01.707.293l2.414 2.414a1 1 0 00.707.293h3.172a1 1 0 00.707-.293l2.414-2.414a1 1 0 01.707-.293H20" /></svg>송장회신</>
                      )}
                    </button>
                    {(() => {
                      // 라벨은 disabled 속성이 없으므로 업로드/발송처리 진행 중엔 pointer-events로 잠그고
                      // 내부 input도 disabled 처리한다(업로드 파싱~발송처리 전 구간 커버).
                      const uploadBusy = isActionBusy(`uploadInvoice:${camp.id}`) || isActionBusy(`submitTracking:${camp.id}`);
                      return (
                        <label
                          aria-disabled={uploadBusy}
                          className={`flex items-center gap-1.5 text-xs bg-white text-emerald-700 font-bold py-1.5 px-3 rounded-lg transition-colors border border-emerald-200 shadow-soft-sm mb-0 relative overflow-hidden group ${uploadBusy ? 'opacity-50 cursor-not-allowed pointer-events-none' : 'hover:bg-emerald-50 cursor-pointer'}`}
                        >
                          {!uploadBusy && <div className="absolute inset-0 bg-emerald-50/50 translate-y-full group-hover:translate-y-0 transition-transform"></div>}
                          {uploadBusy ? (
                            <><RefreshCw className="w-3.5 h-3.5 text-emerald-600 animate-spin relative z-10" /><span className="relative z-10">등록 중…</span></>
                          ) : (
                            <><span className="bg-emerald-500 text-white text-[9px] px-1 rounded font-black leading-none py-0.5 relative z-10">N</span><span className="relative z-10">송장등록</span></>
                          )}
                          <input type="file" accept=".xlsx, .xls" className="hidden" disabled={uploadBusy} onChange={(e) => handleInvoiceUpload(e, camp)} />
                        </label>
                      );
                    })()}
                  </div>
                  
                  {/* 진행률 오버레이 UI */}
                  {activeProgress && activeProgress.campaignId === camp.id && (
                    <div className="absolute inset-0 bg-white/80 backdrop-blur-sm rounded-xl flex flex-col items-center justify-center p-4 z-10 border border-blue-100">
                      <div className="w-full max-w-sm">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-xs font-bold text-blue-700">{activeProgress.message}</span>
                          <span className="text-xs font-bold text-blue-700">{activeProgress.progress}%</span>
                        </div>
                        <div className="w-full bg-blue-100 h-2 rounded-full overflow-hidden">
                          <div 
                            className="bg-blue-600 h-full rounded-full transition-[width] duration-300"
                            style={{ width: `${activeProgress.progress}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>


              </div>

              {/* 아코디언 상세 뷰 (일자별 통합 타임라인) */}
              {expandedCampaignId === camp.id && (
                <div className="border-t border-slate-100 bg-slate-50/50 p-6 rounded-b-2xl animate-in slide-in-from-top-2">
                  {/* 작업 기록(감사 추적) — 실패가 가장 먼저 보이도록 상세 최상단에 배치 */}
                  <CampaignActionLog campaignId={camp.id} refreshKey={actionLogRefresh} />
                  <DailyStatusAccordion camp={camp} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* B3: 캠페인에 매칭되지 않은 진행중 클레임(경량 이름 매칭 실패 건)을 놓치지 않도록
          하단에 별도로 노출한다. 필터 문법은 캠페인 배지/요약 카운터와 동일. */}
      {unmatchedInProgressCount > 0 && (
        <button
          onClick={() => setClaimFilter({ kind: 'unmatched' })}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 bg-slate-50 py-3 text-xs font-bold text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          미매칭 {unmatchedInProgressCount}건
        </button>
      )}

{/* Edit Modal */}
      {editingCampaign && (
        <CampaignEditModal
          campaign={editingCampaign}
          onClose={() => setEditingCampaign(null)}
          onSubmit={async (id, data) => {
            const res = await updateCampaign(id, data);
            if (res.success) {
              setEditingCampaign(null);
              addToast('성공적으로 수정되었습니다.', 'success');
            } else {
              addToast(res.error || '수정에 실패했습니다.', 'error');
            }
          }}
          onDelete={async (id) => {
            const res = await deleteCampaign(id);
            if (res.success) {
              setEditingCampaign(null);
              addToast('캠페인이 삭제되었습니다.', 'success');
            } else {
              addToast(res.error || '삭제에 실패했습니다.', 'error');
            }
          }}
        />
      )}

      {/* Email Sending Modal */}
      {emailModalCampaignId && (() => {
        const camp = campaigns.find(c => c.id === emailModalCampaignId);
        // 발주서 파일명 기본값을 서버 provider 기준으로 미리 조합(서버 execute 라우트와 동일 포맷).
        // 발송 팝업에서 미리 보이고 사용자가 편집 가능. 날짜는 KST yyMMdd.
        const provider = (camp as any)?.orderProvider || (camp as any)?.template || '기본';
        // eslint-disable-next-line react-hooks/purity
        const dKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const today = `${String(dKst.getUTCFullYear()).slice(2)}${String(dKst.getUTCMonth() + 1).padStart(2, '0')}${String(dKst.getUTCDate()).padStart(2, '0')}`;
        const defaultFileName = `발주서_${provider}_와이그라운드_${camp?.sellerName ?? ''}_${today}.xlsx`;
        return (
        <EmailSendModal
          campaignId={emailModalCampaignId}
          defaultTo={emailDefaultTo}
          defaultCc={emailDefaultCc}
          defaultSubject={emailDefaultSubject}
          defaultMessage={emailDefaultMessage}
          defaultFileName={defaultFileName}
          onClose={() => setEmailModalCampaignId(null)}
          addToast={addToast}
          onResult={(ok, errorMessage, fileName, orderCount) => {
            logOrderAction(buildRequestPoLog({
              campaign: { id: emailModalCampaignId ?? undefined, name: camp?.name ?? emailModalCampaignId ?? '(미상 캠페인)' },
              ok, errorMessage, fileName, orderCount, toEmail: camp?.toEmail,
            }));
          }}
          onSuccess={() => {
            setPreviewTab('orders');
            fetchCampaigns(true);
            setEmailModalCampaignId(null);
          }}
        />
        );
      })()}

      {/* 발송지연 안내 모달 — 2단계 확인 후 네이버 /delay 호출(고객 알림 즉시 발송, 취소 불가) */}
      {delayDispatchCampaignId && (() => {
        const camp = campaigns.find(c => c.id === delayDispatchCampaignId);
        if (!camp) return null;
        const busyKey = `delayDispatch:${camp.id}`;
        return (
          <DelayDispatchModal
            campaign={{ id: camp.id, name: camp.name }}
            onClose={() => setDelayDispatchCampaignId(null)}
            addToast={addToast}
            onLog={logOrderAction}
            refreshNow={refreshNow}
            isBusy={isActionBusy(busyKey)}
            setBusy={(busy) => setActionBusy(busyKey, busy)}
          />
        );
      })()}

      {/* Sales Report Modal */}
      {salesReportCampaignId && (
        <SalesReportModal
          campaign={campaigns.find(c => c.id === salesReportCampaignId) || null}
          onClose={() => setSalesReportCampaignId(null)}
          onToast={addToast}
        />
      )}

      {/* Campaign Insights Modal (내부 운영용 비식별 집계) */}
      {insightsCampaignId && (
        <CampaignInsightsModal
          campaign={campaigns.find(c => c.id === insightsCampaignId) || null}
          onClose={() => setInsightsCampaignId(null)}
        />
      )}

      {/* Data Preview Section */}
      {(previewOrders.length > 0 || Object.keys(previewTracking).length > 0) && (
        <div className="mt-8 bg-white rounded-2xl shadow-soft-sm border border-slate-200 overflow-hidden">
          <div className="flex border-b border-slate-200 bg-slate-50">
            <button 
              onClick={() => setPreviewTab('orders')}
              className={`px-6 py-4 text-sm font-bold transition-colors ${previewTab === 'orders' ? 'text-blue-600 bg-white border-b-2 border-blue-600' : 'text-slate-500 hover:text-slate-700'}`}
            >
              발주 데이터 ({previewOrders.length}건)
            </button>
            <button 
              onClick={() => setPreviewTab('tracking')}
              className={`px-6 py-4 text-sm font-bold transition-colors ${previewTab === 'tracking' ? 'text-blue-600 bg-white border-b-2 border-blue-600' : 'text-slate-500 hover:text-slate-700'}`}
            >
              송장 데이터 ({Object.keys(previewTracking).length}건)
            </button>
          </div>

          <div className="p-0">
            {previewTab === 'orders' && (
              <div className="overflow-x-auto max-h-[400px]">
                {previewOrders.length > 0 ? (
                  <table className="w-full text-[10px] text-left whitespace-nowrap">
                    <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 shadow-soft-sm z-10">
                      <tr>
                        {Object.keys(previewOrders[0]).map(key => (
                          <th key={key} className="px-3 py-2 font-bold text-slate-500 text-[10px]">{key}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 relative z-0">
                      {previewOrders.map((row, idx) => (
                        <tr key={idx} className="hover:bg-slate-50">
                          {Object.values(row).map((val: any, vIdx) => (
                            <td key={vIdx} className="px-3 py-1.5 text-slate-500">{val}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="p-8 text-center text-slate-500 text-sm">확보된 발주 데이터가 없습니다. 주문확인 시 자동 등록됩니다.</div>
                )}
              </div>
            )}

            {previewTab === 'tracking' && (
              <div className="flex flex-col h-full">
                <div className="p-4 bg-white flex justify-between items-center border-b border-slate-100">
                  <p className="text-sm text-slate-600 font-medium">송장회신 메일을 통해 확보된 임시 송장 데이터입니다.</p>
                  {/* 파일을 받았으면(버퍼 존재) 0건이어도 원본 확인용 '저장'은 항상 노출 */}
                  {previewInvoiceBuffer && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          if (previewInvoiceBuffer) {
                            downloadExcelBlob(previewInvoiceBuffer, previewInvoiceFileName);
                          }
                        }}
                        className="flex items-center gap-1.5 bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 px-4 py-2 rounded-lg font-bold text-sm shadow-soft-sm transition-colors"
                      >
                        <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                        저장
                      </button>
                      {Object.keys(previewTracking).length > 0 && (() => {
                        const submitBusy = isActionBusy(`submitTracking:${previewCampaign?.id ?? '__nocampaign__'}`);
                        return (
                          <button
                            onClick={() => submitTrackingData(previewTracking, { skipDownload: true, campaign: previewCampaign ?? undefined })}
                            disabled={submitBusy}
                            className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-900 text-white px-4 py-2 rounded-lg font-bold text-sm shadow-soft-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-slate-800"
                          >
                            {submitBusy ? (
                              <><RefreshCw className="w-4 h-4 animate-spin" />발송처리 중…</>
                            ) : (
                              <><span className="text-green-400 font-black text-base leading-none">N</span>발송처리</>
                            )}
                          </button>
                        );
                      })()}
                    </div>
                  )}
                </div>
                <div className="overflow-x-auto max-h-[400px]">
                  {Object.keys(previewTracking).length > 0 ? (
                    <table className="w-full text-[10px] text-left whitespace-nowrap">
                      <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 shadow-soft-sm z-10">
                        <tr>
                          <th className="px-3 py-2 font-bold text-slate-500 text-[10px] w-1/3">주문번호</th>
                          <th className="px-3 py-2 font-bold text-slate-500 text-[10px] w-1/3">택배사</th>
                          <th className="px-3 py-2 font-bold text-slate-500 text-[10px] w-1/3">송장번호</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 relative z-0">
                        {Object.keys(previewTracking).map((orderId) => {
                          const item = previewTracking[orderId];
                          return (
                            <tr key={orderId} className="hover:bg-slate-50">
                              <td className="px-3 py-1.5 text-slate-600 font-medium">{orderId}</td>
                              <td className="px-3 py-1.5 text-slate-500">{item.택배사}</td>
                              <td className="px-3 py-1.5 text-slate-500 font-mono">{item.송장번호}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <div className="p-8 text-center text-slate-500 text-sm">
                      {previewInvoiceBuffer
                        ? "회신 파일은 받았지만 송장번호를 찾지 못했습니다. 파일에 '송장번호/운송장번호' 컬럼이 없거나 값이 비어 있을 수 있어요. 위 '저장'으로 원본을 열어 확인하거나, 올바른 파일을 직접 업로드하세요."
                        : "확보된 송장 데이터가 없습니다. 송장회신 버튼으로 메일을 조회하거나 직접 파일을 업로드하세요."}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Toast Notifications */}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map(toast => (
          <div 
            key={toast.id} 
            className={`pointer-events-auto max-w-sm w-full p-4 rounded-xl shadow-soft-hover border flex items-start gap-3 animate-in slide-in-from-right-4 fade-in duration-300 ${
              toast.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' : 
              toast.type === 'error' ? 'bg-red-50 border-red-200 text-red-800' : 
              'bg-blue-50 border-blue-200 text-blue-800'
            }`}
          >
            <div className="flex-1 text-sm font-medium">{toast.message}</div>
            <button onClick={() => removeToast(toast.id)} className="opacity-50 hover:opacity-100"><svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg></button>
          </div>
        ))}
      </div>
            </div>
          </div>
        </div>
      </section>
    </CrmShell>
  );
}
