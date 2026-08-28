import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import {
  updateOutreachSchema,
  isValidOutreachTransition,
} from "@/lib/validations/outreach";
import type { OutreachStatus } from "@/lib/validations/outreach";
import { parseMarginPolicy, getMarginRatesFromPolicy } from "@/lib/commission";
import { OUTREACH_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";
import { moveDriveShortcut, googleDriveProvider, GOOGLE_DRIVE_PROVIDER } from "@/lib/asset-storage";
import { buildNaverTrackingLink } from "@/lib/tracking";
import type { SnsType } from "@/lib/crm-types";

type Context = {
  params: Promise<{ id: string }>;
};

type OutreachTaskAsset = {
  id: string;
  driveShortcutId?: string | null;
  driveParentFolderId?: string | null;
};

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isSqliteRuntime() {
  return typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.startsWith("file:");
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  const body = await request.json();
  const parsed = updateOutreachSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { status: statusInput, autoCreateCampaign, dropReason } = parsed.data;
  const prisma = getPrisma();

  const task = await prisma.salesTask.findUnique({
    where: { id },
    include: {
      deal: true,
      seller: true,
    },
  });

  if (!task) {
    return NextResponse.json({ error: "해당 영업 테스크를 찾을 수 없습니다" }, { status: 404 });
  }

  const currentStatus = task.status as OutreachStatus;
  const newStatus = statusInput ?? currentStatus;
  if (statusInput !== undefined && !isValidOutreachTransition(currentStatus, newStatus)) {
    return NextResponse.json(
      { error: `허용되지 않는 상태 변경입니다: ${currentStatus} → ${newStatus}` },
      { status: 422 },
    );
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
    parsed.data.lastReminderAt != null ||
    parsed.data.nextReminderAt != null ||
    dropReason != null ||
    parsed.data.proposalMessage !== undefined ||
    parsed.data.negotiationMemo !== undefined ||
    parsed.data.testingMemo !== undefined ||
    parsed.data.sellerId !== undefined ||
    parsed.data.dealId !== undefined ||
    parsed.data.totalMarginRate !== undefined ||
    parsed.data.sellerMarginRate !== undefined;

  if (
    currentStatus === newStatus &&
    !shouldCreateCampaign &&
    !hasMetadataUpdate &&
    !isTransitioningToConvertedWithExistingCampaign
  ) {
    return NextResponse.json({
      id: task.id,
      dealId: task.dealId,
      sellerId: task.sellerId,
      status: task.status,
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
    });
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
        parsed.data.nextReminderAt != null
          ? new Date(parsed.data.nextReminderAt)
          : task.nextReminderAt ?? addDays(new Date(), 3);
    }
  }

  if (parsed.data.lastReminderAt) {
    updateData.lastReminderAt = new Date(parsed.data.lastReminderAt);
  }
  if (parsed.data.nextReminderAt) {
    updateData.nextReminderAt = new Date(parsed.data.nextReminderAt);
  }
  if (parsed.data.proposalMessage !== undefined) {
    updateData.proposalMessage = parsed.data.proposalMessage ?? null;
  }
  if (parsed.data.negotiationMemo !== undefined) {
    updateData.negotiationMemo = parsed.data.negotiationMemo ?? null;
  }
  if (parsed.data.testingMemo !== undefined) {
    updateData.testingMemo = parsed.data.testingMemo ?? null;
  }
  if (parsed.data.sellerId !== undefined) {
    updateData.sellerId = parsed.data.sellerId;
  }
  if (parsed.data.dealId !== undefined) {
    updateData.dealId = parsed.data.dealId;
  }
  if (parsed.data.totalMarginRate !== undefined) {
    updateData.totalMarginRate = parsed.data.totalMarginRate;
  }
  if (parsed.data.sellerMarginRate !== undefined) {
    updateData.sellerMarginRate = parsed.data.sellerMarginRate;
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
    const dealOptions = await prisma.deal.findMany({
      where: { parentDealId: task.dealId },
    });

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
    // 1. OUTREACH 테스크에 연결된 바로가기 Asset 레코드 조회
    const taskAssets: OutreachTaskAsset[] = isSqliteRuntime()
      ? await prisma.asset.findMany({
          where: { entityType: "OUTREACH", entityId: id, archivedAt: null },
          select: { id: true },
        })
      : await prisma.asset.findMany({
          where: { entityType: "OUTREACH", entityId: id, archivedAt: null },
          select: { id: true, driveShortcutId: true, driveParentFolderId: true },
        });

    if (taskAssets.length > 0) {
      // 2. 캠페인 드라이브 폴더 생성 (findOrCreate)
      let campaignFolderId: string | null = null;
      try {
        const driveIntegration = await prisma.storageIntegration.findUnique({
          where: { provider: GOOGLE_DRIVE_PROVIDER },
        });
        if (driveIntegration?.status === "CONNECTED" && driveIntegration.rootFolderId) {
          campaignFolderId = await googleDriveProvider.createFolderForEntity({
            entityType: "CAMPAIGN",
            entityId: campaign.id,
            entityName: `${task.deal.dealName} - ${task.seller.name}`,
            section: "PRODUCT_INTRO",
          });
        }
      } catch {
        // 드라이브 미연결 환경: DB 갱신만 진행
      }

      // 3. 바로가기 파일들 캠페인 폴더로 이동 (드라이브 연결된 경우만)
      if (campaignFolderId && !isSqliteRuntime()) {
        await Promise.all(
          taskAssets.map(async (asset) => {
            if (!asset.driveShortcutId) return;
            await moveDriveShortcut({
              shortcutFileId: asset.driveShortcutId,
              newParentFolderId: campaignFolderId!,
              oldParentFolderId: asset.driveParentFolderId ?? undefined,
            }).catch(() => undefined); // 실패 시 DB 갱신은 계속 진행
          }),
        );
      }

      // 4. DB Asset 레코드 일괄 업데이트 (entityType: CAMPAIGN, entityId: campaign.id)
      await prisma.asset.updateMany({
        where: { id: { in: taskAssets.map((a) => a.id) } },
        data: {
          entityType: "CAMPAIGN",
          entityId: campaign.id,
          ...(!isSqliteRuntime() && campaignFolderId ? { driveParentFolderId: campaignFolderId } : {}),
        },
      });
    }
    // ──────────────────────────────────────────────────────────────────────
  } else if (newStatus === "PENDING_APPROVAL" && autoCreateCampaign && task.linkedCampaignId) {
    // 이미 캠페인이 연결되어 있는 경우에도 CONVERTED 상태로 전환
    updateData.status = "CONVERTED";
  }

  const updated = await prisma.salesTask.update({
    where: { id },
    data: updateData,
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
        },
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

  return NextResponse.json({
    id: updated.id,
    dealId: updated.dealId,
    dealName: updated.deal.dealName,
    brandName: updated.deal.brandName ?? null,
    partnerName: updated.deal.partner?.name ?? null,
    sellerId: updated.sellerId,
    sellerName: updated.seller.alias || updated.seller.name,
    sellerFollowers: updated.seller.currentFollowers,
    sellerCategory: updated.seller.category ?? null,
    status: updated.status,
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
  });
}
