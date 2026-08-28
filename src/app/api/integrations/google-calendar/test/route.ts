import { NextResponse } from "next/server";
import { getGoogleCalendarAccessToken, getGoogleCalendarConnectionStatus, GOOGLE_CALENDAR_PROVIDER } from "@/lib/google-calendar";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";

export async function POST() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    // 1. 실시간으로 토큰 갱신 검증 시도
    await getGoogleCalendarAccessToken();

    // 2. 성공 시 CONNECTED 상태로 갱신
    const currentStatus = await getGoogleCalendarConnectionStatus();
    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_CALENDAR_PROVIDER },
      update: {
        status: "CONNECTED",
        accountEmail: currentStatus.accountEmail,
        lastError: null,
        updatedAt: new Date(),
      },
      create: {
        provider: GOOGLE_CALENDAR_PROVIDER,
        status: "CONNECTED",
        accountEmail: currentStatus.accountEmail,
      },
    });

    return NextResponse.json(await getGoogleCalendarConnectionStatus());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isDisconnected = message.includes("not connected");
    const targetStatus = isDisconnected ? "DISCONNECTED" : "ERROR";

    // 3. 실패 시 ERROR 또는 DISCONNECTED 상태로 갱신
    const currentStatus = await getGoogleCalendarConnectionStatus();
    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_CALENDAR_PROVIDER },
      update: {
        status: targetStatus,
        lastError: isDisconnected ? null : message,
        updatedAt: new Date(),
      },
      create: {
        provider: GOOGLE_CALENDAR_PROVIDER,
        status: targetStatus,
        lastError: isDisconnected ? null : message,
      },
    });

    return NextResponse.json({
      connected: false,
      status: targetStatus,
      accountEmail: currentStatus.accountEmail,
      lastError: isDisconnected ? null : message,
    });
  }
}
