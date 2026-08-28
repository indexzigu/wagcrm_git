'use client';

import React, { useMemo, useState } from 'react';
import { useClaims, type ClaimWithCompanyName } from '@/hooks/useClaims';
import { buildTrackingUrl, type ClaimType } from '@/lib/order-converter/claim-derive';
import { RefreshCw, XIcon, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DataEmpty } from '@/components/ui/empty';

// order-dashboard.tsx:389-406 getProductStatusBadge와 동일한 클래스 팔레트를 재사용한다.
// (baseClass + bg/text/border 조합, shadcn Badge 미사용 관례를 그대로 따름)
const BADGE_BASE = 'text-[10px] px-1.5 py-0.5 rounded font-bold whitespace-nowrap border';

// 서비스 팔레트 status 토큰 매핑. 반품=주의 필요(caution) · 교환=정보성(info) · 취소=중립(outline).
// 상태축은 완료=성사(success) · 미완료=중립(outline) — 미완료를 caution으로 두면 반품(caution) 타입 배지와
// 한 행에 앰버 2개가 겹쳐 축(타입 vs 상태)이 흐려지므로, 완료 여부는 색이 아니라 채움 유무로 구분한다.
function getClaimTypeBadge(claimType: ClaimType) {
  switch (claimType) {
    case 'RETURN':
      return <span className={`${BADGE_BASE} bg-status-caution-bg text-status-caution border-status-caution/20`}>반품</span>;
    case 'EXCHANGE':
      return <span className={`${BADGE_BASE} bg-status-info/10 text-status-info border-status-info/20`}>교환</span>;
    case 'CANCEL':
      return <span className={`${BADGE_BASE} bg-transparent text-foreground border-border`}>취소</span>;
    default:
      return <span className={`${BADGE_BASE} bg-transparent text-foreground border-border`}>{claimType}</span>;
  }
}

function getClaimStatusBadge(label: string, isCompleted: boolean) {
  if (isCompleted) {
    return <span className={`${BADGE_BASE} bg-status-success-bg text-status-success border-status-success/20`}>{label}</span>;
  }
  return <span className={`${BADGE_BASE} bg-transparent text-foreground border-border`}>{label}</span>;
}

