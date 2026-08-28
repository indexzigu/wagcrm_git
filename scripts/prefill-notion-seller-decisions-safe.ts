import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";

type SellerDecisionRow = {
  sourceKey: string;
  sellerName: string;
  decision: string;
  confirmedPlatform: string;
  confirmedHandle: string;
  confirmedChannelUrl: string;
  notes: string;
  recommendedDecision?: string;
  recommendedReason?: string;
  recommendedAction?: string;
};

type SellerEvidenceRow = {
  sourceKey: string;
  sellerPlatform: string;
  sellerHandle: string;
  sellerChannelUrl: string;
  sellerPageUrls: string;
  linkedCampaignSalesCodes: string;
  linkedSalesBrands: string;
  linkedSalesNotes: string;
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

function compact(parts: string[]) {
  return parts.map((part) => part.trim()).filter(Boolean).join(" | ");
}

function normalizeList(value: string | undefined) {
  return (value ?? "")
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.toLowerCase() !== "none")
    .join(" | ");
}

function inferRecommendation(row: SellerDecisionRow, evidence?: SellerEvidenceRow) {
  const hasPlatform = Boolean(evidence?.sellerPlatform?.trim());
  const hasChannelUrl = Boolean(evidence?.sellerChannelUrl?.trim());
  const hasPageUrls = Boolean(evidence?.sellerPageUrls?.trim());
  const hasLinkedSales = Boolean(evidence?.linkedCampaignSalesCodes?.trim());

  if (row.decision?.trim() === "hold") {
    return {
      recommendedDecision: "hold",
      recommendedReason: "no-safe-channel-evidence",
      recommendedAction: "keep-hold-unless-a-real-platform-and-channel-url-are-confirmed",
    };
  }

  if (hasPlatform && hasChannelUrl) {
    return {
      recommendedDecision: "create-new-seller",
      recommendedReason: "channel-already-confirmed-in-seller-directory",
      recommendedAction: "review-prefilled-channel-fields-and-create",
    };
  }

  if (hasPageUrls && hasLinkedSales) {
    return {
      recommendedDecision: "create-new-seller",
      recommendedReason: "linked-sales-and-notion-pages-exist",
      recommendedAction: "open-seller-pages-and-fill-confirmed-platform-handle-url",
    };
  }

  if (hasLinkedSales) {
    return {
      recommendedDecision: "hold",
      recommendedReason: "linked-sales-exist-but-channel-proof-is-missing",
      recommendedAction: "search-linked-sales-trail-for-platform-or-channel-url",
    };
  }

  return {
    recommendedDecision: "hold",
    recommendedReason: "no-reliable-evidence-found",
    recommendedAction: "keep-hold-until-channel-proof-is-found",
  };
}

function main() {
  const decisionPath = "artifacts/notion-import-seller-decisions.template.csv";
  const evidencePath = "artifacts/notion-import-seller-triage-evidence.csv";
  const decisionRows = readCsv<SellerDecisionRow>(decisionPath);
  const evidenceRows = readCsv<SellerEvidenceRow>(evidencePath);
  const evidenceMap = new Map(evidenceRows.map((row) => [row.sourceKey.trim(), row]));

  let platformPrefilled = 0;
  let handlePrefilled = 0;
  let channelPrefilled = 0;
  let notesPrefilled = 0;
  let recommendationUpdated = 0;

  for (const row of decisionRows) {
    const evidence = evidenceMap.get(row.sourceKey.trim());
    if (!evidence) continue;

    if (!row.confirmedPlatform?.trim() && evidence.sellerPlatform?.trim()) {
      row.confirmedPlatform = evidence.sellerPlatform.trim();
      platformPrefilled += 1;
    }
    if (!row.confirmedHandle?.trim() && evidence.sellerHandle?.trim()) {
      row.confirmedHandle = evidence.sellerHandle.trim();
      handlePrefilled += 1;
    }
    if (!row.confirmedChannelUrl?.trim() && evidence.sellerChannelUrl?.trim()) {
      row.confirmedChannelUrl = evidence.sellerChannelUrl.trim();
      channelPrefilled += 1;
    }
    if (!row.notes?.trim()) {
      row.notes = compact([
        evidence.sellerPageUrls ? `seller-pages=${evidence.sellerPageUrls}` : "",
        evidence.linkedCampaignSalesCodes
          ? `linked-sales=${evidence.linkedCampaignSalesCodes}`
          : "",
        normalizeList(evidence.linkedSalesBrands)
          ? `brands=${normalizeList(evidence.linkedSalesBrands)}`
          : "",
        normalizeList(evidence.linkedSalesNotes)
          ? `sales-notes=${normalizeList(evidence.linkedSalesNotes)}`
          : "",
      ]);
      if (row.notes) notesPrefilled += 1;
    }

    const recommendation = inferRecommendation(row, evidence);
    row.recommendedDecision = recommendation.recommendedDecision;
    row.recommendedReason = recommendation.recommendedReason;
    row.recommendedAction = recommendation.recommendedAction;
    recommendationUpdated += 1;
  }

  writeCsv(decisionPath, decisionRows);

  console.log(
    JSON.stringify(
      {
        ok: true,
        path: decisionPath,
        platformPrefilled,
        handlePrefilled,
        channelPrefilled,
        notesPrefilled,
        recommendationUpdated,
        total: decisionRows.length,
      },
      null,
      2,
    ),
  );
}

main();
