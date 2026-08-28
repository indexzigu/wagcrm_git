import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Campaign } from '@/types/campaign';
import { getDisplayDealName } from '@/lib/deal-display';
import { sortProductMappingsByProductName } from '@/lib/order-converter/product-mapping-sort';

/** 옵션명 정규화 키 — 스토어 옵션 재조회 시 기존 딜 연결을 이어붙이는 데 쓴다(공백·기호 표기 흔들림 흡수). */
const normOptionKey = (s: string | null | undefined) => (s || '').replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();

type CampaignEditModalProps = {
  campaign: Campaign;
  onClose: () => void;
  onSubmit: (id: string, data: Partial<Campaign>) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
};

export default function CampaignEditModal({
  campaign,
  onClose,
  onSubmit,
  onDelete,
}: CampaignEditModalProps) {
  const [editName, setEditName] = useState('');
  const [editSellerName, setEditSellerName] = useState('');
  const [editTemplate, setEditTemplate] = useState('');
  const [editToEmail, setEditToEmail] = useState('');
  const [editCcEmail, setEditCcEmail] = useState('');
  const [editThumbnailUrl, setEditThumbnailUrl] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editProductStatus, setEditProductStatus] = useState('');
  const [editSalePeriod, setEditSalePeriod] = useState('');
  const [editMappings, setEditMappings] = useState<any[]>([{ productName: '', optionName: '', brandCode: '', price: 0, campaignDealId: null }]);
  const [isMounted, setIsMounted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [debugLog, setDebugLog] = useState<string | null>(null);
  const [isLoadingLog, setIsLoadingLog] = useState(false);
  const [recommendations, setRecommendations] = useState<Record<string, any[]>>({});
  const [isLoadingOptions, setIsLoadingOptions] = useState(false);
  const [loadOptionsError, setLoadOptionsError] = useState<string | null>(null);
  const [brandOptions, setBrandOptions] = useState<{ slug: string; displayName: string }[]>([]);
  const [brandLoadError, setBrandLoadError] = useState(false);
  const [brandsLoaded, setBrandsLoaded] = useState(false);
  const [isPushingSales, setIsPushingSales] = useState(false);
  const [pushSalesMessage, setPushSalesMessage] = useState<{ text: string; tone: 'success' | 'warn' | 'error' } | null>(null);

  // F4-②: '거래처 양식' 드롭다운을 거래처 발주 설정에서 동적 로드 (하드코딩 제거)
  useEffect(() => {
    let cancelled = false;
    fetch('/order-converter/api/brands')
      .then(r => { if (!r.ok) throw new Error('발주 브랜드 목록 조회 실패'); return r.json(); })
      .then(d => { if (!cancelled && Array.isArray(d.brands)) setBrandOptions(d.brands.map((b: any) => ({ slug: b.slug, displayName: b.displayName }))); })
      .catch(() => { if (!cancelled) setBrandLoadError(true); })
      .finally(() => { if (!cancelled) setBrandsLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  // 로드 전 원시 코드 노출 방지: 브랜드 목록 로드 전에는 현재 값 코드를 '불러오는 중…'으로 표기.
  const templateOptions = useMemo(() => {
    const opts = brandOptions.slice();
    if (editTemplate && !opts.some(o => o.slug === editTemplate)) {
      opts.unshift({ slug: editTemplate, displayName: brandsLoaded ? editTemplate : '불러오는 중…' });
    }
    return opts;
  }, [brandOptions, editTemplate, brandsLoaded]);

  // 코드표 없는 거래처용: 이 캠페인의 스토어 상품을 찾아(productId 우선, 이름 매칭 폴백)
  // 옵션명·가격(추가구성 포함)을 매핑 표에 자동 로드. 상품코드는 비워둔다(미기입 운영).
  const handleLoadStoreOptions = async () => {
    const hasContent = editMappings.some(m => m.optionName || m.brandCode || (m.price || 0) > 0);
    if (hasContent && !window.confirm('현재 매핑 표 내용을 스토어 옵션으로 대체할까요? (딜 연결은 저장 전 다시 확인하세요)')) return;

    setIsLoadingOptions(true);
    setLoadOptionsError(null);
    try {
      const listRes = await fetch('/order-converter/api/naver/products');
      const listData = await listRes.json();
      if (!listRes.ok || !listData.success) throw new Error(listData.error || '스토어 상품 목록 조회에 실패했습니다.');

      const norm = (s: string) => (s || '').replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();
      const campNorm = norm(campaign.name);
      const channelProducts: any[] = (listData.products || []).flatMap((p: any) =>
        (p.channelProducts || []).map((cp: any) => ({ ...cp, _originProductNo: p.originProductNo }))
      );

      // 1순위: 캠페인에 저장된 productId(origin/channel 어느 쪽이든)와 일치
      let target = channelProducts.find((cp: any) =>
        campaign.productId && (String(cp.channelProductNo) === String(campaign.productId) || String(cp._originProductNo) === String(campaign.productId))
      );
      // 2순위: 상품명 정규화 매칭
      if (!target) target = channelProducts.find((cp: any) => norm(cp.name) === campNorm);
      if (!target) target = channelProducts.find((cp: any) => norm(cp.name).includes(campNorm) || campNorm.includes(norm(cp.name)));
      if (!target) throw new Error('캠페인과 일치하는 스토어 상품을 찾지 못했습니다. 상품명이 바뀌었는지 확인하세요.');

      const res = await fetch(`/order-converter/api/naver/products/${target.channelProductNo}/options`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '옵션 조회에 실패했습니다.');
      // 스토어 옵션을 다시 불러와도 기존 딜 연결(campaignDealId)은 옵션명 기준으로 이어받는다.
      // 과거 전 행을 null로 리셋해서, 저장 시 PUT이 매핑을 재생성하며 연결이 전멸하고
      // 딜이 하나도 안 붙으면 판매캠페인 연결까지 해제된다(2026-07-15 점검에서 발견).
      // 신규/이름이 바뀐 옵션만 null로 남아 운영자가 채우면 된다.
      setEditMappings((prev) => {
        const linkedByOption = new Map<string, string>();
        for (const m of prev) {
          const key = normOptionKey(m.optionName);
          if (m.campaignDealId && key && !linkedByOption.has(key)) linkedByOption.set(key, m.campaignDealId);
        }
        return sortProductMappingsByProductName(
          data.rows.map((r: any) => ({
            ...r,
            campaignDealId: linkedByOption.get(normOptionKey(r.optionName)) ?? null,
          })),
        );
      });
    } catch (err: any) {
      setLoadOptionsError(err?.message || '옵션 조회 중 오류가 발생했습니다.');
    } finally {
      setIsLoadingOptions(false);
    }
  };

  const availableDeals = campaign.salesCampaigns?.flatMap((sc: any) =>
    sc.campaignDeals?.map((cd: any) => {
      const finalName = getDisplayDealName(cd.deal) || '이름없음';
      return {
        id: cd.id,
        name: finalName
      };
    }) || []
  ) || [];

  // 딜 등록가 조회표 — 옵션가(스토어 실판매가)와의 교차검증(가격 확인 배지)용.
  // campaigns-handler 는 egress 절감으로 campaignDeals 를 싣지 않으므로(#137·#151)
  // 추천 응답(recommended-deals)의 dealPrice 가 모달이 딜 가격을 아는 유일한 경로다.
  // ⚠️ 이 맵은 최근 추천 후보(3개월 창·기간 게이트 통과·top-10+기간일치 보강)에 한정된다 —
  // 연결 딜이 그 밖(예: 3개월 창 밖 회차)이면 가격이 달라도 배지가 안 뜬다. 배지 부재를
  // "가격 일치 보장"으로 읽지 말 것.
  const dealPriceById = useMemo(() => {
    const map = new Map<string, number>();
    for (const recs of Object.values(recommendations)) {
      for (const r of recs as any[]) {
        const price = Number(r?.dealPrice || 0);
        if (r?.id && price > 0 && !map.has(r.id)) map.set(r.id, price);
      }
    }
    return map;
  }, [recommendations]);

  useEffect(() => {
    // Fetch recommended deals based on auto-mapping logic
    fetch(`/order-converter/api/campaigns/${campaign.id}/recommended-deals`)
      .then(res => res.json())
      .then(data => {
        if (data.recommendations) {
          setRecommendations(data.recommendations);
          
          // 자동 채움 규칙 2단:
          //  ① 100점 이상(사실상 가격 완전일치 포함) — 기존 규칙 유지.
          //  ② 기간(N개월분) 정확일치 후보가 유일하고 서버 autoMap 문턱(30점)을 넘으면 가격이
          //     달라도 자동 선택. 가격은 매칭 기준이 아니다(오너 확정 2026-07-19: 스토어 실판매가
          //     가 정본, 옵션가는 할인율 따라 흔들림 — 3개월분 옵션이 가격 불일치로 50점에 머물러
          //     "미지정"으로 남던 실사고). 기간 일치 후보가 둘 이상이면 오채움 위험이 있어 자동
          //     선택하지 않는다(운영자 수동 선택 유도 — 가격 확인 배지가 교차검증을 돕는다).
          setEditMappings(prev => {
            let hasChanges = false;
            const newMappings = prev.map(m => {
              if (!m.campaignDealId && data.recommendations[m.id]) {
                const recs = data.recommendations[m.id];
                const periodExactRecs = recs.filter((r: any) => r.periodExact);
                const bestRec = recs.find((r: any) => r.score >= 100)
                  ?? (periodExactRecs.length === 1 && periodExactRecs[0].score >= 30 ? periodExactRecs[0] : undefined);
                if (bestRec) {
                  hasChanges = true;
                  return { ...m, campaignDealId: bestRec.id };
                }
              }
              return m;
            });
            return hasChanges ? newMappings : prev;
          });
        }
      })
      .catch(err => console.error("Failed to fetch recommendations", err));
  }, [campaign.id]);

  useEffect(() => {
    setEditName(campaign.name);
    setEditSellerName(campaign.sellerName);
    setEditTemplate(campaign.template || '');
    setEditToEmail(campaign.toEmail || '');
    setEditCcEmail(campaign.ccEmail || '');
    setEditThumbnailUrl(campaign.thumbnailUrl || '');
    setEditCategory(campaign.category || '');
    setEditProductStatus(campaign.productStatus || '');
    setEditSalePeriod(campaign.salePeriod || '');
    if (campaign.mappings && campaign.mappings.length > 0) {
      setEditMappings(sortProductMappingsByProductName(campaign.mappings));
    } else {
      setEditMappings([{ productName: '', optionName: '', brandCode: '', price: 0, campaignDealId: null }]);
    }
    setIsMounted(true);
  }, [campaign]);

  const fetchDebugLog = async () => {
    setIsLoadingLog(true);
    try {
      const res = await fetch(`/order-converter/api/campaigns/${campaign.id}/mapping-debug`);
      const data = await res.json();
      setDebugLog(data.log || "로그가 없습니다.");
    } catch {
      setDebugLog("로그를 불러오지 못했습니다.");
    } finally {
      setIsLoadingLog(false);
    }
  };

  const buildSubmitPayload = (): Partial<Campaign> => ({
    name: editName,
    template: editTemplate,
    sellerName: editSellerName,
    toEmail: editToEmail,
    ccEmail: editCcEmail,
    thumbnailUrl: editThumbnailUrl,
    category: editCategory,
    productStatus: editProductStatus,
    salePeriod: editSalePeriod,
    mappings: sortProductMappingsByProductName(editMappings.map(m => ({ ...m, campaignDealId: m.campaignDealId || null })).filter(m => m.productName || m.optionName || m.brandCode))
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(campaign.id, buildSubmitPayload());
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePushSales = async () => {
    if (isPushingSales || isSubmitting) return;
    setIsPushingSales(true);
    setPushSalesMessage(null);
    try {
      await onSubmit(campaign.id, buildSubmitPayload());
      const res = await fetch(`/order-converter/api/campaigns/${campaign.id}/push-sales`, { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || '판매관리 푸시에 실패했습니다.');
      const unmatched = data.unmatchedDeals ?? 0;
      let text = `판매관리 ${data.pushedCampaigns ?? 0}개 캠페인, ${data.pushedDeals ?? 0}개 딜에 반영했습니다.`;
      // 매칭 0건 딜은 0으로 덮어쓰지 않고 제외했음을 경고로 드러낸다(조용한 0 방지) —
      // 운영자가 매핑 표의 옵션명↔주문 옵션명을 확인하도록 유도.
      if (unmatched > 0) {
        text += ` ${unmatched}개 딜은 매칭된 주문이 없어 제외했습니다. 옵션명 매핑을 확인하세요.`;
      }
      setPushSalesMessage({ text, tone: unmatched > 0 ? 'warn' : 'success' });
    } catch (err: any) {
      setPushSalesMessage({ text: err?.message || '판매관리 푸시에 실패했습니다.', tone: 'error' });
    } finally {
      setIsPushingSales(false);
    }
  };

  const handleTablePaste = (
    e: React.ClipboardEvent<HTMLInputElement>,
    rowIndex: number,
    colIndex: number
  ) => {
    const pasteData = e.clipboardData.getData('text');
    if (!pasteData) return;
    
    const rows = pasteData.split(/\r?\n/).filter(r => r.trim() !== '');
    if (rows.length === 0) return;
    
    if (rows.length > 1 || rows[0].includes('\t')) {
      e.preventDefault();
      const newMappings = editMappings.map(m => ({ ...m }));
      
      let lastProductName = rowIndex > 0 && newMappings[rowIndex - 1] ? newMappings[rowIndex - 1].productName : '';
      
      rows.forEach((row, rIdx) => {
        const cols = row.split('\t');
        const targetRowIdx = rowIndex + rIdx;
        
        if (targetRowIdx >= newMappings.length) {
          newMappings.push({ productName: '', optionName: '', brandCode: '', price: 0, campaignDealId: null });
        }
        
        const targetRow = newMappings[targetRowIdx];
        
        if (colIndex <= 0 && cols[0 - colIndex] !== undefined) {
          const pastedName = cols[0 - colIndex].trim();
          if (pastedName) {
            targetRow.productName = pastedName;
            lastProductName = pastedName;
          } else {
            targetRow.productName = lastProductName;
          }
        }
        
        if (colIndex <= 1 && cols[1 - colIndex] !== undefined) {
          let optName = cols[1 - colIndex].trim();
          optName = optName.replace(/제품:\s*/g, '');
          optName = optName.replace(/\/?\s*수량:\s*/g, '/ ');
          optName = optName.replace(/\[\d+%\]\s*/g, '');
          optName = optName.replace(/^\/\s*/, '');
          targetRow.optionName = optName;
        }
        if (colIndex <= 2 && cols[2 - colIndex] !== undefined) targetRow.brandCode = cols[2 - colIndex].trim();
        if (colIndex <= 3 && cols[3 - colIndex] !== undefined) {
          const parsedPrice = parseInt(cols[3 - colIndex].replace(/,/g, ''), 10);
          targetRow.price = isNaN(parsedPrice) ? 0 : parsedPrice;
        }
      });
      setEditMappings(sortProductMappingsByProductName(newMappings));
    }
  };

  if (!isMounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
      <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div className="bg-white rounded-2xl shadow-overlay relative w-full max-w-4xl max-h-full flex flex-col animate-in fade-in zoom-in-95 duration-200">
        <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-white rounded-t-2xl">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2"><svg className="w-5 h-5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg> 캠페인 설정</h2>
          <button type="button" onClick={onClose} className="text-slate-500 hover:text-slate-600 p-2 rounded-full hover:bg-slate-100 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <div className="overflow-y-auto p-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="col-span-1 min-w-0">
                <label className="block text-[11px] font-bold text-slate-500 mb-1">주문관리 캠페인명</label>
                <div className="w-full border border-slate-200 bg-slate-50 text-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-medium h-[34px] flex items-center overflow-hidden" title={editName || '이름 없음'}>
                  <span className="truncate block w-full">{editName || '이름 없음'}</span>
                </div>
              </div>
              <div className="col-span-1">
                <label className="block text-[11px] font-bold text-slate-500 mb-1">셀러명</label>
                <input required value={editSellerName} onChange={e => setEditSellerName(e.target.value)} className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-blue-500 outline-none transition-[border-color,box-shadow] shadow-soft-sm h-[34px]" />
              </div>
              <div className="col-span-1">
                <label htmlFor="campaign-template-edit" className="block text-[11px] font-bold text-slate-500 mb-1">거래처 양식</label>
                <select id="campaign-template-edit" value={editTemplate} onChange={e => setEditTemplate(e.target.value)} className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs bg-white text-slate-900 focus:ring-2 focus:ring-focus-ring focus:border-blue-500 outline-none transition-[border-color,box-shadow] shadow-soft-sm h-[34px]">
                  <option value="" disabled={templateOptions.length > 0}>
                    {templateOptions.length === 0
                      ? (brandLoadError ? '목록 로드 실패: 새로고침' : '발주 브랜드 없음')
                      : '거래처(브랜드) 선택'}
                  </option>
                  {templateOptions.map(o => (
                    <option key={o.slug} value={o.slug}>{o.displayName}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-1">
                <label className="block text-[11px] font-bold text-slate-500 mb-1">수신 이메일 주소</label>
                <input required value={editToEmail} onChange={e => setEditToEmail(e.target.value)} className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-blue-500 outline-none transition-[border-color,box-shadow] shadow-soft-sm h-[34px]" />
              </div>
              <div className="col-span-2">
                <label className="block text-[11px] font-bold text-slate-500 mb-1">참조 이메일 주소</label>
                <input value={editCcEmail} onChange={e => setEditCcEmail(e.target.value)} className="w-full border border-slate-200 bg-white text-slate-900 placeholder-slate-400 rounded-lg px-2.5 py-1.5 text-xs focus:ring-2 focus:ring-focus-ring focus:border-blue-500 outline-none transition-[border-color,box-shadow] shadow-soft-sm h-[34px]" />
              </div>
              <div className="col-span-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className="block text-[11px] font-bold text-slate-500">연결된 캠페인</label>
                </div>
                <div className="w-full border border-slate-200 bg-slate-50 text-slate-800 rounded-lg px-2.5 py-1 text-xs font-medium flex flex-wrap overflow-y-auto gap-1.5 items-center min-h-[34px] max-h-[80px]">
                  {campaign.salesCampaigns && campaign.salesCampaigns.length > 0 ? (
                    <>
                      {campaign.salesCampaigns.map((sc: any) => (
                        <span key={sc.id} className="inline-flex items-center px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[11px] font-bold border border-blue-100">
                          <span>{sc.campaignName || sc.name}</span>
                        </span>
                      ))}
                    </>
                  ) : (
                    <span className="text-slate-500 text-xs">연결된 캠페인 없음</span>
                  )}
                </div>
                {pushSalesMessage && (
                  <p className={`mt-1 text-[11px] font-semibold ${pushSalesMessage.tone === 'error' ? 'text-red-600' : pushSalesMessage.tone === 'warn' ? 'text-amber-700' : 'text-emerald-700'}`}>
                    {pushSalesMessage.text}
                  </p>
                )}
              </div>
              
              <div className="col-span-3 mt-2">
                <div className="flex justify-between items-center mb-2">
                  <label className="block text-xs font-bold text-slate-500">상품 매핑 표 (코드표 붙여넣기 또는 스토어 옵션 자동 로드 · 상품코드 선택)</label>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={handlePushSales}
                      disabled={isPushingSales || isSubmitting || !editMappings.some((m) => m.campaignDealId)}
                      className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-1 rounded hover:bg-emerald-100 font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isPushingSales ? '전송 중...' : '매출전송'}
                    </button>
                    <button type="button" onClick={handleLoadStoreOptions} disabled={isLoadingOptions} className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-1 rounded hover:bg-emerald-100 font-bold transition-colors disabled:opacity-50">
                      {isLoadingOptions ? '동기화 중...' : 'N스토어 동기화'}
                    </button>
                    <button type="button" onClick={() => setEditMappings([...editMappings, { productName: '', optionName: '', brandCode: '', price: 0, campaignDealId: null }])} className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded hover:bg-slate-200 font-bold transition-colors">+ 행 추가</button>
                  </div>
                </div>
                {loadOptionsError && (
                  <p className="text-xs text-red-500 font-medium mb-2">{loadOptionsError}</p>
                )}
                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full table-fixed text-left text-sm">
                    <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500 uppercase">
                      <tr>
                        <th className="px-2 py-2 font-bold w-[16%]">상품명</th>
                        <th className="px-2 py-2 font-bold">옵션명</th>
                        <th className="px-2 py-2 font-bold w-[14%]">상품코드</th>
                        <th className="px-2 py-2 font-bold w-20">단가</th>
                        <th className="px-2 py-2 font-bold w-[28%]">캠페인(딜)</th>
                        <th className="px-2 py-2 font-bold w-10 text-center">삭제</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {editMappings.map((m, idx) => (
                        <tr key={idx} className="bg-white hover:bg-slate-50">
                          <td className="px-2 py-1">
                            <input value={m.productName} onChange={(e) => {
                              const newM = [...editMappings]; newM[idx] = { ...newM[idx], productName: e.target.value }; setEditMappings(newM);
                            }} onPaste={(e) => handleTablePaste(e, idx, 0)} className="w-full border border-slate-200 rounded-lg px-1.5 py-1 text-[10px] outline-none focus:border-blue-400" />
                          </td>
                          <td className="px-2 py-1">
                            <input value={m.optionName} onChange={(e) => {
                              const newM = [...editMappings]; newM[idx] = { ...newM[idx], optionName: e.target.value }; setEditMappings(newM);
                            }} onPaste={(e) => handleTablePaste(e, idx, 1)} className="w-full border border-slate-200 rounded-lg px-1.5 py-1 text-[10px] outline-none focus:border-blue-400" />
                          </td>
                          <td className="px-2 py-1">
                            <input value={m.brandCode} onChange={(e) => {
                              const newM = [...editMappings]; newM[idx] = { ...newM[idx], brandCode: e.target.value }; setEditMappings(newM);
                            }} onPaste={(e) => handleTablePaste(e, idx, 2)} className="w-full border border-slate-200 rounded-lg px-1.5 py-1 text-[10px] outline-none focus:border-blue-400" />
                          </td>
                          <td className="px-2 py-1">
                            <input type="number" value={m.price} onChange={(e) => {
                              const newM = [...editMappings]; newM[idx] = { ...newM[idx], price: Number(e.target.value) }; setEditMappings(newM);
                            }} onPaste={(e) => handleTablePaste(e, idx, 3)} className="w-full border border-slate-200 rounded-lg px-1.5 py-1 text-[10px] outline-none focus:border-blue-400" />
                          </td>
                          <td className="px-2 py-1">
                            {(() => {
                              // 가격 확인 경고 — 옵션가(스토어 실판매가)와 딜 등록가가 다르면 표시.
                              // 매칭은 막지 않는다(가격은 매칭 기준이 아님) — 스토어 판매가 오입력을
                              // 운영자가 잡도록 불일치를 보이게만 한다(오너 요청 2026-07-19: 교차검증).
                              // 스타일은 이 모달·column-mapping-table 선례와 동일한 "배경 없는
                              // 텍스트+아이콘" 어휘(ss-ux 검토: 여기만 pill 도입은 어휘 믹스).
                              const dealPrice = m.campaignDealId ? dealPriceById.get(m.campaignDealId) : undefined;
                              const optionPrice = Number(m.price || 0);
                              const priceMismatch = !!dealPrice && optionPrice > 0 && dealPrice !== optionPrice;
                              return (
                                <>
                                  <select
                                    value={m.campaignDealId || ''}
                                    onChange={(e) => {
                                      const newM = [...editMappings];
                                      newM[idx] = { ...newM[idx], campaignDealId: e.target.value || null };
                                      setEditMappings(newM);
                                    }}
                                    aria-describedby={priceMismatch ? `price-check-${idx}` : undefined}
                                    className={`w-full border rounded-lg pl-1.5 pr-2 py-1 text-[10px] outline-none focus:border-blue-400 text-ellipsis ${m.campaignDealId ? 'border-green-300 bg-green-50 text-green-700 font-bold' : 'border-slate-200 bg-slate-50 text-slate-500'}`}
                                  >
                                    <option value="">미지정</option>
                                    {availableDeals.length > 0 && (
                                      <optgroup label="연결된 캠페인">
                                        {availableDeals.map((d: any) => (
                                          <option key={d.id} value={d.id}>{d.name}</option>
                                        ))}
                                      </optgroup>
                                    )}
                                    {recommendations[m.id] && recommendations[m.id].length > 0 && (
                                      <optgroup label="추천 캠페인 (자동 매칭 점수순)">
                                        {recommendations[m.id]
                                          .filter((rec: any) => !availableDeals.some((ad: any) => ad.id === rec.id))
                                          .map((rec: any) => (
                                            <option key={`rec-${rec.id}`} value={rec.id}>{rec.name} ({Math.round(rec.score)}점)</option>
                                          ))}
                                      </optgroup>
                                    )}
                                  </select>
                                  {priceMismatch && (
                                    <p id={`price-check-${idx}`} className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-[var(--status-caution-text)]">
                                      <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" />
                                      </svg>
                                      가격 확인: 옵션 {optionPrice.toLocaleString()} · 딜 {dealPrice!.toLocaleString()}
                                    </p>
                                  )}
                                </>
                              );
                            })()}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button type="button" onClick={() => {
                              if (editMappings.length > 1) setEditMappings(editMappings.filter((_, i) => i !== idx));
                            }} className="text-red-400 hover:text-red-600 font-bold p-1"><svg className="w-4 h-4 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg></button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            
            <div className="mt-6 pt-4 border-t border-slate-100">
              <div className="flex justify-between items-center mb-2">
                <label className="block text-xs font-bold text-slate-500">자동 매핑 디버그 (개발용)</label>
                <button type="button" onClick={fetchDebugLog} disabled={isLoadingLog} className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded hover:bg-slate-200 font-bold transition-colors">
                  {isLoadingLog ? '불러오는 중...' : '로그 확인하기'}
                </button>
              </div>
              {debugLog && (
                <div className="bg-slate-900 text-green-400 p-3 rounded-lg text-[10px] sm:text-xs font-mono whitespace-pre-wrap overflow-y-auto max-h-60 mt-2">
                  {debugLog}
                </div>
              )}
            </div>

            <div className="flex gap-2 justify-between mt-6 pt-4 border-t border-slate-100">
              <div>
                {onDelete && (
                  <button type="button" onClick={async () => {
                    if (confirm('정말로 이 캠페인을 삭제하시겠습니까?')) {
                      await onDelete(campaign.id);
                      onClose();
                    }
                  }} className="px-5 py-2 text-sm text-red-600 bg-red-50 hover:bg-red-100 rounded-lg font-bold transition-colors">삭제</button>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="px-5 py-2 text-sm text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 font-bold transition-colors">취소</button>
                <button type="submit" disabled={isSubmitting} className="px-5 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 font-bold shadow-soft-md transition-[background-color,opacity] disabled:opacity-50">{isSubmitting ? '수정 중...' : '수정하기'}</button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body
  );
}