// 캠페인 카드/요약 바 배지가 재사용하는 클레임 항목 컴포넌트. 화면 전체가 아니라
// 캠페인 맥락(카드 내 서브뷰) 안에서도 그대로 재사용할 수 있도록 분리했다.
export function ClaimItemCard({ claim }: { claim: ClaimWithCompanyName }) {
  const trackingUrl = buildTrackingUrl(claim.collectDeliveryCompanyCode, claim.collectDeliveryInvoiceNo);
  return (
    <div
      className={`flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-soft-sm transition-opacity md:flex-row md:items-center md:justify-between ${
        claim.isCompleted ? 'opacity-60' : ''
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {getClaimTypeBadge(claim.claimType)}
          {getClaimStatusBadge(claim.claimStatusLabel, claim.isCompleted)}
          <span className="text-[11px] font-medium text-slate-500">#{claim.productOrderId}</span>
        </div>
        <div className="truncate text-sm font-bold text-slate-800">
          {claim.productName ?? '상품명 미확인'}
          {claim.productOption && <span className="ml-1 font-normal text-slate-500">({claim.productOption})</span>}
          {claim.quantity ? <span className="ml-1 font-normal text-slate-500">x{claim.quantity}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          {claim.matchedCampaignName && <span>캠페인: {claim.matchedCampaignName}</span>}
          {claim.requestDate && <span>요청일: {new Date(claim.requestDate).toLocaleDateString('ko-KR')}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[11px] text-slate-500">
          {claim.collectDeliveryCompanyName ?? claim.collectDeliveryCompanyCode ?? '택배사 미확인'}
        </span>
        {trackingUrl ? (
          <a
            href={trackingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-soft-sm transition-colors hover:bg-slate-50"
          >
            배송조회
          </a>
        ) : (
          <span
            title={
              claim.collectDeliveryInvoiceNo
                ? '지원하지 않는 택배사입니다.'
                : '송장번호가 아직 등록되지 않았습니다.'
            }
            className="cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-300"
          >
            배송조회
          </span>
        )}
      </div>
    </div>
  );
}

type TypeFilter = 'ALL' | ClaimType;
type ProgressFilter = 'ALL' | 'IN_PROGRESS' | 'COMPLETED';

export interface ClaimListProps {
  /** 특정 캠페인의 클레임만 좁혀서 보여준다(캠페인 카드 배지 클릭 시). matchedCampaignName 기준. */
  campaignNameFilter?: string | null;
  /**
   * 서버가 매출·주문과 동일 기준으로 귀속한 취소·반품 productOrderId 목록. 주어지면
   * 이 집합으로 정확히 좁힌다(카드 숫자와 1:1 일치). campaignNameFilter보다 우선.
   */
  orderIdsFilter?: string[] | null;
  /** true면 어떤 캠페인에도 매칭되지 않은 클레임만 보여준다(하단 "미매칭 N건" 클릭 시). */
  unmatchedOnly?: boolean;
  /** 캠페인 맥락 서브뷰로 열렸을 때 닫기 버튼을 보여준다. */
  onClose?: () => void;
  /** 서브뷰 타이틀(예: "{캠페인명} 반품/교환"). 없으면 기본 타이틀 없음(풀스크린 사용 시). */
  title?: string;
}

export default function ClaimList({ campaignNameFilter, orderIdsFilter, unmatchedOnly, onClose, title }: ClaimListProps = {}) {
  const { claims, isLoading, fetchClaims } = useClaims();
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [progressFilter, setProgressFilter] = useState<ProgressFilter>('ALL');
  const [searchTerm, setSearchTerm] = useState('');

  const scopedClaims = useMemo(() => {
    if (unmatchedOnly) return claims.filter((c) => !c.matchedCampaignName);
    // 서버 귀속 productOrderId 집합이 있으면 그걸 최우선으로 사용(카드 숫자와 정합).
    if (orderIdsFilter) {
      const idSet = new Set(orderIdsFilter.map((id) => String(id)));
      return claims.filter((c) => idSet.has(String(c.productOrderId)));
    }
    if (campaignNameFilter) return claims.filter((c) => c.matchedCampaignName === campaignNameFilter);
    return claims;
  }, [claims, campaignNameFilter, orderIdsFilter, unmatchedOnly]);

  const filteredClaims = useMemo(() => {
    return scopedClaims.filter((c) => {
      if (typeFilter !== 'ALL' && c.claimType !== typeFilter) return false;
      if (progressFilter === 'IN_PROGRESS' && c.isCompleted) return false;
      if (progressFilter === 'COMPLETED' && !c.isCompleted) return false;
      if (searchTerm.trim()) {
        const needle = searchTerm.trim().toLowerCase();
        const haystack = `${c.productName ?? ''} ${c.productOption ?? ''} ${c.matchedCampaignName ?? ''}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [scopedClaims, typeFilter, progressFilter, searchTerm]);

  const inProgressCount = useMemo(() => scopedClaims.filter((c) => !c.isCompleted).length, [scopedClaims]);
  const completedCount = useMemo(() => scopedClaims.filter((c) => c.isCompleted).length, [scopedClaims]);

  // 타입별 카운트 — 카드 취소 배지(취소·반품, 교환 제외)와 페이지 수가 왜 다른지 한눈에 드러낸다.
  // 카드 배지는 productOrderStatus∈{CANCELED,RETURNED} '상품주문 라인' 수이고, 이 목록은 claim
  // 이벤트 행이라 교환이 더해진다. 타입 분해를 노출해 그 차이를 표시로 설명한다(카드 계약은 불변).
  const typeCounts = useMemo(() => {
    const acc = { CANCEL: 0, RETURN: 0, EXCHANGE: 0 } as Record<ClaimType, number>;
    for (const c of scopedClaims) acc[c.claimType] = (acc[c.claimType] ?? 0) + 1;
    return acc;
  }, [scopedClaims]);

  // '전체'에만 카드 배지와 이 목록의 집계 기준 차이를 툴팁으로 설명한다(숫자 반복 대신 title 관례 재사용).
  const typeFilters: { key: TypeFilter; label: string; count?: number; hint?: string }[] = [
    {
      key: 'ALL',
      label: '전체',
      count: scopedClaims.length,
      hint: '카드 취소 배지는 취소·반품 상품주문 라인 수(교환 제외)이고, 이 목록은 교환까지 포함한 클레임 이벤트 기준입니다.',
    },
    { key: 'CANCEL', label: '취소', count: typeCounts.CANCEL },
    { key: 'RETURN', label: '반품', count: typeCounts.RETURN },
    { key: 'EXCHANGE', label: '교환', count: typeCounts.EXCHANGE },
  ];

  const progressFilters: { key: ProgressFilter; label: string }[] = [
    { key: 'ALL', label: '전체' },
    { key: 'IN_PROGRESS', label: '진행중' },
    { key: 'COMPLETED', label: '완료' },
  ];

  return (
    <div className="flex flex-col gap-4">
      {(title || onClose) && (
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          {title && <h4 className="text-sm font-bold text-slate-800">{title}</h4>}
          {onClose && (
            <button
              onClick={onClose}
              className="flex size-7 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
              title="닫기"
            >
              <XIcon className="size-4" />
            </button>
          )}
        </div>
      )}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1">
            {typeFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => setTypeFilter(f.key)}
                title={f.hint}
                className={`rounded-md px-2.5 py-1 text-xs font-bold transition-colors ${
                  typeFilter === f.key ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {f.label}
                {f.count != null && (
                  <span className={`ml-1 tabular-nums font-semibold ${typeFilter === f.key ? 'text-white/70' : 'text-slate-500'}`}>
                    {f.count}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1">
            {progressFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => setProgressFilter(f.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-bold transition-colors ${
                  progressFilter === f.key ? 'bg-slate-900 text-white' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            aria-label="상품명 검색"
            placeholder="상품명 검색..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-8 w-48 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-focus-ring"
          />
        </div>
        <Button variant="outline" size="sm" className="h-8 rounded-lg px-2.5 text-xs" disabled={isLoading} onClick={() => fetchClaims()}>
          <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          <span className="sr-only">새로고침</span>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
        <span>진행중 {inProgressCount}건</span>
        <span className="text-slate-300">·</span>
        <span>완료 {completedCount}건</span>
      </div>

      {isLoading && claims.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-500">불러오는 중...</div>
      ) : filteredClaims.length === 0 ? (
        <DataEmpty icon={Inbox} title="해당 조건의 반품/교환 건이 없습니다." bordered={false} className="py-8" />
      ) : (
        <div className="flex flex-col gap-2">
          {filteredClaims.map((claim, idx) => {
            const key = `${claim.productOrderId}:${claim.claimType}:${idx}`;
            return <ClaimItemCard key={key} claim={claim} />;
          })}
        </div>
      )}
    </div>
  );
}
