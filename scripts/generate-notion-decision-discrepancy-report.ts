import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";

type SellerDecisionRow = {
  sourceKey: string;
  sellerName: string;
  reviewReason: string;
  decision: string;
  notes: string;
  recommendedDecision?: string;
  recommendedReason?: string;
  recommendedAction?: string;
};

type DealDecisionRow = {
  sourceKey: string;
  partnerOrBrand: string;
  dealName: string;
  reviewReason: string;
  decision: string;
  notes: string;
  recommendedDecision?: string;
  recommendedReason?: string;
  recommendedAction?: string;
};

type DiscrepancyRow = {
  entity: "seller" | "deal";
  sourceKey: string;
  label: string;
  currentDecision: string;
  recommendedDecision: string;
  reviewReason: string;
  recommendedReason: string;
  recommendedAction: string;
  notes: string;
};

function readCsv<T>(relativePath: string) {
  const raw = readFileSync(join(process.cwd(), relativePath), "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) {
    return [];
  }
  const parsed = Papa.parse<T>(raw, { header: true, skipEmptyLines: true });
  const nonIgnorableErrors = parsed.errors.filter(
    (error) =>
      !error.message.includes("Unable to auto-detect delimiting character") &&
      !(parsed.data.length === 0 && error.message.includes("Too few fields")),
  );
  if (nonIgnorableErrors.length > 0) {
    throw new Error(
      `Failed to parse ${relativePath}: ${nonIgnorableErrors.map((error) => error.message).join(", ")}`,
    );
  }
  return parsed.data;
}

function clean(value: string | undefined) {
  return (value ?? "").replace(/\r?\n/g, " ").trim();
}

function norm(value: string | undefined) {
  return clean(value).toLowerCase();
}

function collectSellerRows(rows: SellerDecisionRow[]): DiscrepancyRow[] {
  return rows.flatMap((row) => {
    const currentDecision = clean(row.decision);
    const recommendedDecision = clean(row.recommendedDecision);
    if (!currentDecision || !recommendedDecision || norm(currentDecision) === norm(recommendedDecision)) {
      return [];
    }

    return [{
      entity: "seller",
      sourceKey: clean(row.sourceKey),
      label: clean(row.sellerName),
      currentDecision,
      recommendedDecision,
      reviewReason: clean(row.reviewReason),
      recommendedReason: clean(row.recommendedReason),
      recommendedAction: clean(row.recommendedAction),
      notes: clean(row.notes),
    }];
  });
}

function collectDealRows(rows: DealDecisionRow[]): DiscrepancyRow[] {
  return rows.flatMap((row) => {
    const currentDecision = clean(row.decision);
    const recommendedDecision = clean(row.recommendedDecision);
    if (!currentDecision || !recommendedDecision || norm(currentDecision) === norm(recommendedDecision)) {
      return [];
    }

    return [{
      entity: "deal",
      sourceKey: clean(row.sourceKey),
      label: `${clean(row.partnerOrBrand)} / ${clean(row.dealName)}`.trim(),
      currentDecision,
      recommendedDecision,
      reviewReason: clean(row.reviewReason),
      recommendedReason: clean(row.recommendedReason),
      recommendedAction: clean(row.recommendedAction),
      notes: clean(row.notes),
    }];
  });
}

function renderSection(title: string, rows: DiscrepancyRow[]) {
  if (rows.length === 0) {
    return [`## ${title}`, "", "- none", ""].join("\n");
  }

  return [
    `## ${title}`,
    "",
    ...rows.map((row, index) => [
      `### ${index + 1}. ${row.label}`,
      "",
      `- Entity: \`${row.entity}\``,
      `- Source key: \`${row.sourceKey}\``,
      `- Current decision: \`${row.currentDecision}\``,
      `- Recommended decision: \`${row.recommendedDecision}\``,
      `- Review reason: \`${row.reviewReason || "none"}\``,
      `- Recommended reason: \`${row.recommendedReason || "none"}\``,
      `- Recommended action: \`${row.recommendedAction || "none"}\``,
      `- Notes: \`${row.notes || "none"}\``,
      "",
    ].join("\n")),
  ].join("\n");
}

function main() {
  const sellerRows = readCsv<SellerDecisionRow>("artifacts/notion-import-seller-decisions.template.csv");
  const dealRows = readCsv<DealDecisionRow>("artifacts/notion-import-deal-decisions.template.csv");

  const discrepancies = [
    ...collectSellerRows(sellerRows),
    ...collectDealRows(dealRows),
  ];
  const sellerDiscrepancies = discrepancies.filter((row) => row.entity === "seller");
  const dealDiscrepancies = discrepancies.filter((row) => row.entity === "deal");

  const markdown = [
    "# Notion Decision Discrepancy Report",
    "",
    "Last updated: 2026-05-17",
    "",
    "## Summary",
    "",
    `- Total discrepancy rows: \`${discrepancies.length}\``,
    `- Seller discrepancy rows: \`${sellerDiscrepancies.length}\``,
    `- Deal discrepancy rows: \`${dealDiscrepancies.length}\``,
    "",
    "Use this report when the current `decision` value differs from the current recommendation.",
    "",
    renderSection("Seller Queue", sellerDiscrepancies),
    renderSection("Deal Queue", dealDiscrepancies),
  ].join("\n");

  const markdownPath = join(process.cwd(), "NOTION_IMPORT_DECISION_DISCREPANCY_REPORT.md");
  const csvPath = join(process.cwd(), "artifacts/notion-import-decision-discrepancies.csv");

  writeFileSync(markdownPath, `${markdown}\n`);
  writeFileSync(csvPath, `${Papa.unparse(discrepancies)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        markdownPath,
        csvPath,
        total: discrepancies.length,
        sellerCount: sellerDiscrepancies.length,
        dealCount: dealDiscrepancies.length,
      },
      null,
      2,
    ),
  );
}

main();
