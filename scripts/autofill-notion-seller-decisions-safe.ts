import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import {
  extractInstagramHandle,
  extractRelationTitles,
  toNullableString,
} from "../src/lib/notion-import/normalize";

const SELLER_DIRECTORY_PATH =
  "/Users/z9/Downloads/셀러디렉토리/셀러 디렉토리 211cfeed46138096bd63d692bbc6e345_all.csv";
const SALES_TRACKING_PATH =
  "/Users/z9/Downloads/세일즈트래킹/세일즈 트래킹 211cfeed4613809bb948f5d072e1a1ce_all.csv";

type SellerDecisionRow = {
  sourceKey: string;
  sellerName: string;
  decision: string;
  confirmedPlatform: string;
  confirmedHandle: string;
  confirmedChannelUrl: string;
  notes: string;
};

type SellerDirectoryRow = {
  채널명: string;
  세일즈_트래킹: string;
  채널주소: string;
  플랫폼: string;
};

type SalesTrackingRow = {
  "셀러 정보": string;
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

function readAbsoluteCsv<T>(absolutePath: string) {
  const raw = readFileSync(absolutePath, "utf8");
  const parsed = Papa.parse<T>(raw, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    throw new Error(
      `Failed to parse ${absolutePath}: ${parsed.errors.map((error) => error.message).join(", ")}`,
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

async function main() {
  const decisionPath = "artifacts/notion-import-seller-decisions.template.csv";
  const decisionRows = readCsv<SellerDecisionRow>(decisionPath);
  const directoryRows = readAbsoluteCsv<SellerDirectoryRow>(SELLER_DIRECTORY_PATH);
  const trackingRows = readAbsoluteCsv<SalesTrackingRow>(SALES_TRACKING_PATH);

  let autofilledCreate = 0;
  let autofilledHold = 0;
  let platformPrefilled = 0;
  let handlePrefilled = 0;
  let channelPrefilled = 0;

  for (const row of decisionRows) {
    if (row.decision?.trim()) continue;

    const directoryRow = directoryRows.find(
      (entry) => toNullableString(entry.채널명) === row.sellerName.trim(),
    );
    const platform = toNullableString(directoryRow?.플랫폼) ?? "";
    const channelUrl = toNullableString(directoryRow?.채널주소) ?? "";
    const handle = extractInstagramHandle(channelUrl) ?? "";
    const trackingRefs = extractRelationTitles(directoryRow?.세일즈_트래킹 ?? "");
    const matchingSalesRows = trackingRows.filter((entry) =>
      extractRelationTitles(entry["셀러 정보"]).includes(row.sellerName.trim()),
    );

    if (!row.confirmedPlatform?.trim() && platform) {
      row.confirmedPlatform = platform;
      platformPrefilled += 1;
    }
    if (!row.confirmedHandle?.trim() && handle) {
      row.confirmedHandle = handle;
      handlePrefilled += 1;
    }
    if (!row.confirmedChannelUrl?.trim() && channelUrl) {
      row.confirmedChannelUrl = channelUrl;
      channelPrefilled += 1;
    }

    if (platform && handle) {
      row.decision = "create-new-seller";
      if (!row.notes?.trim()) row.notes = "autofill-safe-seller-create";
      autofilledCreate += 1;
      continue;
    }

    const hasLinkedEvidence = trackingRefs.length > 0 || matchingSalesRows.length > 0;
    if (!platform && !channelUrl && !hasLinkedEvidence) {
      row.decision = "hold";
      if (!row.notes?.trim()) row.notes = "autofill-safe-orphan-seller-hold";
      autofilledHold += 1;
    }
  }

  writeCsv(decisionPath, decisionRows);

  console.log(
    JSON.stringify(
      {
        ok: true,
        path: decisionPath,
        autofilledCreate,
        autofilledHold,
        platformPrefilled,
        handlePrefilled,
        channelPrefilled,
        total: decisionRows.length,
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
