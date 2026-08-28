import { OutreachRepository } from "@/repositories/outreachRepository";
import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  isValidOutreachTransition,
  type OutreachStatus,
} from "@/lib/validations/outreach";
import { parseMarginPolicy, getMarginRatesFromPolicy } from "@/lib/commission";
import { OUTREACH_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";
import { moveDriveShortcut, googleDriveProvider, GOOGLE_DRIVE_PROVIDER } from "@/lib/asset-storage";
import { buildNaverTrackingLink } from "@/lib/tracking";
import type { SnsType } from "@/lib/crm-types";

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
      throw new Error("해당 딜을 찾을 수 없습니다");
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

  static async updateOutreach(
    id: string,
    data: {
      status?: OutreachStatus;
      autoCreateCampaign?: boolean;
      dropReason?: string | null;
      lastReminderAt?: string | null;
      nextReminderAt?: string | null;
      proposalMessage?: string | null;
      negotiationMemo?: string | null;
      testingMemo?: string | null;
      sellerId?: string;
      dealId?: string;
      totalMarginRate?: number;
      sellerMarginRate?: number;
    }
  ) {
    const { status: statusInput, autoCreateCampaign, dropReason } = data;
    const prisma = getPrisma();

    const task = await OutreachRepository.findById(id, {
      deal: true,
      seller: true,
    });

    if (!task) {
      throw new Error("해당 영업 테스크를 찾을 수 없습니다");
    }

    const currentStatus = task.status as OutreachStatus;
    const newStatus = statusInput ?? currentStatus;
    if (statusInput !== undefined && !isValidOutreachTransition(currentStatus, newStatus)) {
      throw new Error(`허용되지 않는 상태 변경입니다: ${currentStatus} → ${newStatus}`);
    }

    const shouldCreateCampaign =
      newStatus === "PENDING_APPROVAL" &&
      autoCreateCampaign &&
      !task.linkedCampaignId;
    const isTransitioningToConvertedWithExistingCampaign =
      newStatus === "PENDING_APPROVAL" &&
      autoCreateCampaign &&
      !!task.linkedCampaignId;
    const hasMetadataUpdate =
      data.lastReminderAt != null ||
      data.nextReminderAt != null ||
      dropReason != null ||
      data.proposalMessage !== undefined ||
      data.negotiationMemo !== undefined ||
      data.testingMemo !== undefined ||
      data.sellerId !== undefined ||
      data.dealId !== undefined ||
      data.totalMarginRate !== undefined ||
      data.sellerMarginRate !== undefined;

    if (
      currentStatus === newStatus &&
      !shouldCreateCampaign &&
      !hasMetadataUpdate &&
      !isTransitioningToConvertedWithExistingCampaign
    ) {
      return {
        id: task.id,
        dealId: task.dealId,
        sellerId: task.sellerId,
        status: task.status as OutreachStatus,
        proposedAt: task.proposalSentAt.toISOString(),
        acceptedAt: task.confirmedAt?.toISOString() ?? null,
        respondedAt: task.respondedAt?.toISOString() ?? null,
        lastReminderAt: task.lastReminderAt?.toISOString() ?? null,
        nextReminderAt: task.nextReminderAt?.toISOString() ?? null,
        droppedAt: task.droppedAt?.toISOString() ?? null,
        dropReason: task.dropReason ?? null,
        proposalMessage: task.proposalMessage ?? null,
        negotiationMemo: task.negotiationMemo ?? null,
        testingMemo: task.testingMemo ?? null,
        totalMarginRate: Number(task.totalMarginRate?.toString() ?? 0),
        sellerMarginRate: Number(task.sellerMarginRate?.toString() ?? 0),
        linkedCampaignId: task.linkedCampaignId,
        linkedCampaignName: null,
        updatedAt: task.updatedAt.toISOString(),
      };
    }

    const updateData: Record<string, unknown> = { status: newStatus };

    if (statusInput !== undefined) {
      if (newStatus === "NEGOTIATION" || newStatus === "TESTING") {
        updateData.respondedAt = task.respondedAt ?? new Date();
        updateData.nextReminderAt = null;
      }

      if (newStatus === "PENDING_APPROVAL") {
        updateData.respondedAt = task.respondedAt ?? new Date();
        updateData.confirmedAt = task.confirmedAt ?? new Date();
        updateData.nextReminderAt = null;
        updateData.dropReason = null;
      }

      if (newStatus === "DROPPED") {
        updateData.droppedAt = new Date();
        updateData.dropReason = dropReason ?? task.dropReason ?? "수동 종료";
        updateData.nextReminderAt = null;
      }

      if (newStatus === "PROPOSED") {
        updateData.nextReminderAt =
          data.nextReminderAt != null
            ? new Date(data.nextReminderAt)
            : task.nextReminderAt ?? addDays(new Date(), 3);
      }
    }

    if (data.lastReminderAt) {
      updateData.lastReminderAt = new Date(data.lastReminderAt);
    }
    if (data.nextReminderAt) {
      updateData.nextReminderAt = new Date(data.nextReminderAt);
    }
    if (data.proposalMessage !== undefined) {
      updateData.proposalMessage = data.proposalMessage ?? null;
    }
    if (data.negotiationMemo !== undefined) {
      updateData.negotiationMemo = data.negotiationMemo ?? null;
    }
    if (data.testingMemo !== undefined) {
      updateData.testingMemo = data.testingMemo ?? null;
    }
    if (data.sellerId !== undefined) {
      updateData.sellerId = data.sellerId;
    }
    if (data.dealId !== undefined) {
      updateData.dealId = data.dealId;
    }
    if (data.totalMarginRate !== undefined) {
      updateData.totalMarginRate = data.totalMarginRate;
    }
    if (data.sellerMarginRate !== undefined) {
      updateData.sellerMarginRate = data.sellerMarginRate;
    }

    if (shouldCreateCampaign) {
      const taskTotalRate = Number(task.totalMarginRate?.toString() ?? 0);
      const taskSellerRate = Number(task.sellerMarginRate?.toString() ?? 0);
      const hasNegotiatedRates = taskTotalRate > 0 || taskSellerRate > 0;
      let rates = {
        totalMarginRate: taskTotalRate,
        sellerMarginRate: taskSellerRate,
        netMarginRate: taskTotalRate - taskSellerRate,
      };

      if (!hasNegotiatedRates) {
        const policy = parseMarginPolicy(task.deal.baseMarginPolicy);
        const policyRates = (policy ? getMarginRatesFromPolicy(policy, "OWN_MALL") : null) ?? {
          totalMarginRate: 0,
          sellerMarginRate: 0,
          netMarginRate: 0,
        };
        rates = {
          totalMarginRate: policyRates.totalMarginRate,
          sellerMarginRate: policyRates.sellerMarginRate,
          netMarginRate: policyRates.netMarginRate,
        };
      }

      const now = new Date();
      const campaign = await prisma.salesCampaign.create({
        data: {
          dealId: task.dealId,
          sellerId: task.sellerId,
          status: "PREPARATION",
          salesChannel: "OWN_MALL",
          totalMarginRate: rates.totalMarginRate,
          sellerMarginRate: rates.sellerMarginRate,
          netMarginRate: rates.netMarginRate,
          baseNaverLink: "",
          generatedTrackingLink: "pending",
          startDate: now,
          endDate: now,
        },
      });

      const generatedTrackingLink = buildNaverTrackingLink({
        baseUrl: "",
        snsType: task.seller.snsType as SnsType,
        sellerId: task.seller.id,
        campaignId: campaign.id,
      });

      await prisma.salesCampaign.update({
        where: { id: campaign.id },
        data: { generatedTrackingLink },
      });

      // 테스크의 품목별 협의 요율 JSON 데이터 파싱
      let negotiatedRates: Record<string, number> = {};
      if (task.negotiationMemo) {
        try {
          const parsedMemo = JSON.parse(task.negotiationMemo);
          if (parsedMemo && typeof parsedMemo === "object" && parsedMemo.negotiatedFeeRates) {
            negotiatedRates = parsedMemo.negotiatedFeeRates;
          }
        } catch {
          // 일반 텍스트 메모인 경우 에러 무시
        }
      }

      // 연결된 메인 딜의 하위 옵션 딜(품목) 목록 조회
      const dealOptions = await OutreachRepository.findDealOptions(task.dealId);

      if (dealOptions.length > 0) {
        // 옵션 품목들이 존재할 때 각각 CampaignDeal 생성
        for (const opt of dealOptions) {
          const customRate = negotiatedRates[opt.id] !== undefined ? negotiatedRates[opt.id] : null;
          await prisma.campaignDeal.create({
            data: {
              campaignId: campaign.id,
              dealId: opt.id,
              quantity: 0,
              actualSales: 0,
              feeRate: customRate !== null
                ? customRate
                : (opt.totalCommissionRate ? Number(opt.totalCommissionRate.toString()) : rates.sellerMarginRate),
              costPrice: opt.costPrice ? Number(opt.costPrice.toString()) : 0,
              sellingPrice: opt.sellingPrice ? Number(opt.sellingPrice.toString()) : 0,
            },
          });
        }

        // 캠페인 마스터의 하위 품목 개수(itemCount) 갱신
        await prisma.salesCampaign.update({
          where: { id: campaign.id },
          data: { itemCount: dealOptions.length },
        });
      } else {
        // 하위 옵션 딜이 없을 시 메인 딜 자체를 1개 생성하여 데이터 정합성 무결성 확보
        await prisma.campaignDeal.create({
          data: {
            campaignId: campaign.id,
            dealId: task.dealId,
            quantity: 0,
            actualSales: 0,
            feeRate: rates.sellerMarginRate,
            costPrice: task.deal.costPrice ? Number(task.deal.costPrice.toString()) : 0,
            sellingPrice: task.deal.sellingPrice ? Number(task.deal.sellingPrice.toString()) : 0,
          },
        });
        await prisma.salesCampaign.update({
          where: { id: campaign.id },
          data: { itemCount: 1 },
        });
      }

      updateData.linkedCampaignId = campaign.id;
      // 캠페인 생성(승인) 완료 → 자동으로 CONVERTED 상태로 전환
      updateData.status = "CONVERTED";

      // ── 드라이브 바로가기 이관 및 DB Asset 릴레이션 갱신 ──────────────────
      const taskAssets = await OutreachRepository.findTaskAssets(id);

      if (taskAssets.length > 0) {
        let campaignFolderId: string | null = null;
        try {
          const driveIntegration = await OutreachRepository.findStorageIntegration(GOOGLE_DRIVE_PROVIDER);
          if (driveIntegration?.status === "CONNECTED" && driveIntegration.rootFolderId) {
            campaignFolderId = await googleDriveProvider.createFolderForEntity({
              entityType: "CAMPAIGN",
              entityId: campaign.id,
              entityName: `${task.deal.dealName} - ${task.seller.name}`,
              section: "PRODUCT_INTRO",
            });
          }
        } catch {
          // 드라이브 미연결 환경
        }

        if (campaignFolderId) {
          await Promise.all(
            taskAssets.map(async (asset) => {
              if (!asset.driveShortcutId) return;
              await moveDriveShortcut({
                shortcutFileId: asset.driveShortcutId,
                newParentFolderId: campaignFolderId!,
                oldParentFolderId: asset.driveParentFolderId ?? undefined,
              }).catch(() => undefined);
            })
          );
        }

        await OutreachRepository.updateManyAssets(
          taskAssets.map((a) => a.id),
          {
            entityType: "CAMPAIGN",
            entityId: campaign.id,
            ...(campaignFolderId ? { driveParentFolderId: campaignFolderId } : {}),
          }
        );
      }
    } else if (newStatus === "PENDING_APPROVAL" && autoCreateCampaign && task.linkedCampaignId) {
      updateData.status = "CONVERTED";
    }

    const updated = await OutreachRepository.update(id, updateData, {
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
        },
      },
    });

    const linkedCampaign = updated.linkedCampaignId
      ? await prisma.salesCampaign.findUnique({
          where: { id: updated.linkedCampaignId },
          select: {
            campaignName: true,
            deal: { select: { dealName: true } },
            seller: { select: { name: true, alias: true } },
          },
        })
      : null;

    revalidateCrmTags(OUTREACH_INVALIDATION_TAGS);

    return {
      id: updated.id,
      dealId: updated.dealId,
      dealName: updated.deal.dealName,
      brandName: updated.deal.brandName ?? null,
      partnerName: updated.deal.partner?.name ?? null,
      sellerId: updated.sellerId,
      sellerName: updated.seller.alias || updated.seller.name,
      sellerFollowers: updated.seller.currentFollowers,
      sellerCategory: updated.seller.category ?? null,
      status: updated.status as OutreachStatus,
      proposedAt: updated.proposalSentAt.toISOString(),
      acceptedAt: updated.confirmedAt?.toISOString() ?? null,
      respondedAt: updated.respondedAt?.toISOString() ?? null,
      lastReminderAt: updated.lastReminderAt?.toISOString() ?? null,
      nextReminderAt: updated.nextReminderAt?.toISOString() ?? null,
      droppedAt: updated.droppedAt?.toISOString() ?? null,
      dropReason: updated.dropReason ?? null,
      proposalMessage: updated.proposalMessage ?? null,
      negotiationMemo: updated.negotiationMemo ?? null,
      testingMemo: updated.testingMemo ?? null,
      totalMarginRate: Number(updated.totalMarginRate?.toString() ?? 0),
      sellerMarginRate: Number(updated.sellerMarginRate?.toString() ?? 0),
      linkedCampaignId: updated.linkedCampaignId,
      linkedCampaignName: linkedCampaign
        ? linkedCampaign.campaignName ??
          `${linkedCampaign.deal.dealName} - ${linkedCampaign.seller.alias || linkedCampaign.seller.name}`
        : null,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }
}
