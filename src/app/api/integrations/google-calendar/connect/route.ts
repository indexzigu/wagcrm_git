import { NextResponse } from "next/server";
import { buildGoogleCalendarAuthUrl, GOOGLE_CALENDAR_PROVIDER } from "@/lib/google-calendar";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";

export async function POST() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  try {
    const authUrl = buildGoogleCalendarAuthUrl();
    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_CALENDAR_PROVIDER },
      update: { status: "DISCONNECTED", lastError: null },
      create: { provider: GOOGLE_CALENDAR_PROVIDER, status: "DISCONNECTED" },
    });
    return NextResponse.json({ authUrl });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Google Calendar connect failed" },
      { status: 400 },
    );
  }
}
