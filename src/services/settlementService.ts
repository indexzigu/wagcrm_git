import { SettlementRepository } from "@/repositories/settlementRepository";
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
    if (allChecked && campaign.status === "SETTLEMENT_IN_PROGRESS") {
      await SettlementRepository.updateCampaignStatus(campaign.id, "COMPLETED");
      newCampaignStatus = "COMPLETED";
    }

    // If any unchecked AND campaign status is COMPLETED: revert to SETTLEMENT_IN_PROGRESS
    if (!allChecked && campaign.status === "COMPLETED") {
      await SettlementRepository.updateCampaignStatus(
        campaign.id,
        "SETTLEMENT_IN_PROGRESS"
      );
      newCampaignStatus = "SETTLEMENT_IN_PROGRESS";
    }

    return {
      item: updatedItem,
      campaignStatus: newCampaignStatus,
    };
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

  static async getSettlementReport(params: {
    month?: string | null;
    year?: string | null;
    teamId?: string | null;
    searchQuery?: string | null;
    statusFilter?: string | null;
  }) {
    const { month, year: yearParam, teamId, searchQuery, statusFilter } = params;

    let firstDay: Date;
    let lastDay: Date;
    let periodLabel = "";

    if (yearParam) {
      const year = parseInt(yearParam, 10);
      if (isNaN(year) || year < 1000 || year > 9999) {
        throw new Error("Invalid year format. Use YYYY.");
      }
      firstDay = new Date(year, 0, 1);
      lastDay = new Date(year, 11, 31, 23, 59, 59, 999);
      periodLabel = `${year}`;
    } else {
      const targetMonth = month || getCurrentMonth();
      if (!isValidMonthString(targetMonth)) {
        throw new Error("Invalid month format. Use YYYY-MM.");
      }
      const range = getMonthDateRange(targetMonth);
      firstDay = range.firstDay;
      lastDay = range.lastDay;
      periodLabel = targetMonth;
    }

    const where: Record<string, any> = {
      status: { in: parseSettlementStatusFilter(statusFilter || null) },
      endDate: {
        gte: firstDay,
        lte: lastDay,
      },
    };

    if (teamId) {
      where.assignedTo = teamId;
    }

    if (searchQuery) {
      where.OR = [
        { deal: { dealName: containsSearch(searchQuery) } },
        { seller: { name: containsSearch(searchQuery) } },
        { salesChannel: containsSearch(searchQuery) },
      ];
    }

    const campaigns = await SettlementRepository.findCampaignsForReport({
      where,
      include: {
        deal: true,
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
    }));

    return buildSettlementReportModel(mappedCampaigns, periodLabel);
  }
}
