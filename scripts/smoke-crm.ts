import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const baseUrl = (process.env.WAG_CRM_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const smokeAssetUrl = "https://example.com/smoke-asset-link";
const smokeConversionEvent = "smoke_test_conversion";

type JsonRecord = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(response: Response) {
  const raw = await response.text();
  return raw ? (JSON.parse(raw) as JsonRecord) : {};
}

async function getDevAuthCookie() {
  const response = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: "POST",
    redirect: "manual",
  });
  const cookie = response.headers.get("set-cookie");
  assert(cookie, "Failed to acquire dev auth cookie");
  const match = cookie.match(/wag_crm_dev_auth=[^;]+/);
  assert(match, "Dev auth cookie was not returned");
  return match[0];
}

function hasDriveOAuthEnv() {
  return Boolean(
    process.env.GOOGLE_DRIVE_CLIENT_ID?.trim() &&
    process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim(),
  );
}

async function main() {
  const prisma = new PrismaClient();
  const cookie = await getDevAuthCookie();
  const headers = { cookie };
  const smokeCampaign = await prisma.salesCampaign.findFirst({
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  assert(smokeCampaign, "No campaign available for smoke QA");
  const campaignId = smokeCampaign.id;

  const initialAssetCount = await prisma.asset.count({ where: { archivedAt: null } });
  const initialSmokeConversionCount = await prisma.trackingAttribution.count({
    where: { conversionEvent: smokeConversionEvent },
  });

  let createdAssetId: string | null = null;
  let createdConversionId: string | null = null;
  let driveStatus: string | null = null;
  let driveCheckSkipped = false;

  try {
    const assetForm = new FormData();
    assetForm.set("entityType", "CAMPAIGN");
    assetForm.set("entityId", campaignId);
    assetForm.set("section", "PRODUCT_INTRO");
    assetForm.set("externalUrl", smokeAssetUrl);
    assetForm.set("fileName", smokeAssetUrl);
    assetForm.set("notes", "Smoke asset link");
    assetForm.set("provider", "EXTERNAL_LINK");

    const assetResponse = await fetch(`${baseUrl}/api/assets`, {
      method: "POST",
      headers,
      body: assetForm,
    });
    const assetJson = await readJson(assetResponse);
    assert(assetResponse.ok, `Asset smoke create failed: ${JSON.stringify(assetJson)}`);
    createdAssetId = String((assetJson.asset as JsonRecord).id);
    assert(createdAssetId, "Asset smoke create returned no asset id");

    if (hasDriveOAuthEnv()) {
      const driveResponse = await fetch(`${baseUrl}/api/integrations/google-drive/test`, {
        method: "POST",
        headers,
      });
      const driveJson = await readJson(driveResponse);
      assert(driveResponse.ok, `Drive smoke test failed: ${JSON.stringify(driveJson)}`);
      driveStatus = String(driveJson.status);
      assert(
        ["CONNECTED", "DISCONNECTED"].includes(driveStatus),
        `Unexpected Drive status: ${JSON.stringify(driveJson)}`,
      );
    } else {
      driveCheckSkipped = true;
    }

    const conversionResponse = await fetch(`${baseUrl}/api/conversions`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        campaignId,
        nt_source: "INSTAGRAM",
        nt_medium: "seller-mina",
        nt_detail: campaignId,
        landingUrl: `${baseUrl}/`,
        conversionEvent: smokeConversionEvent,
        payload: { source: "smoke-script" },
      }),
    });
    const conversionJson = await readJson(conversionResponse);
    assert(
      conversionResponse.ok,
      `Conversion smoke create failed: ${JSON.stringify(conversionJson)}`,
    );
    createdConversionId = String(conversionJson.id);
    assert(createdConversionId, "Conversion smoke create returned no id");

    const storedConversion = await prisma.trackingAttribution.findUnique({
      where: { id: createdConversionId },
      select: {
        id: true,
        campaignId: true,
        ntSource: true,
        ntMedium: true,
        ntDetail: true,
        conversionEvent: true,
      },
    });
    assert(storedConversion, "Conversion smoke row was not persisted");

    console.log(
      JSON.stringify(
        {
          ok: true,
          baseUrl,
          driveStatus,
          driveCheckSkipped,
          createdAssetId,
          createdConversionId,
        },
        null,
        2,
      ),
    );
  } finally {
    if (createdAssetId) {
      await fetch(`${baseUrl}/api/assets/${createdAssetId}`, {
        method: "DELETE",
        headers,
      });
    }
    if (createdConversionId) {
      await prisma.trackingAttribution.deleteMany({
        where: { id: createdConversionId },
      });
    }

    const finalAssetCount = await prisma.asset.count({ where: { archivedAt: null } });
    const finalSmokeConversionCount = await prisma.trackingAttribution.count({
      where: { conversionEvent: smokeConversionEvent },
    });

    assert(
      finalAssetCount === initialAssetCount,
      `Asset count drifted: before=${initialAssetCount} after=${finalAssetCount}`,
    );
    assert(
      finalSmokeConversionCount === initialSmokeConversionCount,
      `Smoke conversions were not cleaned up: before=${initialSmokeConversionCount} after=${finalSmokeConversionCount}`,
    );

    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
