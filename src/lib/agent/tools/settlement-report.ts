import { z } from "zod";
import { SettlementService } from "@/services/settlementService";
import { SettlementRepository } from "@/repositories/settlementRepository";
import { containsSearch } from "@/lib/prisma-search";
import {
  getCurrentMonth,
  getMonthDateRange,
  isValidMonthString,
  parseSettlementStatusFilter,
} from "@/lib/settlement-report";
import type { AgentTool, ToolResult } from "./types";
import { missingParam, notFound, ok, queryFailed } from "./types";
// deriveSettlementState/SettlementStateLabel은 상태기계 모듈로 이동됐다(청사진 §2, plan-critic #5).
// write-executor(confirm_settlement)와 동일한 판정 함수를 공유하기 위함. 기존 import 경로
// (`../settlement-report`)를 유지하도록 여기서 re-export한다.
import { deriveSettlementState } from "@/lib/settlement-status";
// Data 타입(+구성 타입)은 런타임-프리 모듈로 이동됐다(청사진 §2-1/§3-1, 번들 안전).
// 기존 import 경로(`./settlement-report`) 호환을 위해 여기서 type re-export한다 —
// 런타임 코드는 변경 없음(diff는 타입 이동뿐).
import type { SettlementStateLabel, GetSettlementReportData, SettlementCampaignWithState } from "./data-types";

export { deriveSettlementState };
export type { SettlementStateLabel, GetSettlementReportData, SettlementCampaignWithState };

const inputSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional()
    .describe("조회할 월 (YYYY-MM). year와 동시 지정 시 month 우선. 미지정 시 이번 달."),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .describe("조회할 연도 전체 (YYYY). month가 없을 때만 사용."),
  sellerName: z.string().optional().describe("셀러 이름으로 필터링 (부분 일치)"),
  statusFilter: z
    .enum(["SETTLEMENT_IN_PROGRESS", "COMPLETED", "ALL"])
    .optional()
    .describe("정산 상태 필터. 미지정 시 진행중+완료 전체."),
});

export type GetSettlementReportInput = z.infer<typeof inputSchema>;

/**
 * SettlementService.getSettlementReport()로 화면과 동일한 요약 수치를 얻고,
 * 동일한 where 조건으로 SettlementRepository.findCampaignsForReport를 다시 호출해
 * isDepositReceived/isPayoutCompleted/depositReceivedAt/payoutCompletedAt을 병합한다.
 * (SettlementService는 이 필드들을 반환하지 않으므로 — settlementService.ts는 소유권 밖이라 수정 불가)
 */
