"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Search, ExternalLink, RefreshCw, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { evaluateMarketPrice, type EvaluatedCandidate } from "@/lib/price-monitor/pipeline";
import type { PriceVerdict } from "@/lib/price-monitor/verdict";
import type { OutlierReason } from "@/lib/price-monitor/outlier";
import { summarizeSourceFailures, type MarketSourceErrors } from "@/lib/price-monitor/source-errors";

export type MonitorItem = {
  id: string;
  name: string;
  searchQuery: string;
  sellingPrice: number;
  unit?: string | null;
  expectedQuantity?: number | null;
  /** AI가 추출한 모델명/모델코드(P3-2) — evaluateMarketPrice 판정 시 매치 보너스로 사용된다. */
  modelName?: string | null;
};

type MultiMarketPriceMonitorProps = {
  items: MonitorItem[];
  campaignShippingFee?: number | null;
  campaignFreeShippingThreshold?: number | null;
};

type PriceItem = {
  mall: string;
  price: number;
  shippingFee: number;
  totalPrice: number;
  url: string;
  channel: string;
  productName?: string;
};

type EvaluatedPriceItem = PriceItem & EvaluatedCandidate;

const EXCLUDE_REASON_LABEL: Record<OutlierReason, string> = {
  EXCLUDE_KEYWORD: "제외 키워드(중고/해외직구 등)",
  MATCH_TOO_LOW: "상품명 불일치",
  PRICE_BAND_VIOLATION: "비정상 저가(밴드 초과)",
  QUANTITY_MISMATCH: "수량 불일치",
};

const VERDICT_BADGE: Record<PriceVerdict, { label: string; className: string }> = {
  OK: { label: "최저가 유지 중", className: "text-emerald-600" },
  TIE: { label: "동가(±1%)", className: "text-amber-600" },
  VIOLATED: { label: "최저가 경쟁력 위험", className: "text-rose-600" },
  REVIEW: { label: "검토 필요 · 일치율 낮음", className: "text-amber-600" },
  NO_DATA: { label: "비교 데이터 없음", className: "text-slate-500" },
};

