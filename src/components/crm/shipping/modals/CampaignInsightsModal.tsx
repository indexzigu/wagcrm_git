import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Campaign } from '@/types/campaign';

type CampaignInsightsModalProps = {
  campaign: Campaign | null;
  onClose: () => void;
};

// 내부 운영용 캠페인 인사이트 모달 — 스냅샷 분석성 필드(유입경로·시간대·구매자·결제)의
// 비식별 집계를 보여준다. 셀러 제공용 아님(매출보고와 별개 화면).
export default function CampaignInsightsModal({ campaign, onClose }: CampaignInsightsModalProps) {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!campaign || !isMounted) return null;

  const insights = campaign.insights;
  const deviceTotal = insights ? insights.device.mobile + insights.device.pc + insights.device.unknown : 0;
  const mobileRatio = insights && deviceTotal > 0 ? (insights.device.mobile / deviceTotal) * 100 : 0;
  const hourlyMax = insights ? Math.max(1, ...insights.hourly.map(h => h.orders)) : 1;
  // 주문건수는 결제(orderId) distinct 기준(계약: docs/agents/data-contracts.md). totalOrders(상품주문
  // 라인수)는 표시 금지 — 인사이트 카운트·비율이 전부 결제 단위라 표시 총합도 결제 단위로 맞춘다.
  // 과거 마감 캠페인은 distinctOrderCount 백필 전이라 totalOrders로 폴백(0 표기 방지, 핸들러와 동일).
  const orderCount = campaign.distinctOrderCount ?? campaign.totalOrders ?? 0;

  const summaryCards = insights ? [
    { label: '구매자 수', value: `${insights.buyers.unique.toLocaleString()}명`, sub: `유효 주문 ${orderCount.toLocaleString()}건` },
    { label: '반복 구매율', value: `${insights.buyers.repeatRatio.toFixed(1)}%`, sub: `캠페인 내 2회+ ${insights.buyers.repeat.toLocaleString()}명` },
    { label: '모바일 비율', value: `${mobileRatio.toFixed(1)}%`, sub: `멤버십 ${insights.membership.ratio.toFixed(1)}%` },
    { label: '취소·반품율', value: `${insights.claims.ratio.toFixed(1)}%`, sub: `취소 ${insights.claims.canceled} · 반품 ${insights.claims.returned} · 교환 ${insights.claims.exchanged}` },
  ] : [];

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
      <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" onClick={onClose} />
      <div className="bg-white rounded-2xl shadow-overlay relative w-full max-w-4xl max-h-[90vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-white rounded-t-2xl shrink-0">
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <svg className="w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
            </svg>
            캠페인 인사이트
            <span className="text-sm font-medium text-slate-500 ml-1 truncate max-w-[300px]">{campaign.name}</span>
            {/* 마감/폴백 캠페인은 라이브가 아닌 마감 시점 동결 스냅샷임을 명시(수치 신뢰 맥락). */}
            {(campaign.isFrozenFallback || campaign.isActive === false) && (
              <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5 whitespace-nowrap shrink-0">
                마감 시점 스냅샷
              </span>
            )}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-600 p-2 rounded-full hover:bg-slate-100 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 bg-slate-50/50" style={{ scrollbarGutter: 'stable' }}>
          {!insights ? (
            <div className="text-center p-10 text-slate-500 font-medium bg-white rounded-xl border border-slate-200">
              인사이트 스냅샷이 없습니다. (이 기능 도입 전 마감된 캠페인은 마감 시점 데이터가 남아있지 않습니다)
            </div>
          ) : orderCount === 0 ? (
            <div className="text-center p-10 text-slate-500 font-medium bg-white rounded-xl border border-slate-200">
              집계된 유효 주문이 없습니다.
            </div>
          ) : (
            <div className="space-y-6">
              {/* 요약 카드 */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {summaryCards.map((card) => (
                  <div key={card.label} className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-soft-sm">
                    <div className="text-xs font-bold text-slate-500 uppercase">{card.label}</div>
                    <div className="text-xl font-bold text-slate-800 mt-1">{card.value}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{card.sub}</div>
                  </div>
                ))}
              </div>

              {/* 유입 경로 */}
              <div className="bg-white border border-indigo-200 rounded-xl overflow-hidden shadow-soft-sm ring-1 ring-indigo-50">
                <div className="bg-indigo-50/50 px-5 py-3 border-b border-indigo-100">
                  <h3 className="font-bold text-indigo-900">유입 경로별 주문</h3>
                  <p className="text-[11px] text-indigo-700/70 mt-0.5">네이버 주문 데이터의 inflowPath 기준 · &quot;마케팅링크&quot;는 외부(SNS 등) 링크 유입</p>
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-left text-sm whitespace-nowrap min-w-[560px]">
                  <thead className="bg-white border-b border-slate-100 text-xs text-slate-500 uppercase">
                    <tr>
                      <th className="px-5 py-3 font-bold">경로</th>
                      <th className="w-[90px] px-5 py-3 font-bold text-right">주문</th>
                      <th className="w-[170px] px-5 py-3 font-bold text-right">비중</th>
                      <th className="w-[130px] px-5 py-3 font-bold text-right">매출</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {insights.inflow.map((row) => (
                      <tr key={row.path} className="hover:bg-slate-50/50 transition-colors">
                        <td className="px-5 py-3 font-medium text-xs text-slate-700">{row.path}</td>
                        <td className="px-5 py-3 text-right text-xs text-slate-600 font-semibold">{row.orders.toLocaleString()}건</td>
                        <td className="px-5 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${row.orderRatio}%` }}></div>
                            </div>
                            <span className="text-xs font-bold text-slate-500 w-10 text-right">{row.orderRatio.toFixed(1)}%</span>
                          </div>
                        </td>
                        <td className="px-5 py-3 text-right text-xs text-slate-800 font-bold">{row.revenue.toLocaleString()}원</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>

              {/* 시간대별 주문 */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-soft-sm">
                <div className="bg-slate-50 px-5 py-3 border-b border-slate-200">
                  <h3 className="font-bold text-slate-700">시간대별 주문 (KST)</h3>
                </div>
                <div className="px-5 pt-6 pb-3">
                  <div className="flex items-end gap-1 h-28">
                    {insights.hourly.map((h) => (
                      <div key={h.hour} className="flex-1 h-full flex flex-col items-center justify-end gap-1 group relative">
                        <div className="hidden group-hover:block absolute -top-6 text-[10px] font-bold text-slate-600 bg-white border border-slate-200 rounded px-1 whitespace-nowrap z-10">
                          {h.hour}시 · {h.orders}건
                        </div>
                        {/* 퍼센트 높이는 items-end 부모에서 0으로 해석되므로 픽셀 고정(막대영역 88px) */}
                        <div
                          className={`w-full rounded-t ${h.orders > 0 ? 'bg-blue-400 group-hover:bg-blue-500' : 'bg-slate-100'}`}
                          style={{ height: `${Math.max(h.orders > 0 ? 5 : 2, Math.round((h.orders / hourlyMax) * 88))}px` }}
                        ></div>
                        <span className="text-[9px] text-slate-500 leading-none">{h.hour % 3 === 0 ? h.hour : ''}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* 결제 수단 */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-soft-sm">
                <div className="bg-slate-50 px-5 py-3 border-b border-slate-200">
                  <h3 className="font-bold text-slate-700">결제 수단</h3>
                </div>
                <div className="px-5 py-4 flex flex-wrap gap-2">
                  {insights.paymentMeans.map((pm) => (
                    <span key={pm.means} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-100 text-xs font-bold text-slate-600">
                      {pm.means}
                      <b className="text-slate-800">{pm.orders.toLocaleString()}건</b>
                      <span className="text-slate-500 font-medium">({orderCount > 0 ? ((pm.orders / orderCount) * 100).toFixed(0) : 0}%)</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-100 bg-white rounded-b-2xl flex justify-end items-center shrink-0">
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
