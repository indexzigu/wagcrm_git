import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/api-auth";
import { readAssetBytes, SUPABASE_PROVIDER } from "@/lib/asset-storage";
import { PriceSheetRepository, PriceSheetRowRepository, serializeJsonField } from "@/repositories/priceSheetRepository";
import { extractPathA } from "@/lib/price-sheet/extract-path-a";
import { extractPathBPptx, extractPathBInline } from "@/lib/price-sheet/extract-path-b";
import { PriceSheetExtractError } from "@/lib/price-sheet/types";
import { normalizePriceSheetForResponse } from "@/lib/price-sheet/serialize-response";

const MIME_BY_FORMAT: Record<string, string> = {
  IMAGE: "image/png",
  PDF: "application/pdf",
};

function guessMimeType(fileName: string, sourceFormat: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "pdf") return "application/pdf";
  return MIME_BY_FORMAT[sourceFormat] ?? "application/octet-stream";
}

/**
 * 가격표 추출 실행. LLM 실패 시 mock-안전 패턴(throw만, DB에 안 씀)을 따르되,
 * PriceSheet 자체 상태는 EXTRACT_FAILED로 남겨 UI가 재시도를 안내할 수 있게 한다.
 * 실패행(파싱 결과가 비어있는 등)은 여기서 막지 않는다 — rawCells 보존 + flags.needsReview는
 * extract-path-a/b의 결정적 코드가 이미 행 단위로 처리했다.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;
  const priceSheet = await PriceSheetRepository.findById(id, false);
  if (!priceSheet) {
    return NextResponse.json({ error: "가격표를 찾을 수 없습니다." }, { status: 404 });
  }

  if (!priceSheet.assetId) {
    return NextResponse.json({ error: "원본 파일이 저장되어 있지 않습니다." }, { status: 409 });
  }

  let buffer: Buffer;
  try {
    // 원본은 storeRawObject 규약(Supabase 설정 시 버킷, 로컬 dev만 파일)으로 저장됐다 —
    // readAssetBytes의 SUPABASE storagePath 분기가 두 경우를 모두 처리한다.
    buffer = await readAssetBytes({ provider: SUPABASE_PROVIDER, storagePath: priceSheet.assetId });
  } catch {
    await PriceSheetRepository.updateStatus(id, "EXTRACT_FAILED", {
      reviewNote: "원본 파일을 읽을 수 없습니다.",
    });
    return NextResponse.json({ error: "원본 파일을 읽을 수 없습니다." }, { status: 500 });
  }

  try {
    let result;
    if (priceSheet.extractPath === "A") {
      result = await extractPathA(buffer);
    } else if (priceSheet.sourceFormat === "PPTX") {
      result = await extractPathBPptx(buffer);
    } else {
      const mimeType = guessMimeType(priceSheet.assetId, priceSheet.sourceFormat);
      result = await extractPathBInline(buffer, mimeType);
    }

    if (result.rows.length > 0) {
      await PriceSheetRowRepository.createMany(id, result.rows);
    }

    const columnMapping =
      "columnMapping" in result ? (result as { columnMapping: unknown }).columnMapping : undefined;

    const updated = await PriceSheetRepository.updateStatus(id, "EXTRACTED", {
      policyText: result.policyText,
      detectedTables: result.detectedTables,
      ...(columnMapping !== undefined
        ? { columnMapping: serializeJsonField(columnMapping) as Prisma.InputJsonValue }
        : {}),
    });

    return NextResponse.json({ priceSheet: normalizePriceSheetForResponse(updated), rowCount: result.rows.length });
  } catch (err) {
    const message = err instanceof PriceSheetExtractError ? err.message : "가격표 추출 중 오류가 발생했습니다.";
    console.error(`[POST /api/price-sheets/${id}/extract] Error:`, err);
    await PriceSheetRepository.updateStatus(id, "EXTRACT_FAILED", {
      reviewNote: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
