import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { filterIgnoredRows } from "./notion-import-ignore";
import {
  extractInstagramHandle,
  extractRelationTitles,
  toNullableString,
} from "../src/lib/notion-import/normalize";

const SELLER_DIRECTORY_PATH =
  "/Users/z9/Downloads/셀러디렉토리/셀러 디렉토리 211cfeed46138096bd63d692bbc6e345_all.csv";
const SALES_TRACKING_PATH =
  "/Users/z9/Downloads/세일즈트래킹/세일즈 트래킹 211cfeed4613809bb948f5d072e1a1ce_all.csv";

type SellerReviewRow = {
  reviewType: string;
  sourceKey: string;
  reviewReason: string;
  sellerName: string;
  candidateReason: string;
};

type CampaignReviewRow = {
  reviewType: string;
  sourceKey: string;
  reviewReason: string;
  sellerName: string;
  dealName: string;
  salesCode: string;
  candidateLabel: string;
};

type SellerDirectoryRow = {
  채널명: string;
  비고: string;
  세일즈_트래킹: string;
  업데이트: string;
  채널주소: string;
  카테고리: string;
  플랫폼: string;
};

type SalesTrackingRow = {
  세일즈코드: string;
  "셀러 정보": string;
  비고: string;
  브랜드: string;
  "생성 일시": string;
};

type SellerEvidence = {
  sellerDirectoryPresent: boolean;
  platform: string;
  handle: string;
  channelUrl: string;
  category: string;
  sellerUpdatedAt: string;
  sellerNote: string;
  sellerTrackingRefs: string[];
  sellerPageUrls: string[];
  linkedSalesRows: Array<{
    salesCode: string;
    brand: string;
    note: string;
    createdAt: string;
    sellerPageUrl: string;
  }>;
};

type SellerWorksheetEntry = {
  sellerName: string;
  sourceKey: string;
  reviewReason: string;
  candidateReason: string;
  campaigns: CampaignReviewRow[];
  evidence: SellerEvidence;
};

type SellerEvidenceExportRow = {
  sellerName: string;
  sourceKey: string;
  reviewReason: string;
  linkedCampaignCount: string;
  linkedCampaignSalesCodes: string;
  sellerDirectoryPresent: string;
  sellerUpdatedAt: string;
  sellerPlatform: string;
  sellerHandle: string;
  sellerChannelUrl: string;
  sellerCategory: string;
  sellerNote: string;
  sellerTrackingRefCount: string;
  sellerTrackingRefs: string;
  sellerPageUrls: string;
  linkedSalesRowCount: string;
  linkedSalesBrands: string;
  linkedSalesNotes: string;
};

/**
 * Parse a CSV artifact into typed rows and fail loudly if the file is missing.
 */
function readCsvRows<T>(relativePath: string): T[] {
  const absolutePath = join(process.cwd(), relativePath);
  const raw = readFileSync(absolutePath, "utf8");
  const parsed = Papa.parse<T>(raw, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    throw new Error(
      `Failed to parse ${relativePath}: ${parsed.errors.map((error) => error.message).join(", ")}`,
    );
  }

  return parsed.data;
}

function readAbsoluteCsvRows<T>(absolutePath: string): T[] {
  const raw = readFileSync(absolutePath, "utf8");
  const parsed = Papa.parse<T>(raw, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    throw new Error(
      `Failed to parse ${absolutePath}: ${parsed.errors.map((error) => error.message).join(", ")}`,
    );
  }

  return parsed.data;
}

/**
 * Extract the human-readable deal candidate label from the backlog export.
 */
function formatDealCandidate(candidateLabel: string): string {
  return candidateLabel.trim() || "No current deal candidate";
}

function extractUrls(value: string) {
  return [...value.matchAll(/https?:\/\/[^)\s,]+/g)].map((match) => match[0]);
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim() ?? "").filter(Boolean))];
}

