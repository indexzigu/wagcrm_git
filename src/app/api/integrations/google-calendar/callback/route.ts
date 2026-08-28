import { NextResponse } from "next/server";
import {
  exchangeGoogleCalendarCode,
  GOOGLE_CALENDAR_PROVIDER,
  encryptSecret,
} from "@/lib/google-calendar";
import { getPrisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const redirectBase = `${appUrl}/?calendar=`;

  if (error) {
    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_CALENDAR_PROVIDER },
      update: { status: "ERROR", lastError: error },
      create: { provider: GOOGLE_CALENDAR_PROVIDER, status: "ERROR", lastError: error },
    });
    return NextResponse.redirect(`${redirectBase}error`);
  }

  if (!code) {
    return NextResponse.redirect(`${redirectBase}error`);
  }

  try {
    const token = await exchangeGoogleCalendarCode(code);

    const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const profile = profileResponse.ok
      ? ((await profileResponse.json()) as { email?: string })
      : {};

    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_CALENDAR_PROVIDER },
      update: {
        status: "CONNECTED",
        accountEmail: profile.email ?? null,
        encryptedRefreshToken: token.refresh_token
          ? encryptSecret(token.refresh_token)
          : undefined,
        accessTokenExpiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000)
          : null,
        lastSyncAt: new Date(),
        lastError: null,
      },
      create: {
        provider: GOOGLE_CALENDAR_PROVIDER,
        status: "CONNECTED",
        accountEmail: profile.email ?? null,
        encryptedRefreshToken: token.refresh_token
          ? encryptSecret(token.refresh_token)
          : null,
        accessTokenExpiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000)
          : null,
        lastSyncAt: new Date(),
      },
    });

    return NextResponse.redirect(`${redirectBase}connected`);
  } catch (callbackError) {
    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_CALENDAR_PROVIDER },
      update: {
        status: "ERROR",
        lastError:
          callbackError instanceof Error ? callbackError.message : "OAuth callback failed",
      },
      create: {
        provider: GOOGLE_CALENDAR_PROVIDER,
        status: "ERROR",
        lastError:
          callbackError instanceof Error ? callbackError.message : "OAuth callback failed",
      },
    });
    return NextResponse.redirect(`${redirectBase}error`);
  }
}
