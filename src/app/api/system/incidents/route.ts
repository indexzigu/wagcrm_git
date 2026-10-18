import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { AUTOMATION_INCIDENT_FIELDS } from "@/lib/automation-incidents";

// 자동화 작업 사고 장부(CronIncident) 읽기 — 홈 「오늘 처리할 일」(`?status=waiting_owner`)과 설정 「자동화 작업
// 상태」 설명창의 「이상 기록」(`?jobKey=`)이 쓴다(크론 자가 복구 2단계). 읽기 전용이다.
// - 응답 칸은 `AUTOMATION_INCIDENT_FIELDS` 뿐이다. ⛔ `lastMessage`(실패 원문 — 프록시 주소·토큰이 섞일 수 있다)는
//   select 에 넣지 않는다(route.test.ts 가 응답 칸 목록을 고정한다).
// - C(알림 자체가 틀림)는 내부 기록이고, `suppressedAt` 이 찍힌 사고는 알림 직전 재확인에서 막힌 것이라 화면에 내지 않는다.
// - 정상화된 사고는 14일 안의 것만 — 그보다 오래된 기록은 지금 판단을 바꾸지 않는다.
// 세션 게이트는 `src/proxy.ts` 가 1차로 막고, 여기 `requireAuth` 는 2차 방어다.

const RESOLVED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 200;
const SELECT = Object.fromEntries(AUTOMATION_INCIDENT_FIELDS.map((field) => [field, true])) as Record<
  (typeof AUTOMATION_INCIDENT_FIELDS)[number],
  true
>;

export async function GET(request: Request) {
  // requireAuth 가 쿠키를 읽으므로 이 라우트는 요청마다 동적으로 돈다(캐시되지 않는다).
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const jobKey = searchParams.get("jobKey");
  if (status !== null && status !== "waiting_owner") {
    return NextResponse.json({ error: "status 는 waiting_owner 만 받습니다." }, { status: 400 });
  }
  if (status === null && !jobKey) {
    return NextResponse.json({ error: "status 또는 jobKey 가 필요합니다." }, { status: 400 });
  }

  const where: Prisma.CronIncidentWhereInput = {
    kind: { not: "C" },
    suppressedAt: null,
    ...(jobKey ? { jobKey } : {}),
    ...(status
      ? { status }
      : {
          OR: [
            { status: { in: ["open", "waiting_owner"] } },
            { status: "resolved", normalizedAt: { gte: new Date(Date.now() - RESOLVED_WINDOW_MS) } },
          ],
        }),
  };

  try {
    const incidents = await getPrisma().cronIncident.findMany({
      where,
      select: SELECT,
      orderBy: { firstSeenAt: "asc" },
      take: MAX_ROWS,
    });
    return NextResponse.json({ incidents });
  } catch (error) {
    console.error("[SystemIncidentsAPI] 사고 장부 조회 실패:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
