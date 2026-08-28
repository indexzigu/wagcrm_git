import { NextResponse } from "next/server";
import { getGoogleDriveConnectionStatus, GOOGLE_DRIVE_PROVIDER } from "@/lib/asset-storage";
import { getPrisma } from "@/lib/prisma";

export async function POST() {
  const status = await getGoogleDriveConnectionStatus();
  await getPrisma().storageIntegration.upsert({
    where: { provider: GOOGLE_DRIVE_PROVIDER },
    update: {
      status: status.connected ? "CONNECTED" : "DISCONNECTED",
      accountEmail: status.accountEmail,
      rootFolderId: status.rootFolderId,
      lastSyncAt: new Date(),
      lastError: status.connected ? null : status.lastError,
    },
    create: {
      provider: GOOGLE_DRIVE_PROVIDER,
      status: status.connected ? "CONNECTED" : "DISCONNECTED",
      accountEmail: status.accountEmail,
      rootFolderId: status.rootFolderId,
      lastSyncAt: new Date(),
      lastError: status.connected ? null : status.lastError,
    },
  });
  return NextResponse.json(status);
}
