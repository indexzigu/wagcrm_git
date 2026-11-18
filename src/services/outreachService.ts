import { OutreachRepository } from "@/repositories/outreachRepository";
import { Prisma } from "@prisma/client";
import type { OutreachStatus } from "@/lib/validations/outreach";
import { OUTREACH_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export class OutreachService {
  static async getOutreaches(dealId?: string | null, sellerId?: string | null) {
    const where: Prisma.SalesTaskWhereInput = {};
    if (dealId) where.dealId = dealId;
    if (sellerId) where.sellerId = sellerId;

    const tasks = await OutreachRepository.findMany({
      where,
      include: {
        deal: {
          select: {
            dealName: true,
            brandName: true,
            partner: {
              select: {
                name: true,
              },
            },
          },
        },
        seller: {
          select: {
            name: true,
            alias: true,
            currentFollowers: true,
            category: true,
            snsType: true,
            snsHandle: true,
          },
        },
      },
      orderBy: [{ nextReminderAt: "asc" }, { createdAt: "desc" }],
    });

    const linkedCampaignIds = tasks
      .map((item) => item.linkedCampaignId)
      .filter((value): value is string => Boolean(value));

    const linkedCampaigns =
      linkedCampaignIds.length > 0
        ? await OutreachRepository.findLinkedCampaigns(linkedCampaignIds)
        : [];

    const linkedCampaignMap = new Map(
      linkedCampaigns.map((campaign) => [
        campaign.id,
        campaign.campaignName ?? `${campaign.deal.dealName} - ${campaign.seller.alias || campaign.seller.name}`,
      ]),
    );

    return tasks.map((task) => ({
      id: task.id,
      dealId: task.dealId,
      dealName: task.deal.dealName,
      brandName: task.deal.brandName ?? null,
      partnerName: task.deal.partner?.name ?? null,
      sellerId: task.sellerId,
      sellerName: task.seller.alias || task.seller.name,
      sellerFollowers: task.seller.currentFollowers,
      sellerCategory: task.seller.category ?? null,
      snsType: task.seller.snsType ?? null,
      snsHandle: task.seller.snsHandle ?? null,
      status: task.status as OutreachStatus,
      contactChannel: task.contactChannel ?? "DM",
      proposalMessage: task.proposalMessage ?? null,
      negotiationMemo: task.negotiationMemo ?? null,
      testingMemo: task.testingMemo ?? null,
      proposedAt: task.proposalSentAt.toISOString(),
      acceptedAt: task.confirmedAt?.toISOString() ?? null,
      respondedAt: task.respondedAt?.toISOString() ?? null,
      lastReminderAt: task.lastReminderAt?.toISOString() ?? null,
      nextReminderAt: task.nextReminderAt?.toISOString() ?? null,
      droppedAt: task.droppedAt?.toISOString() ?? null,
      dropReason: task.dropReason ?? null,
      totalMarginRate: Number(task.totalMarginRate?.toString() ?? 0),
      sellerMarginRate: Number(task.sellerMarginRate?.toString() ?? 0),
      linkedCampaignId: task.linkedCampaignId,
      linkedCampaignName: task.linkedCampaignId
        ? linkedCampaignMap.get(task.linkedCampaignId) ?? null
        : null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    }));
  }

  static async createOutreach(data: {
    dealId: string;
    sellerId: string;
    contactChannel: string;
    proposalMessage?: string | null;
  }) {
    const { dealId, sellerId, contactChannel, proposalMessage } = data;

    const deal = await OutreachRepository.findDealById(dealId);
    if (!deal) {
      throw new Error("해당 판매 조건을 찾을 수 없습니다");
    }

    const seller = await OutreachRepository.findSellerById(sellerId);
    if (!seller) {
      throw new Error("해당 셀러를 찾을 수 없습니다");
    }

    const existingTask = await OutreachRepository.findExistingTask(dealId, sellerId);
    if (existingTask) {
      throw new Error("이미 해당 셀러에게 영업 테스크를 생성했습니다");
    }

    const proposalSentAt = new Date();
    const task = await OutreachRepository.create(
      {
        dealId,
        sellerId,
        status: "PROPOSED",
        contactChannel,
        proposalMessage: proposalMessage ?? null,
        proposalSentAt,
        nextReminderAt: addDays(proposalSentAt, 3),
      },
      {
        deal: {
          select: {
            dealName: true,
            brandName: true,
            partner: { select: { name: true } },
          },
        },
        seller: {
          select: {
            name: true,
            alias: true,
            currentFollowers: true,
            category: true,
            snsType: true,
            snsHandle: true,
          },
        },
      }
    );

    revalidateCrmTags(OUTREACH_INVALIDATION_TAGS);

    return {
      id: task.id,
      dealId: task.dealId,
      dealName: task.deal.dealName,
      brandName: task.deal.brandName ?? null,
      partnerName: task.deal.partner?.name ?? null,
      sellerId: task.sellerId,
      sellerName: task.seller.alias || task.seller.name,
      sellerFollowers: task.seller.currentFollowers,
      sellerCategory: task.seller.category ?? null,
      snsType: task.seller.snsType ?? null,
      snsHandle: task.seller.snsHandle ?? null,
      status: task.status as OutreachStatus,
      contactChannel: task.contactChannel ?? "DM",
      proposalMessage: task.proposalMessage ?? null,
      negotiationMemo: task.negotiationMemo ?? null,
      testingMemo: task.testingMemo ?? null,
      proposedAt: task.proposalSentAt.toISOString(),
      acceptedAt: task.confirmedAt?.toISOString() ?? null,
      respondedAt: task.respondedAt?.toISOString() ?? null,
      lastReminderAt: task.lastReminderAt?.toISOString() ?? null,
      nextReminderAt: task.nextReminderAt?.toISOString() ?? null,
      droppedAt: task.droppedAt?.toISOString() ?? null,
      dropReason: task.dropReason ?? null,
      totalMarginRate: Number(task.totalMarginRate?.toString() ?? 0),
      sellerMarginRate: Number(task.sellerMarginRate?.toString() ?? 0),
      linkedCampaignId: task.linkedCampaignId,
      linkedCampaignName: null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    };
  }
}
