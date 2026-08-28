import { NextResponse } from "next/server";
import { z } from "zod";
import { recordCampaignActivity } from "@/lib/campaign-activity";
import {
  chooseAssetProvider,
  getGoogleDriveConnectionStatus,
  getStorageProvider,
  SUPABASE_DIRECT_UPLOAD_LIMIT_BYTES,
} from "@/lib/asset-storage";
import { estimateSupabaseAssetBytes, resolveAssetEntity, toAssetRow } from "@/lib/assets";
import { toCampaignRow } from "@/lib/campaign-row";
import type { AssetEntityType, AssetProvider, AssetSection } from "@/lib/crm-types";
import { getPrisma } from "@/lib/prisma";
import { isUniqueViolation } from "@/lib/prisma-errors";
import { ASSET_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";

const assetQuerySchema = z.object({
  entityType: z.enum(["DEAL", "CAMPAIGN", "PARTNER", "SELLER", "OUTREACH"]).optional(),
  entityId: z.string().optional(),
  section: z
    .enum([
      "PRODUCT_INTRO",
      "PRICE_TABLE",
      "GROUP_BUY_PRICE",
      "DETAIL_PAGE",
      "SNS_CREATIVE",
      "CONTRACT_SETTLEMENT",
      "SAMPLE_REVIEW",
      "ORDER_TEMPLATE",
      "ETC",
    ])
    .optional(),
  includeArchived: z.coerce.boolean().default(false),
  search: z.string().optional(),
});

const assetFormSchema = z.object({
  entityType: z.enum(["DEAL", "CAMPAIGN", "PARTNER", "SELLER", "OUTREACH"]),
  entityId: z.string().min(1),
  section: z.enum([
    "PRODUCT_INTRO",
    "PRICE_TABLE",
    "GROUP_BUY_PRICE",
    "DETAIL_PAGE",
    "SNS_CREATIVE",
    "CONTRACT_SETTLEMENT",
    "SAMPLE_REVIEW",
    "ORDER_TEMPLATE",
    "ETC",
  ]),
  notes: z.string().optional(),
  provider: z
    .enum(["SUPABASE", "GOOGLE_DRIVE", "EXTERNAL_LINK", "CLOUDFLARE_R2"])
    .optional(),
  externalUrl: z
    .string()
    .url()
    .refine((v) => /^https?:\/\//i.test(v), "http/https URL만 허용됩니다")
    .optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.coerce.number().nonnegative().optional(),
  longTermArchive: z.coerce.boolean().default(false),
  // 게시물 표현 자산 시딩(추천 원클릭 등록 등 메타를 이미 아는 호출자용) — 외부링크 자산에만 의미.
  // 크론(campaign-engagement-collector)이 이후 같은 규약으로 덮어써 신선도를 유지한다.
  mediaType: z.enum(["image", "video", "reel", "carousel", "unknown"]).optional(),
  videoUrl: z
    .string()
    .url()
    .refine((v) => /^https?:\/\//i.test(v), "http/https URL만 허용됩니다")
    .optional(),
  postedAt: z.coerce.date().optional(),
  // 썸네일 시딩은 재호스팅된(수명 있는) URL만 — 만료성 IG CDN(fbcdn 등)은 거부해
  // enrich 크론의 재호스팅 경로(thumbnailUrl null 대상)로 흘려보낸다.
  thumbnailUrl: z
    .string()
    .url()
    .refine(
      (v) => !/(cdninstagram\.com|fbcdn\.net)/i.test(v),
      "만료성 인스타 CDN 썸네일은 시딩할 수 없습니다",
    )
    .optional(),
});

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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = assetQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const prisma = getPrisma();
  const assets = await prisma.asset.findMany({
    where: {
      ...(parsed.data.entityType ? { entityType: parsed.data.entityType } : {}),
      ...(parsed.data.entityId ? { entityId: parsed.data.entityId } : {}),
      ...(parsed.data.section ? { section: parsed.data.section } : {}),
      ...(parsed.data.includeArchived ? {} : { archivedAt: null }),
      ...(parsed.data.search
        ? {
            OR: [
              { fileName: { contains: parsed.data.search } },
              { notes: { contains: parsed.data.search } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ assets: assets.map(toAssetRow) });
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const parsed = assetFormSchema.safeParse({
    entityType: formData.get("entityType"),
    entityId: formData.get("entityId"),
    section: formData.get("section"),
    notes: formData.get("notes") || undefined,
    provider: formData.get("provider") || undefined,
    externalUrl: formData.get("externalUrl") || undefined,
    fileName: formData.get("fileName") || undefined,
    mimeType: formData.get("mimeType") || undefined,
    sizeBytes: formData.get("sizeBytes") || undefined,
    longTermArchive: formData.get("longTermArchive") || false,
    mediaType: formData.get("mediaType") || undefined,
    videoUrl: formData.get("videoUrl") || undefined,
    postedAt: formData.get("postedAt") || undefined,
    thumbnailUrl: formData.get("thumbnailUrl") || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const file = formData.get("file");
  const { entityName, campaignId } = await resolveAssetEntity({
    entityType: parsed.data.entityType as AssetEntityType,
    entityId: parsed.data.entityId,
  });

  if (parsed.data.externalUrl && !(file instanceof File)) {
    const provider: AssetProvider =
      parsed.data.provider === "GOOGLE_DRIVE" ? "GOOGLE_DRIVE" : "EXTERNAL_LINK";
    let asset;
    try {
      asset = await getPrisma().asset.create({
        data: {
          provider,
          section: parsed.data.section,
          entityType: parsed.data.entityType,
          entityId: parsed.data.entityId,
          campaignId,
          fileName: parsed.data.fileName ?? parsed.data.externalUrl,
          mimeType: parsed.data.mimeType,
          sizeBytes: parsed.data.sizeBytes ?? 0,
          externalUrl: parsed.data.externalUrl,
          notes: parsed.data.notes,
          mediaType: parsed.data.mediaType,
          videoUrl: parsed.data.videoUrl,
          postedAt: parsed.data.postedAt,
          thumbnailUrl: parsed.data.thumbnailUrl,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // H1 부분 유니크 인덱스(Asset_entity_externalUrl_active_key) 위반: 동시 요청의 진 쪽.
      // 기존 활성 Asset을 재조회해 성공(200)으로 수렴한다 — 프론트(R1 handleAddLink,
      // R5 addSellerPost)는 asset 필드만 있으면 정상 경로로 처리하므로 응답 형태 호환.
      // 생성된 것이 없으므로 활동 기록·캐시 무효화는 생략한다(campaign도 변화 없음 → null).
      const existing = await getPrisma().asset.findFirst({
        where: {
          entityType: parsed.data.entityType,
          entityId: parsed.data.entityId,
          externalUrl: parsed.data.externalUrl,
          archivedAt: null,
        },
      });
      if (!existing) throw error; // 승자가 그새 보관된 극단 케이스 — 원 에러를 삼키지 않는다
      return NextResponse.json({
        asset: toAssetRow(existing),
        campaign: null,
        alreadyExists: true,
      });
    }
    if (campaignId) {
      await recordCampaignActivity({
        campaignId,
        action: "ASSET_LINKED",
        label: "Asset linked",
        details: `${parsed.data.section} · ${asset.fileName}`,
      });
    }
    const campaign = campaignId ? await loadCampaignRow(campaignId) : null;
    revalidateCrmTags(ASSET_INVALIDATION_TAGS);
    return NextResponse.json({ asset: toAssetRow(asset), campaign }, { status: 201 });
  }

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file or externalUrl is required" }, { status: 400 });
  }

  const googleDrive = await getGoogleDriveConnectionStatus();
  const supabaseBytes = await estimateSupabaseAssetBytes();
  const selectedProvider =
    parsed.data.provider ??
    chooseAssetProvider({
      sizeBytes: file.size,
      longTermArchive: parsed.data.longTermArchive,
      currentSupabaseBytes: supabaseBytes,
      googleDriveConnected: googleDrive.connected,
    });

  if (
    selectedProvider === "SUPABASE" &&
    file.size > SUPABASE_DIRECT_UPLOAD_LIMIT_BYTES &&
    !googleDrive.connected
  ) {
    return NextResponse.json(
      { error: "20MB 초과 파일은 Google Drive 연결 후 업로드하세요." },
      { status: 409 },
    );
  }
  if (selectedProvider === "GOOGLE_DRIVE" && !googleDrive.connected) {
    return NextResponse.json(
      { error: "Google Drive is not connected" },
      { status: 409 },
    );
  }

  const provider = getStorageProvider(selectedProvider as AssetProvider);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const stored = await provider.upload({
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    bytes,
    section: parsed.data.section as AssetSection,
    entityType: parsed.data.entityType as AssetEntityType,
    entityId: parsed.data.entityId,
    entityName,
  });
  const asset = await getPrisma().asset.create({
    data: {
      provider: stored.provider,
      section: parsed.data.section,
      entityType: parsed.data.entityType,
      entityId: parsed.data.entityId,
      campaignId,
      fileName: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      storagePath: stored.storagePath,
      externalFileId: stored.externalFileId,
      externalUrl: stored.externalUrl,
      thumbnailUrl: stored.thumbnailUrl,
      notes: parsed.data.notes,
    },
  });
  if (campaignId) {
    await recordCampaignActivity({
      campaignId,
      action: "ASSET_UPLOADED",
      label: "Asset uploaded",
      details: `${parsed.data.section} · ${file.name}`,
    });
  }
  const campaign = campaignId ? await loadCampaignRow(campaignId) : null;
  revalidateCrmTags(ASSET_INVALIDATION_TAGS);
  return NextResponse.json({ asset: toAssetRow(asset), campaign }, { status: 201 });
}
