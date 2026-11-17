import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/api-auth";
import { readAssetBytes, SUPABASE_PROVIDER } from "@/lib/asset-storage";
import {
  isApplyLocked,
  PriceSheetRepository,
  PriceSheetRowRepository,
  serializeJsonField,
} from "@/repositories/priceSheetRepository";
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

  // T-310: 반영 중·반영 완료 시트는 재추출하지 않는다 — 추출(특히 LLM 경로 B)은 같은 품목을 다른
  // rawCells(=다른 rowHash)로 새 행으로 만들 수 있고, 그 행을 다시 매핑·반영하면 같은 딜이 또 생긴다.
  // 시작 전에 막는다. 추출 도중 반영이 끝나면 새 행은 들어갈 수 있지만, 아래 조건부 상태 쓰기가
  // 시트를 APPLIED 로 두므로 그 행은 다시 반영될 수 없다(반영 라우트가 APPLIED 시트를 409 로 거부).
  if (isApplyLocked(priceSheet.status)) {
    return NextResponse.json({ error: APPLY_LOCKED_MESSAGE }, { status: 409 });
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
    await PriceSheetRepository.updateStatusUnlessApplyLocked(id, "EXTRACT_FAILED", {
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

    // 추출은 길다(LLM) — 그 사이 반영이 끝났을 수 있으므로 상태 조건을 쓰기 자체에 건다.
    const changed = await PriceSheetRepository.updateStatusUnlessApplyLocked(id, "EXTRACTED", {
      policyText: result.policyText,
      detectedTables: result.detectedTables,
      ...(columnMapping !== undefined
        ? { columnMapping: serializeJsonField(columnMapping) as Prisma.InputJsonValue }
        : {}),
    });
    if (changed === 0) {
      return NextResponse.json({ error: APPLY_LOCKED_MESSAGE }, { status: 409 });
    }
    const updated = await PriceSheetRepository.findById(id, false);

    return NextResponse.json({
      priceSheet: updated ? normalizePriceSheetForResponse(updated) : null,
      rowCount: result.rows.length,
    });
  } catch (err) {
    const message = err instanceof PriceSheetExtractError ? err.message : "가격표 추출 중 오류가 발생했습니다.";
    console.error(`[POST /api/price-sheets/${id}/extract] Error:`, err);
    await PriceSheetRepository.updateStatusUnlessApplyLocked(id, "EXTRACT_FAILED", {
      reviewNote: message,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

const APPLY_LOCKED_MESSAGE = "반영 중이거나 반영이 끝난 가격표는 다시 추출할 수 없습니다.";
