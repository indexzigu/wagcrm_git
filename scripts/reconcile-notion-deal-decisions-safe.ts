import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";

type DealDecisionRow = {
  sourceKey: string;
  partnerOrBrand: string;
  candidateLabel: string;
  reviewReason: string;
  decisionOptions: string;
  decision: string;
  confirmedPartnerName: string;
  confirmedBrandName: string;
  existingDealId: string;
  notes: string;
  recommendedDecision?: string;
  recommendedReason?: string;
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

function writeCsv<T extends Record<string, unknown>>(relativePath: string, rows: T[]) {
  const sanitized = rows.map((row) => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      next[key] = String(value ?? "")
        .replace(/\r?\n/g, " ")
        .trim();
    }
    return next;
  });
  writeFileSync(join(process.cwd(), relativePath), `${Papa.unparse(sanitized)}\n`);
}

function hasOption(options: string | undefined, expected: string) {
  return (options ?? "")
    .split("|")
    .map((value) => value.trim())
    .includes(expected);
}

function normalize(value: string | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function parseCandidateLabel(candidateLabel: string) {
  const parts = candidateLabel
    .split("/")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    candidatePartner: parts[1] ?? "",
    candidateBrand: parts[2] ?? "",
  };
}

function main() {
  const path = "artifacts/notion-import-deal-decisions.template.csv";
  const rows = readCsv<DealDecisionRow>(path);

  let alignedToSeparate = 0;
  let partnerRebased = 0;
  let brandRebased = 0;
  let clearedExistingDealId = 0;
  let skipped = 0;

  for (const row of rows) {
    const currentDecision = row.decision?.trim();
    const recommendedDecision = row.recommendedDecision?.trim();
    const recommendedReason = row.recommendedReason?.trim();

    const isSafeMismatchRule =
      row.reviewReason?.includes("product-name-match-with-different-partner") &&
      recommendedDecision === "create-separate-deal" &&
      recommendedReason === "product-name-matches-but-partner-or-brand-differs" &&
      hasOption(row.decisionOptions, "create-separate-deal");

    if (!isSafeMismatchRule) {
      skipped += 1;
      continue;
    }

    const importedOwner = row.partnerOrBrand?.trim();
    const { candidatePartner, candidateBrand } = parseCandidateLabel(row.candidateLabel ?? "");
    const normalizedImportedOwner = normalize(importedOwner);

    if (currentDecision !== "create-separate-deal") {
      row.decision = "create-separate-deal";
      alignedToSeparate += 1;
    }

    if (importedOwner && row.confirmedPartnerName?.trim() !== importedOwner) {
      row.confirmedPartnerName = importedOwner;
      partnerRebased += 1;
    }

    const fallbackBrand = [candidateBrand, candidatePartner].find(
      (value) => normalize(value) && normalize(value) !== normalizedImportedOwner,
    );
    if (fallbackBrand && row.confirmedBrandName?.trim() !== fallbackBrand) {
      row.confirmedBrandName = fallbackBrand;
      brandRebased += 1;
    }

    if (row.existingDealId?.trim()) {
      row.existingDealId = "";
      clearedExistingDealId += 1;
    }

    const nextNote = "reconciled-to-recommended-separate-deal";
    if (!row.notes?.includes(nextNote)) {
      row.notes = row.notes?.trim()
        ? `${row.notes.trim()} | ${nextNote}`
        : nextNote;
    }
  }

  writeCsv(path, rows);

  console.log(
    JSON.stringify(
      {
        ok: true,
        path,
        alignedToSeparate,
        partnerRebased,
        brandRebased,
        clearedExistingDealId,
        skipped,
        total: rows.length,
      },
      null,
      2,
    ),
  );
}

main();
