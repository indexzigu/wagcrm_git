import { NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import { syncCampaignToCalendar } from "@/lib/google-calendar-sync";
import {
  createDraftCampaign,
  DraftCampaignError,
} from "@/lib/mobile-draft-campaign";

/**
 * POST /api/mobile/campaigns/draft — 예비 캠페인 경량 생성
 * (MOBILE_UX_PLAN §4 · Phase 4 — 모바일 유일의 쓰기 경로).
 *
 * 정식 POST /api/campaigns 는 salesChannel·baseNaverLink(URL)가 하드 필수라
 * "링크 미확정" 예비 단계에 부적합 — 여기서는 딜·셀러·기간 3필드만 받고
 * 나머지는 딜 정책에서 자동 유도한다(로직: src/lib/mobile-draft-campaign.ts).
 */

const draftCampaignSchema = z
  .object({
    dealId: z.string().min(1),
    sellerId: z.string().min(1),
    startDate: z.string().date(),
    endDate: z.string().date(),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: "종료일은 시작일보다 빠를 수 없습니다.",
    path: ["endDate"],
  });

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = draftCampaignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const draft = await createDraftCampaign(parsed.data);

    revalidateCampaignCaches();

    // 구글 캘린더 자동 등록 — 정식 생성 라우트(campaigns POST)와 동일 패턴:
    // after() 백그라운드 fire-and-forget(멱등·best-effort). await 금지 —
    // 캘린더 미연결/구글 오류여도 캠페인 생성은 이미 성공한 상태다.
    after(() =>
      syncCampaignToCalendar(draft.id).catch((calendarError) =>
        console.error("[calendar-sync] 모바일 draft 생성 훅 실패:", calendarError),
      ),
    );

    return NextResponse.json(draft, { status: 201 });
  } catch (error) {
    if (error instanceof DraftCampaignError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("POST /api/mobile/campaigns/draft failed:", error);
    return NextResponse.json(
      { error: "예비 캠페인 생성에 실패했습니다." },
      { status: 500 },
    );
  }
}
