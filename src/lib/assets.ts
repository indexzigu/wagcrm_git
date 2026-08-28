import type { Asset } from "@prisma/client";
import type { AssetEntityType, AssetRow } from "./crm-types";
import { getPrisma } from "./prisma";

export function toAssetRow(asset: Asset): AssetRow {
  return {
    id: asset.id,
    provider: asset.provider as AssetRow["provider"],
    section: asset.section as AssetRow["section"],
    entityType: asset.entityType as AssetRow["entityType"],
    entityId: asset.entityId,
    campaignId: asset.campaignId,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    storagePath: asset.storagePath,
    externalFileId: asset.externalFileId,
    externalUrl: asset.externalUrl,
    thumbnailUrl: asset.thumbnailUrl,
    notes: asset.notes,
    likeCount: asset.likeCount,
    commentCount: asset.commentCount,
    likesHidden: asset.likesHidden,
    engagementSyncedAt: asset.engagementSyncedAt?.toISOString() ?? null,
    mediaType: asset.mediaType,
    videoUrl: asset.videoUrl,
    postedAt: asset.postedAt?.toISOString() ?? null,
    archivedAt: asset.archivedAt?.toISOString() ?? null,
    createdAt: asset.createdAt.toISOString(),
  };
}

export async function resolveAssetEntity(input: {
  entityType: AssetEntityType;
  entityId: string;
}) {
  const prisma = getPrisma();
  if (input.entityType === "CAMPAIGN") {
    const campaign = await prisma.salesCampaign.findUnique({
      where: { id: input.entityId },
      include: { deal: true },
    });
    return {
      entityName: campaign?.deal.dealName ?? input.entityId,
      campaignId: campaign?.id ?? input.entityId,
    };
  }
  if (input.entityType === "DEAL") {
    const deal = await prisma.deal.findUnique({ where: { id: input.entityId } });
    return { entityName: deal?.dealName ?? input.entityId, campaignId: null };
  }
  if (input.entityType === "PARTNER") {
    const partner = await prisma.partner.findUnique({ where: { id: input.entityId } });
    return { entityName: partner?.name ?? input.entityId, campaignId: null };
  }
  if (input.entityType === "OUTREACH") {
    const task = await prisma.salesTask.findUnique({
      where: { id: input.entityId },
      include: { deal: true, seller: true },
    });
    const name = task
      ? `${task.deal.dealName}-${task.seller.alias || task.seller.name}`
      : input.entityId;
    return { entityName: name, campaignId: task?.linkedCampaignId ?? null };
  }
  const seller = await prisma.seller.findUnique({ where: { id: input.entityId } });
  return { entityName: seller?.name ?? input.entityId, campaignId: null };
}

export async function estimateSupabaseAssetBytes() {
  const prisma = getPrisma();
  const result = await prisma.asset.aggregate({
    where: { provider: "SUPABASE", archivedAt: null },
    _sum: { sizeBytes: true },
  });
  return result._sum.sizeBytes ?? 0;
}
