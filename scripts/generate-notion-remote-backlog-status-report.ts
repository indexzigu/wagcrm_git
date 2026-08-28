import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { isIgnoredSourceKey } from "./notion-import-ignore";

type BacklogRow = {
  reviewType: string;
  sourceKey: string;
  reviewReason: string;
  sellerName: string;
  dealName: string;
  partnerOrBrand: string;
  salesCode: string;
  candidateLabel: string;
  suggestedAction: string;
};

type DecisionPlan = {
  generatedAt: string;
  counts: {
    plan: number;
    pending: number;
    blocked?: number;
    invalid: number;
  };
  planRows: Array<{
    sourceKey: string;
    action: string;
    entity: string;
    reference: string;
  }>;
  pendingRows?: Array<{ entity: string; sourceKey: string; reason: string }>;
  blockedRows?: Array<{ entity: string; sourceKey: string; reason: string }>;
};

type DecisionApply = {
  batchId: string;
  generatedAt: string;
  mode: string;
  target: string;
  executed: Record<string, number>;
  failures: Array<{ sourceKey: string; action: string; reason: string }>;
  planRows: Array<{
    sourceKey: string;
    action: string;
    entity: string;
    reference: string;
  }>;
};

type RemainingRow = {
  queue: string;
  entity: string;
  sourceKey: string;
  reason: string;
  decisionHint: string;
  operatorAction: string;
};

type StatusRow = {
  status: "applied" | "outstanding" | "snapshot-only" | "ignored";
  reviewType: string;
  sourceKey: string;
  label: string;
  reviewReason: string;
  suggestedAction: string;
  planAction: string;
  remainingQueue: string;
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

function readJson<T>(relativePath: string) {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as T;
}

function clean(value: string | undefined) {
  return (value ?? "").replace(/\r?\n/g, " ").trim();
}

function makeLabel(row: BacklogRow) {
  if (row.reviewType === "seller") return clean(row.sellerName) || clean(row.sourceKey);
  if (row.reviewType === "deal") {
    return [clean(row.partnerOrBrand), clean(row.dealName)].filter(Boolean).join(" / ");
  }
  return clean(row.salesCode) || clean(row.sourceKey);
}

function renderSection(title: string, rows: StatusRow[]) {
  if (rows.length === 0) {
    return [`## ${title}`, "", "- none", ""].join("\n");
  }

  return [
    `## ${title}`,
    "",
    ...rows.map((row, index) =>
      [
        `### ${index + 1}. ${row.label}`,
        "",
        `- Review type: \`${row.reviewType}\``,
        `- Source key: \`${row.sourceKey}\``,
        `- Snapshot status: \`${row.status}\``,
        `- Review reason: \`${row.reviewReason || "none"}\``,
        `- Snapshot suggested action: \`${row.suggestedAction || "none"}\``,
        `- Decision plan action: \`${row.planAction || "none"}\``,
        `- Remaining queue: \`${row.remainingQueue || "none"}\``,
        `- Decision hint: \`${row.decisionHint || "none"}\``,
        `- Operator action: \`${row.operatorAction || "none"}\``,
        "",
      ].join("\n"),
    ),
  ].join("\n");
}

function main() {
  const backlogRows = readCsv<BacklogRow>("artifacts/notion-import-review-backlog.remote.csv");
  const plan = readJson<DecisionPlan>("artifacts/notion-import-decision-plan.json");
  const apply = readJson<DecisionApply>("artifacts/notion-decision-apply-remote.json");
  const remainingRows = readCsv<RemainingRow>("artifacts/notion-import-remaining-manual-review.csv");

  const appliedSourceKeys = new Set(apply.planRows.map((row) => clean(row.sourceKey)));
  const planBySourceKey = new Map(
    plan.planRows.map((row) => [clean(row.sourceKey), row.action]),
  );
  const remainingBySourceKey = new Map(
    remainingRows.map((row) => [
      clean(row.sourceKey),
      {
        queue: clean(row.queue),
        decisionHint: clean(row.decisionHint),
        operatorAction: clean(row.operatorAction),
      },
    ]),
  );

  const rows: StatusRow[] = backlogRows.map((row) => {
    const sourceKey = clean(row.sourceKey);
    const remaining = remainingBySourceKey.get(sourceKey);
    const isApplied = appliedSourceKeys.has(sourceKey);
    const status: StatusRow["status"] = isIgnoredSourceKey(sourceKey)
      ? "ignored"
      : remaining
        ? "outstanding"
        : isApplied
          ? "applied"
          : "snapshot-only";

    return {
      status,
      reviewType: clean(row.reviewType),
      sourceKey,
      label: makeLabel(row),
      reviewReason: clean(row.reviewReason),
      suggestedAction: clean(row.suggestedAction),
      planAction: clean(planBySourceKey.get(sourceKey)),
      remainingQueue: clean(remaining?.queue),
      decisionHint: clean(remaining?.decisionHint),
      operatorAction: clean(remaining?.operatorAction),
    };
  });

  const outstandingRows = rows.filter((row) => row.status === "outstanding");
  const appliedRows = rows.filter((row) => row.status === "applied");
  const snapshotOnlyRows = rows.filter((row) => row.status === "snapshot-only");
  const ignoredRows = rows.filter((row) => row.status === "ignored");

  const markdown = [
    "# Notion Remote Backlog Status",
    "",
    "Last updated: 2026-05-17",
    "",
    "## Summary",
    "",
    `- Remote backlog snapshot rows: \`${rows.length}\``,
    `- Applied or resolved rows: \`${appliedRows.length}\``,
    `- Outstanding rows: \`${outstandingRows.length}\``,
    `- Snapshot-only rows: \`${snapshotOnlyRows.length}\``,
    `- Ignored rows: \`${ignoredRows.length}\``,
    `- Latest remote apply batch: \`${apply.batchId}\``,
    "",
    "Use this report to distinguish historical remote review rows from the actual remaining operator queue.",
    "",
    renderSection("Outstanding Queue", outstandingRows),
    renderSection("Ignored Rows", ignoredRows),
    renderSection("Applied Or Resolved", appliedRows),
    renderSection("Snapshot Only", snapshotOnlyRows),
  ].join("\n");

  const markdownPath = join(process.cwd(), "NOTION_IMPORT_REMOTE_BACKLOG_STATUS.md");
  const csvPath = join(process.cwd(), "artifacts/notion-import-remote-backlog-status.csv");

  writeFileSync(markdownPath, `${markdown}\n`);
  writeFileSync(csvPath, `${Papa.unparse(rows)}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        markdownPath,
        csvPath,
        counts: {
          total: rows.length,
          applied: appliedRows.length,
          outstanding: outstandingRows.length,
          snapshotOnly: snapshotOnlyRows.length,
          ignored: ignoredRows.length,
        },
        latestRemoteApplyBatch: apply.batchId,
      },
      null,
      2,
    ),
  );
}

main();