async function execute(input: GetSettlementReportInput): Promise<ToolResult<GetSettlementReportData>> {
  const { month, year, sellerName, statusFilter } = input;

  if (month && !isValidMonthString(month)) {
    return missingParam("month 형식이 잘못되었습니다. YYYY-MM 형식이어야 합니다.", { month });
  }
  if (year && !/^\d{4}$/.test(year)) {
    return missingParam("year 형식이 잘못되었습니다. YYYY 형식이어야 합니다.", { year });
  }

  try {
    const report = await SettlementService.getSettlementReport({
      month: month ?? null,
      year: year ?? null,
      teamId: null,
      searchQuery: sellerName ?? null,
      statusFilter: statusFilter ?? null,
    });

    if (report.campaigns.length === 0) {
      return notFound(
        "해당 기간/조건에 정산 캠페인이 없습니다.",
        ["SalesCampaign", "SettlementChecklist"],
        { month, year, sellerName, statusFilter }
      );
    }

    // 화면(getSettlementReport)과 동일한 필터로 원본 캠페인을 다시 조회해 상태 플래그를 얻는다.
    let firstDay: Date;
    let lastDay: Date;
    let periodLabel: string;
    if (year) {
      const y = parseInt(year, 10);
      firstDay = new Date(y, 0, 1);
      lastDay = new Date(y, 11, 31, 23, 59, 59, 999);
      periodLabel = `${y}`;
    } else {
      const targetMonth = month || getCurrentMonth();
      const range = getMonthDateRange(targetMonth);
      firstDay = range.firstDay;
      lastDay = range.lastDay;
      periodLabel = targetMonth;
    }

    const where: Record<string, unknown> = {
      status: { in: parseSettlementStatusFilter(statusFilter ?? null) },
      endDate: { gte: firstDay, lte: lastDay },
    };
    if (sellerName) {
      where.OR = [
        { deal: { dealName: containsSearch(sellerName) } },
        { seller: { name: containsSearch(sellerName) } },
        { salesChannel: containsSearch(sellerName) },
      ];
    }

    const rawCampaigns = await SettlementRepository.findCampaignsForReport({
      where,
      // CG-2: 그룹 캠페인의 입금/지급 상태는 CampaignGroup 소유 — dual-read용 group 동반 조회.
      include: { deal: true, seller: true, group: true },
    });

    const rawById = new Map(rawCampaigns.map((c) => [c.id, c]));

    const stateCounts: Record<SettlementStateLabel, number> = {
      pending: 0,
      confirmed: 0,
      paid: 0,
    };

    // m5: report.campaigns(SettlementService 결과)와 rawCampaigns(findCampaignsForReport)를
    // id로 병합하는데, 두 조회의 where 조건이 어긋나면 raw가 undefined인 채로 fallback(false)
    // 처리되어 상태 라벨이 조용히 틀릴 수 있다. miss 발생 시 로그를 남기고 evidence로 노출한다.
    let mergeMisses = 0;

    const campaigns: SettlementCampaignWithState[] = report.campaigns.map((c) => {
      const raw = rawById.get(c.id);
      if (!raw) {
        mergeMisses += 1;
      }
      // CG-2 dual-read: 그룹 캠페인은 그룹 값이 정본(그룹 값 null/false여도 캠페인 잔존값 무시).
      const isDepositReceived = raw?.group
        ? raw.group.isDepositReceived
        : raw?.isDepositReceived ?? false;
      const isPayoutCompleted = raw?.group
        ? raw.group.isPayoutCompleted
        : raw?.isPayoutCompleted ?? false;
      // 자사몰의 중간 단계(공급사 지급 완료)를 읽으려면 이 플래그도 같은 dual-read 로
      // 넘겨야 한다 — 빠지면 상태가 셀러 지급 전까지 영원히 pending 이다.
      const isSupplierPayoutCompleted = raw?.group
        ? raw.group.isSupplierPayoutCompleted
        : raw?.isSupplierPayoutCompleted ?? false;
      const state = deriveSettlementState({
        // 병합 miss(아래 `mergeMisses`)면 채널을 모른다 — 슬롯 판정표의 기본 갈래
        // (셀러몰 = 입금+지급)로 떨어지며, 이는 종전 채널 무관 동작과 같다.
        salesChannel: raw?.salesChannel ?? "",
        isDepositReceived,
        isPayoutCompleted,
        isSupplierPayoutCompleted,
      });
      stateCounts[state] += 1;

      return {
        id: c.id,
        dealName: c.dealName,
        brandName: c.brandName,
        sellerName: c.sellerName,
        actualSales: c.actualSales,
        sellerPayoutAmount: c.sellerPayoutAmount,
        netMarginAmount: c.netMarginAmount,
        state,
        isDepositReceived,
        isPayoutCompleted,
        depositReceivedAt: (raw?.group ? raw.group.depositReceivedAt : raw?.depositReceivedAt)?.toISOString() ?? null,
        payoutCompletedAt: (raw?.group ? raw.group.payoutCompletedAt : raw?.payoutCompletedAt)?.toISOString() ?? null,
      };
    });

    if (mergeMisses > 0) {
      console.warn(
        `[get_settlement_report] rawCampaigns 병합 miss ${mergeMisses}건 — isDepositReceived/isPayoutCompleted가 fallback(false)으로 채워졌습니다.`,
        { month, year, sellerName, statusFilter, mergeMisses }
      );
    }

    return ok(
      {
        period: periodLabel,
        summary: report.summary,
        campaigns,
        stateCounts,
      },
      ["SalesCampaign", "SettlementChecklist", "Deal", "Seller"],
      { month, year, sellerName, statusFilter, mergeMisses }
    );
  } catch (err) {
    return queryFailed(
      err instanceof Error ? err.message : "정산 리포트 조회 중 오류가 발생했습니다.",
      ["SalesCampaign"],
      { month, year, sellerName, statusFilter }
    );
  }
}

export const getSettlementReportTool: AgentTool<GetSettlementReportInput, GetSettlementReportData> = {
  name: "get_settlement_report",
  description:
    "정산 리포트를 조회합니다. 월(month) 또는 연도(year) 단위로 캠페인별 정산 예정(pending)/확정(confirmed)/지급완료(paid) 상태와 매출/정산금액을 반환합니다. 셀러 이름으로 필터링할 수 있습니다.",
  inputSchema,
  execute,
};
