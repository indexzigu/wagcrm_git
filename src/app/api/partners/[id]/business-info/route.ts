import { NextResponse } from "next/server";
import { PartnerService } from "@/services/partnerService";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";

type Context = {
  params: Promise<{ id: string }>;
};

type BusinessInfoOcrRequest = {
  fileBase64: string;
  mimeType: string;
};

function isBusinessInfoOcrRequest(value: unknown): value is BusinessInfoOcrRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.fileBase64 === "string" &&
    candidate.fileBase64.trim().length > 0 &&
    typeof candidate.mimeType === "string" &&
    candidate.mimeType.trim().length > 0
  );
}

/**
 * GET /api/partners/:id/business-info?force=true
 * 사업자번호로 국세청 API + bizno.net 무료 스크래핑을 수행하여 정보를 업데이트합니다.
 */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const { searchParams } = new URL(request.url);
  const force = searchParams.get("force") === "true";

  try {
    const result = await PartnerService.syncBusinessInfo(id, force);
    revalidateMasterDataCaches();
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Partner business info sync failed:", error);
    const status = error.message?.includes("찾을 수 없습니다") ? 404 : 400;
    return NextResponse.json({ error: error.message || "동기화에 실패했습니다." }, { status });
  }
}

/**
 * POST /api/partners/:id/business-info
 * 업로드된 사업자등록증 이미지(base64)를 파싱하여 사업자 정보를 업데이트합니다.
 */
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;

  let reqBody: unknown;
  try {
    reqBody = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }

  if (!isBusinessInfoOcrRequest(reqBody)) {
    return NextResponse.json({ error: "fileBase64 및 mimeType은 필수입니다." }, { status: 400 });
  }

  const { fileBase64, mimeType } = reqBody;

  try {
    const updatedPartner = await PartnerService.parseBusinessCardOcr(id, fileBase64, mimeType);
    revalidateMasterDataCaches();
    return NextResponse.json({
      success: true,
      partner: {
        id: updatedPartner.id,
        name: updatedPartner.name,
        type: updatedPartner.type,
        contactInfo: updatedPartner.contactInfo,
        bankAccount: updatedPartner.bankAccount,
        businessNumber: updatedPartner.businessNumber,
        companyStatus: updatedPartner.companyStatus,
        companyRole: updatedPartner.companyRole,
        ceoName: updatedPartner.ceoName,
        address: updatedPartner.address,
        businessType: updatedPartner.businessType,
        businessItem: updatedPartner.businessItem,
        bizSyncedAt: updatedPartner.bizSyncedAt?.toISOString()
      }
    });
  } catch (error: any) {
    console.error("Gemini OCR parsing failed:", error);
    if (error.message?.includes("API 키가 설정되지 않아")) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (error.message?.includes("찾을 수 없습니다")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error.message?.includes("파싱에 실패해")) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json({ error: error.message || "사업자등록증 처리에 실패했습니다." }, { status: 500 });
  }
}
