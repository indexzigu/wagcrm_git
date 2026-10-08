import type { Prisma } from "@prisma/client";
import { SettlementRepository } from "@/repositories/settlementRepository";
import { getPrisma } from "@/lib/prisma";
import { lockCampaignGroup, propagateGroupStatus } from "@/services/campaignGroupService";
import { monthlySettlementService } from "@/services/monthlySettlementService";
import { containsSearch } from "@/lib/prisma-search";
import { DEFAULT_CHECKLIST_ITEMS } from "@/lib/validations/settlement";
import {
  buildSettlementReportModel,
  getCurrentMonth,
  getMonthDateRange,
  isValidMonthString,
  parseSettlementStatusFilter,
} from "@/lib/settlement-report";

export class SettlementService {
  static async getOrCreateChecklist(campaignId: string) {
    return SettlementRepository.upsertChecklist(
      campaignId,
      [...DEFAULT_CHECKLIST_ITEMS],
      {
        items: {
          orderBy: { sortOrder: "asc" },
        },
      }
    );
  }

  static async toggleChecklistItem(itemId: string, isChecked: boolean) {
    const item = await SettlementRepository.findChecklistItemById(itemId);
    if (!item) {
      throw new Error("체크리스트 항목을 찾을 수 없습니다");
    }

    const updatedItem = await SettlementRepository.updateChecklistItem(itemId, {
      isChecked,
      completedAt: isChecked ? new Date() : null,
    });

    const checklist = await SettlementRepository.findParentChecklistWithItems(
      item.checklistId
    );
    if (!checklist) {
      throw new Error("정산 체크리스트를 찾을 수 없습니다");
    }

    const { campaign, items } = checklist;

    // Guard: do not auto-transition if checklist has zero items
    if (items.length === 0) {
      return {
        item: updatedItem,
        campaignStatus: campaign.status,
      };
    }

    // Check if ALL items are checked (use updated value for the toggled item)
    const allChecked = items.every((i) =>
      i.id === itemId ? isChecked : i.isChecked
    );

    let newCampaignStatus = campaign.status;

    // If all checked AND campaign status is SETTLEMENT_IN_PROGRESS: auto-transition to COMPLETED
    // 월별 정산 완료 게이트(T-240)는 이 레거시 경로에도 건다 — 상태를 쓰는 모든 경로가 같은 답을 내야 한다.
    if (
      allChecked &&
      campaign.status === "SETTLEMENT_IN_PROGRESS" &&
      !(await monthlySettlementService.findCompletionBlocker(getPrisma(), campaign.id))
    ) {
      await SettlementService.transitionCampaignStatus(campaign, "COMPLETED");
      newCampaignStatus = "COMPLETED";
    }

    // If any unchecked AND campaign status is COMPLETED: revert to SETTLEMENT_IN_PROGRESS
    if (!allChecked && campaign.status === "COMPLETED") {
      await SettlementService.transitionCampaignStatus(campaign, "SETTLEMENT_IN_PROGRESS");
      newCampaignStatus = "SETTLEMENT_IN_PROGRESS";
    }

    return {
      item: updatedItem,
      campaignStatus: newCampaignStatus,
    };
  }

  /**
   * 체크리스트 완료/해제에 따른 status 전이 — 원본 쓰기와 그룹 상태 연동(`propagateGroupStatus`)을
   * 한 트랜잭션으로 묶는다(조합 캠페인의 상태 변경은 그룹 전체에 적용, 오너 확정 2026-10-05).
   * ⚠️ 이 경로(`/api/settlement-checklist/*`)는 앱 내 호출부가 0건인 레거시 표면이지만 status 를
   * 쓰는 API 라 같은 규칙을 지킨다.
   */
  private static async transitionCampaignStatus(
    campaign: { id: string; status: string; groupId: string | null },
    status: "COMPLETED" | "SETTLEMENT_IN_PROGRESS",
  ) {
    await getPrisma().$transaction(async (tx) => {
      // 🪤 락 순서: 원본 행을 쓰기 전에 그룹 락부터(`lockCampaignGroup` 주석).
      if (campaign.groupId) await lockCampaignGroup(tx, campaign.groupId);
      await tx.salesCampaign.update({ where: { id: campaign.id }, data: { status } });
      await propagateGroupStatus(tx, {
        originCampaignId: campaign.id,
        groupId: campaign.groupId,
        originPreviousStatus: campaign.status,
        status,
        actor: "SYSTEM",
        log: { kind: "activity-change" },
      });
    });
  }

  static async addChecklistItem(checklistId: string, label: string) {
    const checklist = await SettlementRepository.findParentChecklistWithItems(
      checklistId
    );
    if (!checklist) {
      throw new Error("정산 체크리스트를 찾을 수 없습니다");
    }

    // Get max sortOrder from existing items (or -1 if none)
    const maxSortOrder =
      checklist.items.length > 0
        ? Math.max(...checklist.items.map((i) => i.sortOrder))
        : -1;

    return SettlementRepository.createChecklistItem({
      checklistId,
      label,
      isChecked: false,
      sortOrder: maxSortOrder + 1,
    });
  }

