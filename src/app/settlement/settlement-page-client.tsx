"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useFilterParams } from "@/hooks/use-filter-params";
import { ChevronDown, ChevronLeft, ChevronRight, Download, FileText, RefreshCw, Search, TrendingUp, Wallet } from "lucide-react";
import { MONEY_DIRECTION_ICON } from "@/lib/money-direction";
import { unparse } from "papaparse";
import { SettlementTable } from "@/components/crm/settlement-table";
import { SettlementCompletedTable } from "@/components/crm/settlement-completed-table";
import { SettlementSelectionBar } from "@/components/crm/settlement-selection-bar";
import {
  sumSettlementSelection,
  toCompletedSelectionInput,
} from "@/lib/settlement-selection-summary";
import { MobileSettlementView } from "@/components/mobile/mobile-settlement-view";
import { useIsMobile } from "@/hooks/use-mobile";
import { CampaignSidePanel } from "@/components/crm/campaign-side-panel";
import { TaxFilingDialog, previousMonth } from "@/components/crm/tax-filing-dialog";
import { formatDDay } from "@/lib/tax-filing-log";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { toast } from "sonner";
import type { DashboardData, CampaignRow } from "@/lib/crm-types";
import type {
  SettlementReportData,
} from "@/lib/settlement-report";
import { sortDealRowsByName } from "@/lib/deal-sort";
import {
  formatSettlementMonth,
  getCurrentMonth,
  getNextMonth,
  getPreviousMonth,
} from "@/lib/settlement-report";

const formatCurrency = (val: number | null | undefined) => {
  if (val == null) return "-";
  return `${Math.round(Number(val)).toLocaleString()}원`;
};

interface SettlementPageClientProps {
  initialData: DashboardData;
  defaultMonth?: string;
}

