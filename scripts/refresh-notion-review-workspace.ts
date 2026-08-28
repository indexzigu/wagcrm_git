import { execFileSync } from "node:child_process";

type Step = {
  label: string;
  scriptPath: string;
  args?: string[];
};

const steps: Step[] = [
  {
    label: "export review backlog artifacts",
    scriptPath: "scripts/export-notion-review-backlog.ts",
  },
  {
    label: "generate seller triage worksheet",
    scriptPath: "scripts/generate-notion-seller-triage-worksheet.ts",
  },
  {
    label: "generate deal and campaign review worksheets",
    scriptPath: "scripts/generate-notion-review-worksheets.ts",
  },
  {
    label: "generate decision template csv files",
    scriptPath: "scripts/generate-notion-decision-templates.ts",
  },
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
    args: ["--target=remote"],
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
    label: "generate remaining manual review packet",
    scriptPath: "scripts/generate-notion-remaining-manual-review.ts",
  },
  {
    label: "generate decision discrepancy report",
    scriptPath: "scripts/generate-notion-decision-discrepancy-report.ts",
  },
  {
    label: "generate remote backlog status report",
    scriptPath: "scripts/generate-notion-remote-backlog-status-report.ts",
  },
];

/**
 * Run one workspace refresh step with the repo-local tsx loader path.
 */
function runStep(step: Step) {
  console.log(`Running: ${step.label}`);
  execFileSync(process.execPath, ["--import", "tsx", step.scriptPath, ...(step.args ?? [])], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
}

async function main() {
  const results: Array<{ label: string; ok: boolean; usedExistingArtifacts?: boolean }> = [];

  for (const [index, step] of steps.entries()) {
    try {
      runStep(step);
      results.push({ label: step.label, ok: true });
    } catch (error) {
      if (index === 0) {
        console.warn(
          `Warning: ${step.label} failed. Continuing with existing backlog artifacts for worksheet regeneration.`,
        );
        results.push({
          label: step.label,
          ok: false,
          usedExistingArtifacts: true,
        });
        continue;
      }

      throw error;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        stepCount: steps.length,
        results,
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
