import { NextResponse } from "next/server";
import {
  encryptSecret,
  ensureGoogleDriveRootFolder,
  exchangeGoogleDriveCode,
  GOOGLE_DRIVE_PROVIDER,
} from "@/lib/asset-storage";
import { getPrisma } from "@/lib/prisma";
import { revalidateCrmTags, CRM_CACHE_TAGS } from "@/lib/cache-tags";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const assetsUrl = `${appUrl}/assets`;

  if (!code && !error) {
    return NextResponse.redirect(`${assetsUrl}?drive=error`);
  }

  if (error) {
    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_DRIVE_PROVIDER },
      update: { status: "ERROR", lastError: error },
      create: {
        provider: GOOGLE_DRIVE_PROVIDER,
        status: "ERROR",
        lastError: error,
      },
    });
    revalidateCrmTags([CRM_CACHE_TAGS.dashboard]);
    return NextResponse.redirect(`${assetsUrl}?drive=error`);
  }

  if (!code) {
    return NextResponse.redirect(`${assetsUrl}?drive=error`);
  }

  const oauthCode = code;

  try {
    const token = await exchangeGoogleDriveCode(oauthCode);
    const rootFolderId = await ensureGoogleDriveRootFolder(token.access_token);
    const profileResponse = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      { headers: { Authorization: `Bearer ${token.access_token}` } },
    );
    const profile = profileResponse.ok
      ? ((await profileResponse.json()) as { email?: string })
      : {};

    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_DRIVE_PROVIDER },
      update: {
        status: "CONNECTED",
        accountEmail: profile.email ?? null,
        rootFolderId,
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
        provider: GOOGLE_DRIVE_PROVIDER,
        status: "CONNECTED",
        accountEmail: profile.email ?? null,
        rootFolderId,
        encryptedRefreshToken: token.refresh_token
          ? encryptSecret(token.refresh_token)
          : null,
        accessTokenExpiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000)
          : null,
        lastSyncAt: new Date(),
      },
    });
    revalidateCrmTags([CRM_CACHE_TAGS.dashboard]);
    return NextResponse.redirect(`${assetsUrl}?drive=connected`);
  } catch (callbackError) {
    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_DRIVE_PROVIDER },
      update: {
        status: "ERROR",
        lastError:
          callbackError instanceof Error ? callbackError.message : "OAuth callback failed",
      },
      create: {
        provider: GOOGLE_DRIVE_PROVIDER,
        status: "ERROR",
        lastError:
          callbackError instanceof Error ? callbackError.message : "OAuth callback failed",
      },
    });
    revalidateCrmTags([CRM_CACHE_TAGS.dashboard]);
    return NextResponse.redirect(`${assetsUrl}?drive=error`);
  }
}
