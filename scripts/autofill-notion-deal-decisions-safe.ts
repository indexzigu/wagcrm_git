import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { getPrisma } from "../src/lib/prisma";

type DealDecisionRow = {
  sourceKey: string;
  partnerOrBrand: string;
  dealName: string;
  reviewReason: string;
  candidateId: string;
  decisionOptions: string;
  decision: string;
  existingDealId: string;
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

function hasOption(options: string, expected: string) {
  return options
    .split("|")
    .map((value) => value.trim())
    .includes(expected);
}

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function getTarget() {
  const targetArg = process.argv.find((arg) => arg.startsWith("--target="));
  return (targetArg ? targetArg.slice("--target=".length) : "remote").toLowerCase();
}

async function main() {
  const target = getTarget();
  if (target === "local") {
    process.env.DATABASE_URL = "file:./dev.db";
    process.env.DIRECT_URL = "";
  }
  const prisma = getPrisma();

  const path = "artifacts/notion-import-deal-decisions.template.csv";
  const rows = readCsv<DealDecisionRow>(path);

  let autofilled = 0;
  let existingDealIdPrefilled = 0;
  let skippedUnresolved = 0;
  let downgradedToHold = 0;
  let resolvedByPartnerMatch = 0;
  let skippedOwnerMismatch = 0;

  for (const row of rows) {
    const currentDecision = row.decision?.trim();
    if (currentDecision && currentDecision !== "merge-existing-deal") continue;
    const isSafeReason = row.reviewReason?.includes("product-name-match-with-different-partner");
    const hasCandidateId = row.candidateId?.trim().length > 0;
    const canMerge = hasOption(row.decisionOptions ?? "", "merge-existing-deal");
    if (!isSafeReason || !hasCandidateId || !canMerge) continue;

    const dealName = row.dealName?.trim();
    if (!dealName) {
      skippedUnresolved += 1;
      if (currentDecision === "merge-existing-deal") {
        row.decision = "hold";
        if (!row.notes?.trim()) row.notes = "autofill-safe-deal-unresolved-local-hold";
        downgradedToHold += 1;
      }
      continue;
    }
    const matchedDeals = await prisma.deal.findMany({
      where: { dealName },
      select: {
        id: true,
        partnerCompanyName: true,
        brandName: true,
        partner: {
          select: { name: true },
        },
      },
      take: 5,
    });
    const partnerHint = normalize(row.partnerOrBrand);
    let resolvedDealId = "";
    const partnerMatched = matchedDeals.filter((deal) => {
      if (!partnerHint) return false;
      const partnerName = normalize(deal.partner?.name);
      const partnerCompanyName = normalize(deal.partnerCompanyName);
      const brandName = normalize(deal.brandName);
      return [partnerName, partnerCompanyName, brandName].includes(partnerHint);
    });
    if (partnerMatched.length === 1) {
      resolvedDealId = partnerMatched[0]!.id;
      resolvedByPartnerMatch += 1;
    }

    if (!resolvedDealId) {
      skippedUnresolved += 1;
      if (matchedDeals.length > 0 && partnerHint) {
        skippedOwnerMismatch += 1;
      }
      if (currentDecision === "merge-existing-deal") {
        row.decision = "hold";
        if (!row.notes?.trim()) {
          row.notes = matchedDeals.length > 0 && partnerHint
            ? "autofill-safe-deal-owner-mismatch-local-hold"
            : "autofill-safe-deal-unresolved-local-hold";
        }
        downgradedToHold += 1;
      }
      continue;
    }

    row.decision = "merge-existing-deal";
    if (!row.existingDealId?.trim() || row.existingDealId.trim() !== resolvedDealId) {
      row.existingDealId = resolvedDealId;
      existingDealIdPrefilled += 1;
    }
    if (!row.notes?.trim()) {
      row.notes = "autofill-safe-deal-merge";
    }
    autofilled += 1;
  }

  writeCsv(path, rows);

  console.log(
    JSON.stringify(
      {
        ok: true,
        path,
        target,
        autofilled,
        existingDealIdPrefilled,
        resolvedByPartnerMatch,
        skippedUnresolved,
        skippedOwnerMismatch,
        downgradedToHold,
        total: rows.length,
      },
      null,
      2,
    ),
  );

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
