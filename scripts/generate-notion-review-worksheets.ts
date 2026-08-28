import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { readFileSync } from "node:fs";

type DealReviewRow = {
  reviewType: string;
  sourceKey: string;
  reviewReason: string;
  dealName: string;
  partnerOrBrand: string;
  candidateId: string;
  candidateLabel: string;
};

type CampaignReviewRow = {
  reviewType: string;
  sourceKey: string;
  reviewReason: string;
  sellerName: string;
  dealName: string;
  salesCode: string;
  sourceCreatedAt: string;
  candidateId: string;
  candidateLabel: string;
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

function renderDealSection(row: DealReviewRow, index: number): string {
  return `### ${index}. ${row.partnerOrBrand} / ${row.dealName}

- Review row: \`${row.sourceKey}\`
- Reason: \`${row.reviewReason}\`
- Imported partner or brand: \`${row.partnerOrBrand}\`
- Current DB candidate: \`${row.candidateLabel.trim() || "none"}\`
- Current DB candidate id: \`${row.candidateId.trim() || "none"}\`

Decision:

- [ ] Merge into existing deal
- [ ] Create separate deal
- [ ] Hold

Operator notes:

- Operating partner confirmed:
- Brand label confirmed:
- Existing deal id if merge:
- Manual action taken:
- Notes:
`;
}

function renderCampaignSection(row: CampaignReviewRow, index: number): string {
  const [sellerCandidate = "", dealCandidate = ""] = row.candidateLabel
    .split("|")
    .map((value) => value.trim());

  const [sellerCandidateId = "", dealCandidateId = ""] = row.candidateId
    .split("|")
    .map((value) => value.trim());

  return `### ${index}. ${row.salesCode}

- Review row: \`${row.sourceKey}\`
- Reason: \`${row.reviewReason}\`
- Seller: \`${row.sellerName}\`
- Deal: \`${row.dealName}\`
- Source created at: \`${row.sourceCreatedAt}\`
- Seller candidate: \`${sellerCandidate || "none"}\`
- Seller candidate id: \`${sellerCandidateId || "none"}\`
- Deal candidate: \`${dealCandidate || "none"}\`
- Deal candidate id: \`${dealCandidateId || "none"}\`

Decision:

- [ ] Normalize to existing deal and create campaign
- [ ] Hold

Operator notes:

- Normalized sales code:
- Normalized seller id:
- Normalized deal id:
- Manual action taken:
- Notes:
`;
}

function buildDealWorksheet(rows: DealReviewRow[]): string {
  const sections = rows
    .filter((row) => row.reviewType === "deal")
    .sort((left, right) => {
      const partnerCompare = left.partnerOrBrand.localeCompare(right.partnerOrBrand, "ko");
      return partnerCompare !== 0
        ? partnerCompare
        : left.dealName.localeCompare(right.dealName, "ko");
    })
    .map((row, index) => renderDealSection(row, index + 1))
    .join("\n");

  return `# Notion Import Deal Review Worksheet

Last updated: 2026-05-16

## Purpose

Resolve deal rows that matched by product name but still require an operator
decision on whether to merge into the current CRM deal or create a separate
operational deal.

Related artifact:

- \`artifacts/notion-import-review-backlog.remote.decide-merge-vs-separate-deal.csv\`

## Decision Rules

- Partner = operating or settlement owner.
- Brand = market-facing label.
- Deal = one product or offer unit.
- Campaign = one sales execution against an existing deal.
- If the imported partner or brand matches the current CRM candidate owner:
  - merge into the existing deal
- If the product name matches but the imported partner or brand differs from the CRM candidate owner:
  - create a separate deal
- If the imported owner is missing or still ambiguous:
  - hold the row
- Same brand with different products should stay as separate deals.
- The same product sold repeatedly should reuse one deal and create new campaigns.
- Cosmetic naming differences alone should not create a new deal.

## Deal Queue

${sections}
## Re-import Order After Deal Resolution

1. Apply merge decisions or create separate deals manually.
2. Re-run \`npm run notion:triage:refresh\` to refresh backlog artifacts and worksheets.
3. If the remote export step is temporarily unavailable, the refresh command still
   regenerates worksheets from the latest local backlog artifacts.
4. If deal-linked campaign rows disappear from review, move to campaign apply pass.
`;
}

function buildCampaignWorksheet(rows: CampaignReviewRow[]): string {
  const sections = rows
    .filter((row) => row.reviewType === "campaign")
    .sort((left, right) => left.salesCode.localeCompare(right.salesCode, "ko"))
    .map((row, index) => renderCampaignSection(row, index + 1))
    .join("\n");

  return `# Notion Import Campaign Normalization Worksheet

Last updated: 2026-05-16

## Purpose

Resolve campaign rows where seller and deal candidates already exist, but the
campaign import still requires explicit normalization before creation.

Related artifact:

- \`artifacts/notion-import-review-backlog.remote.create-campaign-after-name-normalization.csv\`

## Decision Rules

- If the candidate seller and deal are correct:
  - normalize names to the current CRM records
  - allow campaign creation on the next import pass
- If either candidate is wrong:
  - hold the row
  - correct the upstream mapping first

## Campaign Queue

${sections}
## Re-import Order After Campaign Normalization

1. Confirm normalized seller and deal mappings for each campaign row.
2. Re-run \`npm run notion:triage:refresh\` to refresh backlog artifacts and worksheets.
3. If the remote export step is temporarily unavailable, the refresh command still
   regenerates worksheets from the latest local backlog artifacts.
4. Apply only after the normalization queue clears without introducing new review rows.
`;
}

async function main() {
  const dealRows = readCsvRows<DealReviewRow>(
    "artifacts/notion-import-review-backlog.remote.decide-merge-vs-separate-deal.csv",
  );
  const campaignRows = readCsvRows<CampaignReviewRow>(
    "artifacts/notion-import-review-backlog.remote.create-campaign-after-name-normalization.csv",
  );

  const dealOutputPath = join(process.cwd(), "NOTION_IMPORT_DEAL_REVIEW_WORKSHEET.md");
  const campaignOutputPath = join(
    process.cwd(),
    "NOTION_IMPORT_CAMPAIGN_NORMALIZATION_WORKSHEET.md",
  );

  writeFileSync(dealOutputPath, `${buildDealWorksheet(dealRows)}\n`);
  writeFileSync(campaignOutputPath, `${buildCampaignWorksheet(campaignRows)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        dealOutputPath,
        campaignOutputPath,
        dealCount: dealRows.filter((row) => row.reviewType === "deal").length,
        campaignCount: campaignRows.filter((row) => row.reviewType === "campaign").length,
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
