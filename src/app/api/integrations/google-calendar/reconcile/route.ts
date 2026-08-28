import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import {
  deleteCalendarEventsByIds,
  scanOrphanCalendarEvents,
} from "@/lib/google-calendar-sync";

/**
 * 구글 캘린더 고아 이벤트 정리 — GET(예행 조회) / POST(명시 삭제).
 *
 * 동기화는 DB 장부에 적힌 id 로만 이벤트를 지우므로, 장부가 끊긴 이벤트는 재동기화로
 * 영원히 사라지지 않는다. 이 라우트가 그 잔재를 찾아 없앤다.
 *
 * ⚠️ 캘린더가 `primary`(개인 기본)라 **GET 으로 목록을 보고 그 id 를 POST 로 되보내는
 * 2단계**를 강제한다 — POST 는 자체 스캔을 하지 않는다(스캔~삭제 사이에 생긴 이벤트가
 * 확인 없이 삭제되는 것을 막는다).
 */

const DEFAULT_RANGE_YEARS_BACK = 3;
const DEFAULT_RANGE_YEARS_FORWARD = 1;

function resolveRange(url: URL): { timeMin: string; timeMax: string } {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const now = new Date();
  const min = from
    ? new Date(`${from}T00:00:00.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear() - DEFAULT_RANGE_YEARS_BACK, 0, 1));
  const max = to
    ? new Date(`${to}T23:59:59.000Z`)
    : new Date(Date.UTC(now.getUTCFullYear() + DEFAULT_RANGE_YEARS_FORWARD, 0, 1));
  return { timeMin: min.toISOString(), timeMax: max.toISOString() };
}

export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { timeMin, timeMax } = resolveRange(new URL(request.url));
  try {
    const result = await scanOrphanCalendarEvents({ timeMin, timeMax });
    if (result.skipped === "not_connected") {
      return NextResponse.json(
        { error: "구글 캘린더가 연결되어 있지 않습니다." },
        { status: 401 },
      );
    }
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "조회에 실패했습니다." },
        { status: 502 },
      );
    }
    return NextResponse.json({
      range: { from: timeMin.slice(0, 10), to: timeMax.slice(0, 10) },
      scanned: result.scanned,
      referenced: result.referenced,
      orphanCount: result.orphans.length,
      orphans: result.orphans,
    });
  } catch (error) {
    console.error("[google-calendar/reconcile] 조회 오류:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 500 },
    );
  }
}

/** ActivityLog 의 캘린더 정리 앵커 — 특정 캠페인/그룹에 귀속되지 않는 운영 행위다. */
const RECONCILE_ENTITY_TYPE = "GOOGLE_CALENDAR";
const RECONCILE_ENTITY_ID = "reconcile";

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }

  // 라벨(제목·기간)은 삭제하면 구글에서 영영 확인할 수 없다 — 화면이 보내주면 감사
  // 기록에 함께 남긴다(없어도 삭제는 진행). id 만 남기면 "무엇을 지웠나"에 답할 수 없다.
  const labels = (body as { labels?: unknown })?.labels;
  const labelById = new Map<string, string>();
  if (Array.isArray(labels)) {
    for (const l of labels) {
      const item = l as { id?: unknown; label?: unknown };
      if (typeof item?.id === "string" && typeof item?.label === "string") {
        labelById.set(item.id, item.label.slice(0, 200));
      }
    }
  }

  const eventIds = (body as { eventIds?: unknown })?.eventIds;
  if (
    !Array.isArray(eventIds) ||
    eventIds.length === 0 ||
    !eventIds.every((id): id is string => typeof id === "string" && id.length > 0)
  ) {
    // 전량 삭제를 허용하지 않는다 — 지울 대상은 GET 으로 확인한 id 여야 한다.
    return NextResponse.json(
      { error: "삭제할 eventIds 배열이 필요합니다(먼저 GET 으로 목록을 확인하세요)." },
      { status: 400 },
    );
  }

  // 회계·정산 캘린더 분리 후 이벤트는 두 캘린더에 나뉘어 산다 — GET 이 알려준
  // id→캘린더 매핑을 되보내면 그 캘린더에서 지운다(없는 id 는 primary 로 해석).
  const calendarIdsRaw = (body as { calendarIds?: unknown })?.calendarIds;
  const calendarById = new Map<string, string>();
  if (calendarIdsRaw && typeof calendarIdsRaw === "object" && !Array.isArray(calendarIdsRaw)) {
    for (const [id, cal] of Object.entries(calendarIdsRaw as Record<string, unknown>)) {
      if (typeof cal === "string" && cal.length > 0) calendarById.set(id, cal);
    }
  }

  try {
    const result = await deleteCalendarEventsByIds(
      eventIds.map((id) => ({ id, calendarId: calendarById.get(id) })),
    );
    if (result.skipped === "not_connected") {
      return NextResponse.json(
        { error: "구글 캘린더가 연결되어 있지 않습니다." },
        { status: 401 },
      );
    }
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "삭제에 실패했습니다." },
        { status: 502 },
      );
    }
    // 감사 기록 — 되돌릴 수 없는 외부 삭제라 "무엇을 몇 건 지웠나"가 남아야 한다.
    // 실패해도 삭제 결과 보고를 막지 않는다(이미 지워진 뒤다) — 대신 삼키지 않고 남긴다.
    if (result.deleted > 0) {
      const deletedIds = [...new Set(eventIds)];
      await getPrisma()
        .activityLog.create({
          data: {
            entityType: RECONCILE_ENTITY_TYPE,
            entityId: RECONCILE_ENTITY_ID,
            type: "DELETE",
            fieldName: "calendarEvents",
            previousValue: String(result.deleted),
            content: JSON.stringify(
              deletedIds.map((id) => ({ id, label: labelById.get(id) ?? null })),
            ).slice(0, 8000),
            actor: auth.context.userId,
          },
        })
        .catch((logError) =>
          console.error("[google-calendar/reconcile] 감사 기록 실패:", logError),
        );
    }

    return NextResponse.json({
      deleted: result.deleted,
      protected: result.protected,
      message:
        `${result.deleted}건을 삭제했습니다.` +
        (result.protected > 0
          ? ` (동기화 중인 ${result.protected}건은 보호되어 건너뛰었습니다.)`
          : ""),
    });
  } catch (error) {
    console.error("[google-calendar/reconcile] 삭제 오류:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "알 수 없는 오류" },
      { status: 500 },
    );
  }
}
