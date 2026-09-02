"use client";

import { useEffect, useState, useCallback } from "react";
import { ClipboardList, Trash2, Loader2, Info } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";
import type { CampaignRow, CampaignDealRow } from "@/lib/crm-types";
import { getDisplayDealName } from "@/lib/deal-display";
import { sortDealRowsByName } from "@/lib/deal-sort";
import {
  buildSearchQuery,
  parseSearchKeywordFromSupplementaryInfo,
  parseModelNameFromSupplementaryInfo,
  inferQuantityFromName,
} from "@/lib/price-monitor/query-builder";
import { cn } from "@/lib/utils";
import { patchCampaign } from "@/lib/campaign-patch";
import { DataEmpty } from "@/components/ui/empty";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MarketPriceMonitor } from "./market-price-monitor";
import { HelpPopover } from "./help-popover";

type CampaignDealsTableProps = {
  campaign: CampaignRow;
  onCampaignUpdated: (campaign: CampaignRow) => void;
};

type DealOption = {
  id: string;
  dealName: string;
  searchQuery: string;
  costPrice: number;
  sellingPrice: number;
  totalCommissionRate: number | null;
  unit?: string | null;
  expectedQuantity?: number | null;
  /** AI가 추출한 모델명/모델코드(P3-2, UX1-B) — 자식(하위품목) supplementaryInfo에서 우선 파싱하고, 없으면 메인 딜로 폴백한다. */
  modelName?: string | null;
};

function computeSupplyPrice(sellingPrice: number | null | undefined, commissionRate: number | null | undefined) {
  if (sellingPrice == null || commissionRate == null) return null;
  if (!Number.isFinite(sellingPrice) || !Number.isFinite(commissionRate)) return null;
  if (sellingPrice < 0 || commissionRate < 0 || commissionRate >= 100) return null;
  return Math.round(sellingPrice * (1 - commissionRate / 100));
}

/**
 * 정산 단계 편집 안내 — **상시 표시가 아니라 설명 팝오버 안에 있다**(오너 지시 2026-08-28).
 * ⛔ 다시 카드 본문에 상시 노출로 되돌리지 말 것: 아래 표를 밀어내기만 한다.
 * ⚠️ 다만 트리거에는 caution 톤을 남긴다 — 「지금부터 스토어 자동 집계가 꺼진다」는
 *    행동 변화 고지라, 접으면서 **주의사항이 있다는 신호**까지 사라지면 정산 단계 내내
 *    한 번도 안 열어볼 수 있다(ss-ux 검토). 색은 심각도 축이다(P8 §1).
 */
const SETTLEMENT_BASIS_NOTICE =
  "정산 단계에서는 스토어 자동 집계가 더 이상 반영되지 않습니다. 여기서 수정한 품목, 주문수량, 판매가, 총 수수료율, 셀러 수수료율이 최종 정산 금액 산식에 사용됩니다. 공급가는 판매가와 총수수료율로 자동 계산됩니다.";