export function SettlementPageClient({ initialData, defaultMonth }: SettlementPageClientProps) {
  const isMobile = useIsMobile();
  const { filters, setFilter } = useFilterParams();

  const [data, setData] = useState<DashboardData>(initialData);
  const [loading, setLoading] = useState(false);
  
  const viewType = (filters.viewType as "month" | "year") || "month";
  const selectedMonth = filters.month || defaultMonth || getCurrentMonth();
  const selectedYear = filters.year || String(new Date().getFullYear());
  const searchQuery = filters.q || "";

  const [localQuery, setLocalQuery] = useState(searchQuery);
  const isComposingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalQuery(searchQuery);
  }, [searchQuery]);

  const debouncedSetFilter = useCallback(
    (value: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        if (!isComposingRef.current) {
          if (value.trim().length >= 2 || value.trim().length === 0) {
            setFilter("q", value);
          }
        }
      }, 350);
    },
    [setFilter]
  );

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const [reportData, setReportData] = useState<SettlementReportData | null>(null);
  const [taxFilingOpen, setTaxFilingOpen] = useState(false);
  const [taxFilingMonth, setTaxFilingMonth] = useState(previousMonth);
  const [taxPendingCount, setTaxPendingCount] = useState<number | null>(null);
  const [taxNextDueDate, setTaxNextDueDate] = useState<string | null>(null);

  // 헤더 배지용 미처리 건수 — 다이얼로그를 열기 전에도 남은 일이 있음을 알려야 하므로
  // 대상 월이 바뀔 때마다 조회한다. 배지는 보조 정보라 실패해도 페이지는 그대로
  // 동작해야 한다(무음 실패) — 그리고 조회 도중 월이 바뀌면 먼저 나간 응답이 늦게
  // 돌아와 새 월의 건수를 덮어쓰지 않도록 취소 플래그로 막는다.
  //
  // 세금계산서(board.pendingCount)뿐 아니라 원천징수 3절차 미처리(withholdingPendingCount)
  // 도 더한다 — 원천세 신고를 놓친 채로 마감일이 다가오는 것도 이 배지가 잡아야 할
  // 대상이다(세무 신고자료 도우미 설계 문서 「B. 정산 페이지」절). D-day 는 원천징수
  // 쪽만 표시한다 — 세금계산서 발행 기한은 아직 확인되지 않았고, 확인 안 된 기한을
  // 배지로 띄우면 오너가 그 날짜를 믿고 움직인다(tax-filing-dialog.tsx 헤더 주석과 같은
  // 이유).
  //
  // `taxFilingOpen`도 의존성에 넣는다 — 다이얼로그에서 완료 체크를 누르고 닫아도 이
  // effect는 원래 `taxFilingMonth`가 바뀔 때만 다시 돌아 배지가 옛 값(예: "3 · D-day")
  // 에 멈춰 있었다. 카운트만 있던 시절엔 눈에 덜 띄는 흠이었지만, D-day가 붙은 뒤로는
  // "이미 다 냈는데도 D-day가 지났다"는 낡은 마감일 주장이 되어 더 나쁘다. 닫힐 때도
  // 다시 조회해 다이얼로그 안에서의 변경을 반영한다(무음 실패·취소 처리는 그대로 유지).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/settlement/tax-filing-board?month=${taxFilingMonth}`);
        if (!res.ok) return;
        const board = await res.json();
        if (!cancelled) {
          setTaxPendingCount((board.pendingCount ?? 0) + (board.withholdingPendingCount ?? 0));
          setTaxNextDueDate(board.withholdingNextDueDate ?? null);
        }
      } catch {
        // 배지는 보조 정보다 — 실패해도 페이지 동작을 막지 않는다(무음).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taxFilingMonth, taxFilingOpen]);
  // 표 선택 상태는 **페이지가 소유한다** — 진행 중·완료 두 표가 하단 액션 바 하나를
  // 공유하기 위해서다(표마다 자기 바를 렌더하면 둘 다 `position: fixed` 라 겹친다).
  // 덕분에 두 섹션을 교차 선택해 한 묶음으로 명세서를 뽑을 수도 있다.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const handleToggleRow = useCallback((campaignId: string, checked: boolean) => {
    setSelectedIds((current) =>
      checked
        ? current.includes(campaignId)
          ? current
          : [...current, campaignId]
        : current.filter((id) => id !== campaignId),
    );
  }, []);
  const handleToggleAll = useCallback((campaignIds: string[], checked: boolean) => {
    setSelectedIds((current) =>
      checked
        ? Array.from(new Set([...current, ...campaignIds]))
        : current.filter((id) => !campaignIds.includes(id)),
    );
  }, []);

  const [selectedCampaign, setSelectedCampaign] = useState<CampaignRow | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  // 정산 일정·재무 편집 state 는 여기 없다 — 그 폼은 `CampaignSidePanel` 이 소유한다.
  // 이 파일에 있던 사본은 비활성으로 방치돼 있던 레거시 시트 전용이었고, 그 시트와 함께
  // 제거했다(T-023 — "같은 결과물인데 다른 모듈"의 정체 중 하나).
  /**
   * 행 클릭 = "이 캠페인을 골랐다". **무조건 갈아끼운다** — 아래 동기화용과 반드시
   * 갈라 둬야 한다. 하나로 합치고 id 가드를 걸면 최초 선택 때 `previous` 가 null 이라
   * 교체가 일어나지 않아 **패널이 빈 채로 뜬다**(`CampaignSidePanel` 은 campaign 이
   * 없으면 null 을 반환한다). 대시보드도 같은 이유로 `openCampaign` 과
   * `replaceCampaignRow` 를 나눠 둔다(crm-dashboard.tsx).
   */
  const selectCampaign = useCallback((campaign: CampaignRow) => {
    setSelectedCampaign(campaign);
  }, []);

  /**
   * "어떤 캠페인이 **바뀌었다**" — 지금 열려 있는 그 캠페인일 때만 갈아끼운다.
   * 그룹으로 묶기는 형제 캠페인까지 한 번에 갱신해 흘려보내므로, 가드가 없으면
   * 열어 둔 패널이 마지막 형제로 점프한다.
   */
  const syncUpdatedCampaign = useCallback((campaign: CampaignRow) => {
    setSelectedCampaign((previous) =>
      previous?.id === campaign.id ? campaign : previous,
    );
  }, []);

  const refreshReport = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (viewType === "year") {
        params.set("year", selectedYear);
      } else {
        params.set("month", selectedMonth);
      }
      params.set("searchQuery", searchQuery);

      const response = await fetch(`/api/reports/settlement?${params.toString()}`);
      if (!response.ok) {
        throw new Error("정산 리포트를 가져오는 데 실패했습니다.");
      }

      const nextReport = (await response.json()) as SettlementReportData;
      setReportData(nextReport);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "정산 리포트 로딩 오류");
      setReportData(null);
    }
  }, [searchQuery, selectedMonth, selectedYear, viewType]);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/campaigns?workspace=settlement");
      if (!response.ok) {
        throw new Error("정산 데이터를 가져오는 데 실패했습니다.");
      }
      const campaignsData = (await response.json()) as {
        campaigns: CampaignRow[];
      };
      setData((prev) => ({
        ...prev,
        campaigns: campaignsData.campaigns,
      }));
      await refreshReport();
      toast.success("정산 데이터가 갱신되었습니다.");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "데이터 로딩 오류");
    } finally {
      setLoading(false);
    }
  }, [refreshReport]);

  useEffect(() => {
    void refreshReport();
  }, [refreshReport]);

  const filteredCampaigns = useMemo(() => {
    const allowedIds = new Set(reportData?.campaigns.map((campaign) => campaign.id) ?? []);
    return data.campaigns.filter((c) => allowedIds.has(c.id));
  }, [data.campaigns, reportData]);
  const activeCampaigns = useMemo(
    () => filteredCampaigns
      .filter((campaign) => campaign.status !== "COMPLETED")
      .sort((a, b) => (b.startDate || "").localeCompare(a.startDate || "")),
    [filteredCampaigns],
  );
  const completedCampaigns = useMemo(
    () => filteredCampaigns
      .filter((campaign) => campaign.status === "COMPLETED")
      .sort((a, b) => (b.startDate || "").localeCompare(a.startDate || "")),
    [filteredCampaigns],
  );
  const selectedActiveCampaigns = useMemo(
    () => activeCampaigns.filter((campaign) => selectedIds.includes(campaign.id)),
    [activeCampaigns, selectedIds],
  );
  const selectedCompletedCampaigns = useMemo(
    () => completedCampaigns.filter((campaign) => selectedIds.includes(campaign.id)),
    [completedCampaigns, selectedIds],
  );
  // ⚠️ 합산 입력을 섹션별로 나누는 것은 장식이 아니다 — 완료 표는 영업수익·판매대행비를
  // 캠페인 컬럼이 아니라 리포트 파생값으로 렌더하므로(컬럼이 비면 요율 폴백) 같은 규칙으로
  // 합산하면 화면 숫자와 합계가 어긋난다(`toCompletedSelectionInput` 주석).
  const selectionSummary = useMemo(() => {
    const reportMap = new Map((reportData?.campaigns ?? []).map((rc) => [rc.id, rc]));
    return sumSettlementSelection([
      ...selectedActiveCampaigns,
      ...selectedCompletedCampaigns.map((campaign) =>
        toCompletedSelectionInput(campaign, reportMap.get(campaign.id)),
      ),
    ]);
  }, [selectedActiveCampaigns, selectedCompletedCampaigns, reportData]);
  const selectedCampaigns = useMemo(
    () => [...selectedActiveCampaigns, ...selectedCompletedCampaigns],
    [selectedActiveCampaigns, selectedCompletedCampaigns],
  );

  const pendingDepositAmount = useMemo(
    () =>
      activeCampaigns
        .filter((campaign) => !campaign.isDepositReceived)
        .reduce((sum, campaign) => sum + Number(campaign.settlementSales ?? 0), 0),
    [activeCampaigns],
  );
  const pendingPayoutAmount = useMemo(
    () =>
      activeCampaigns
        .filter((campaign) => !campaign.isPayoutCompleted)
        .reduce((sum, campaign) => sum + Number(campaign.sellerExpense ?? 0), 0),
    [activeCampaigns],
  );