function buildSellerEvidence(
  sellerName: string,
  directoryRows: SellerDirectoryRow[],
  trackingRows: SalesTrackingRow[],
): SellerEvidence {
  const directoryRow = directoryRows.find(
    (row) => toNullableString(row.채널명) === sellerName,
  );
  const matchingTrackingRows = trackingRows.filter((row) => {
    const relationTitles = extractRelationTitles(row["셀러 정보"]);
    return relationTitles.includes(sellerName);
  });

  const directoryTrackingRefs = extractRelationTitles(directoryRow?.세일즈_트래킹 ?? "");
  const directoryPageUrls = extractUrls(directoryRow?.세일즈_트래킹 ?? "");

  const linkedSalesRows = matchingTrackingRows.map((row) => ({
    salesCode: toNullableString(row.세일즈코드) ?? "",
    brand: toNullableString(row.브랜드) ?? "",
    note: toNullableString(row.비고) ?? "",
    createdAt: toNullableString(row["생성 일시"]) ?? "",
    sellerPageUrl: extractUrls(row["셀러 정보"] ?? "")[0] ?? "",
  }));

  const campaignPageUrls = linkedSalesRows
    .map((row) => row.sellerPageUrl)
    .filter(Boolean);

  return {
    sellerDirectoryPresent: Boolean(directoryRow),
    platform: toNullableString(directoryRow?.플랫폼) ?? "",
    handle: extractInstagramHandle(directoryRow?.채널주소) ?? "",
    channelUrl: toNullableString(directoryRow?.채널주소) ?? "",
    category: toNullableString(directoryRow?.카테고리) ?? "",
    sellerUpdatedAt: toNullableString(directoryRow?.업데이트) ?? "",
    sellerNote: toNullableString(directoryRow?.비고) ?? "",
    sellerTrackingRefs: directoryTrackingRefs,
    sellerPageUrls: uniqueStrings([...directoryPageUrls, ...campaignPageUrls]),
    linkedSalesRows,
  };
}

/**
 * Render one seller section with linked campaign blockers.
 */
function renderSellerSection(entry: SellerWorksheetEntry, index: number): string {
  const campaignLines =
    entry.campaigns.length > 0
      ? entry.campaigns
          .map((campaign) => {
            const dealCandidate = formatDealCandidate(campaign.candidateLabel);
            return [
              `- \`${campaign.salesCode}\``,
              `  - deal candidate already exists: \`${dealCandidate}\``,
            ].join("\n");
          })
          .join("\n")
      : "- none currently blocked only by this seller";

  const evidenceLines = [
    `- Seller directory row present: ${entry.evidence.sellerDirectoryPresent ? "yes" : "no"}`,
    `- Seller directory updated at: ${entry.evidence.sellerUpdatedAt || "none"}`,
    `- Seller directory platform: ${entry.evidence.platform || "none"}`,
    `- Seller directory handle: ${entry.evidence.handle || "none"}`,
    `- Seller directory channel URL: ${entry.evidence.channelUrl || "none"}`,
    `- Seller directory category: ${entry.evidence.category || "none"}`,
    `- Seller directory note: ${entry.evidence.sellerNote || "none"}`,
    `- Seller directory linked sales refs: ${
      entry.evidence.sellerTrackingRefs.length > 0
        ? entry.evidence.sellerTrackingRefs.map((value) => `\`${value}\``).join(", ")
        : "none"
    }`,
    `- Seller Notion page URLs: ${
      entry.evidence.sellerPageUrls.length > 0
        ? entry.evidence.sellerPageUrls.map((value) => `\`${value}\``).join(", ")
        : "none"
    }`,
    `- Matching sales-tracking rows: ${
      entry.evidence.linkedSalesRows.length > 0 ? String(entry.evidence.linkedSalesRows.length) : "0"
    }`,
    ...entry.evidence.linkedSalesRows.map(
      (row) =>
        `  - \`${row.salesCode || "unknown"}\` / brand \`${row.brand || "none"}\` / note \`${row.note || "none"}\` / created \`${row.createdAt || "none"}\``,
    ),
  ].join("\n");

  return `### ${index}. ${entry.sellerName}

- Review row: \`${entry.sourceKey}\`
- Reason: \`${entry.reviewReason}\`
- Current DB candidate: ${entry.candidateReason === "no-current-match" ? "none" : entry.candidateReason}

Decision:

- [ ] Existing seller alias
- [ ] Create new seller
- [ ] Hold

Operator notes:

- Confirmed platform:
- Confirmed handle:
- Confirmed channel URL:
- Existing seller id if merge:
- Manual action taken:

Linked campaigns:

${campaignLines}

Evidence:

${evidenceLines}`;
}

