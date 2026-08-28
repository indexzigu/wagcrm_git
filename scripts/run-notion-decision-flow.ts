import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type DecisionPlan = {
  counts: {
    plan: number;
    pending: number;
    blocked?: number;
    invalid: number;
  };
  pendingRows?: Array<{ entity: string; sourceKey: string; reason: string }>;
  blockedRows?: Array<{ entity: string; sourceKey: string; reason: string }>;
  invalidRows?: Array<{ entity: string; sourceKey: string; reason: string }>;
};

type DecisionRun = {
  mode: string;
  target: string;
  planCount: number;
  pendingCount: number;
  invalidCount: number;
  executed: Record<string, number>;
  failures: Array<{ sourceKey: string; action: string; reason: string }>;
};

type Step = {
  label: string;
  scriptPath: string;
  args?: string[];
};

function getArg(flag: string) {
  return process.argv.includes(flag);
}

function runStep(step: Step) {
  console.log(`Running: ${step.label}`);
  execFileSync(
    process.execPath,
    ["--import", "tsx", step.scriptPath, ...(step.args ?? [])],
    {
      cwd: process.cwd(),
      stdio: "inherit",
    },
  );
}

function readJson<T>(relativePath: string) {
  const absolutePath = join(process.cwd(), relativePath);
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}

function topRows<T>(rows: T[] | undefined, limit = 5) {
  if (!rows || rows.length === 0) return [];
  return rows.slice(0, limit);
}

function main() {
  const applyLocal = getArg("--apply-local");
  const decisionStepLabel = applyLocal
    ? "run local decision apply"
    : "run local decision dry-run";

  const steps: Step[] = [
    {
      label: "sync markdown worksheets into decision templates",
      scriptPath: "scripts/sync-notion-worksheets-to-decision-templates.ts",
    },
    {
      label: "autofill safe seller decisions",
      scriptPath: "scripts/autofill-notion-seller-decisions-safe.ts",
    },
    {
      label: "prefill seller decision evidence",
      scriptPath: "scripts/prefill-notion-seller-decisions-safe.ts",
    },
    {
      label: "reconcile seller decisions to temporary create-safe values",
      scriptPath: "scripts/reconcile-notion-seller-decisions-safe.ts",
    },
    {
      label: "autofill safe campaign decisions",
      scriptPath: "scripts/autofill-notion-decisions-safe.ts",
    },
    {
      label: "autofill safe deal merge decisions",
      scriptPath: "scripts/autofill-notion-deal-decisions-safe.ts",
      args: ["--target=local"],
    },
    {
      label: "prefill safe deal confirmation fields",
      scriptPath: "scripts/prefill-notion-deal-decisions-safe.ts",
    },
    {
      label: "reconcile deal decisions to safe recommendations",
      scriptPath: "scripts/reconcile-notion-deal-decisions-safe.ts",
    },
    {
      label: "generate decision execution plan",
      scriptPath: "scripts/generate-notion-decision-plan.ts",
    },
    {
      label: decisionStepLabel,
      scriptPath: "scripts/apply-notion-decision-plan.ts",
      args: applyLocal ? ["--apply", "--target=local"] : ["--target=local"],
    },
  ];

  for (const step of steps) {
    runStep(step);
  }

  const plan = readJson<DecisionPlan>("artifacts/notion-import-decision-plan.json");
  const runArtifactPath = applyLocal
    ? "artifacts/notion-decision-apply-local.json"
    : "artifacts/notion-decision-dry-run-local.json";
  const runResult = readJson<DecisionRun>(runArtifactPath);

  console.log(
    JSON.stringify(
      {
        ok: true,
        summary: {
          mode: applyLocal ? "apply-local" : "dry-run",
          planCount: plan.counts.plan,
          pendingCount: plan.counts.pending,
          blockedCount: plan.counts.blocked ?? 0,
          invalidCount: plan.counts.invalid,
          runMode: runResult.mode,
          runTarget: runResult.target,
          runExecuted: runResult.executed,
          runFailureCount: runResult.failures.length,
        },
        nextCheck: {
          pendingPreview: topRows(plan.pendingRows, 8),
          blockedPreview: topRows(plan.blockedRows, 8),
          invalidPreview: topRows(plan.invalidRows, 8),
          runFailuresPreview: topRows(runResult.failures, 8),
        },
      },
      null,
      2,
    ),
  );
}

main();
