import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";

type SellerDecisionRow = {
  sourceKey: string;
  sellerName: string;
  reviewReason: string;
  candidateId: string;
  candidateLabel: string;
  decisionOptions?: string;
  decision: string;
  confirmedPlatform: string;
  confirmedHandle: string;
  confirmedChannelUrl: string;
  existingSellerId: string;
  notes: string;
};

type DealDecisionRow = {
  sourceKey: string;
  partnerOrBrand: string;
  dealName: string;
  reviewReason: string;
  candidateId: string;
  candidateLabel: string;
  decisionOptions?: string;
  decision: string;
  confirmedPartnerName: string;
  confirmedBrandName: string;
  existingDealId: string;
  notes: string;
};

type CampaignDecisionRow = {
  sourceKey: string;
  salesCode: string;
  sellerName: string;
  dealName: string;
  reviewReason: string;
  sellerCandidateId: string;
  sellerCandidateLabel: string;
  dealCandidateId: string;
  dealCandidateLabel: string;
  decisionOptions?: string;
  decision: string;
  normalizedSalesCode: string;
  normalizedSellerId: string;
  normalizedDealId: string;
  notes: string;
};

type PlanAction =
  | "seller-merge"
  | "seller-create"
  | "deal-merge"
  | "deal-create-separate"
  | "campaign-create-normalized";

type PlanRow = {
  sourceKey: string;
  action: PlanAction;
  entity: "seller" | "deal" | "campaign";
  reference: string;
  payload: Record<string, string>;
};

