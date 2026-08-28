import { NextResponse } from "next/server";
import { recordCampaignActivity } from "@/lib/campaign-activity";
import { getStorageProvider, isSupabaseStorageConfigured } from "@/lib/asset-storage";
import { toCampaignRow } from "@/lib/campaign-row";
import { toAssetRow } from "@/lib/assets";
import type { AssetProvider } from "@/lib/crm-types";
import { getPrisma } from "@/lib/prisma";
import { ASSET_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";

type Context = {
  params: Promise<{ id: string }>;
};

async function loadCampaignRow(campaignId: string) {
  const campaign = await getPrisma().salesCampaign.findUnique({
    where: { id: campaignId },
    include: {
      deal: { include: { partner: true } },
      seller: {
        include: {
          agency: true,
          histories: { orderBy: { snapshotDate: "asc" }, take: 12 },
        },
      },
      activities: { orderBy: { createdAt: "desc" }, take: 12 },
      group: true,
    },
  });

  return campaign ? toCampaignRow(campaign) : null;
}

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const prisma = getPrisma();
  const asset = await prisma.asset.findUnique({ where: { id } });
  if (!asset) return NextResponse.json({ error: "Asset not found" }, { status: 404 });

  if (url.searchParams.get("download") === "1") {
    if (
      asset.provider === "SUPABASE" &&
      asset.storagePath &&
      !isSupabaseStorageConfigured()
    ) {
      return NextResponse.json({ downloadUrl: `/api/assets/${asset.id}/file` });
    }
    const provider = getStorageProvider(asset.provider as AssetProvider);
    const downloadUrl = await provider.getDownloadUrl(asset);
    return NextResponse.json({ downloadUrl });
  }

  return NextResponse.json({ asset: toAssetRow(asset) });
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  const prisma = getPrisma();
  
  let body: { fileName?: string; archived?: boolean } = {};
  try {
    body = await request.json();
  } catch {
    // Body 파싱 실패 시 기본값 처리 (기존 보관 기능 호환성 유지)
    body = { archived: true };
  }

  const updateData: any = {};
  if (body.fileName) {
    updateData.fileName = body.fileName;
  }
  
  // archived가 명시되었거나, fileName조차 없으면 기본 보관 처리
  if (body.archived === true || (body.fileName === undefined && body.archived !== false)) {
    updateData.archivedAt = new Date();
  } else if (body.archived === false) {
    updateData.archivedAt = null;
  }

  const asset = await prisma.asset.update({
    where: { id },
    data: updateData,
  });

  if (updateData.archivedAt) {
    if (asset.campaignId) {
      await recordCampaignActivity({
        campaignId: asset.campaignId,
        action: "ASSET_ARCHIVED",
        label: "Asset archived",
        details: `${asset.section} · ${asset.fileName}`,
      });
    }
  } else if (body.fileName) {
    if (asset.campaignId) {
      await recordCampaignActivity({
        campaignId: asset.campaignId,
        action: "ASSET_UPDATED",
        label: "Asset renamed",
        details: `${asset.section} · ${body.fileName}`,
      });
    }
  }

  const campaign = asset.campaignId ? await loadCampaignRow(asset.campaignId) : null;
  revalidateCrmTags(ASSET_INVALIDATION_TAGS);
  return NextResponse.json({ asset: toAssetRow(asset), campaign });
}

export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;
  const prisma = getPrisma();
  const asset = await prisma.asset.findUnique({ where: { id } });
  if (!asset) return NextResponse.json({ ok: true });

  const provider = getStorageProvider(asset.provider as AssetProvider);
  await provider.delete(asset);
  if (asset.campaignId) {
    await recordCampaignActivity({
      campaignId: asset.campaignId,
      action: "ASSET_DELETED",
      label: "Asset deleted",
      details: `${asset.section} · ${asset.fileName}`,
    });
  }
  await prisma.asset.delete({ where: { id } });
  const campaign = asset.campaignId ? await loadCampaignRow(asset.campaignId) : null;
  revalidateCrmTags(ASSET_INVALIDATION_TAGS);
  return NextResponse.json({ ok: true, campaign });
}