export function CampaignDealsTable({
  campaign,
  onCampaignUpdated,
}: CampaignDealsTableProps) {
  const [dealOptions, setDealOptions] = useState<DealOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  // 로컬에서 테이블 편집 상태 관리
  const [localDeals, setLocalDeals] = useState<CampaignDealRow[]>([]);
  const isSettlementEditingStage =
    campaign.status === "SETTLEMENT_IN_PROGRESS" || campaign.status === "COMPLETED";

  // 부모 캠페인의 데이터가 변경되면 로컬 데이터 동기화
  useEffect(() => {
    let active = true;
    const run = async () => {
      await Promise.resolve(); // Defer state update
      if (active) {
        setLocalDeals(sortDealRowsByName(campaign.campaignDeals ?? []));
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [campaign.campaignDeals]);

  // 메인 딜의 전체 상세 정보(하위 옵션 포함) 조회
  useEffect(() => {
    let active = true;

    if (!campaign.dealId) {
      const runEmpty = async () => {
        await Promise.resolve();
        if (active) {
          setDealOptions([]);
        }
      };
      void runEmpty();
      return () => {
        active = false;
      };
    }

    async function fetchDealDetails() {
      if (active) {
        setLoadingOptions(true);
      }
      try {
        const response = await fetch(`/api/deals/${campaign.dealId}`);
        if (!response.ok) throw new Error("딜 상세 정보를 불러오지 못했습니다.");
        const data = await response.json();
        
        if (active) {
          const options: DealOption[] = [];
          
          const mainBrandName = data.brandName || "";
          const mainDealName = data.dealName || "";
          // 버그② 복구: AI가 추출한 searchKeyword(supplementaryInfo JSON)를 검색쿼리의 core로
          // 사용한다. 메인 딜에서 1회 추출되며 수량을 포함하지 않는 것이 설계 의도(청사진 §설계).
          const mainSearchKeyword = parseSearchKeywordFromSupplementaryInfo(data.supplementaryInfo);
          // P3-2 + UX1-B: 모델명은 메인 딜 supplementaryInfo에서도 파싱하되, 실제로는 하위품목
          // (자식 옵션)에 붙는 경우가 대부분이라 자식 자신의 modelName을 우선 사용하고 이 값은
          // 자식에 modelName이 없을 때의 폴백으로만 쓰인다(아래 childModelName ?? mainModelName).
          const mainModelName = parseModelNameFromSupplementaryInfo(data.supplementaryInfo);

          // Major 4: 정규식 특수문자가 unit에 섞여 있어도(예: "개[") 크래시 없이 안전하게
          // 처리하도록 query-builder의 inferQuantityFromName(이미 escapeRegExp 처리됨)을 재사용한다.
          let mainParsedQuantity = data.unitQuantity;
          if (!mainParsedQuantity && data.unit) {
            const inferred = inferQuantityFromName(mainDealName, data.unit);
            if (inferred != null) {
              mainParsedQuantity = inferred;
            }
          }

          // 메인 딜 자체도 옵션으로 추가할 수 있도록 포함
          options.push({
            id: data.id,
            dealName: getDisplayDealName(data),
            searchQuery: buildSearchQuery({
              searchKeyword: mainSearchKeyword,
              brandName: mainBrandName,
              dealName: mainDealName,
              unitQuantity: mainParsedQuantity,
              unit: data.unit,
            }),
            sellingPrice: Number(data.sellingPrice || 0),
            totalCommissionRate: data.totalCommissionRate ? Number(data.totalCommissionRate) : null,
            costPrice: computeSupplyPrice(
              Number(data.sellingPrice || 0),
              data.totalCommissionRate ? Number(data.totalCommissionRate) : campaign.totalMarginRate,
            ) ?? Number(data.costPrice || 0),
            unit: data.unit,
            expectedQuantity: mainParsedQuantity,
            modelName: mainModelName,
          });

          // 하위 자식 옵션들 추가
          if (data.options && Array.isArray(data.options)) {
            data.options.forEach((opt: {
              id: string;
              dealName: string;
              unit?: string | null;
              unitQuantity?: number | null;
              supplementaryInfo?: string | null;
              costPrice?: number | string | null;
              sellingPrice?: number | string | null;
              totalCommissionRate?: number | string | null;
            }) => {
              const combinedName = opt.dealName;
              // C1-2: 자식 자신의 unit이 null이면 부모 unit으로 폴백한다(기존 데이터 구제 —
              // 자식 unit이 비어 있어도 부모 unit 기준으로 dealName에서 수량을 역추출할 수 있다).
              const resolvedUnit = opt.unit ?? data.unit;

              // Major 4 회귀 수정: resolvedUnit을 이스케이프 없이 직접 new RegExp에 넣으면
              // 정규식 특수문자가 섞인 단위(예: "개[")에서 파싱 자체가 던진다. query-builder의
              // inferQuantityFromName(escapeRegExp 처리됨)을 재사용해 안전하게 역추출한다.
              let parsedQuantity = opt.unitQuantity;
              if (!parsedQuantity && resolvedUnit) {
                const inferred = inferQuantityFromName(combinedName, resolvedUnit);
                if (inferred != null) {
                  parsedQuantity = inferred;
                }
              }

              // 버그③ 복구 + C1-1 쿼리 규칙 통일: core는 메인 딜의 searchKeyword(없으면
              // brandName+mainDealName 폴백 — searchKeyword는 메인딜에서만 1회 추출되므로)를
              // 그대로 쓰고, childDealName/parentDealName을 전달해 옵션 자신의 차별화 요소
              // (색상/맛/구성 등)를 쿼리에 포함시킨다. 수량 토큰은 이 옵션 자신의
              // unitQuantity+resolvedUnit으로 파생한다.
              // UX1-B 도메인 교정: 모델명은 하위품목명에 붙는 경우가 대부분이므로 자식
              // supplementaryInfo의 modelName을 우선(자식 ?? 부모)으로 해소한다.
              const childModelName = parseModelNameFromSupplementaryInfo(opt.supplementaryInfo);
              options.push({
                id: opt.id,
                dealName: combinedName,
                searchQuery: buildSearchQuery({
                  searchKeyword: mainSearchKeyword,
                  brandName: mainBrandName,
                  dealName: mainDealName,
                  unitQuantity: parsedQuantity,
                  unit: resolvedUnit,
                  childDealName: opt.dealName,
                  parentDealName: mainDealName,
                }),
                sellingPrice: Number(opt.sellingPrice || 0),
                totalCommissionRate: opt.totalCommissionRate ? Number(opt.totalCommissionRate) : null,
                costPrice: computeSupplyPrice(
                  Number(opt.sellingPrice || 0),
                  opt.totalCommissionRate ? Number(opt.totalCommissionRate) : campaign.totalMarginRate,
                ) ?? Number(opt.costPrice || 0),
                unit: resolvedUnit,
                expectedQuantity: parsedQuantity,
                modelName: childModelName ?? mainModelName,
              });
            });
          }
          setDealOptions(options);
        }
      } catch (err) {
        console.error("Failed to fetch deal options:", err);
      } finally {
        if (active) setLoadingOptions(false);
      }
    }

    void fetchDealDetails();
    return () => {
      active = false;
    };
  }, [campaign.dealId, campaign.totalMarginRate]);

  // 로컬 행 데이터 수정 핸들러
  const handleFieldChange = useCallback(
    (index: number, field: keyof CampaignDealRow, value: string | number | null) => {
      setLocalDeals((prev) => {
        const next = [...prev];
        const item = { ...next[index] };
        const valueStr = value !== null ? String(value) : "";

        if (field === "quantity") {
          const quantity = Math.max(0, parseInt(valueStr) || 0);
          item.quantity = quantity;
          // 주문수량이나 판매가 변경 시 매출액(actualSales) 자동 계산
          const sp = item.sellingPrice ?? 0;
          item.actualSales = sp * quantity;
        } else if (field === "sellingPrice") {
          const sellingPrice = Math.max(0, parseFloat(valueStr) || 0);
          item.sellingPrice = sellingPrice;
          item.costPrice = computeSupplyPrice(sellingPrice, item.feeRate ?? campaign.totalMarginRate) ?? 0;
          item.actualSales = sellingPrice * item.quantity;
        } else if (field === "actualSales") {
          item.actualSales = Math.max(0, parseFloat(valueStr) || 0);
        } else if (field === "feeRate") {
          // 수수료율은 null 허용, 0 미만 100 초과 차단
          if (valueStr === "") {
            item.feeRate = null;
          } else {
            const val = parseFloat(valueStr);
            item.feeRate = isNaN(val) ? 0 : Math.min(100, Math.max(0, val));
            item.costPrice = computeSupplyPrice(item.sellingPrice ?? 0, item.feeRate) ?? 0;
          }
        } else if (field === "sellerMarginRate") {
          if (valueStr === "") {
            item.sellerMarginRate = null;
          } else {
            const val = parseFloat(valueStr);
            item.sellerMarginRate = isNaN(val) ? 0 : Math.min(100, Math.max(0, val));
          }
        }

        next[index] = item;
        return next;
      });
    },
    [campaign.totalMarginRate]
  );

  // 품목 추가 핸들러
  const handleAddOption = useCallback(
    (optionId: string) => {
      const option = dealOptions.find((o) => o.id === optionId);
      if (!option) return;

      // 이미 추가되어 있는지 검증
      if (localDeals.some((d) => d.dealId === optionId)) {
        toast.warning("이미 등록된 상품 구성입니다.");
        return;
      }

      const newRow: CampaignDealRow = {
        id: "", // 신규 생성
        campaignId: campaign.id,
        dealId: option.id,
        dealName: option.dealName,
        quantity: 0,
        actualSales: 0,
        feeRate: option.totalCommissionRate ?? campaign.totalMarginRate,
        sellerMarginRate: campaign.sellerMarginRate,
        sellingPrice: option.sellingPrice,
        costPrice: computeSupplyPrice(
          option.sellingPrice,
          option.totalCommissionRate ?? campaign.totalMarginRate,
        ) ?? option.costPrice,
      };

      setLocalDeals((prev) => sortDealRowsByName([...prev, newRow]));
      toast.success(`"${option.dealName}"이(가) 추가되었습니다.`);
    },
    [dealOptions, localDeals, campaign.id, campaign.sellerMarginRate, campaign.totalMarginRate]
  );

  // 품목 제거 핸들러
  const handleRemoveRow = useCallback((index: number) => {
    setLocalDeals((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // 저장 API 전송
  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await patchCampaign<CampaignRow>(
        campaign.id,
        {
          campaignDeals: localDeals.map((ld) => ({
            dealId: ld.dealId,
            quantity: ld.quantity,
            actualSales: ld.actualSales ?? 0,
            feeRate: ld.feeRate,
            sellerMarginRate: ld.sellerMarginRate ?? campaign.sellerMarginRate,
            costPrice: computeSupplyPrice(
              ld.sellingPrice ?? 0,
              ld.feeRate ?? campaign.totalMarginRate,
            ) ?? 0,
            sellingPrice: ld.sellingPrice,
          })),
        },
        { fallbackError: "매출 내역 저장 실패", preferServerError: true },
      );

      if (!result.ok) {
        throw new Error(result.error);
      }

      onCampaignUpdated(result.data);
      toast.success("매출 상세 내역이 성공적으로 저장되었습니다.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "오류가 발생했습니다.");
    } finally {
      setSaving(false);
    }
  };

  // 저장 버튼 클릭 시 정합성 검사 후 저장 진행 또는 컨펌 다이얼로그 호출
  const handleSaveClick = () => {
    const hasInconsistency = localDeals.some(
      (d) => (d.quantity === 0 && (d.actualSales ?? 0) > 0) ||
             ((d.quantity ?? 0) > 0 && d.actualSales === 0)
    );
    if (hasInconsistency) {
      setIsConfirmOpen(true);
    } else {
      void handleSave();
    }
  };

  // 합계 계산
  const totals = localDeals.reduce(
    (acc, cur) => {
      const sales = cur.actualSales ?? 0;
      const commissionRate = cur.feeRate ?? 0;
      const commission = sales * (commissionRate / 100);
      const sellerFee = sales * ((cur.sellerMarginRate ?? campaign.sellerMarginRate ?? 0) / 100);

      return {
        quantity: acc.quantity + (cur.quantity || 0),
        actualSales: acc.actualSales + sales,
        commission: acc.commission + commission,
        sellerFee: acc.sellerFee + sellerFee,
        grossProfit: acc.grossProfit + commission - sellerFee,
      };
    },
    { quantity: 0, actualSales: 0, commission: 0, sellerFee: 0, grossProfit: 0 }
  );

  // 아직 매출 상세내역에 추가되지 않은 옵션 목록 필터링
  const availableOptions = dealOptions.filter(
    (opt) => !localDeals.some((ld) => ld.dealId === opt.id)
  );

  return (
    <div className="space-y-4 rounded-[24px] border border-border/70 bg-white/90 p-5 shadow-soft-sm">
      {/* 폭이 모자라면 **제목을 쪼개지 말고 액션 묶음을 다음 줄로** 내린다 — 종전엔
          제목이 「매출 상 / 세 내역」으로 갈라졌다(오너 지적 2026-08-28). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <ClipboardList className="size-4 shrink-0 text-slate-500" />
          <h3 className="whitespace-nowrap text-sm font-semibold text-foreground">
            매출 상세 내역
          </h3>
          {isSettlementEditingStage ? (
            <HelpPopover
              ariaLabel="최종 정산 기준 데이터 안내"
              title="최종 정산 기준 데이터"
              text={SETTLEMENT_BASIS_NOTICE}
              className="text-status-caution-text hover:text-status-caution"
            />
          ) : null}
        </div>

        {/* 헤더가 줄바꿈되면 이 묶음이 자기 줄에 홀로 남아 `justify-between` 이 무력해진다 —
            `ml-auto` 로 우측 정렬을 유지한다(ss-ux 검토 P2). */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* 품목 추가 드롭다운 */}
          {availableOptions.length > 0 && (
            <select
              onChange={(e) => {
                if (e.target.value) {
                  handleAddOption(e.target.value);
                  e.target.value = "";
                }
              }}
              defaultValue=""
              // ⚠️ `max-w-*` 는 장식이 아니다 — 셀렉트는 **가장 긴 옵션 이름만큼** 늘어나서
              //    헤더를 통째로 밀어냈다(오너 지적 2026-08-28). 폭을 묶어 한 줄에 들어가게 한다.
              className="h-8 max-w-[168px] min-w-0 rounded-lg border border-border bg-background px-2.5 py-1 text-xs text-foreground shadow-soft-sm focus:border-primary focus:outline-none"
              disabled={loadingOptions}
            >
              <option value="" disabled>
                {loadingOptions ? "딜 목록 로딩 중..." : "+ 옵션 품목 추가"}
              </option>
              {availableOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.dealName} ({formatCurrency(opt.sellingPrice)}원)
                </option>
              ))}
            </select>
          )}
          {localDeals.length > 0 ? (
            <>
              <MarketPriceMonitor 
                items={localDeals.map((deal) => {
                  const originOpt = dealOptions.find(o => o.id === deal.dealId);
                  return {
                    id: deal.dealId,
                    name: deal.dealName,
                    searchQuery: originOpt?.searchQuery || deal.dealName,
                    sellingPrice: deal.sellingPrice ?? 0,
                    unit: originOpt?.unit,
                    expectedQuantity: originOpt?.expectedQuantity,
                    modelName: originOpt?.modelName,
                  };
                })}
                campaignShippingFee={campaign.shippingFee}
                campaignFreeShippingThreshold={campaign.freeShippingThreshold}
              />
              <Button
                size="sm"
                onClick={handleSaveClick}
                disabled={saving}
                className="h-8 rounded-lg px-4 text-xs font-semibold shadow-soft-sm bg-primary text-primary-foreground hover:bg-primary/95 transition-colors"
              >
                {saving && <Loader2 className="mr-1.5 size-3 animate-spin" />}
                저장
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {localDeals.length === 0 ? (
        <DataEmpty
          icon={Info}
          title="등록된 매출 품목이 없습니다."
          description={
            availableOptions.length > 0
              ? "우측 상단에서 옵션 품목을 선택하여 추가하세요."
              : "연결된 딜에 사용할 수 있는 옵션 상품이 없습니다."
          }
        />
      ) : (
          <div className="overflow-hidden rounded-xl border border-border/60 bg-white shadow-soft-sm">
            <div className="overflow-x-auto">
                <table className="w-full table-fixed border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-border/70 bg-slate-50/60 text-[10px] font-semibold text-muted-foreground">
                      <th className="w-[34%] whitespace-nowrap px-3 py-2">구성</th>
                      <th className="w-[9%] whitespace-nowrap pl-2 pr-[15px] py-2 text-right">주문수량</th>
                      <th className="w-[12%] whitespace-nowrap px-2 py-2 text-right">거래금액</th>
                      <th className="w-[12%] whitespace-nowrap px-2 py-2 text-right">영업 수익</th>
                      <th className="w-[12%] whitespace-nowrap px-2 py-2 text-right">판매대행비</th>
                      <th className="w-[12%] whitespace-nowrap px-2 py-2 text-right">영업이익</th>
                      <th className="w-[9%] whitespace-nowrap px-2 py-2 text-center">관리</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                {localDeals.map((deal, idx) => {
                  const sales = deal.actualSales ?? 0;
                  const commission = sales * ((deal.feeRate ?? 0) / 100);
                  const sellerFee = sales * ((deal.sellerMarginRate ?? campaign.sellerMarginRate ?? 0) / 100);
                  const grossProfit = commission - sellerFee;

                  return (
                    <tr key={deal.dealId || idx} className="hover:bg-slate-50/40">
                      <td className="px-3 py-1.5 align-top font-medium text-slate-700">
                        <div className="truncate text-[11px]">{deal.dealName}</div>
                        <div className="mt-1 grid grid-cols-2 gap-1 text-[8px] leading-tight text-slate-500">
                          <MiniNumberField
                            label="판매가"
                            value={deal.sellingPrice ?? ""}
                            onChange={(value) => handleFieldChange(idx, "sellingPrice", value)}
                          />
                          <MiniNumberField
                            label="공급가"
                            value={computeSupplyPrice(deal.sellingPrice ?? 0, deal.feeRate ?? campaign.totalMarginRate) ?? deal.costPrice ?? ""}
                            readOnly
                          />
                          <MiniNumberField
                            label="총수수료율"
                            value={deal.feeRate ?? ""}
                            suffix="%"
                            step="0.1"
                            onChange={(value) => handleFieldChange(idx, "feeRate", value)}
                          />
                          <MiniNumberField
                            label="셀러수수료율"
                            value={deal.sellerMarginRate ?? campaign.sellerMarginRate ?? ""}
                            suffix="%"
                            step="0.1"
                            onChange={(value) => handleFieldChange(idx, "sellerMarginRate", value)}
                          />
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right align-middle">
                        <input
                          type="number"
                          value={deal.quantity ?? ""}
                          onChange={(e) => handleFieldChange(idx, "quantity", e.target.value)}
                          className="h-7 w-full rounded border bg-white px-1.5 py-0.5 text-right text-[10px] font-semibold focus:outline-none focus:ring-1 focus:ring-focus-ring [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          placeholder="0"
                          min="0"
                        />
                      </td>
                      <td className="px-1.5 py-1.5 text-right align-middle text-[10px] font-semibold tabular-nums text-slate-700">
                        {formatCurrency(sales)}
                      </td>
                      <td className="px-1.5 py-1.5 text-right align-middle text-[10px] font-medium tabular-nums text-slate-700">
                        {formatCurrency(commission)}
                      </td>
                      <td className="px-1.5 py-1.5 text-right align-middle text-[10px] font-medium tabular-nums text-rose-600">
                        {formatCurrency(sellerFee)}
                      </td>
                      <td className="px-1.5 py-1.5 text-right align-middle text-[10px] font-semibold tabular-nums text-emerald-600">
                        {formatCurrency(grossProfit)}
                      </td>
                      <td className="px-2 py-1.5 text-center align-middle">
                        <div className="flex items-center justify-center">
                          <button
                            type="button"
                            onClick={() => handleRemoveRow(idx)}
                            className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-red-500 transition-colors"
                            aria-label="품목 삭제"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                <tr className="bg-slate-50/80 text-[10px] font-bold border-t border-border/80 text-slate-900">
                  <td className="px-3 py-2">합계 (VAT 포함)</td>
                  <td className="px-2 py-2 text-right text-primary">{totals.quantity}</td>
                  <td className="px-1.5 py-2 text-right text-slate-700">{formatCurrency(totals.actualSales)}</td>
                  <td className="px-1.5 py-2 text-right text-slate-700">{formatCurrency(totals.commission)}</td>
                  <td className="px-1.5 py-2 text-right text-rose-600">{formatCurrency(totals.sellerFee)}</td>
                  <td className="px-1.5 py-2 text-right text-emerald-600">{formatCurrency(totals.grossProfit)}</td>
                  <td className="px-2 py-2"></td>
                </tr>
                  </tbody>
                </table>
          </div>
        </div>
      )}
      {/* 정합성 확인 컨펌 다이얼로그 */}
      <AlertDialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>매출 데이터 정합성 확인</AlertDialogTitle>
            <AlertDialogDescription className="text-xs">
              현재 입력된 매출 데이터 중 아래와 같은 불일치가 감지되었습니다:
              <br /><br />
              <strong className="text-amber-600">• 주문 수량이 0인데 거래 금액이 등록되었거나, 주문 수량은 있으나 거래 금액이 0원인 품목이 존재합니다.</strong>
              <br /><br />
              이대로 저장하시겠습니까?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">취소</AlertDialogCancel>
            <AlertDialogAction
              className="text-xs"
              onClick={() => {
                setIsConfirmOpen(false);
                void handleSave();
              }}
            >
              저장 진행
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MiniNumberField({
  label,
  value,
  suffix,
  step,
  readOnly = false,
  onChange,
}: {
  label: string;
  value: string | number;
  suffix?: string;
  step?: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 items-center gap-0.5 rounded bg-slate-100 px-1 py-0.5">
      <span className="shrink-0 text-[8px] text-slate-500">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min="0"
        readOnly={readOnly}
        tabIndex={readOnly ? -1 : undefined}
        onChange={(event) => onChange?.(event.target.value)}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-right text-[9px] font-semibold tabular-nums text-slate-700 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none",
          readOnly && "cursor-default text-slate-500",
        )}
      />
      {suffix ? <span className="shrink-0 text-[8px] text-slate-500">{suffix}</span> : null}
    </label>
  );
}
