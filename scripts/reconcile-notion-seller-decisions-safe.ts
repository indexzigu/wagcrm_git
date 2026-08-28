import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";

type SellerDecisionRow = {
  sourceKey: string;
  decisionOptions: string;
  decision: string;
  confirmedPlatform: string;
  confirmedHandle: string;
  notes: string;
};

type TempSellerConfig = {
  platform: string;
  handle: string;
  note: string;
};

// sourceKey 에 실 셀러명이 들어가므로 코드에 하드코딩하지 않고 gitignore 된 로컬 설정에서 읽는다
// (PUBLIC 레포 미노출 — AGENTS.md P0). 템플릿: scripts/config/notion-temp-sellers.example.json
function loadTempSellerConfig(): Record<string, TempSellerConfig> {
  const path = join(process.cwd(), "scripts/config/notion-temp-sellers.local.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Notion 임시 셀러 설정이 없습니다: ${path}\n` +
        `scripts/config/notion-temp-sellers.example.json 을 복사해 실제 셀러로 채우세요.`,
    );
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const config: Record<string, TempSellerConfig> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("_")) continue; // _comment 등 메타 키 무시
    config[key] = value as TempSellerConfig;
  }
  return config;
}

const TEMP_SELLER_CONFIG: Record<string, TempSellerConfig> = loadTempSellerConfig();

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

function splitNotes(value: string) {
  return value
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function appendUniqueNote(existing: string, note: string) {
  const parts = splitNotes(existing);
  if (!parts.includes(note)) parts.push(note);
  return parts.join(" | ");
}

function allowsCreateNewSeller(row: SellerDecisionRow) {
  return row.decisionOptions
    .split("|")
    .map((part) => part.trim())
    .includes("create-new-seller");
}

function main() {
  const decisionPath = "artifacts/notion-import-seller-decisions.template.csv";
  const decisionRows = readCsv<SellerDecisionRow>(decisionPath);

  let decisionUpdated = 0;
  let platformUpdated = 0;
  let handleUpdated = 0;
  let notesUpdated = 0;

  for (const row of decisionRows) {
    const config = TEMP_SELLER_CONFIG[row.sourceKey.trim()];
    if (!config || !allowsCreateNewSeller(row)) continue;

    if (row.decision.trim() !== "create-new-seller") {
      row.decision = "create-new-seller";
      decisionUpdated += 1;
    }
    if (row.confirmedPlatform.trim() !== config.platform) {
      row.confirmedPlatform = config.platform;
      platformUpdated += 1;
    }
    if (row.confirmedHandle.trim() !== config.handle) {
      row.confirmedHandle = config.handle;
      handleUpdated += 1;
    }

    const nextNotes = appendUniqueNote(row.notes ?? "", config.note);
    if (nextNotes !== (row.notes ?? "").trim()) {
      row.notes = nextNotes;
      notesUpdated += 1;
    }
  }

  writeCsv(decisionPath, decisionRows);

  console.log(
    JSON.stringify(
      {
        ok: true,
        path: decisionPath,
        decisionUpdated,
        platformUpdated,
        handleUpdated,
        notesUpdated,
        targetedRows: Object.keys(TEMP_SELLER_CONFIG).length,
      },
      null,
      2,
    ),
  );
}

main();
