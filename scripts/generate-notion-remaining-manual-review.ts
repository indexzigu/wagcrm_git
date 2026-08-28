import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { isIgnoredSourceKey } from "./notion-import-ignore";

type ReviewRow = {
  reviewType: string;
  sourceKey: string;
  reviewReason: string;
  sellerName: string;
  dealName: string;
  partnerOrBrand: string;
  salesCode: string;
  rawSchedule: string;
  sourceCreatedAt: string;
  candidateLabel: string;
  suggestedAction: string;
};

type SellerEvidenceRow = {
  sellerName: string;
  sourceKey: string;
  linkedCampaignSalesCodes: string;
  sellerDirectoryPresent: string;
  sellerPageUrls: string;
  linkedSalesBrands: string;
  linkedSalesNotes: string;
};

type DecisionPlan = {
  counts: {
    plan: number;
    pending: number;
    blocked?: number;
    invalid: number;
  };
  pendingRows?: Array<{ entity: string; sourceKey: string; reason: string }>;
  blockedRows?: Array<{ entity: string; sourceKey: string; reason: string }>;
};

type RemainingRow = {
  queue: "pending" | "blocked";
  entity: string;
  sourceKey: string;
  reason: string;
  sellerName: string;
  dealName: string;
  partnerOrBrand: string;
  salesCode: string;
  reviewReason: string;
  sourceCreatedAt: string;
  candidateLabel: string;
  suggestedAction: string;
  sellerDirectoryPresent: string;
  sellerPageUrls: string;
  linkedCampaignSalesCodes: string;
  linkedSalesBrands: string;
  linkedSalesNotes: string;
  decisionHint: string;
  operatorAction: string;
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
  const parsed = Papa.parse<T>(raw, {
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

function readJson<T>(relativePath: string) {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

function renderSection(title: string, rows: RemainingRow[]) {
  if (rows.length === 0) {
    return [`## ${title}`, "", "- none", ""].join("\n");
  }

  const sections = rows.map((row, index) => {
    const heading = row.entity === "seller"
      ? row.sellerName || row.sourceKey
      : row.entity === "deal"
        ? `${row.partnerOrBrand} / ${row.dealName}`.trim()
        : row.salesCode || row.sourceKey;

    return [
      `### ${index + 1}. ${heading}`,
      "",
      `- Entity: \`${row.entity}\``,
      `- Source key: \`${row.sourceKey}\``,
      `- Queue reason: \`${row.reason}\``,
      `- Review reason: \`${row.reviewReason || "none"}\``,
      `- Suggested action: \`${row.suggestedAction || "none"}\``,
      `- Decision hint: \`${row.decisionHint || "none"}\``,
      `- Operator action: \`${row.operatorAction || "none"}\``,
      `- Seller: \`${row.sellerName || "none"}\``,
      `- Deal: \`${row.dealName || "none"}\``,
      `- Partner/Brand: \`${row.partnerOrBrand || "none"}\``,
      `- Sales code: \`${row.salesCode || "none"}\``,
      `- Source created at: \`${row.sourceCreatedAt || "none"}\``,
      `- Candidate label: \`${row.candidateLabel || "none"}\``,
      `- Seller directory present: \`${row.sellerDirectoryPresent || "no"}\``,
      `- Seller page URLs: ${row.sellerPageUrls ? `\`${row.sellerPageUrls}\`` : "none"}`,
      `- Linked campaign sales codes: ${row.linkedCampaignSalesCodes ? `\`${row.linkedCampaignSalesCodes}\`` : "none"}`,
      `- Linked sales brands: ${row.linkedSalesBrands ? `\`${row.linkedSalesBrands}\`` : "none"}`,
      `- Linked sales notes: ${row.linkedSalesNotes ? `\`${row.linkedSalesNotes}\`` : "none"}`,
      "",
    ].join("\n");
  });

  return [`## ${title}`, "", ...sections].join("\n");
}

function clean(value: string | undefined) {
  return (value ?? "").replace(/\r?\n/g, " ").trim();
}

function normalizeEvidenceList(value: string | undefined) {
  const tokens = clean(value)
    .split("|")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && token.toLowerCase() !== "none");
  return tokens.length > 0 ? tokens.join(" | ") : "";
}

function inferDecisionHint(row: Omit<RemainingRow, "decisionHint" | "operatorAction">) {
  if (row.entity === "seller") {
    if (row.queue === "blocked") {
      return {
        decisionHint: "keep-hold-unless-channel-is-confirmed",
        operatorAction: "find-real-platform-or-channel-url-before-any-create",
      };
    }

    if (row.linkedCampaignSalesCodes && row.sellerPageUrls) {
      return {
        decisionHint: "likely-create-new-seller-after-channel-confirmation",
        operatorAction: "open seller pages and confirm a real platform plus handle",
      };
    }

    if (row.linkedCampaignSalesCodes) {
      return {
        decisionHint: "prefer-hold-until-channel-proof-is-found",
        operatorAction: "search linked sales trail for handle or channel URL",
      };
    }
  }

  if (row.entity === "deal" && row.queue === "blocked") {
    const candidateParts = row.candidateLabel
      .split("/")
      .map((value) => value.trim())
      .filter(Boolean);
    const candidatePartner = candidateParts[1] ?? "";
    const candidateBrand = candidateParts[2] ?? "";
    return {
      decisionHint: "create-separate-deal-when-product-matches-but-owner-differs",
      operatorAction:
        candidatePartner || candidateBrand
          ? `treat ${row.partnerOrBrand || "the imported owner"} and ${candidatePartner || candidateBrand} as separate unless the same operator is proven`
          : "confirm the operating partner or brand before deciding whether to separate the deal",
    };
  }

  if (row.entity === "campaign") {
    const candidateParts = row.candidateLabel
      .split("|")
      .map((value) => value.trim())
      .filter(Boolean);
    if (candidateParts.length >= 2) {
      return {
        decisionHint: "likely-create-normalized-campaign",
        operatorAction: "use the matched seller and deal ids to create the normalized campaign",
      };
    }
  }

  return {
    decisionHint: "manual-review-required",
    operatorAction: "inspect source evidence before choosing a decision",
  };
}

function main() {
  const plan = readJson<DecisionPlan>("artifacts/notion-import-decision-plan.json");
  const backlogRows = readCsv<ReviewRow>("artifacts/notion-import-review-backlog.remote.csv");
  const sellerEvidenceRows = readCsv<SellerEvidenceRow>("artifacts/notion-import-seller-triage-evidence.csv");

  const backlogBySourceKey = new Map(backlogRows.map((row) => [row.sourceKey.trim(), row]));
  const evidenceBySourceKey = new Map(
    sellerEvidenceRows.map((row) => [row.sourceKey.trim(), row]),
  );

  const collect = (
    queue: "pending" | "blocked",
    rows: Array<{ entity: string; sourceKey: string; reason: string }> | undefined,
  ): RemainingRow[] =>
    (rows ?? []).map((row) => {
      const backlog = backlogBySourceKey.get(row.sourceKey.trim());
      const evidence = evidenceBySourceKey.get(row.sourceKey.trim());
      const baseRow = {
        queue,
        entity: row.entity,
        sourceKey: clean(row.sourceKey),
        reason: clean(row.reason),
        sellerName: clean(backlog?.sellerName ?? evidence?.sellerName ?? ""),
        dealName: clean(backlog?.dealName ?? ""),
        partnerOrBrand: clean(backlog?.partnerOrBrand ?? ""),
        salesCode: clean(backlog?.salesCode ?? ""),
        reviewReason: clean(backlog?.reviewReason ?? ""),
        sourceCreatedAt: clean(backlog?.sourceCreatedAt ?? ""),
        candidateLabel: clean(backlog?.candidateLabel ?? ""),
        suggestedAction: clean(backlog?.suggestedAction ?? ""),
        sellerDirectoryPresent: clean(evidence?.sellerDirectoryPresent ?? ""),
        sellerPageUrls: clean(evidence?.sellerPageUrls ?? ""),
        linkedCampaignSalesCodes: clean(evidence?.linkedCampaignSalesCodes ?? ""),
        linkedSalesBrands: normalizeEvidenceList(evidence?.linkedSalesBrands ?? ""),
        linkedSalesNotes: normalizeEvidenceList(evidence?.linkedSalesNotes ?? ""),
      };
      return {
        ...baseRow,
        ...inferDecisionHint(baseRow),
      };
    }).filter((row) => !isIgnoredSourceKey(row.sourceKey));

  const pendingRows = collect("pending", plan.pendingRows);
  const blockedRows = collect("blocked", plan.blockedRows);
  const remainingRows = [...pendingRows, ...blockedRows];

  const markdown = [
    "# Notion Remaining Manual Review",
    "",
    `Last updated: 2026-05-16`,
    "",
    "## Summary",
    "",
    `- Pending rows: \`${pendingRows.length}\``,
    `- Blocked rows: \`${blockedRows.length}\``,
    `- Total remaining manual rows: \`${remainingRows.length}\``,
    "",
    renderSection("Pending", pendingRows),
    renderSection("Blocked", blockedRows),
  ].join("\n");

  const markdownPath = join(process.cwd(), "NOTION_IMPORT_REMAINING_MANUAL_REVIEW.md");
  const csvPath = join(process.cwd(), "artifacts/notion-import-remaining-manual-review.csv");

  writeFileSync(markdownPath, `${markdown}\n`);
  writeFileSync(csvPath, `${Papa.unparse(remainingRows)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        markdownPath,
        csvPath,
        pendingCount: pendingRows.length,
        blockedCount: blockedRows.length,
        total: remainingRows.length,
      },
      null,
      2,
    ),
  );
}

main();
