"use client";

import { FileSpreadsheet, Loader2 } from "lucide-react";
import { DataEmpty } from "@/components/ui/empty";
import { formatDate } from "@/lib/format";
import type { CampaignRow } from "@/lib/crm-types";
import type { SettlementReportCampaign } from "@/lib/settlement-report";
import { isIndividualSeller } from "@/lib/seller-tax-utils";
import { resolveProfitTone, PROFIT_TONE_TEXT_DENSE } from "@/lib/profit-tone";
import {
  settlementCheckboxCol,
  settlementFluidCol,
  settlementTableStyle,
} from "./settlement-table-layout";

interface SettlementCompletedTableProps {
  campaigns: CampaignRow[];
  reportCampaigns: SettlementReportCampaign[];
  onSelectCampaign: (campaign: CampaignRow) => void;
  loading?: boolean;
  /**
   * 선택 상태는 **페이지가 소유한다** — 진행 중 표와 하나의 하단 액션 바를 공유하기
   * 위해서다(표마다 자기 바를 띄우면 `position: fixed` 라 서로 겹친다). 그래서 두 표는
   * 같은 3개 prop 을 받는다(`SettlementTable` 과 동일 계약).
   */
  selectedIds: string[];
  onToggleRow: (campaignId: string, checked: boolean) => void;
  onToggleAll: (campaignIds: string[], checked: boolean) => void;
}

const formatCurrency = (val: number | null | undefined) => {
  if (val == null) return "-";
  return Math.round(Number(val)).toLocaleString();
};