interface CsvRow {
  "캠페인명": string;
  "브랜드": string;
  "셀러": string;
  "시작일": string;
  "종료일": string;
  "품목명": string;
  "품목 단가": number | string;
  "주문수량": number;
  "거래금액": number;
  "수수료율(%)": number | string;
  "판매수수료": number;
  "순마진액": number;
  "셀러정산액": number;
  "상태": string;
}

  const handleExportCsv = useCallback(() => {
    if (!filteredCampaigns || filteredCampaigns.length === 0) return;

    const rows: CsvRow[] = [];
    let totalOrderCount = 0;
    let totalActualSales = 0;
    let totalFeeAmount = 0;
    let totalNetMargin = 0;
    let totalSellerPayout = 0;

    filteredCampaigns.forEach((campaign) => {
      const deals = campaign.campaignDeals && campaign.campaignDeals.length > 0
        ? sortDealRowsByName(campaign.campaignDeals)
        : [
            {
              dealName: campaign.dealName,
              sellingPrice: campaign.deal?.sellingPrice ?? 0,
              quantity: campaign.quantity ?? 0,
              actualSales: campaign.actualSales ?? 0,
              feeRate: campaign.totalMarginRate,
            },
          ];

      deals.forEach((deal) => {
        const quantity = deal.quantity ?? 0;
        const actualSales = deal.actualSales ?? 0;
        const feeRate = deal.feeRate ?? 0;
        const feeAmount = actualSales * (feeRate / 100);

        // 마스터 마진율 기준 분배 계산
        const totalMarginRate = campaign.totalMarginRate;
        const sellerMarginRate = campaign.sellerMarginRate;
        const netMarginRate = campaign.netMarginRate;

        let netMarginAmount = 0;
        let sellerPayoutAmount = 0;

        if (totalMarginRate > 0) {
          netMarginAmount = feeAmount * (netMarginRate / totalMarginRate);
          sellerPayoutAmount = feeAmount * (sellerMarginRate / totalMarginRate);
        }

        // 반올림 처리
        const roundedFeeAmount = Math.round(feeAmount * 100) / 100;
        const roundedNetMargin = Math.round(netMarginAmount * 100) / 100;
        const roundedSellerPayout = Math.round(sellerPayoutAmount * 100) / 100;

        rows.push({
          "캠페인명": campaign.dealName,
          "브랜드": campaign.deal?.brandName ?? campaign.partnerName ?? "",
          "셀러": campaign.sellerName,
          "시작일": campaign.startDate,
          "종료일": campaign.endDate,
          "품목명": deal.dealName,
          "품목 단가": deal.sellingPrice ?? 0,
          "주문수량": quantity,
          "거래금액": actualSales,
          "수수료율(%)": feeRate,
          "판매수수료": roundedFeeAmount,
          "순마진액": roundedNetMargin,
          "셀러정산액": roundedSellerPayout,
          "상태": campaign.status === "COMPLETED" ? "정산 완료" : "정산 진행중",
        });

        totalOrderCount += quantity;
        totalActualSales += actualSales;
        totalFeeAmount += feeAmount;
        totalNetMargin += netMarginAmount;
        totalSellerPayout += sellerPayoutAmount;
      });
    });

    // 합계 행 추가
    rows.push({
      "캠페인명": "합계",
      "브랜드": "",
      "셀러": "",
      "시작일": "",
      "종료일": "",
      "품목명": "",
      "품목 단가": "",
      "주문수량": totalOrderCount,
      "거래금액": totalActualSales,
      "수수료율(%)": "",
      "판매수수료": Math.round(totalFeeAmount * 100) / 100,
      "순마진액": Math.round(totalNetMargin * 100) / 100,
      "셀러정산액": Math.round(totalSellerPayout * 100) / 100,
      "상태": "",
    });

    const csv = unparse(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `settlement-workspace-${selectedMonth}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [filteredCampaigns, selectedMonth]);

  const handleSelectCampaign = (campaign: CampaignRow) => {
    selectCampaign(campaign);
    setPanelOpen(true);
  };


  return isMobile ? (
    <MobileSettlementView
      reportData={reportData}
      campaigns={filteredCampaigns}
      selectedMonth={selectedMonth}
      viewType={viewType}
      selectedYear={selectedYear}
      localQuery={localQuery}
      setLocalQuery={setLocalQuery}
      commitSearch={debouncedSetFilter}
      onOpenCampaign={handleSelectCampaign}
      onRefresh={handleRefresh}
      loading={loading}
    />
  ) : (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-auto px-5 pb-5 pt-5 md:px-8">
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200/60 bg-white/80 px-4 py-2.5 text-xs text-slate-600 shadow-soft-sm backdrop-blur-sm">
        <div className="flex shrink-0 items-center gap-1.5">
          <TrendingUp className="size-3.5 text-muted-foreground" />
          <span className="font-medium">총 매출액:</span>
          <span className="font-semibold text-slate-800">{formatCurrency(reportData?.summary.totalRevenue)}</span>
        </div>
        <span className="hidden text-slate-200 md:inline">|</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Wallet className="size-3.5 text-muted-foreground" />
          <span className="font-medium">총 마진:</span>
          <span className="font-semibold text-slate-800">{formatCurrency(reportData?.summary.totalMargin)}</span>
        </div>
        <span className="hidden text-slate-200 md:inline">|</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Download className="size-3.5 text-muted-foreground" />
          <span className="font-medium">셀러 정산금:</span>
          <span className="font-semibold text-slate-800">{formatCurrency(reportData?.summary.totalSellerPayouts)}</span>
        </div>
        <span className="hidden text-slate-200 md:inline">|</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <MONEY_DIRECTION_ICON.in className="size-3.5 text-muted-foreground" />
          <span className="font-medium">입금 대기:</span>
          <span className="font-semibold text-slate-800">{formatCurrency(pendingDepositAmount)}</span>
        </div>
        <span className="hidden text-slate-200 md:inline">|</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <MONEY_DIRECTION_ICON.out className="size-3.5 text-muted-foreground" />
          <span className="font-medium">지급 대기:</span>
          <span className="font-semibold text-slate-800">{formatCurrency(pendingPayoutAmount)}</span>
        </div>
      </div>

      <div className="flex flex-col rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
        <div className="flex min-h-12 shrink-0 flex-col gap-3 border-b border-border/70 px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border border-border/80 bg-white p-1 shadow-soft-sm">
              <Button
                size="xs"
                variant={viewType === "month" ? "default" : "ghost"}
                onClick={() => setFilter("viewType", "month")}
                className="h-7 rounded-md px-2.5 text-xs"
              >
                월별
              </Button>
              <Button
                size="xs"
                variant={viewType === "year" ? "default" : "ghost"}
                onClick={() => setFilter("viewType", "year")}
                className="h-7 rounded-md px-2.5 text-xs"
              >
                연도별
              </Button>
            </div>

            <div className="flex h-9 min-w-48 items-center justify-between gap-2 rounded-lg border border-border/80 bg-white px-2 shadow-soft-sm">
              <button
                type="button"
                onClick={() => {
                  if (viewType === "year") {
                    setFilter("year", String(Number(selectedYear) - 1));
                  } else {
                    setFilter("month", getPreviousMonth(selectedMonth));
                  }
                }}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                aria-label="이전 기간"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <span className="min-w-24 text-center text-xs font-semibold text-foreground">
                {viewType === "year" ? `${selectedYear}년` : formatSettlementMonth(selectedMonth)}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (viewType === "year") {
                    setFilter("year", String(Number(selectedYear) + 1));
                  } else {
                    setFilter("month", getNextMonth(selectedMonth));
                  }
                }}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                aria-label="다음 기간"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <InputGroup className="h-9 w-full border border-slate-200 bg-white shadow-soft-sm sm:w-64">
              <InputGroupAddon>
                <Search className="size-4 text-muted-foreground" />
              </InputGroupAddon>
              <InputGroupInput
                type="text"
                placeholder="검색 (2글자 이상)"
                value={localQuery}
                onChange={(e) => {
                  const val = e.target.value;
                  setLocalQuery(val);
                  if (!isComposingRef.current) {
                    debouncedSetFilter(val);
                  }
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={(e) => {
                  isComposingRef.current = false;
                  const val = (e.target as HTMLInputElement).value;
                  debouncedSetFilter(val);
                }}
                className="h-full text-xs"
              />
            </InputGroup>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportCsv}
              disabled={!reportData || reportData.campaigns.length === 0}
            >
              <Download data-icon="inline-start" />
              CSV 내보내기
            </Button>
            <Button size="sm" variant="outline" onClick={() => setTaxFilingOpen(true)}>
              <FileText data-icon="inline-start" />
              세무 처리
              {taxPendingCount != null && taxPendingCount > 0 ? (
                <span className="ml-1.5 rounded-full bg-status-caution/15 px-1.5 py-0.5 text-[10px] font-semibold text-status-caution-text">
                  {taxPendingCount}
                  {taxNextDueDate ? ` · ${formatDDay(taxNextDueDate)}` : ""}
                </span>
              ) : null}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleRefresh()}
              disabled={loading}
            >
              <RefreshCw data-icon="inline-start" className={loading ? "animate-spin" : ""} />
              새로고침
            </Button>
          </div>
        </div>

        <section className="flex flex-col gap-4 px-5 py-4">
          <div className="flex items-center gap-2">
            <ChevronDown className="size-4 text-slate-500" />
            <h2 className="text-base font-semibold text-slate-800">정산 진행 중 캠페인</h2>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-500">
              {activeCampaigns.length}건
            </span>
          </div>
          <SettlementTable
            campaigns={activeCampaigns}
            onSelectCampaign={handleSelectCampaign}
            loading={loading}
            selectedIds={selectedIds}
            onToggleRow={handleToggleRow}
            onToggleAll={handleToggleAll}
          />
        </section>

        <div className="border-t border-slate-200" />

        <section className="flex flex-col gap-4 px-5 py-4">
          <div className="flex items-center gap-2">
            <ChevronDown className="size-4 text-slate-500" />
            <h2 className="text-base font-semibold text-slate-800">정산 완료 캠페인</h2>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-500">
              {completedCampaigns.length}건
            </span>
          </div>
          <SettlementCompletedTable
            campaigns={completedCampaigns}
            reportCampaigns={reportData?.campaigns ?? []}
            onSelectCampaign={handleSelectCampaign}
            loading={loading}
            selectedIds={selectedIds}
            onToggleRow={handleToggleRow}
            onToggleAll={handleToggleAll}
          />
        </section>
      </div>

      <SettlementSelectionBar selectedCampaigns={selectedCampaigns} summary={selectionSummary} />

      <CampaignSidePanel
        campaign={selectedCampaign}
        logs={initialData.apiCallLogs}
        assets={initialData.assets}
        storage={initialData.storage}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        onActualSalesSaved={(campaign) => {
          syncUpdatedCampaign(campaign);
          setData((prev) => ({
            ...prev,
            campaigns: prev.campaigns.map((item) => (item.id === campaign.id ? campaign : item)),
          }));
          void refreshReport();
        }}
        onCampaignUpdated={(campaign) => {
          syncUpdatedCampaign(campaign);
          setData((prev) => ({
            ...prev,
            campaigns: prev.campaigns.map((item) => (item.id === campaign.id ? campaign : item)),
          }));
          void refreshReport();
        }}
        title="정산관리 캠페인 상세 페이지"
        description="캠페인의 정산 및 재무 내역을 확인하고 설정을 관리합니다."
        settlementWorkspace
      />


      <TaxFilingDialog
        open={taxFilingOpen}
        onOpenChange={setTaxFilingOpen}
        month={taxFilingMonth}
        onMonthChange={setTaxFilingMonth}
      />
    </div>
  );
}