  static async getSettlementReport(params: SettlementReportQuery) {
    const { where, periodLabel, firstDay, lastDay, yearMonthFilter } = buildSettlementReportQuery(params);

    const campaigns = await SettlementRepository.findCampaignsForReport({
      where,
      include: {
        // 월정산 거래처 여부(T-240) — 월별 줄을 리포트에 싣는 조건이다.
        deal: { include: { partner: { select: { monthlySettlement: true } } } },
        // 그 기간의 월별 줄만 — 같은 캠페인이 9월·10월 목록에 각자 자기 달 줄로 뜬다.
        monthlySettlements: { where: { yearMonth: yearMonthFilter } },
        seller: {
          include: {
            agency: true,
          },
        },
        // CG-2: 그룹 캠페인의 공유 일정(입금/지급 예정일)은 CampaignGroup이 소유 —
        // 리포트 빌더가 dual-read할 수 있도록 항상 group을 동반 조회한다.
        group: true,
      },
      orderBy: [{ updatedAt: "desc" }],
    });

    const mappedCampaigns = campaigns.map((c) => ({
      ...c,
      sellerCompanyBusinessNumber: c.seller?.agency?.businessNumber ?? null,
      monthlySettlementEnabled: Boolean(c.deal.partner?.monthlySettlement),
      // 종료일로 이 기간에 든 캠페인인가 — 아니면 월별 줄로만 들어온 것이라 캠페인 단위 금액
      // (마진·셀러 정산금)을 이 기간 합계에 더하지 않는다(같은 캠페인의 이중 집계 방지).
      includedByEndDate: c.endDate >= firstDay && c.endDate <= lastDay,
    }));

    return buildSettlementReportModel(mappedCampaigns, periodLabel);
  }
}

export type SettlementReportQuery = {
  month?: string | null;
  year?: string | null;
  teamId?: string | null;
  searchQuery?: string | null;
  statusFilter?: string | null;
};

/**
 * 정산 리포트의 조회 조건 SSOT — 화면(`getSettlementReport`)과 어시스턴트 도구
 * (`agent/tools/settlement-report.ts`)가 같은 캠페인 집합을 보게 한다(종전엔 두 곳에 손으로 복사돼 있었다).
 *
 * 기간 소속 = 종료일이 그 기간 **또는**(T-240) 월정산 거래처 캠페인이 그 기간에 월별 줄을 가짐.
 * 그래서 9/28~10/4 캠페인은 9월 목록(9월분 줄)과 10월 목록(종료일·10월분 줄)에 함께 뜬다.
 */
export function buildSettlementReportQuery(params: SettlementReportQuery) {
  const { month, year: yearParam, teamId, searchQuery, statusFilter } = params;

  let firstDay: Date;
  let lastDay: Date;
  let periodLabel: string;
  let yearMonthFilter: Prisma.StringFilter;

  if (yearParam) {
    const year = parseInt(yearParam, 10);
    if (isNaN(year) || year < 1000 || year > 9999) {
      throw new Error("Invalid year format. Use YYYY.");
    }
    firstDay = new Date(year, 0, 1);
    lastDay = new Date(year, 11, 31, 23, 59, 59, 999);
    periodLabel = `${year}`;
    yearMonthFilter = { startsWith: `${year}-` };
  } else {
    const targetMonth = month || getCurrentMonth();
    if (!isValidMonthString(targetMonth)) {
      throw new Error("Invalid month format. Use YYYY-MM.");
    }
    const range = getMonthDateRange(targetMonth);
    firstDay = range.firstDay;
    lastDay = range.lastDay;
    periodLabel = targetMonth;
    yearMonthFilter = { equals: targetMonth };
  }

  const and: Prisma.SalesCampaignWhereInput[] = [
    {
      OR: [
        { endDate: { gte: firstDay, lte: lastDay } },
        {
          deal: { partner: { monthlySettlement: true } },
          monthlySettlements: { some: { yearMonth: yearMonthFilter } },
        },
      ],
    },
  ];
  if (searchQuery) {
    and.push({
      OR: [
        { deal: { dealName: containsSearch(searchQuery) } },
        { seller: { name: containsSearch(searchQuery) } },
        { salesChannel: containsSearch(searchQuery) },
      ],
    });
  }

  const where: Prisma.SalesCampaignWhereInput = {
    status: { in: parseSettlementStatusFilter(statusFilter || null) },
    AND: and,
    ...(teamId ? { assignedTo: teamId } : {}),
  };

  return { where, periodLabel, firstDay, lastDay, yearMonthFilter };
}
