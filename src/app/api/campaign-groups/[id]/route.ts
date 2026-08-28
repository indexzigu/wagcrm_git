import { NextResponse, after } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import { campaignGroupService, CampaignGroupError } from "@/services/campaignGroupService";
import { campaignGroupRepository } from "@/repositories/campaignGroupRepository";
import { toCampaignGroupDetail } from "@/lib/campaign-group-row";
import {
  deleteCampaignCalendarEvents,
  syncCampaignToCalendar,
  syncGroupToCalendar,
} from "@/lib/google-calendar-sync";

/**
 * CG-3: 해체 시 그룹 장부(calendarEventIds)의 이벤트를 지우고, 무그룹으로
 * 복귀한 캠페인들은 개별 이벤트를 되살린다. fire-and-forget(best-effort) —
 * 캘린더 실패가 그룹 조작을 막지 않는다.
 */
function scheduleDissolvedCalendarCleanup(
  groupId: string,
  groupCalendarEventIds: string | null,
  memberCampaignIds: string[],
) {
  after(async () => {
    try {
      if (groupCalendarEventIds) {
        await deleteCampaignCalendarEvents(groupCalendarEventIds);
      }
      for (const campaignId of memberCampaignIds) {
        await syncCampaignToCalendar(campaignId);
      }
    } catch (calendarError) {
      console.error(
        `[calendar-sync] 그룹 ${groupId} 해체 훅 캘린더 정리 실패:`,
        calendarError,
      );
    }
  });
}

/**
 * GET/PATCH/DELETE /api/campaign-groups/[id] (블루프린트 §3).
 * - GET: 그룹 상세(멤버 목록 포함).
 * - PATCH: 이름 변경 · 멤버 추가/제거. 제거로 멤버 ≤1이 되면 자동 해체 → 200 { dissolved: true }.
 * - DELETE: 그룹 전체 해체.
 * 불변식 ⑤ 준수: groupId는 오직 이 라우트(campaign-groups)로만 바뀐다. campaigns PATCH 우회 없음.
 */

type Context = {
  params: Promise<{ id: string }>;
};

function mapGroupError(error: unknown, fallback: string) {
  if (error instanceof CampaignGroupError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const group = await campaignGroupRepository.findById(id);
  if (!group) {
    return NextResponse.json({ error: "그룹을 찾을 수 없습니다." }, { status: 404 });
  }
  return NextResponse.json(toCampaignGroupDetail(group));
}

const updateGroupSchema = z.object({
  name: z.string().max(100).nullable().optional(),
  addCampaignIds: z.array(z.string().min(1)).optional(),
  removeCampaignIds: z.array(z.string().min(1)).optional(),
});

export async function PATCH(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const parsed = updateGroupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { name, addCampaignIds, removeCampaignIds } = parsed.data;

  try {
    // 해체될 수 있는 조작 전에 장부·멤버를 확보한다(해체되면 그룹 행이 사라짐).
    const prior =
      removeCampaignIds && removeCampaignIds.length > 0
        ? await campaignGroupRepository.findById(id)
        : null;

    // 제거 먼저 — 멤버 ≤1이면 자동 해체(불변식 ②)되므로 이후 조작은 무의미하다.
    if (removeCampaignIds && removeCampaignIds.length > 0) {
      const result = await campaignGroupService.removeMembers(id, removeCampaignIds);
      if (result.dissolved) {
        revalidateCampaignCaches();
        scheduleDissolvedCalendarCleanup(
          id,
          prior?.calendarEventIds ?? null,
          prior?.members.map((m) => m.id) ?? [],
        );
        return NextResponse.json({ dissolved: true });
      }
    }

    if (addCampaignIds && addCampaignIds.length > 0) {
      await campaignGroupService.addMembers(id, addCampaignIds);
    }

    if (name !== undefined) {
      await campaignGroupService.renameGroup(id, name);
    }

    revalidateCampaignCaches();

    // CG-3: 멤버십·이름 변경은 그룹 이벤트(제목·기간 롤업)에 반영, 제거돼 무그룹이
    // 된 캠페인은 개별 이벤트로 복귀한다.
    const removedIds = removeCampaignIds ?? [];
    after(async () => {
      try {
        await syncGroupToCalendar(id);
        for (const campaignId of removedIds) {
          await syncCampaignToCalendar(campaignId);
        }
      } catch (calendarError) {
        console.error(
          `[calendar-sync] 그룹 ${id} 수정 훅 동기화 실패:`,
          calendarError,
        );
      }
    });

    const detail = await campaignGroupRepository.findById(id);
    if (!detail) {
      return NextResponse.json({ error: "그룹을 찾을 수 없습니다." }, { status: 404 });
    }
    return NextResponse.json(toCampaignGroupDetail(detail));
  } catch (error) {
    return mapGroupError(error, "그룹 수정에 실패했습니다.");
  }
}

export async function DELETE(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  try {
    // 해체 전에 장부·멤버를 확보(해체되면 그룹 행이 사라짐).
    const prior = await campaignGroupRepository.findById(id);
    const result = await campaignGroupService.dissolveGroup(id);
    revalidateCampaignCaches();
    scheduleDissolvedCalendarCleanup(
      id,
      prior?.calendarEventIds ?? null,
      prior?.members.map((m) => m.id) ?? [],
    );
    return NextResponse.json(result);
  } catch (error) {
    return mapGroupError(error, "그룹 해체에 실패했습니다.");
  }
}
