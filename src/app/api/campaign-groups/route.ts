import { NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import { campaignGroupService, CampaignGroupError } from "@/services/campaignGroupService";
import { campaignGroupRepository } from "@/repositories/campaignGroupRepository";
import { toCampaignGroupDetail } from "@/lib/campaign-group-row";
import { syncGroupToCalendar } from "@/lib/google-calendar-sync";

/**
 * POST /api/campaign-groups — 기존 캠페인들을 새 그룹으로 묶는다(블루프린트 §3, 경로 ⓐ/ⓒ).
 * 불변식(이종 셀러 409 · 이미 그룹 소속 409 · 멤버 <2 400)은 서비스가 타입드 에러로 강제.
 */

const createGroupSchema = z.object({
  campaignIds: z
    .array(z.string().min(1))
    .min(2, "그룹은 최소 2개 캠페인이 필요합니다."),
});

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = createGroupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const group = await campaignGroupService.createGroup(parsed.data.campaignIds);
    revalidateCampaignCaches();

    // CG-3: 그룹 형성 시 멤버 개별 이벤트를 정리하고 그룹당 3개 이벤트로 전환.
    // fire-and-forget — 캘린더 실패가 그룹 생성을 막지 않는다.
    after(async () => {
      try {
        const result = await syncGroupToCalendar(group.id);
        if (!result.ok) {
          console.error(`[calendar-sync] 그룹 ${group.id} 생성 훅 동기화 실패:`, result);
        }
      } catch (calendarError) {
        console.error(`[calendar-sync] 그룹 ${group.id} 생성 훅 실패:`, calendarError);
      }
    });

    const detail = await campaignGroupRepository.findByIdOrThrow(group.id);
    return NextResponse.json(toCampaignGroupDetail(detail), { status: 201 });
  } catch (error) {
    if (error instanceof CampaignGroupError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error("POST /api/campaign-groups failed:", error);
    return NextResponse.json({ error: "그룹 생성에 실패했습니다." }, { status: 500 });
  }
}