export function MarketPriceMonitor({
  items = [],
  campaignShippingFee,
  campaignFreeShippingThreshold,
}: MultiMarketPriceMonitorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  
  // Map of itemId -> result state
  const [results, setResults] = useState<Record<string, {
    loading: boolean;
    items: EvaluatedPriceItem[];
    minItem: EvaluatedPriceItem | null;
    verdict: PriceVerdict;
    ourUnitPrice: number | null;
    searchedQuery: string;
    /**
     * 소스별 실패 사유(`/api/price-monitoring` 응답의 errors). 화면 상단 경고 배너의 재료다 —
     * 이걸 버리면 3소스 중 하나가 죽어도 남은 소스로 계산된 값이 무표시로 "최저가" 행세를 한다
     * (실제로 그랬다: 쿠팡이 16일간 401 이었는데 화면에는 아무 흔적도 없었음).
     */
    sourceErrors?: MarketSourceErrors;
  }>>({});
  
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});

  const toggleExpand = (id: string) => {
    setExpandedItems(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const getOurShipping = (sellingPrice: number) => {
    return campaignShippingFee &&
      (!campaignFreeShippingThreshold || sellingPrice < campaignFreeShippingThreshold)
        ? campaignShippingFee
        : 0;
  };

  const fetchSingleItem = async (item: MonitorItem, customQuery?: string) => {
    const queryToSearch = customQuery ?? item.searchQuery;
    setResults(prev => ({
      ...prev,
      [item.id]: { ...prev[item.id], loading: true, searchedQuery: queryToSearch }
    }));

    try {
      const res = await fetch("/api/price-monitoring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: queryToSearch }),
      });
      if (res.ok) {
        const data = await res.json();
        const ourShipping = getOurShipping(item.sellingPrice);
        const ourTotalPrice = item.sellingPrice + ourShipping;

        // 버그④ 복구: 자체 bigram 유사도 재구현을 제거하고 공용 pipeline(scoring→outlier→verdict,
        // computeSimilarityScore 재사용)으로 대체 — cron/price-monitoring과 동일 판정 로직.
        const evalResult = evaluateMarketPrice({
          candidates: (data.allItems || []) as PriceItem[],
          targetQuery: queryToSearch,
          ourTotalPrice,
          expectedUnit: item.unit,
          expectedQuantity: item.expectedQuantity,
          modelName: item.modelName,
        });

        setResults(prev => ({
          ...prev,
          [item.id]: {
            loading: false,
            items: evalResult.allScored,
            minItem: evalResult.minValidItem,
            verdict: evalResult.verdict,
            ourUnitPrice: evalResult.ourUnitPrice,
            searchedQuery: queryToSearch,
            sourceErrors: data.errors as MarketSourceErrors | undefined,
          }
        }));
      } else {
        throw new Error(`요청 실패 (HTTP ${res.status})`);
      }
    } catch (error) {
      console.error("Price monitor fetch error:", error);
      const reason = error instanceof Error ? error.message : "조회 요청 실패";
      setResults(prev => ({
        ...prev,
        [item.id]: {
          loading: false,
          items: [],
          minItem: null,
          verdict: "NO_DATA",
          ourUnitPrice: null,
          searchedQuery: queryToSearch,
          // 요청 자체가 실패하면 어느 소스도 조회되지 않은 것이다. NO_DATA 배지만으로는
          // "검색 결과가 없다"로 읽혀(아래 렌더) 장애가 정상 결과로 위장되므로 3소스 전부
          // 실패로 표기해 같은 배너에 태운다.
          sourceErrors: { naver: reason, coupang: reason, kakao: reason },
        }
      }));
    }
  };

  const fetchAll = async () => {
    setLoadingAll(true);
    await Promise.allSettled(items.map(item => fetchSingleItem(item)));
    setLoadingAll(false);
  };

  /**
   * 아래 자동 조회 effect 가 "구독하지 않고 최신값만 읽어야 하는" 두 값의 통로다.
   * ⚠️ `results` 를 effect 의존성에 넣으면 안 된다 — effect 가 `fetchSingleItem` 으로
   * `results` 를 갱신하므로 자기 자신을 재트리거한다(첫 setResults 가 loading:true 를
   * 심어 필터에 걸리긴 하지만, 조회 완료·재조회마다 effect 가 계속 깨어난다).
   * `fetchSingleItem` 도 매 렌더 새 함수라 같은 문제를 만든다. 따라서 두 값은 ref 로
   * 끊고, effect 는 원래 의도대로 "열림 · 대상 목록"에만 반응한다.
   */
  const latestRef = useRef({ results, fetchSingleItem });
  useEffect(() => {
    latestRef.current = { results, fetchSingleItem };
  });

  useEffect(() => {
    if (isOpen) {
      // Auto-fetch all items that don't have results yet
      const { results: latestResults, fetchSingleItem: fetchLatest } = latestRef.current;
      const itemsToFetch = items.filter(item => !latestResults[item.id]);
      if (itemsToFetch.length > 0) {
        setLoadingAll(true);
        Promise.allSettled(itemsToFetch.map(item => fetchLatest(item))).then(() => {
          setLoadingAll(false);
        });
      }
    }
  }, [isOpen, items]);

  // 소스 실패는 딜마다 같은 값으로 반복되므로(같은 키·같은 API) 딜별로 붙이지 않고
  // 목록 위 한 곳에 모은다 — 17줄에 같은 경고를 반복하면 P8 §2대로 경고가 배경이 된다.
  const sourceFailure = summarizeSourceFailures(items.map((i) => results[i.id]?.sourceErrors));

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 rounded-lg px-3 text-xs shadow-soft-sm flex items-center gap-1.5 border-blue-200 bg-blue-50/50 text-blue-700 hover:bg-blue-100 hover:text-blue-800 transition-colors">
          <Search className="w-3.5 h-3.5" />
          {/* 「최저가 조회」 → 「가격조회」(오너 지시 2026-08-28) — 매출 상세 내역 헤더가
              한 줄에 들어가게 하는 폭 절감의 일부다. 다이얼로그 안 문구는 그대로 둔다
              (거기선 폭이 문제가 아니고 「시장 최저가」가 정확한 말이다). */}
          가격조회
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="sm:max-w-[1000px] !max-w-[1000px] w-[95vw] max-h-[90vh] flex flex-col overflow-hidden p-0 sm:p-5 gap-0 sm:gap-3">
        <DialogHeader className="shrink-0 flex flex-row items-center justify-between p-3 sm:p-0 pb-2 border-b sm:border-0">
          <DialogTitle className="text-base">시장 최저가 일괄 모니터링</DialogTitle>
          <Button onClick={fetchAll} disabled={loadingAll || items.length === 0} className="w-24 h-8 text-xs">
            {loadingAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <><RefreshCw className="w-3 h-3 mr-1"/> 전체 조회</>}
          </Button>
        </DialogHeader>

        {/*
          소스 결손 고지 — 아래 판정이 "무엇을 보고" 내려졌는지를 밝힌다(P2 Decision-Value:
          판정의 신뢰 조건이라 장식이 아니다). 색은 P8 §1 심각도 축의 caution 을 탄다.
          ⚠️ 텍스트에 opacity 를 얹지 말 것 — globals.css 의 --status-caution 주석대로 /70·/80 은
          AA 가 무너진다. 위계는 불투명 --status-caution-text + font-weight 로만 준다.
        */}
        {sourceFailure && (
          <div
            role="status"
            className="shrink-0 mx-3 sm:mx-0 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-status-caution/25 bg-status-caution-bg px-3.5 py-2.5 text-xs text-status-caution-text"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <span className="font-semibold">
              {sourceFailure.failed.map((f) => f.label).join(" · ")} 소스 응답 실패
            </span>
            <span className="font-normal">
              {sourceFailure.includedLabels.length > 0
                ? `아래 최저가와 판정은 ${sourceFailure.includedLabels.join(" · ")}만 보고 계산됐습니다.`
                : "판정 근거가 된 소스가 없습니다."}
            </span>
            <span className="w-full text-[11px] font-normal">
              {sourceFailure.failed.map((f) => `${f.label}: ${f.reason}`).join(" / ")}
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto min-h-0 space-y-3 p-3 sm:p-0">
          {items.map(item => {
            const res = results[item.id];
            const isLoading = res?.loading;
            const minItem = res?.minItem;
            const fetchedItems = res?.items || [];
            const validItems = fetchedItems.filter((i) => !("excludeReason" in i));
            const isSearched = !!res;
            const verdict: PriceVerdict = res?.verdict ?? "NO_DATA";

            const ourShipping = getOurShipping(item.sellingPrice);
            const ourTotalPrice = item.sellingPrice + ourShipping;

            const secondItem = validItems.length > 1 ? validItems[1] : null;

            let gapAmount = 0;
            let diffText = "";
            if (minItem) {
              if (verdict === "TIE") {
                diffText = "시장가와 사실상 동일(±1%)";
              } else if (verdict === "OK") {
                if (secondItem) {
                  gapAmount = secondItem.totalPrice - ourTotalPrice;
                  diffText = `2위보다 ${formatCurrency(gapAmount)}원 저렴`;
                } else {
                  diffText = "단독 최저가";
                }
              } else if (verdict === "VIOLATED") {
                gapAmount = ourTotalPrice - minItem.totalPrice;
                diffText = `1위보다 ${formatCurrency(gapAmount)}원 비쌈`;
              } else if (verdict === "REVIEW") {
                diffText = "더 싼 후보가 있으나 일치율이 낮음, 다른 품목인지 확인 필요";
              }
            }

            const isExpanded = expandedItems[item.id];

            return (
              <div key={item.id} className="border rounded-lg bg-white overflow-hidden shadow-soft-sm">
                {/* Header row (summary) */}
                <div 
                  className="flex flex-col sm:flex-row sm:items-center justify-between p-3 cursor-pointer hover:bg-slate-50 transition-colors gap-2 sm:gap-0"
                  onClick={() => toggleExpand(item.id)}
                >
                  <div className="flex-1 min-w-0">
                    <h4 className="text-xs font-semibold text-slate-800 truncate" title={item.name}>{item.name}</h4>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      우리 판매가: <span className="font-medium text-slate-700">{formatCurrency(ourTotalPrice)}원</span>
                      {res?.ourUnitPrice != null && (
                        <span className="text-slate-500"> ({formatCurrency(Math.round(res.ourUnitPrice))}원/{item.unit ?? "단위"})</span>
                      )}
                    </div>
                  </div>

                  <div className="flex-1 flex sm:justify-center items-center">
                    {isLoading ? (
                      <div className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" /> 조회 중...
                      </div>
                    ) : isSearched ? (
                      <div>
                        <div className={`text-xs font-bold flex items-center gap-1 ${VERDICT_BADGE[verdict].className}`}>
                          {verdict === "OK" && <CheckCircle2 className="w-3.5 h-3.5" />}
                          {verdict === "VIOLATED" && <AlertTriangle className="w-3.5 h-3.5" />}
                          {verdict === "REVIEW" && <AlertTriangle className="w-3.5 h-3.5" />}
                          <Badge
                            variant="secondary"
                            className={`shadow-none px-1.5 py-0 text-[10px] font-semibold bg-transparent ${VERDICT_BADGE[verdict].className}`}
                          >
                            {VERDICT_BADGE[verdict].label}
                          </Badge>
                        </div>
                        {diffText && <div className={`text-[9px] mt-0.5 ${VERDICT_BADGE[verdict].className}`}>{diffText}</div>}
                        {verdict === "NO_DATA" && (
                          <div className="text-[9px] mt-0.5 text-slate-500">
                            {fetchedItems.length > 0 ? "유효 비교 후보 없음(전량 이상치 배제)" : "검색 결과 없음"}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs text-slate-500">대기 중</div>
                    )}
                  </div>

                  <div className="flex-1 flex items-center justify-between sm:justify-end gap-3">
                    <div className="text-left sm:text-right">
                      <div className="text-[11px] text-slate-500 mb-0.5">시장 유효 최저가</div>
                      {isLoading ? (
                        <div className="text-sm font-bold text-slate-300">...</div>
                      ) : minItem ? (
                        <div>
                          <div className="text-sm font-bold text-blue-600">{formatCurrency(minItem.totalPrice)}원</div>
                          {minItem.unitPrice != null && (
                            <div className="text-[9px] text-slate-500">{formatCurrency(Math.round(minItem.unitPrice))}원/{item.unit ?? "단위"}</div>
                          )}
                        </div>
                      ) : (
                        <div className="text-sm font-bold text-slate-300">-</div>
                      )}
                    </div>
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
                  </div>
                </div>

                {/* Expanded Content */}
                {isExpanded && (
                  <div className="border-t bg-slate-50 p-3">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                        <input
                          type="text"
                          value={res?.searchedQuery ?? item.searchQuery}
                          onChange={(e) => {
                            const val = e.target.value;
                            setResults(prev => ({
                              ...prev,
                              [item.id]: { ...prev[item.id], searchedQuery: val }
                            }));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              fetchSingleItem(item, res?.searchedQuery ?? item.searchQuery);
                            }
                          }}
                          className="w-full h-8 pl-8 pr-3 rounded-md border text-xs bg-white"
                          placeholder="검색어 입력..."
                        />
                      </div>
                      <Button 
                        size="sm" 
                        variant="secondary"
                        onClick={() => fetchSingleItem(item, res?.searchedQuery ?? item.searchQuery)} 
                        disabled={isLoading}
                        className="h-8 text-[11px] px-3"
                      >
                        {isLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1"/>} 재조회
                      </Button>
                    </div>

                    <div className="border rounded-lg bg-white overflow-x-auto">
                      <table className="w-full text-xs text-slate-600">
                        <thead>
                          <tr className="border-b">
                            <th className="font-semibold px-2 py-2 text-left w-[9%]">채널</th>
                            <th className="font-semibold px-2 py-2 text-left w-[13%]">판매처</th>
                            <th className="font-semibold px-2 py-2 text-left w-[28%]">수집된 상품명</th>
                            <th className="font-semibold px-2 py-2 text-center w-[12%]">분석</th>
                            <th className="font-semibold px-2 py-2 text-right w-[9%]">상품가</th>
                            <th className="font-semibold px-2 py-2 text-right w-[7%]">배송비</th>
                            <th className="font-semibold px-2 py-2 text-right w-[10%]">최종가</th>
                            <th className="font-semibold px-2 py-2 text-left w-[12%]">비고</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fetchedItems.map((fetchedItem, idx) => {
                            const isExcluded = "excludeReason" in fetchedItem && !!fetchedItem.excludeReason;
                            const isLowest = !isExcluded && res.minItem?.url === fetchedItem.url;
                            const isDanger = isLowest && fetchedItem.totalPrice < ourTotalPrice;

                            let scoreColor = "text-slate-500";
                            if (fetchedItem.matchScore >= 80) scoreColor = "text-emerald-600 font-medium";
                            else if (fetchedItem.matchScore >= 50) scoreColor = "text-amber-600 font-medium";
                            else scoreColor = "text-rose-600 font-medium";

                            return (
                              <tr
                                key={idx}
                                className={`border-b last:border-0 ${isDanger ? 'bg-rose-50' : isExcluded ? 'bg-slate-50/70 opacity-60' : 'hover:bg-slate-50'}`}
                              >
                                <td className="px-2 py-2.5">
                                  <Badge variant="secondary" className="bg-slate-100 text-slate-500 font-normal shadow-none px-1.5 py-0 text-[10px] uppercase">
                                    {fetchedItem.channel}
                                  </Badge>
                                </td>
                                <td className="px-2 py-2.5 truncate max-w-[100px]">{fetchedItem.mall}</td>
                                <td className={`px-2 py-2.5 truncate max-w-[200px] ${isDanger ? 'font-medium text-rose-700' : ''}`} title={fetchedItem.productName}>
                                  {fetchedItem.productName || "-"}
                                </td>
                                <td className="px-2 py-2.5 text-center">
                                  <div className={`text-[11px] ${scoreColor}`}>
                                    {fetchedItem.matchScore}% 일치
                                  </div>
                                  {item.unit && (
                                    <div className="text-[10px] text-slate-500">
                                      {fetchedItem.extractedQuantity != null
                                        ? `${fetchedItem.extractedQuantity}${item.unit}`
                                        : `수량(?)`}
                                    </div>
                                  )}
                                  {fetchedItem.unitPrice != null && (
                                    <div className="text-[9px] text-slate-500">{formatCurrency(Math.round(fetchedItem.unitPrice))}원/{item.unit ?? "단위"}</div>
                                  )}
                                </td>
                                <td className="px-2 py-2.5 text-right">{formatCurrency(fetchedItem.price)}</td>
                                <td className="px-2 py-2.5 text-right text-slate-500">{formatCurrency(fetchedItem.shippingFee)}</td>
                                <td className={`px-2 py-2.5 text-right font-semibold ${isDanger ? 'text-rose-600' : 'text-slate-700'}`}>
                                  <a href={fetchedItem.url} target="_blank" rel="noreferrer" className="flex items-center justify-end gap-1 hover:underline">
                                    {formatCurrency(fetchedItem.totalPrice)}
                                    <ExternalLink className="w-3 h-3 text-slate-400" />
                                  </a>
                                </td>
                                <td className="px-2 py-2.5">
                                  {isExcluded && "excludeReason" in fetchedItem && fetchedItem.excludeReason && (
                                    <span className="text-[10px] text-slate-500">
                                      배제: {EXCLUDE_REASON_LABEL[fetchedItem.excludeReason]}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                          {!isLoading && fetchedItems.length === 0 && isSearched && (
                            <tr>
                              <td colSpan={8} className="px-3 py-6 text-center text-slate-500 text-[11px]">
                                검색 결과가 없습니다.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          
          {items.length === 0 && (
            <div className="py-12 text-center text-slate-500 text-sm">
              모니터링할 품목이 없습니다. 하위 품목을 먼저 추가해주세요.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