async function main() {
  const sellerRows = readCsvRows<SellerReviewRow>(
    "artifacts/notion-import-review-backlog.remote.confirm-channel-before-create.csv",
  ).filter((row) => row.reviewType === "seller");

  const campaignRows = readCsvRows<CampaignReviewRow>(
    "artifacts/notion-import-review-backlog.remote.resolve-seller-first.csv",
  ).filter((row) => row.reviewType === "campaign");
  const directoryRows = readAbsoluteCsvRows<SellerDirectoryRow>(SELLER_DIRECTORY_PATH);
  const trackingRows = readAbsoluteCsvRows<SalesTrackingRow>(SALES_TRACKING_PATH);

  const entries: SellerWorksheetEntry[] = filterIgnoredRows(sellerRows)
    .map((sellerRow) => ({
      sellerName: sellerRow.sellerName.trim(),
      sourceKey: sellerRow.sourceKey.trim(),
      reviewReason: sellerRow.reviewReason.trim(),
      candidateReason: sellerRow.candidateReason.trim(),
      campaigns: campaignRows.filter(
        (campaignRow) => campaignRow.sellerName.trim() === sellerRow.sellerName.trim(),
      ),
      evidence: buildSellerEvidence(
        sellerRow.sellerName.trim(),
        directoryRows,
        trackingRows,
      ),
    }))
    .sort((left, right) => left.sellerName.localeCompare(right.sellerName, "ko"));

  const lines = [
    "# Notion Import Seller Triage Worksheet",
    "",
    "Last updated: 2026-05-16",
    "",
    "## Purpose",
    "",
    "Resolve the highest-priority seller review queue first so the blocked campaign",
    "rows can be re-imported with minimal follow-up work.",
    "",
    "Related artifacts:",
    "",
    "- `artifacts/notion-import-review-backlog.remote.confirm-channel-before-create.csv`",
    "- `artifacts/notion-import-review-backlog.remote.resolve-seller-first.csv`",
    "",
    "## Decision Rules",
    "",
    "- If the seller is confirmed as an existing creator under another display name:",
    "  - update the existing seller row with the correct handle/channel URL",
    "  - mark linked campaign rows as ready for re-import",
    "- If the seller is a real new creator:",
    "  - create the seller manually with confirmed platform + handle",
    "  - then re-run remote dry-run for campaigns",
    "- If identity cannot be confirmed:",
    "  - keep seller and linked campaigns on hold",
    "",
    "## Seller Queue",
    "",
    ...entries.flatMap((entry, index) => [renderSellerSection(entry, index + 1), ""]),
    "## Re-import Order After Seller Resolution",
    "",
    "1. Apply seller corrections or manual seller create.",
    "2. Re-run `npm run notion:triage:refresh` to refresh backlog artifacts and worksheets.",
    "3. If the remote export step is temporarily unavailable, the refresh command still",
    "   regenerates worksheets from the latest local backlog artifacts.",
    "4. If seller-linked campaign rows disappear from review, move to campaign apply pass.",
    "",
  ];

  const outputPath = join(process.cwd(), "NOTION_IMPORT_SELLER_TRIAGE_WORKSHEET.md");
  const evidenceOutputPath = join(
    process.cwd(),
    "artifacts/notion-import-seller-triage-evidence.csv",
  );
  writeFileSync(outputPath, `${lines.join("\n")}`);

  const evidenceRows: SellerEvidenceExportRow[] = entries.map((entry) => ({
    sellerName: entry.sellerName,
    sourceKey: entry.sourceKey,
    reviewReason: entry.reviewReason,
    linkedCampaignCount: String(entry.campaigns.length),
    linkedCampaignSalesCodes: entry.campaigns.map((campaign) => campaign.salesCode).join(" | "),
    sellerDirectoryPresent: entry.evidence.sellerDirectoryPresent ? "yes" : "no",
    sellerUpdatedAt: entry.evidence.sellerUpdatedAt,
    sellerPlatform: entry.evidence.platform,
    sellerHandle: entry.evidence.handle,
    sellerChannelUrl: entry.evidence.channelUrl,
    sellerCategory: entry.evidence.category,
    sellerNote: entry.evidence.sellerNote,
    sellerTrackingRefCount: String(entry.evidence.sellerTrackingRefs.length),
    sellerTrackingRefs: entry.evidence.sellerTrackingRefs.join(" | "),
    sellerPageUrls: entry.evidence.sellerPageUrls.join(" | "),
    linkedSalesRowCount: String(entry.evidence.linkedSalesRows.length),
    linkedSalesBrands: entry.evidence.linkedSalesRows.map((row) => row.brand).join(" | "),
    linkedSalesNotes: entry.evidence.linkedSalesRows.map((row) => row.note || "none").join(" | "),
  }));
  writeFileSync(evidenceOutputPath, `${Papa.unparse(evidenceRows)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputPath,
        evidenceOutputPath,
        sellerCount: entries.length,
        blockedCampaignCount: campaignRows.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
