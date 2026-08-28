import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getAuthContext } from "@/lib/auth-context";
import { normalizeAssetStorageSegment, storeRawObject } from "@/lib/asset-storage";
import { getPrisma } from "@/lib/prisma";
import { PriceSheetRepository } from "@/repositories/priceSheetRepository";
import { MAX_FILE_SIZE_BYTES } from "@/lib/price-sheet/types";

const EXT_TO_FORMAT: Record<string, { sourceFormat: string; extractPath: "A" | "B" }> = {
  xlsx: { sourceFormat: "XLSX", extractPath: "A" },
  xls: { sourceFormat: "XLSX", extractPath: "A" },
  csv: { sourceFormat: "CSV", extractPath: "A" },
  pptx: { sourceFormat: "PPTX", extractPath: "B" },
  pdf: { sourceFormat: "PDF", extractPath: "B" },
  png: { sourceFormat: "IMAGE", extractPath: "B" },
  jpg: { sourceFormat: "IMAGE", extractPath: "B" },
  jpeg: { sourceFormat: "IMAGE", extractPath: "B" },
  webp: { sourceFormat: "IMAGE", extractPath: "B" },
};

const querySchema = z.object({
  partnerId: z.string().optional(),
  status: z.string().optional(),
});

export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const sheets = await PriceSheetRepository.findMany({
    where: {
      ...(parsed.data.partnerId ? { partnerId: parsed.data.partnerId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status } : {}),
    },
    include: { rows: false, partner: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ priceSheets: sheets });
}

/**
 * 원본 저장 — Asset enum 확장 없이 PriceSheet.assetId에 storagePath 문자열만 기록.
 * 저장 자체는 storeRawObject(Supabase 설정 시 버킷, 미설정 로컬 dev만 파일 폴백)에 위임한다.
 * Supabase 오브젝트 키는 ASCII만 허용하므로 basename은 normalizeAssetStorageSegment로
 * 정규화하되, extract의 mime 추정이 storagePath 확장자를 읽으므로 확장자는 따로 보존한다.
 */
async function saveOriginalFile(
  fileName: string,
  ext: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const dotIndex = fileName.lastIndexOf(".");
  const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  const cleanBase = normalizeAssetStorageSegment(base, "pricesheet");
  const storagePath = `PRICE_SHEET/${date}_${Date.now()}_${cleanBase}.${ext}`;
  return storeRawObject(storagePath, Buffer.from(bytes), mimeType);
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const formData = await request.formData();
  const file = formData.get("file");
  const partnerId = formData.get("partnerId");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      { error: `파일 크기가 20MB를 초과합니다 (${(file.size / 1024 / 1024).toFixed(1)}MB)` },
      { status: 413 }
    );
  }

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const formatInfo = EXT_TO_FORMAT[ext];
  if (!formatInfo) {
    return NextResponse.json(
      { error: `지원하지 않는 파일 형식입니다: .${ext} (xlsx/csv/pptx/pdf/png/jpg만 지원)` },
      { status: 400 }
    );
  }

  const authCtx = await getAuthContext();
  const actor = authCtx?.email ?? "SYSTEM";

  const bytes = new Uint8Array(await file.arrayBuffer());
  const assetId = await saveOriginalFile(
    file.name,
    ext,
    file.type || "application/octet-stream",
    bytes,
  );

  const partnerIdValue = typeof partnerId === "string" && partnerId.length > 0 ? partnerId : null;

  if (partnerIdValue) {
    const partner = await getPrisma().partner.findUnique({ where: { id: partnerIdValue } });
    if (!partner) {
      return NextResponse.json({ error: "존재하지 않는 거래처입니다." }, { status: 400 });
    }
  }

  const priceSheet = await PriceSheetRepository.create({
    partnerId: partnerIdValue,
    sourceFormat: formatInfo.sourceFormat,
    extractPath: formatInfo.extractPath,
    assetId,
    status: "UPLOADED",
    createdBy: actor,
  });

  return NextResponse.json({ priceSheet, fileName: file.name }, { status: 201 });
}