function readCsvRows<T>(relativePath: string): T[] {
  const absolutePath = join(process.cwd(), relativePath);
  const raw = readFileSync(absolutePath, "utf8");
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

function norm(value: string) {
  return value.trim().toLowerCase();
}

function main() {
  const sellerRows = readCsvRows<SellerDecisionRow>(
    "artifacts/notion-import-seller-decisions.template.csv",
  );
  const dealRows = readCsvRows<DealDecisionRow>("artifacts/notion-import-deal-decisions.template.csv");
  const campaignRows = readCsvRows<CampaignDecisionRow>(
    "artifacts/notion-import-campaign-decisions.template.csv",
  );

  const planRows: PlanRow[] = [];
  const pendingRows: Array<{ entity: string; sourceKey: string; reason: string }> = [];
  const blockedRows: Array<{ entity: string; sourceKey: string; reason: string }> = [];
  const invalidRows: Array<{ entity: string; sourceKey: string; reason: string }> = [];

  for (const row of sellerRows) {
    const decision = norm(row.decision);
    if (!decision) {
      pendingRows.push({ entity: "seller", sourceKey: row.sourceKey, reason: "decision-empty" });
      continue;
    }
    if (decision === "existing-seller-alias") {
      if (!row.existingSellerId.trim()) {
        invalidRows.push({
          entity: "seller",
          sourceKey: row.sourceKey,
          reason: "existingSellerId required",
        });
        continue;
      }
      planRows.push({
        sourceKey: row.sourceKey,
        action: "seller-merge",
        entity: "seller",
        reference: row.sellerName,
        payload: {
          existingSellerId: row.existingSellerId.trim(),
          confirmedPlatform: row.confirmedPlatform.trim(),
          confirmedHandle: row.confirmedHandle.trim(),
          confirmedChannelUrl: row.confirmedChannelUrl.trim(),
          notes: row.notes.trim(),
        },
      });
      continue;
    }
    if (decision === "create-new-seller") {
      if (!row.confirmedPlatform.trim() || !row.confirmedHandle.trim()) {
        invalidRows.push({
          entity: "seller",
          sourceKey: row.sourceKey,
          reason: "confirmedPlatform and confirmedHandle required",
        });
        continue;
      }
      planRows.push({
        sourceKey: row.sourceKey,
        action: "seller-create",
        entity: "seller",
        reference: row.sellerName,
        payload: {
          confirmedPlatform: row.confirmedPlatform.trim(),
          confirmedHandle: row.confirmedHandle.trim(),
          confirmedChannelUrl: row.confirmedChannelUrl.trim(),
          notes: row.notes.trim(),
        },
      });
      continue;
    }
    if (decision === "hold") {
      blockedRows.push({ entity: "seller", sourceKey: row.sourceKey, reason: "explicit-hold" });
      continue;
    }
    invalidRows.push({
      entity: "seller",
      sourceKey: row.sourceKey,
      reason: `unknown decision: ${row.decision} (allowed: existing-seller-alias|create-new-seller|hold)`,
    });
  }

  for (const row of dealRows) {
    const decision = norm(row.decision);
    if (!decision) {
      pendingRows.push({ entity: "deal", sourceKey: row.sourceKey, reason: "decision-empty" });
      continue;
    }
    if (decision === "merge-existing-deal") {
      const existingDealId = row.existingDealId.trim() || row.candidateId.trim();
      if (!existingDealId) {
        invalidRows.push({ entity: "deal", sourceKey: row.sourceKey, reason: "existingDealId or candidateId required" });
        continue;
      }
      planRows.push({
        sourceKey: row.sourceKey,
        action: "deal-merge",
        entity: "deal",
        reference: `${row.partnerOrBrand} / ${row.dealName}`,
        payload: {
          existingDealId,
          dealName: row.dealName.trim(),
          partnerOrBrand: row.partnerOrBrand.trim(),
          confirmedPartnerName: row.confirmedPartnerName.trim(),
          confirmedBrandName: row.confirmedBrandName.trim(),
          notes: row.notes.trim(),
        },
      });
      continue;
    }
    if (decision === "create-separate-deal") {
      planRows.push({
        sourceKey: row.sourceKey,
        action: "deal-create-separate",
        entity: "deal",
        reference: `${row.partnerOrBrand} / ${row.dealName}`,
        payload: {
          confirmedPartnerName: row.confirmedPartnerName.trim(),
          confirmedBrandName: row.confirmedBrandName.trim(),
          notes: row.notes.trim(),
        },
      });
      continue;
    }
    if (decision === "hold") {
      blockedRows.push({ entity: "deal", sourceKey: row.sourceKey, reason: "explicit-hold" });
      continue;
    }
    invalidRows.push({
      entity: "deal",
      sourceKey: row.sourceKey,
      reason: `unknown decision: ${row.decision} (allowed: merge-existing-deal|create-separate-deal|hold)`,
    });
  }

  for (const row of campaignRows) {
    const decision = norm(row.decision);
    if (!decision) {
      pendingRows.push({ entity: "campaign", sourceKey: row.sourceKey, reason: "decision-empty" });
      continue;
    }
    if (decision === "create-normalized-campaign") {
      const normalizedSellerId = row.normalizedSellerId.trim() || row.sellerCandidateId.trim();
      const normalizedDealId = row.normalizedDealId.trim() || row.dealCandidateId.trim();
      if (!normalizedSellerId || !normalizedDealId) {
        invalidRows.push({
          entity: "campaign",
          sourceKey: row.sourceKey,
          reason: "normalizedSellerId and normalizedDealId required",
        });
        continue;
      }
      planRows.push({
        sourceKey: row.sourceKey,
        action: "campaign-create-normalized",
        entity: "campaign",
        reference: row.salesCode,
        payload: {
          normalizedSalesCode: row.normalizedSalesCode.trim() || row.salesCode.trim(),
          normalizedSellerId,
          normalizedDealId,
          sellerName: row.sellerName.trim(),
          dealName: row.dealName.trim(),
          notes: row.notes.trim(),
        },
      });
      continue;
    }
    if (decision === "hold") {
      blockedRows.push({ entity: "campaign", sourceKey: row.sourceKey, reason: "explicit-hold" });
      continue;
    }
    invalidRows.push({
      entity: "campaign",
      sourceKey: row.sourceKey,
      reason: `unknown decision: ${row.decision} (allowed: create-normalized-campaign|hold)`,
    });
  }

  const planPath = join(process.cwd(), "artifacts/notion-import-decision-plan.json");
  writeFileSync(
    planPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        counts: {
          plan: planRows.length,
          pending: pendingRows.length,
          blocked: blockedRows.length,
          invalid: invalidRows.length,
        },
        planRows,
        pendingRows,
        blockedRows,
        invalidRows,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        planPath,
        planCount: planRows.length,
        pendingCount: pendingRows.length,
        blockedCount: blockedRows.length,
        invalidCount: invalidRows.length,
      },
      null,
      2,
    ),
  );
}

main();
