import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";

type CampaignDecisionRow = {
  sourceKey: string;
  salesCode: string;
  reviewReason: string;
  sellerCandidateId: string;
  dealCandidateId: string;
  decision: string;
  normalizedSalesCode: string;
  normalizedSellerId: string;
  normalizedDealId: string;
  notes: string;
};

function readCsv<T>(relativePath: string) {
  const raw = readFileSync(join(process.cwd(), relativePath), "utf8");
  const parsed = Papa.parse<T>(raw, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    throw new Error(
      `Failed to parse ${relativePath}: ${parsed.errors.map((error) => error.message).join(", ")}`,
    );
  }
  return parsed.data;
}

function writeCsv<T>(relativePath: string, rows: T[]) {
  const sanitizedRows = rows.map((row) => {
    const next: Record<string, string> = {};
    for (const [key, rawValue] of Object.entries(row as Record<string, unknown>)) {
      next[key] = String(rawValue ?? "")
        .replace(/\r?\n/g, " ")
        .trim();
    }
    return next;
  });
  writeFileSync(join(process.cwd(), relativePath), `${Papa.unparse(sanitizedRows)}\n`);
}

function main() {
  const path = "artifacts/notion-import-campaign-decisions.template.csv";
  const rows = readCsv<CampaignDecisionRow>(path);
  let autofilled = 0;

  for (const row of rows) {
    if (row.decision?.trim()) continue;
    const hasCandidates = row.sellerCandidateId?.trim() && row.dealCandidateId?.trim();
    const reviewReason = row.reviewReason?.trim() ?? "";
    const isSafeReason =
      reviewReason.includes("missing-deal-match") ||
      reviewReason.includes("missing-seller-match");
    if (!hasCandidates || !isSafeReason) continue;

    row.decision = "create-normalized-campaign";
    row.normalizedSalesCode = row.salesCode?.trim() || "";
    row.normalizedSellerId = row.sellerCandidateId?.trim() || "";
    row.normalizedDealId = row.dealCandidateId?.trim() || "";
    if (!row.notes?.trim()) {
      row.notes = "autofill-safe-campaign";
    }
    autofilled += 1;
  }

  writeCsv(path, rows);

  console.log(
    JSON.stringify(
      {
        ok: true,
        path,
        autofilled,
        total: rows.length,
      },
      null,
      2,
    ),
  );
}

main();