export function SettlementCompletedTable({
  campaigns,
  reportCampaigns,
  onSelectCampaign,
  loading = false,
  selectedIds,
  onToggleRow,
  onToggleAll,
}: SettlementCompletedTableProps) {
  // reportCampaigns를 ID로 빠르게 매핑하기 위한 맵
  const reportMap = new Map(reportCampaigns.map((rc) => [rc.id, rc]));
  const isAllSelected =
    campaigns.length > 0 && campaigns.every((campaign) => selectedIds.includes(campaign.id));

  return (
    <div className="relative flex flex-col min-h-[150px]">
      {loading ? (
        <div className="flex flex-1 flex-col items-center justify-center py-16 text-center bg-white/40 rounded-xl border border-border/50">
          <Loader2 className="size-8 animate-spin text-primary/60 mb-3" />
          <h4 className="text-sm font-semibold text-slate-800">데이터를 불러오는 중입니다</h4>
          <p className="mt-1 text-xs text-muted-foreground max-w-xs">잠시만 기다려주세요.</p>
        </div>
      ) : campaigns.length === 0 ? (
        <DataEmpty
          icon={FileSpreadsheet}
          title="정산 완료된 캠페인이 없습니다."
          description="현재 정산 완료 상태의 캠페인 내역이 없습니다."
          className="flex-1 justify-center py-16"
        />
      ) : (
        <div className="crm-horizontal-accent crm-horizontal-accent-settlement overflow-hidden rounded-xl border border-border/60 bg-white/50 shadow-soft-sm">
          <div className="overflow-x-auto pt-1">
            {/* 폭 규약의 정본은 `settlement-table-layout.ts` 다 — 진행 표와 **같은 모듈**을 써야
                체크박스 폭·캠페인명 시작 좌표·오른쪽 끝이 어긋나지 않는다.
                🪤 종전 `max-w-[1060px]` 상한은 제거됐다(오너 요청 2026-08-28) — 근거는 그 모듈 주석. */}
            <table
              className="w-full border-collapse text-left text-xs table-fixed"
              style={settlementTableStyle}
            >
              <colgroup>
                {/* ⛔ **모든 열에 폭을 지정하지 말 것** — `table-fixed w-full` 은 지정폭 합이
                    컨테이너보다 작으면 남는 폭을 **전 열에 비례 배분**한다. 그래서 48px 체크박스
                    열이 54px 로 부풀어 진행 목록과 캠페인명 시작 좌표가 6px 어긋났다(오너 신고
                    2026-08-25, 실측 1124px 컨테이너에서 48→54 · 캠페인명 left 166 vs 172).
                    🪤 **종전 이 자리의 「진행 목록은 총폭이 컨테이너를 넘어 스크롤 = 선언폭 유지」는
                    이제 틀렸다** — 2026-08-26 아이콘화로 그 표도 994px 로 줄어 같은 비례 배분에
                    걸렸고(1600px 에서 체크박스 63.59px 실측), 그래서 그쪽도 캠페인명을 폭 미지정
                    흡수 열로 바꿨다. **두 표 모두 흡수 열 규약을 쓴다** — 한쪽만 되돌리면 갈린다.
                    처방은 **흡수 열 하나를 폭 미지정으로 두는 것**이다 — CSS 표 사양상 폭이
                    지정되지 않은 열이 하나라도 있으면 남는 폭은 그 열로만 가고 나머지는 선언폭을
                    정확히 유지한다. 흡수 열로 캠페인명을 고른 이유: 좌측 정렬 + truncate 라
                    넓어지면 이름이 더 보이고(현재 잘리는 표다) 좁아져도 레이아웃이 깨지지 않는다. */}
                <col style={settlementCheckboxCol} />
                <col />
                <col style={settlementFluidCol(80)} />
                <col style={settlementFluidCol(80)} />
                {/* 금액 8열은 **여백을 `px-4`→`px-2`(32→16px)로 줄이고** 선언폭을 실측 필요폭에
                    맞췄다(오너 승인 2026-08-26). 거기서 나온 폭이 전부 흡수 열인 캠페인명으로 간다.
                    ⚠️ **여백과 선언폭은 한 벌이다** — 여백만 되돌리면 금액이 잘리고, 폭만 되돌리면
                    캠페인명이 다시 좁아진다. 아래 `px-2` 와 짝으로만 수정할 것.

                    왜 필요했나(실측, 1280px 뷰포트 · 프로덕션 38행): 이 표는 11열이 고정폭이고
                    캠페인명 1열만 남는 폭을 흡수하는 구조라, 사이드바 기본이 펼침으로 바뀌며
                    (#455) 생긴 **112px 손실이 캠페인명 한 열에 100% 몰렸다**(236→124px). 그 결과
                    캠페인명이 38행 중 36행, 기간 줄이 38행 전부 잘렸다(종료일이 통째로 소실).
                    ⛔ 「판매 대행비」·「영업이익율」은 헤더가 내용보다 길어 **헤더 필요폭이 하한**이다
                    (여백 16px 기준 각 70 · 67px) — 이 둘을 내용 기준으로 더 줄이면 헤더가 두 줄로
                    감긴다(흡수 열 도입 때 실제로 겪었다). 아래 값은 그 하한에 여유를 얹은 것이다. */}
                <col style={settlementFluidCol(80)} />
                <col style={settlementFluidCol(76)} />
                <col style={settlementFluidCol(76)} />
                <col style={settlementFluidCol(68)} />
                <col style={settlementFluidCol(64)} />
                <col style={settlementFluidCol(58)} />
                <col style={settlementFluidCol(70)} />
                <col style={settlementFluidCol(74)} />
              </colgroup>
              <thead>
                <tr className="border-b border-border/70 bg-slate-50/70 font-semibold text-muted-foreground select-none">
                  <th className="px-4 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={isAllSelected}
                      onChange={(event) =>
                        onToggleAll(campaigns.map((campaign) => campaign.id), event.target.checked)
                      }
                      className="size-4 cursor-pointer rounded border-slate-300 text-primary focus:ring-focus-ring"
                      aria-label="모든 정산 완료 항목 선택"
                    />
                  </th>
                  <th className="px-4 py-3">캠페인명</th>
                  <th className="px-4 py-3">브랜드</th>
                  <th className="px-4 py-3">거래처</th>
                  <th className="px-2 py-3 text-right">총 거래액</th>
                  <th className="px-2 py-3 text-right">영업 수익</th>
                  <th className="px-2 py-3 text-right">판매 대행비</th>
                  <th className="px-2 py-3 text-right">운영비</th>
                  <th className="px-2 py-3 text-right">공제세액</th>
                  <th className="px-2 py-3 text-right">기타비용</th>
                  <th className="px-2 py-3 text-right">영업이익율</th>
                  <th className="px-2 py-3 text-right">영업이익</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {campaigns.map((campaign) => {
                  const reportCampaign = reportMap.get(campaign.id);
                  const profitTone = resolveProfitTone(campaign.operatingProfit);
                  const isSelected = selectedIds.includes(campaign.id);

                  return (
                    <tr
                      key={campaign.id}
                      className={`transition-colors ${
                        isSelected
                          ? "bg-primary/5 hover:bg-primary/5"
                          : isIndividualSeller(campaign)
                            ? "bg-amber-50/40 hover:bg-amber-50/60"
                            : "hover:bg-slate-50/50"
                      }`}
                    >
                      {/* 선택 — 진행 중 표와 같은 체크박스 계약(라벨만 다르다) */}
                      <td className="px-4 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(event) => onToggleRow(campaign.id, event.target.checked)}
                          className="size-4 cursor-pointer rounded border-slate-300 text-primary focus:ring-focus-ring"
                          aria-label={`${campaign.campaignName ?? "캠페인"} 선택`}
                        />
                      </td>

                      {/* 캠페인명 */}
                      <td className="px-4 py-3 min-w-0">
                        <div className="flex flex-col gap-1 min-w-0">
                          <button
                            type="button"
                            onClick={() => onSelectCampaign(campaign)}
                            className="max-w-full text-left hover:underline truncate"
                          >
                            <span className="font-medium text-slate-800">
                              {campaign.dealName} - {campaign.sellerName}
                            </span>
                            {campaign.roundNumber ? (
                              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                                ({campaign.roundNumber}차)
                              </span>
                            ) : null}
                          </button>
                          <span className="text-[10px] text-muted-foreground truncate">
                            {formatDate(campaign.startDate)} ~ {formatDate(campaign.endDate)}
                          </span>
                        </div>
                      </td>

                      {/* 브랜드 */}
                      <td className="px-4 py-3 min-w-0">
                        <span className="block truncate text-[11px] font-medium text-slate-700">
                          {campaign.deal?.brandName || "-"}
                        </span>
                      </td>

                      {/* 거래처 */}
                      <td className="px-4 py-3 min-w-0">
                        <span className="block truncate text-[11px] font-medium text-slate-700">
                          {campaign.partnerName || "-"}
                        </span>
                      </td>

                      {/* 실매출 */}
                      <td className="px-2 py-3 text-right font-medium text-slate-500 tabular-nums">
                        {formatCurrency(campaign.actualSales)}
                      </td>

                      {/* 수수료 매출 (총 수수료 매출) */}
                      <td className="px-2 py-3 text-right font-medium text-slate-600 tabular-nums">
                        {reportCampaign ? formatCurrency(reportCampaign.totalMarginAmount) : "-"}
                      </td>

                      {/* 셀러 수수료액 — 실제로 나가는 돈이라 자금 방향축(값은 rose-600 과 동일) */}
                      <td className="px-2 py-3 text-right font-medium text-money-out tabular-nums">
                        {reportCampaign ? formatCurrency(reportCampaign.sellerPayoutAmount) : "-"}
                      </td>

                      {/* 운영비 */}
                      <td className="px-2 py-3 text-right font-medium text-slate-500 tabular-nums">
                        {reportCampaign ? formatCurrency(reportCampaign.operatingExpense) : "-"}
                      </td>

                      {/* 공제세액 */}
                      <td className="px-2 py-3 text-right font-medium text-slate-500 tabular-nums">
                        {reportCampaign ? formatCurrency(reportCampaign.taxExpense) : "-"}
                      </td>

                      {/* 기타비용 */}
                      <td className="px-2 py-3 text-right font-medium text-slate-500 tabular-nums">
                        {reportCampaign ? formatCurrency(reportCampaign.miscExpense) : "-"}
                      </td>

                      {/* 영업이익율 */}
                      <td className="px-2 py-3 text-right font-medium text-slate-500 tabular-nums">
                        {campaign.operatingProfit != null && campaign.actualSales && campaign.actualSales > 0
                          ? `${(Number(campaign.operatingProfit) / Number(campaign.actualSales) * 100).toFixed(1)}%`
                          : "-"}
                      </td>

                      {/* 영업이익 — 부호를 따른다(profit-tone SSOT). 이전엔 무조건 emerald-600 이라
                          적자 캠페인도 초록이었고, 그 값(#059669)은 흰 배경 3.77:1 로 AA 미달이었다. */}
                      <td className={`px-2 py-3 text-right font-medium tabular-nums ${(profitTone && PROFIT_TONE_TEXT_DENSE[profitTone]) || ""}`}>
                        {formatCurrency(campaign.operatingProfit)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
