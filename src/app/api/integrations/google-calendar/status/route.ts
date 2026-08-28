import { NextResponse } from "next/server";
import {
  getGoogleCalendarConnectionStatus,
  GOOGLE_CALENDAR_PROVIDER,
  isValidCalendarId,
  setFinanceCalendarId,
} from "@/lib/google-calendar";
import { requireAuth } from "@/lib/api-auth";

/**
 * 회계·정산 캘린더 ID 설정 — 입금·출금 이벤트의 목적지 캘린더(2026-08-25 캘린더 분리).
 * 빈 문자열/null 은 해제(모든 이벤트가 primary 로 폴백). 반영은 저장 즉시가 아니라
 * 다음 동기화(개별 훅 또는 /calendar 의 "전체 동기화")부터다 — 기존 이벤트의 이사도
 * 그 동기화가 수행한다.
 */
export async function PATCH(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }

  const raw = (body as { financeCalendarId?: unknown })?.financeCalendarId;
  if (raw !== null && typeof raw !== "string") {
    return NextResponse.json(
      { error: "financeCalendarId 는 문자열 또는 null 이어야 합니다." },
      { status: 400 },
    );
  }
  const trimmed = typeof raw === "string" ? raw.trim() : null;
  const next = trimmed ? trimmed : null;
  if (next !== null && !isValidCalendarId(next)) {
    return NextResponse.json(
      {
        error:
          "캘린더 ID 형식이 아닙니다. 구글 캘린더 설정 → 캘린더 통합의 '캘린더 ID'(…@group.calendar.google.com)를 붙여넣으세요.",
      },
      { status: 400 },
    );
  }

  try {
    await setFinanceCalendarId(next);
    const status = await getGoogleCalendarConnectionStatus();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "저장에 실패했습니다." },
      { status: 500 },
    );
  }
}

export async function GET() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  try {
    const status = await getGoogleCalendarConnectionStatus();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get calendar status" },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  try {
    const { getPrisma } = await import("@/lib/prisma");
    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_CALENDAR_PROVIDER },
      update: {
        status: "DISCONNECTED",
        encryptedRefreshToken: null,
        accountEmail: null,
        lastError: null,
      },
      create: {
        provider: GOOGLE_CALENDAR_PROVIDER,
        status: "DISCONNECTED",
      },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to disconnect" },
      { status: 500 },
    );
  }
}
