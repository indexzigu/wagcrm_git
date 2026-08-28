import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getAuthContext } from "@/lib/auth-context";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";
import { sellerService } from "@/services/sellerService";

// 다건 순차 생성 — 서버리스 기본 타임아웃 여유 확보.
export const maxDuration = 60;

/**
 * POST /api/sellers/bulk
 *
 * 발굴 셀러 대량 등록 유입 경로. 자유 텍스트(URL/핸들 다건)를 받아 순차 생성하고
 * 행 단위 성공/중복/실패 집계를 반환한다. 지표 보강 스크래핑은 클라이언트가
 * 반환된 created[].channelUrl로 백그라운드 트리거한다.
 *
 * body: { text: string, isMonitored?: boolean }
 */
export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const rawBody: unknown = await request.json().catch(() => null);
  const body =
    rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : {};

  const text = typeof body.text === "string" ? body.text : "";
  const isMonitored = body.isMonitored === true;

  if (text.trim().length === 0) {
    return NextResponse.json(
      { error: "등록할 URL 또는 핸들을 입력해주세요." },
      { status: 400 }
    );
  }

  const authCtx = await getAuthContext();
  const actor = authCtx?.email ?? "SYSTEM";

  try {
    const result = await sellerService.createSellersBulk(text, { isMonitored }, actor);
    if (result.created.length > 0) {
      revalidateMasterDataCaches();
    }
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    console.error("[POST /api/sellers/bulk] Error:", error);
    return NextResponse.json(
      { error: "대량 등록 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
