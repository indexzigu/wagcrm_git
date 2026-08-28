import { readFileSync } from "node:fs";
import { requiredCiSecrets } from "./release-config-shared";

const workflowPath = ".github/workflows/release-preflight.yml";
const checklistPath = "RELEASE_CHECKLIST.md";
const envCheckPath = "scripts/check-env.ts";

type Result = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

function extractWorkflowSecretNames(source: string) {
  return Array.from(source.matchAll(/\${{\s*secrets\.([A-Z0-9_]+)\s*}}/g)).map((match) => match[1]);
}

function extractChecklistSecretNames(source: string) {
  return Array.from(source.matchAll(/- `([A-Z0-9_]+)`/g)).map((match) => match[1]);
}

function main() {
  const result: Result = { ok: true, errors: [], warnings: [] };
  const workflowSource = readFileSync(workflowPath, "utf8");
  const checklistSource = readFileSync(checklistPath, "utf8");
  const envCheckSource = readFileSync(envCheckPath, "utf8");

  const workflowSecrets = new Set(extractWorkflowSecretNames(workflowSource));
  const checklistSecrets = new Set(extractChecklistSecretNames(checklistSource));

  for (const secret of requiredCiSecrets) {
    if (!workflowSecrets.has(secret)) {
      result.errors.push(`Workflow is missing required CI secret mapping: ${secret}`);
    }
    if (!checklistSecrets.has(secret)) {
      result.errors.push(`Release checklist is missing documented CI secret: ${secret}`);
    }
    if (!envCheckSource.includes(`"${secret}"`)) {
      result.warnings.push(
        `env:check does not reference CI secret '${secret}' directly; verify that this is intentional.`,
      );
    }
  }

  const workflowRequiredLoop = workflowSource.match(/for name in ([A-Z0-9_ ]+); do/);
  if (!workflowRequiredLoop) {
    result.errors.push("Workflow required-secret validation loop was not found.");
  } else {
    const names = workflowRequiredLoop[1].trim().split(/\s+/);
    for (const secret of requiredCiSecrets) {
      if (!names.includes(secret)) {
        result.errors.push(`Workflow required-secret validation loop is missing: ${secret}`);
      }
    }
  }

  const output = {
    ok: result.errors.length === 0,
    requiredCiSecrets,
    workflowPath,
    checklistPath,
    envCheckPath,
    errors: result.errors,
    warnings: result.warnings,
  };

  console.log(JSON.stringify(output, null, 2));

  if (result.errors.length > 0) {
    process.exit(1);
  }
}

main();
