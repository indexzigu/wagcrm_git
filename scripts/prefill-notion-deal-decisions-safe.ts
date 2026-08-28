import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";

type DealDecisionRow = {
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
  recommendedDecision?: string;
  recommendedReason?: string;
  recommendedAction?: string;
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

function normalize(value: string | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function parseCandidateLabel(candidateLabel: string) {
  const parts = candidateLabel
    .split("/")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    candidateDealName: parts[0] ?? "",
    candidatePartner: parts[1] ?? "",
    candidateBrand: parts[2] ?? "",
  };
}

function inferRecommendation(row: DealDecisionRow) {
  const importedPartnerOrBrand = normalize(row.partnerOrBrand);
  const { candidatePartner, candidateBrand } = parseCandidateLabel(row.candidateLabel);
  const normalizedCandidatePartner = normalize(candidatePartner);
  const normalizedCandidateBrand = normalize(candidateBrand);

  if (!importedPartnerOrBrand) {
    return {
      recommendedDecision: "hold",
      recommendedReason: "missing-imported-partner-or-brand",
      recommendedAction: "confirm-the-operating-partner-or-brand-before-deciding",
    };
  }

  const matchesCandidateIdentity =
    importedPartnerOrBrand === normalizedCandidatePartner ||
    importedPartnerOrBrand === normalizedCandidateBrand;

  if (matchesCandidateIdentity) {
    return {
      recommendedDecision: "merge-existing-deal",
      recommendedReason: "imported-partner-or-brand-matches-candidate-identity",
      recommendedAction: "merge-into-the-existing-deal-and-keep-brand-or-partner-notes-aligned",
    };
  }

  if (normalizedCandidatePartner || normalizedCandidateBrand) {
    return {
      recommendedDecision: "create-separate-deal",
      recommendedReason: "product-name-matches-but-partner-or-brand-differs",
      recommendedAction: "create-a-separate-deal-unless-you-can-prove-the-same-operating-owner",
    };
  }

  return {
    recommendedDecision: "hold",
    recommendedReason: "candidate-identity-could-not-be-parsed",
    recommendedAction: "inspect-the-source-row-and-candidate-before-deciding",
  };
}

function main() {
  const path = "artifacts/notion-import-deal-decisions.template.csv";
  const rows = readCsv<DealDecisionRow>(path);

  let partnerPrefilled = 0;
  let brandPrefilled = 0;
  let existingIdPrefilled = 0;
  let notesPrefilled = 0;
  let recommendationUpdated = 0;

  for (const row of rows) {
    const { candidatePartner, candidateBrand } = parseCandidateLabel(row.candidateLabel);

    if (!row.confirmedPartnerName?.trim() && candidatePartner) {
      row.confirmedPartnerName = candidatePartner;
      partnerPrefilled += 1;
    }

    if (!row.confirmedBrandName?.trim() && candidateBrand) {
      row.confirmedBrandName = candidateBrand;
      brandPrefilled += 1;
    }

    if (!row.existingDealId?.trim() && row.candidateId?.trim()) {
      row.existingDealId = row.candidateId.trim();
      existingIdPrefilled += 1;
    }

    if (!row.notes?.trim()) {
      row.notes = "prefill-from-candidate-label";
      notesPrefilled += 1;
    }

    const recommendation = inferRecommendation(row);
    row.recommendedDecision = recommendation.recommendedDecision;
    row.recommendedReason = recommendation.recommendedReason;
    row.recommendedAction = recommendation.recommendedAction;
    recommendationUpdated += 1;
  }

  writeCsv(path, rows);

  console.log(
    JSON.stringify(
      {
        ok: true,
        path,
        counts: {
          rows: rows.length,
          partnerPrefilled,
          brandPrefilled,
          existingIdPrefilled,
          notesPrefilled,
          recommendationUpdated,
        },
      },
      null,
      2,
    ),
  );
}

main();
