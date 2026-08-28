import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { recordSellerFollowersSnapshot } from "@/lib/seller-history";
import { YOUTUBE_SNAPSHOT_SOURCE } from "@/lib/collectors/youtube-collector";
import { verifyCronQuerySecret } from "@/lib/cron-auth";

async function logApiCall(
  provider: string,
  endpoint: string,
  statusCode: number,
  success: boolean,
  errorMessage: string | null = null,
  permissionScope: string | null = null,
  metadata: string | null = null
) {
  try {
    const prisma = getPrisma();
    await prisma.apiCallLog.create({
      data: {
        provider,
        permissionScope,
        endpoint,
        statusCode,
        success,
        errorMessage,
        metadata,
      },
    });
  } catch (err) {
    console.error("[logApiCall] Failed to log API call:", err);
  }
}

export async function POST(req: NextRequest) {
  try {
    // 1. Secret Key validation — Apify 웹훅 설정은 URL 만 받으므로 이 경로만 쿼리형이다.
    if (!verifyCronQuerySecret(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2. Parse Webhook Payload
    const body = await req.json();
    const { resource } = body;
    const { defaultDatasetId } = resource;

    if (!defaultDatasetId) {
      await logApiCall("YOUTUBE", "/api/cron/apify-webhook/youtube", 400, false, "No dataset ID", "apify", JSON.stringify(body));
      return NextResponse.json({ error: "No dataset ID provided" }, { status: 400 });
    }

    // 3. Fetch data from Apify Dataset
    const apifyToken = process.env.APIFY_API_TOKEN;
    const datasetUrl = `https://api.apify.com/v2/datasets/${defaultDatasetId}/items?token=${apifyToken}`;
    
    const response = await fetch(datasetUrl);
    if (!response.ok) {
      const errText = await response.text();
      await logApiCall("YOUTUBE", datasetUrl, response.status, false, "Failed to fetch dataset items", "apify", errText);
      return NextResponse.json({ error: "Failed to fetch dataset items" }, { status: 500 });
    }

    const items = await response.json();

    // 4. Process each item
    let successCount = 0;
    let failedCount = 0;

    for (const item of items) {
      try {
        const url = item.url || item.channelUrl; // YouTube scraper usually returns the URL
        if (!url) {
          failedCount++;
          continue;
        }

        // Extract handle from url
        // e.g. https://www.youtube.com/@handle or https://www.youtube.com/channel/UC...
        let handle = "";
        if (url.includes("@")) {
          handle = url.split("@")[1]?.split("/")[0];
        } else if (url.includes("/channel/")) {
          handle = url.split("/channel/")[1]?.split("/")[0];
        }

        if (!handle) {
          failedCount++;
          continue;
        }

        const prisma = getPrisma();
        // Find matching seller
        const seller = await prisma.seller.findFirst({
          where: { snsHandle: handle },
        });

        if (!seller) {
          // It's possible the original snsHandle was a little different, maybe fallback to searching
          failedCount++;
          continue;
        }

        const subscriberCount = item.numberOfSubscribers ?? item.subscribersCount ?? item.subscribers;

        if (typeof subscriberCount !== "number") {
          await logApiCall("YOUTUBE", "Webhook Item Processing", 200, false, "Subscriber count missing", "apify", JSON.stringify(item));
          failedCount++;
          continue;
        }

        // 라벨 SSOT 는 수집기 쪽 상수다(이 웹훅이 Apify 갈래의 실제 writer).
        await recordSellerFollowersSnapshot(seller.id, subscriberCount, YOUTUBE_SNAPSHOT_SOURCE.APIFY);

        await prisma.seller.update({
          where: { id: seller.id },
          data: { currentFollowers: subscriberCount },
        });

        successCount++;
        await logApiCall("YOUTUBE", "Webhook Item Processing", 200, true, null, "apify", JSON.stringify({ sellerId: seller.id, handle: handle, subscribers: subscriberCount }));

      } catch (err) {
        failedCount++;
        const errMsg = err instanceof Error ? err.message : "Unknown error processing item";
        await logApiCall("YOUTUBE", "Webhook Item Processing", 500, false, errMsg, "apify", JSON.stringify(item));
      }
    }

    return NextResponse.json({ success: true, successCount, failedCount });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown webhook error";
    await logApiCall("YOUTUBE", "/api/cron/apify-webhook/youtube", 500, false, errMsg, "apify", null);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
