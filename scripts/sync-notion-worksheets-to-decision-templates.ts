import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";

type CsvRow = Record<string, string>;

type Section = {
  title: string;
  body: string;
};

function readText(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function readCsv(relativePath: string) {
  const csvText = readText(relativePath);
  if (!csvText.trim()) {
    return [];
  }
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) {
    return [];
  }
  const parsed = Papa.parse<CsvRow>(csvText, {
    header: true,
    skipEmptyLines: true,
  });
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

function writeCsv(relativePath: string, rows: CsvRow[]) {
  const sanitizedRows = rows.map((row) => {
    const next: CsvRow = {};
    for (const [key, rawValue] of Object.entries(row)) {
      const value = String(rawValue ?? "")
        .replace(/\r?\n/g, " ")
        .trim();
      next[key] = value === `"` ? "" : value;
    }
    return next;
  });
  writeFileSync(join(process.cwd(), relativePath), `${Papa.unparse(sanitizedRows)}\n`);
}

function splitSections(markdown: string) {
  const sectionRegex = /^###\s+\d+\.\s+(.+)$/gm;
  const sections: Section[] = [];
  const matches = [...markdown.matchAll(sectionRegex)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match || match.index == null) continue;
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    sections.push({
      title: match[1]?.trim() ?? "",
      body: markdown.slice(start, end).trim(),
    });
  }
  return sections;
}

function extractReviewRow(sectionBody: string) {
  const match = sectionBody.match(/- Review row:\s*`([^`]+)`/);
  return match?.[1]?.trim() ?? "";
}

function extractCheckedDecision(sectionBody: string, labels: string[]) {
  for (const label of labels) {
    const regex = new RegExp(`- \\[(x|X)\\] ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    if (regex.test(sectionBody)) return label;
  }
  return "";
}

function extractField(sectionBody: string, label: string) {
  const lines = sectionBody.split("\n");
  const prefix = `- ${label}`;
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return "";
}

function compactNote(parts: string[]) {
  return parts.map((part) => part.trim()).filter(Boolean).join(" | ");
}

function setIfNotEmpty(row: CsvRow, key: string, value: string) {
  if (value.trim().length > 0) {
    row[key] = value.trim();
  }
}

function syncSellerWorksheet() {
  const worksheet = readText("NOTION_IMPORT_SELLER_TRIAGE_WORKSHEET.md");
  const rows = readCsv("artifacts/notion-import-seller-decisions.template.csv");
  const bySourceKey = new Map(rows.map((row) => [row.sourceKey?.trim(), row]));

  let updated = 0;
  for (const section of splitSections(worksheet)) {
    const sourceKey = extractReviewRow(section.body);
    if (!sourceKey) continue;
    const row = bySourceKey.get(sourceKey);
    if (!row) continue;

    const checked = extractCheckedDecision(section.body, [
      "Existing seller alias",
      "Create new seller",
      "Hold",
    ]);
    const nextDecision =
      checked === "Existing seller alias"
        ? "existing-seller-alias"
        : checked === "Create new seller"
          ? "create-new-seller"
          : checked === "Hold"
            ? "hold"
            : "";

    if (nextDecision) row.decision = nextDecision;
    setIfNotEmpty(row, "confirmedPlatform", extractField(section.body, "Confirmed platform:"));
    setIfNotEmpty(row, "confirmedHandle", extractField(section.body, "Confirmed handle:"));
    setIfNotEmpty(row, "confirmedChannelUrl", extractField(section.body, "Confirmed channel URL:"));
    setIfNotEmpty(row, "existingSellerId", extractField(section.body, "Existing seller id if merge:"));
    setIfNotEmpty(
      row,
      "notes",
      compactNote([extractField(section.body, "Manual action taken:")]),
    );
    updated += 1;
  }

  writeCsv("artifacts/notion-import-seller-decisions.template.csv", rows);
  return updated;
}

function syncDealWorksheet() {
  const worksheet = readText("NOTION_IMPORT_DEAL_REVIEW_WORKSHEET.md");
  const rows = readCsv("artifacts/notion-import-deal-decisions.template.csv");
  const bySourceKey = new Map(rows.map((row) => [row.sourceKey?.trim(), row]));

  let updated = 0;
  for (const section of splitSections(worksheet)) {
    const sourceKey = extractReviewRow(section.body);
    if (!sourceKey) continue;
    const row = bySourceKey.get(sourceKey);
    if (!row) continue;

    const checked = extractCheckedDecision(section.body, [
      "Merge into existing deal",
      "Create separate deal",
      "Hold",
    ]);
    const nextDecision =
      checked === "Merge into existing deal"
        ? "merge-existing-deal"
        : checked === "Create separate deal"
          ? "create-separate-deal"
          : checked === "Hold"
            ? "hold"
            : "";

    if (nextDecision) row.decision = nextDecision;
    setIfNotEmpty(
      row,
      "confirmedPartnerName",
      extractField(section.body, "Operating partner confirmed:"),
    );
    setIfNotEmpty(row, "confirmedBrandName", extractField(section.body, "Brand label confirmed:"));
    setIfNotEmpty(row, "existingDealId", extractField(section.body, "Existing deal id if merge:"));
    setIfNotEmpty(
      row,
      "notes",
      compactNote([
        extractField(section.body, "Manual action taken:"),
        extractField(section.body, "Notes:"),
      ]),
    );
    updated += 1;
  }

  writeCsv("artifacts/notion-import-deal-decisions.template.csv", rows);
  return updated;
}

function syncCampaignWorksheet() {
  const worksheet = readText("NOTION_IMPORT_CAMPAIGN_NORMALIZATION_WORKSHEET.md");
  const rows = readCsv("artifacts/notion-import-campaign-decisions.template.csv");
  const bySourceKey = new Map(rows.map((row) => [row.sourceKey?.trim(), row]));

  let updated = 0;
  for (const section of splitSections(worksheet)) {
    const sourceKey = extractReviewRow(section.body);
    if (!sourceKey) continue;
    const row = bySourceKey.get(sourceKey);
    if (!row) continue;

    const checked = extractCheckedDecision(section.body, [
      "Normalize to existing deal and create campaign",
      "Hold",
    ]);
    const nextDecision =
      checked === "Normalize to existing deal and create campaign"
        ? "create-normalized-campaign"
        : checked === "Hold"
          ? "hold"
          : "";

    if (nextDecision) row.decision = nextDecision;
    setIfNotEmpty(row, "normalizedSalesCode", extractField(section.body, "Normalized sales code:"));
    setIfNotEmpty(row, "normalizedSellerId", extractField(section.body, "Normalized seller id:"));
    setIfNotEmpty(row, "normalizedDealId", extractField(section.body, "Normalized deal id:"));
    setIfNotEmpty(
      row,
      "notes",
      compactNote([
        extractField(section.body, "Manual action taken:"),
        extractField(section.body, "Notes:"),
      ]),
    );
    updated += 1;
  }

  writeCsv("artifacts/notion-import-campaign-decisions.template.csv", rows);
  return updated;
}

function main() {
  const sellerUpdated = syncSellerWorksheet();
  const dealUpdated = syncDealWorksheet();
  const campaignUpdated = syncCampaignWorksheet();

  console.log(
    JSON.stringify(
      {
        ok: true,
        sellerUpdated,
        dealUpdated,
        campaignUpdated,
      },
      null,
      2,
    ),
  );
}

main();
