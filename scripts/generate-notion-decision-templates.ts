import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { filterIgnoredRows } from "./notion-import-ignore";

type SellerReviewRow = {
  reviewType: string;
  sourceKey: string;
  reviewReason: string;
  sellerName: string;
  candidateId: string;
  candidateLabel: string;
};

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
  candidateId: string;
  candidateLabel: string;
};

type SellerDecisionTemplateRow = {
  sourceKey: string;
  sellerName: string;
  reviewReason: string;
  candidateId: string;
  candidateLabel: string;
  decisionOptions: string;
  decision: string;
  confirmedPlatform: string;
  confirmedHandle: string;
  confirmedChannelUrl: string;
  existingSellerId: string;
  notes: string;
};

type DealDecisionTemplateRow = {
  sourceKey: string;
  partnerOrBrand: string;
  dealName: string;
  reviewReason: string;
  candidateId: string;
  candidateLabel: string;
  decisionOptions: string;
  decision: string;
  confirmedPartnerName: string;
  confirmedBrandName: string;
  existingDealId: string;
  notes: string;
};

type CampaignDecisionTemplateRow = {
  sourceKey: string;
  salesCode: string;
  sellerName: string;
  dealName: string;
  reviewReason: string;
  sellerCandidateId: string;
  sellerCandidateLabel: string;
  dealCandidateId: string;
  dealCandidateLabel: string;
  decisionOptions: string;
  decision: string;
  normalizedSalesCode: string;
  normalizedSellerId: string;
  normalizedDealId: string;
  notes: string;
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

function splitCandidatePair(value: string) {
  const [left = "", right = ""] = value.split("|").map((entry) => entry.trim());
  return [left, right] as const;
}

function writeTemplateCsv<T extends Record<string, string>>(
  outputPath: string,
  rows: T[],
  fields: Array<keyof T>,
) {
  const csv = Papa.unparse({
    fields: fields as string[],
    data: rows,
  });
  writeFileSync(outputPath, `${csv}\n`);
}

async function main() {
  const sellerRows = readCsvRows<SellerReviewRow>(
    "artifacts/notion-import-review-backlog.remote.confirm-channel-before-create.csv",
  ).filter((row) => row.reviewType === "seller");
  const dealRows = readCsvRows<DealReviewRow>(
    "artifacts/notion-import-review-backlog.remote.decide-merge-vs-separate-deal.csv",
  ).filter((row) => row.reviewType === "deal");
  const campaignRows = readCsvRows<CampaignReviewRow>(
    "artifacts/notion-import-review-backlog.remote.create-campaign-after-name-normalization.csv",
  ).filter((row) => row.reviewType === "campaign");

  const sellerTemplateRows: SellerDecisionTemplateRow[] = filterIgnoredRows(sellerRows).map((row) => ({
    sourceKey: row.sourceKey.trim(),
    sellerName: row.sellerName.trim(),
    reviewReason: row.reviewReason.trim(),
    candidateId: row.candidateId.trim(),
    candidateLabel: row.candidateLabel.trim(),
    decisionOptions: "existing-seller-alias|create-new-seller|hold",
    decision: "",
    confirmedPlatform: "",
    confirmedHandle: "",
    confirmedChannelUrl: "",
    existingSellerId: "",
    notes: "",
  }));

  const dealTemplateRows: DealDecisionTemplateRow[] = dealRows.map((row) => ({
    sourceKey: row.sourceKey.trim(),
    partnerOrBrand: row.partnerOrBrand.trim(),
    dealName: row.dealName.trim(),
    reviewReason: row.reviewReason.trim(),
    candidateId: row.candidateId.trim(),
    candidateLabel: row.candidateLabel.trim(),
    decisionOptions: "merge-existing-deal|create-separate-deal|hold",
    decision: "",
    confirmedPartnerName: "",
    confirmedBrandName: "",
    existingDealId: "",
    notes: "",
  }));

  const campaignTemplateRows: CampaignDecisionTemplateRow[] = campaignRows.map((row) => {
    const [sellerCandidateId, dealCandidateId] = splitCandidatePair(row.candidateId);
    const [sellerCandidateLabel, dealCandidateLabel] = splitCandidatePair(row.candidateLabel);

    return {
      sourceKey: row.sourceKey.trim(),
      salesCode: row.salesCode.trim(),
      sellerName: row.sellerName.trim(),
      dealName: row.dealName.trim(),
      reviewReason: row.reviewReason.trim(),
      sellerCandidateId,
      sellerCandidateLabel,
      dealCandidateId,
      dealCandidateLabel,
      decisionOptions: "create-normalized-campaign|hold",
      decision: "",
      normalizedSalesCode: "",
      normalizedSellerId: "",
      normalizedDealId: "",
      notes: "",
    };
  });

  const artifactDir = join(process.cwd(), "artifacts");
  const sellerOutputPath = join(artifactDir, "notion-import-seller-decisions.template.csv");
  const dealOutputPath = join(artifactDir, "notion-import-deal-decisions.template.csv");
  const campaignOutputPath = join(
    artifactDir,
    "notion-import-campaign-decisions.template.csv",
  );

  writeTemplateCsv(sellerOutputPath, sellerTemplateRows, [
    "sourceKey",
    "sellerName",
    "reviewReason",
    "candidateId",
    "candidateLabel",
    "decisionOptions",
    "decision",
    "confirmedPlatform",
    "confirmedHandle",
    "confirmedChannelUrl",
    "existingSellerId",
    "notes",
  ]);
  writeTemplateCsv(dealOutputPath, dealTemplateRows, [
    "sourceKey",
    "partnerOrBrand",
    "dealName",
    "reviewReason",
    "candidateId",
    "candidateLabel",
    "decisionOptions",
    "decision",
    "confirmedPartnerName",
    "confirmedBrandName",
    "existingDealId",
    "notes",
  ]);
  writeTemplateCsv(campaignOutputPath, campaignTemplateRows, [
    "sourceKey",
    "salesCode",
    "sellerName",
    "dealName",
    "reviewReason",
    "sellerCandidateId",
    "sellerCandidateLabel",
    "dealCandidateId",
    "dealCandidateLabel",
    "decisionOptions",
    "decision",
    "normalizedSalesCode",
    "normalizedSellerId",
    "normalizedDealId",
    "notes",
  ]);

  console.log(
    JSON.stringify(
      {
        ok: true,
        sellerOutputPath,
        dealOutputPath,
        campaignOutputPath,
        sellerCount: sellerTemplateRows.length,
        dealCount: dealTemplateRows.length,
        campaignCount: campaignTemplateRows.length,
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
