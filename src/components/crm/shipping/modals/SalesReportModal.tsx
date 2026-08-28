import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Campaign } from '@/types/campaign';
import { toPng } from 'html-to-image';

type SalesReportModalProps = {
  campaign: Campaign | null;
  onClose: () => void;
  onToast: (message: string, type: 'success' | 'error' | 'info') => void;
};

export default function SalesReportModal({
  campaign,
  onClose,
  onToast,
}: SalesReportModalProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!campaign) return null;

  const handleSaveImage = async () => {
    const target = document.getElementById('sales-report-content');
    if (!target) return;

    const sellerName = campaign.sellerName || '알수없음';
    const campaignName = campaign.name || '캠페인';

    // 캡처 시 스크롤바가 찍히지 않도록 임시 스타일 주입
    const styleId = 'hide-scrollbar-style';
    let styleEl = document.getElementById(styleId);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      styleEl.innerHTML = `
        #sales-report-content::-webkit-scrollbar,
        #sales-report-content *::-webkit-scrollbar {
          display: none !important;
          width: 0 !important;
          height: 0 !important;
        }
        #sales-report-content,
        #sales-report-content * {
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
        }
      `;
      document.head.appendChild(styleEl);
    }

    try {
      onToast('이미지 저장 중...', 'info');
      const dataUrl = await toPng(target, {
        pixelRatio: 2,
        backgroundColor: '#f8fafc', // slate-50에 맞춤
        width: target.scrollWidth,
        height: target.scrollHeight,
        style: {
          overflow: 'hidden',
          maxHeight: 'none',
          scrollbarGutter: 'auto'
        }
      });
      const link = document.createElement('a');
      link.href = dataUrl;
      const today = new Date();
      const yy = String(today.getFullYear()).slice(2);
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      link.download = `[매출보고]${sellerName}_${campaignName}_${yy}${mm}${dd}.png`;
      link.click();
      
      onToast('이미지 저장이 완료되었습니다.', 'success');
    } catch (e) {
      console.error(e);
      onToast('저장 중 오류가 발생했습니다.', 'error');
    } finally {
      const el = document.getElementById(styleId);
      if (el) el.remove();
    }
  };

  const dailyStats = (campaign as any).dailyStats || [];

  // 취소·반품 보충 신호(수량 + 환불금액). 총매출·총수량은 이미 취소·반품 제외 순수치라, 여기선 "차감"이 아니라
  // "참고" 톤으로 상시 노출한다(PNG 저장본에서도 읽히도록 hover 아님). 미결제취소는 서버 집계에서 이미 제외됨.
  const cancelReturnQty = Number((campaign as any).cancelReturnQuantity) || 0;
  const cancelReturnAmt = Number((campaign as any).cancelReturnAmount) || 0;

  let totalOverallOrders = 0;
  let totalOverallQuantity = 0;
  let totalOverallRevenue = 0;
  const overallOptionsMap: Record<string, { price: number, orders: number, quantity: number, revenue: number }> = {};
  
  dailyStats.forEach((stat: any) => {
    totalOverallOrders += stat.orders;
    totalOverallQuantity += (stat.quantity || stat.orders || 0);
    totalOverallRevenue += stat.revenue;
    if (stat.options) {
      stat.options.forEach((opt: any) => {
        const optName = opt.name.replace(/^제품:\s*/, '');
        if (!overallOptionsMap[optName]) {
          overallOptionsMap[optName] = { price: opt.price, orders: 0, quantity: 0, revenue: 0 };
        } else if (!overallOptionsMap[optName].price && opt.price) {
          // 최초 등장일 price가 0이면 이후 날짜의 유효 단가로 백필
          overallOptionsMap[optName].price = opt.price;
        }
        overallOptionsMap[optName].orders += opt.orders;
        overallOptionsMap[optName].quantity += (opt.quantity || opt.orders || 0);
        overallOptionsMap[optName].revenue += opt.revenue;
      });
    }
  });

  const overallOptions = Object.keys(overallOptionsMap).map(optName => {
    const opt = overallOptionsMap[optName];
    return {
      name: optName,
      price: opt.price,
      orders: opt.orders,
      quantity: opt.quantity,
      revenue: opt.revenue,
      ratio: totalOverallQuantity > 0 ? (opt.quantity / totalOverallQuantity) * 100 : 0
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  if (!isMounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
      <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div className="bg-white rounded-2xl shadow-overlay relative w-full max-w-4xl max-h-[90vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-white rounded-t-2xl shrink-0">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            매출 보고
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-600 p-2 rounded-full hover:bg-slate-100 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <div id="sales-report-content" className="p-6 overflow-y-auto flex-1 bg-slate-50/50" style={{ scrollbarGutter: 'stable' }}>
          {dailyStats.length === 0 ? (
            <div className="text-center p-10 text-slate-500 font-medium bg-white rounded-xl border border-slate-200">
              집계된 매출 내역이 없습니다.
            </div>
          ) : (
            <div className="space-y-6">
              {/* 전체 누적 성과 */}
              <div className="bg-white border border-blue-200 rounded-xl overflow-hidden shadow-soft-sm ring-1 ring-blue-50">
                <div className="bg-blue-50/50 px-5 py-3 border-b border-blue-100 flex justify-between items-center">
                  <h3 className="font-bold text-blue-900">전체 누적 현황</h3>
                  <div className="text-sm font-bold text-blue-800 flex gap-4 flex-wrap">
                    <span>총 주문: {totalOverallOrders.toLocaleString()}건</span>
                    <span>총 수량: {totalOverallQuantity.toLocaleString()}개</span>
                    <span>총 매출: {totalOverallRevenue.toLocaleString()}원</span>
                    {cancelReturnQty > 0 && (
                      <span className="sm:border-l border-blue-200 sm:pl-4 text-slate-600 font-medium">취소·반품 {cancelReturnQty.toLocaleString()}개 · 환불 {cancelReturnAmt.toLocaleString()}원</span>
                    )}
                  </div>
                </div>
                {cancelReturnQty > 0 && (
                  <div className="px-5 py-1.5 text-[11px] text-slate-600 border-b border-slate-100">※ 위 총 주문·수량·매출은 취소·반품 제외 순수치입니다.</div>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm whitespace-nowrap table-fixed min-w-[750px]">
                    <thead className="bg-white border-b border-slate-100 text-xs text-slate-500 uppercase">
                      <tr>
                        <th className="px-5 py-3 font-bold text-left">구성(옵션)</th>
                        <th className="w-[100px] px-5 py-3 font-bold text-right">판매가격</th>
                        <th className="w-[80px] px-5 py-3 font-bold text-right">주문수량</th>
                        <th className="w-[160px] px-5 py-3 font-bold text-right">판매 비중</th>
                        <th className="w-[130px] px-5 py-3 font-bold text-right">매출합산</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {overallOptions.length > 0 ? (
                        overallOptions.map((opt: any, oIdx: number) => (
                          <tr key={oIdx} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-5 py-3 font-medium text-xs text-slate-700 truncate">{opt.name}</td>
                            <td className="px-5 py-3 text-right text-xs text-slate-600">{opt.price.toLocaleString()}원</td>
                            <td className="px-5 py-3 text-right text-xs text-slate-600 font-semibold">{opt.quantity.toLocaleString()}개</td>
                            <td className="px-5 py-3 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                  <div className="h-full bg-blue-500 rounded-full" style={{ width: `${opt.ratio}%` }}></div>
                                </div>
                                <span className="text-xs font-bold text-slate-500 w-9 text-right">{opt.ratio.toFixed(1)}%</span>
                              </div>
                            </td>
                            <td className="px-5 py-3 text-right text-xs text-slate-800 font-bold">{opt.revenue.toLocaleString()}원</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="px-5 py-4 text-center text-slate-500 text-xs">상세 옵션 데이터가 없습니다.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 일자별 성과 */}
              {dailyStats.map((stat: any, idx: number) => {
                // 주문일자 코호트 기준 취소·반품(서버가 원래 주문일에 되돌려 귀속). 취소가 있는 날만
                // 헤더 span + 순수치 각주를 조건부로 노출 — 취소 0인 날은 순수치=총계라 알릴 것이 없다.
                const dCancelQty = Number(stat.cancelQuantity) || 0;
                const dCancelAmt = Number(stat.cancelRevenue) || 0;
                return (
                <div key={idx} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-soft-sm">
                  <div className="bg-slate-50 px-5 py-3 border-b border-slate-200 flex justify-between items-start">
                    <h3 className="font-bold text-slate-700">{stat.date}</h3>
                    <div className="text-sm font-medium text-slate-600 flex gap-4 flex-wrap justify-end">
                      <span>총 주문: <b className="text-slate-800">{stat.orders.toLocaleString()}건</b></span>
                      <span>총 수량: <b className="text-slate-800">{(stat.quantity || stat.orders || 0).toLocaleString()}개</b></span>
                      <span>총 매출: <b className="text-slate-800">{stat.revenue.toLocaleString()}원</b></span>
                      {dCancelQty > 0 && (
                        <span className="sm:border-l border-slate-300 sm:pl-4 text-slate-600 font-medium">취소·반품 {dCancelQty.toLocaleString()}개 · 환불 {dCancelAmt.toLocaleString()}원</span>
                      )}
                    </div>
                  </div>
                  {dCancelQty > 0 && (
                    <div className="px-5 py-1.5 text-[11px] text-slate-600 border-b border-slate-100">※ 위 총 주문·수량·매출은 이 날 주문분의 취소·반품 제외 순수치입니다.</div>
                  )}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm whitespace-nowrap table-fixed min-w-[750px]">
                      <thead className="bg-white border-b border-slate-100 text-xs text-slate-500 uppercase">
                        <tr>
                          <th className="px-5 py-3 font-bold text-left">구성(옵션)</th>
                          <th className="w-[100px] px-5 py-3 font-bold text-right">판매가격</th>
                          <th className="w-[80px] px-5 py-3 font-bold text-right">주문수량</th>
                          <th className="w-[160px] px-5 py-3 font-bold text-right">판매 비중</th>
                          <th className="w-[130px] px-5 py-3 font-bold text-right">매출합산</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {stat.options && stat.options.length > 0 ? (
                          [...stat.options]
                            .sort((a: any, b: any) => {
                              const aName = a.name.replace(/^제품:\s*/, '');
                              const bName = b.name.replace(/^제품:\s*/, '');
                              return aName.localeCompare(bName, 'ko');
                            })
                            .map((opt: any, oIdx: number) => {
                            const optName = opt.name.replace(/^제품:\s*/, '');
                            return (
                              <tr key={oIdx} className="hover:bg-slate-50/50 transition-colors">
                                <td className="px-5 py-3 font-medium text-xs text-slate-700 truncate">{optName}</td>
                                <td className="px-5 py-3 text-right text-xs text-slate-600">{opt.price.toLocaleString()}원</td>
                                <td className="px-5 py-3 text-right text-xs text-slate-600 font-semibold">{(opt.quantity || opt.orders || 0).toLocaleString()}개</td>
                                <td className="px-5 py-3 text-right">
                                  <div className="flex items-center justify-end gap-2">
                                    <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${opt.ratio}%` }}></div>
                                    </div>
                                    <span className="text-xs font-bold text-slate-500 w-9 text-right">{opt.ratio.toFixed(1)}%</span>
                                  </div>
                                </td>
                                <td className="px-5 py-3 text-right text-xs text-slate-800 font-bold">{opt.revenue.toLocaleString()}원</td>
                              </tr>
                            );
                          })
                        ) : (
                          <tr>
                            <td colSpan={5} className="px-5 py-4 text-center text-slate-500 text-xs">상세 옵션 데이터가 없습니다.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
        
        <div className="pl-6 pr-10 py-4 border-t border-slate-100 bg-white rounded-b-2xl flex justify-end items-center gap-2 shrink-0">
          <button 
            onClick={handleSaveImage} 
            className="flex items-center gap-1.5 px-5 py-2 text-sm text-slate-600 hover:text-slate-800 bg-white border border-slate-300 rounded-lg font-bold transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            이미지 저장
          </button>
          <button 
            onClick={onClose} 
            className="px-5 py-2 text-sm text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg font-bold transition-colors"
          >
            닫기
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
