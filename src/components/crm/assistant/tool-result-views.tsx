import type { FC } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
// ⚠️ 타입은 오직 런타임-프리 모듈(data-types.ts)에서만 import한다(청사진 §2-1/§3-1,
// 번들 안전 — plan-critic #1). tool 파일(settlement-report.ts 등)에서 직접 import하지
// 않는다 — 실수로 값-import가 섞이면 prisma가 클라이언트 번들에 들어가는 위험 구조다.
import type {
  GetSettlementReportData,
  SettlementStateLabel,
  SearchDealsData,
  GetPipelineStatusData,
  GetCampaignFinancialsData,
  GetOrderSnapshotData,
} from "@/lib/agent/tools/data-types";

/**
 * tool-result-views — READ 도구 5종 v1 리치 렌더 (청사진 §2-2, §3-#5).
 *
 * message-list.tsx가 각 toolCall(ok && data 존재)에 대해 `TOOL_RESULT_RENDERERS[toolName]`을
 * 찾아 EvidenceTable 위에 렌더한다. data는 unknown으로 받아 각 뷰에서 최소한의 런타임
 * 가드(필수 필드 존재 체크)만 하고, 실패 시 null을 반환해 조용히 스킵한다(리치 렌더는
 * 부가 기능이지 근거 표시의 필수 경로가 아니다 — EvidenceTable은 항상 별도로 유지됨).
 *
 * 청사진 §7-2/§7-3: 정산 리포트 캠페인 행 액션(퀵액션 칩). onQuickAction은 레지스트리
 * 전 뷰가 공통으로 받는 선택적 prop이지만, 실제로 버튼을 그리는 것은 SettlementReportView
 * 뿐이다 — 다른 4개 뷰는 prop만 통과시키고 무동작(presentational 순수성 유지).
 */

type ToolResultViewProps = { data: unknown; onQuickAction?: (text: string) => void };

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

// ---- get_settlement_report ----

const SETTLEMENT_STATE_LABELS: Record<SettlementStateLabel, string> = {
  pending: "예정",
  confirmed: "확정",
  paid: "지급완료",
};

function isGetSettlementReportData(data: unknown): data is GetSettlementReportData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.summary === "object" &&
    d.summary !== null &&
    Array.isArray(d.campaigns) &&
    typeof d.stateCounts === "object" &&
    d.stateCounts !== null
  );
}

// 청사진 §7-2: 정산 상태별 행 액션 라벨 + 전송 문장에 쓰는 한글 처리 라벨.
const SETTLEMENT_ACTION_LABELS: Partial<Record<SettlementStateLabel, string>> = {
  pending: "입금확정",
  confirmed: "지급완료",
};

