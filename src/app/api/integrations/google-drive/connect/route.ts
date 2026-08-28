import { NextResponse } from "next/server";
import { buildGoogleDriveAuthUrl, GOOGLE_DRIVE_PROVIDER } from "@/lib/asset-storage";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";

export async function POST() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;
  try {
    const authUrl = buildGoogleDriveAuthUrl();
    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_DRIVE_PROVIDER },
      update: { status: "DISCONNECTED", lastError: null },
      create: { provider: GOOGLE_DRIVE_PROVIDER, status: "DISCONNECTED" },
    });
    return NextResponse.json({ authUrl });
  } catch (error) {
    await getPrisma().storageIntegration.upsert({
      where: { provider: GOOGLE_DRIVE_PROVIDER },
      update: {
        status: "ERROR",
        lastError: error instanceof Error ? error.message : "Unknown error",
      },
      create: {
        provider: GOOGLE_DRIVE_PROVIDER,
        status: "ERROR",
        lastError: error instanceof Error ? error.message : "Unknown error",
      },
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Google Drive connect failed" },
      { status: 400 },
    );
  }
}