const SettlementReportView: FC<ToolResultViewProps> = ({ data, onQuickAction }) => {
  if (!isGetSettlementReportData(data)) return null;
  const { summary, campaigns, stateCounts } = data;

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="grid grid-cols-4 gap-2 text-xs">
        <div>
          <p className="text-muted-foreground">총매출</p>
          <p className="font-semibold text-foreground">{formatNumber(summary.totalRevenue)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">총마진</p>
          <p className="font-semibold text-foreground">{formatNumber(summary.totalMargin)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">셀러지급</p>
          <p className="font-semibold text-foreground">{formatNumber(summary.totalSellerPayouts)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">건수</p>
          <p className="font-semibold text-foreground">{summary.campaignCount}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(Object.entries(stateCounts) as [SettlementStateLabel, number][]).map(([state, count]) => (
          <Badge key={state} variant="outline">
            {SETTLEMENT_STATE_LABELS[state] ?? state} {count}
          </Badge>
        ))}
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">딜명</th>
              <th className="px-2 py-1.5 font-medium">셀러</th>
              <th className="px-2 py-1.5 font-medium">매출</th>
              <th className="px-2 py-1.5 font-medium">정산액</th>
              <th className="px-2 py-1.5 font-medium">상태</th>
              {onQuickAction && <th className="px-2 py-1.5 font-medium">액션</th>}
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => {
              // 청사진 §7-2: pending→입금확정 기안, confirmed→지급완료 기안, paid→버튼 없음.
              const actionLabel = SETTLEMENT_ACTION_LABELS[c.state];
              return (
                <tr key={c.id} className="border-t border-border">
                  <td className="px-2 py-1.5">{c.dealName}</td>
                  <td className="px-2 py-1.5">{c.sellerName}</td>
                  <td className="px-2 py-1.5">{formatNumber(c.actualSales)}</td>
                  <td className="px-2 py-1.5">{formatNumber(c.sellerPayoutAmount)}</td>
                  <td className="px-2 py-1.5">
                    <Badge variant="outline">{SETTLEMENT_STATE_LABELS[c.state] ?? c.state}</Badge>
                  </td>
                  {onQuickAction && (
                    <td className="px-2 py-1.5">
                      {actionLabel && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={() =>
                            onQuickAction(
                              `"${c.dealName}" 캠페인(ID: ${c.id})의 정산 ${actionLabel} 처리를 기안해줘`
                            )
                          }
                        >
                          {actionLabel} 기안
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ---- search_deals ----

function isSearchDealsData(data: unknown): data is SearchDealsData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.items);
}

// onQuickAction은 시그니처 통일을 위해 받기만 하고 사용하지 않는다(청사진 §7-3 —
// SettlementReportView만 행 액션 구현, 나머지는 prop 통과만).
const SearchDealsView: FC<ToolResultViewProps> = ({ data }) => {
  if (!isSearchDealsData(data)) return null;
  const { items, count, truncated } = data;

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{count}건</span>
        {truncated && <span>상위 20건까지 표시됩니다</span>}
      </div>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-xs">
            <span className="font-medium text-foreground">{item.dealName}</span>
            <Badge variant="outline">{item.status}</Badge>
            {item.brandName && <span className="text-muted-foreground">{item.brandName}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
};

// ---- get_pipeline_status ----

function isGetPipelineStatusData(data: unknown): data is GetPipelineStatusData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.statusCounts);
}

const PipelineStatusView: FC<ToolResultViewProps> = ({ data }) => {
  if (!isGetPipelineStatusData(data)) return null;
  const { statusCounts, totalCount, campaigns } = data;

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {statusCounts.map((sc) => (
          <Badge key={sc.status} variant="outline">
            {sc.status} {sc.count}
          </Badge>
        ))}
        <span className="ml-auto text-muted-foreground">총 {totalCount}건</span>
      </div>
      {campaigns && campaigns.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {campaigns.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-xs">
              <span className="font-medium text-foreground">{c.dealName}</span>
              <span className="text-muted-foreground">{c.sellerName}</span>
              <Badge variant="outline">{c.status}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ---- get_campaign_financials ----

function isGetCampaignFinancialsData(data: unknown): data is GetCampaignFinancialsData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return typeof d.derived === "object" && d.derived !== null;
}

const CampaignFinancialsView: FC<ToolResultViewProps> = ({ data }) => {
  if (!isGetCampaignFinancialsData(data)) return null;
  const { actualSales, derived, isDepositReceived, isPayoutCompleted } = data;

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="grid grid-cols-5 gap-2 text-xs">
        <div>
          <p className="text-muted-foreground">실매출</p>
          <p className="font-semibold text-foreground">{formatNumber(actualSales)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">정산매출</p>
          <p className="font-semibold text-foreground">{formatNumber(derived.settlementSales)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">셀러지급</p>
          <p className="font-semibold text-foreground">{formatNumber(derived.sellerExpense)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">세금</p>
          <p className="font-semibold text-foreground">{formatNumber(derived.taxExpense)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">영업이익</p>
          <p className="font-semibold text-foreground">{formatNumber(derived.operatingProfit)}</p>
        </div>
      </div>

      {/* 완료 = `status-success`, 대기 = `outline`(무채). ⛔ 완료를 `status-active`(네이비)로
          되돌리지 말 것 — 근거 정본은 proposal-card `StatusChip` 주석. 이 두 플래그는 아래
          캡션이 방어하는 파생 계산값이 아니라 **DB 에 기록된 확정 플래그**라(모바일 상세
          시트·정산 칸과 같은 값) 완료색을 쓰는 것이 과잉 확신이 아니다.
          ⛔ 대기 쪽을 `status-pending` 으로 올리지 말 것(P8 §2 — 아직 안 일어난 일은 무채). */}
      <div className="flex flex-wrap gap-1.5">
        <Badge variant={isDepositReceived ? "status-success" : "outline"}>
          입금 {isDepositReceived ? "완료" : "대기"}
        </Badge>
        <Badge variant={isPayoutCompleted ? "status-success" : "outline"}>
          지급 {isPayoutCompleted ? "완료" : "대기"}
        </Badge>
      </div>

      {/* 3중 방어 유지 — 이 화면 값은 계산된 파생치이며 정산 확정치가 아니다(청사진 §2-2). */}
      <p className="text-xs text-muted-foreground">파생 계산값, 정산 확정치 아님</p>
    </div>
  );
};

// ---- get_order_snapshot ----

function isGetOrderSnapshotData(data: unknown): data is GetOrderSnapshotData {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return typeof d.totals === "object" && d.totals !== null;
}

const OrderSnapshotView: FC<ToolResultViewProps> = ({ data }) => {
  if (!isGetOrderSnapshotData(data)) return null;
  const { days, totals } = data;

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="grid grid-cols-4 gap-2 text-xs">
        <div>
          <p className="text-muted-foreground">주문</p>
          <p className="font-semibold text-foreground">{totals.ordersCount}</p>
        </div>
        <div>
          <p className="text-muted-foreground">신규</p>
          <p className="font-semibold text-foreground">{totals.newOrdersCount}</p>
        </div>
        <div>
          <p className="text-muted-foreground">준비</p>
          <p className="font-semibold text-foreground">{totals.preparingCount}</p>
        </div>
        <div>
          <p className="text-muted-foreground">배송중</p>
          <p className="font-semibold text-foreground">{totals.deliveringCount}</p>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">일자</th>
              <th className="px-2 py-1.5 font-medium">주문</th>
              <th className="px-2 py-1.5 font-medium">신규</th>
              <th className="px-2 py-1.5 font-medium">준비</th>
              <th className="px-2 py-1.5 font-medium">배송중</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.snapshotDate} className="border-t border-border">
                <td className="px-2 py-1.5">{d.snapshotDate}</td>
                <td className="px-2 py-1.5">{d.ordersCount}</td>
                <td className="px-2 py-1.5">{d.newOrdersCount}</td>
                <td className="px-2 py-1.5">{d.preparingCount}</td>
                <td className="px-2 py-1.5">{d.deliveringCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/** message-list.tsx가 toolName으로 조회하는 리치 렌더 레지스트리 (청사진 §2-1/§7-2). */
export const TOOL_RESULT_RENDERERS: Record<string, FC<ToolResultViewProps>> = {
  get_settlement_report: SettlementReportView,
  search_deals: SearchDealsView,
  get_pipeline_status: PipelineStatusView,
  get_campaign_financials: CampaignFinancialsView,
  get_order_snapshot: OrderSnapshotView,
};
