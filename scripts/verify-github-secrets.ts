import "dotenv/config";
import { execFileSync } from "node:child_process";
import { optionalCiSecrets, requiredCiSecrets } from "./release-config-shared";

type GithubSecretRow = {
  name: string;
};

type GithubVariableRow = {
  name: string;
};

function resolveRepo() {
  const fromEnv = process.env.GITHUB_REPOSITORY?.trim();
  if (fromEnv) return fromEnv;
  const remote = execFileSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
  }).trim();
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Could not resolve GitHub repository from origin: ${remote}`);
  }
  return match[1];
}

function readJson<T>(cmd: string, args: string[]) {
  const stdout = execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout) as T;
}

function main() {
  const repo = resolveRepo();
  const secrets = readJson<GithubSecretRow[]>("gh", [
    "secret",
    "list",
    "--repo",
    repo,
    "--json",
    "name",
  ]);
  const variables = readJson<GithubVariableRow[]>("gh", [
    "variable",
    "list",
    "--repo",
    repo,
    "--json",
    "name",
  ]);

  const secretNames = new Set(secrets.map((entry) => entry.name));
  const variableNames = new Set(variables.map((entry) => entry.name));

  const missingRequiredSecrets = requiredCiSecrets.filter((name) => !secretNames.has(name));
  const missingOptionalSecrets = optionalCiSecrets.filter((name) => !secretNames.has(name));

  const misplacedRequiredVariables = requiredCiSecrets.filter((name) => variableNames.has(name));
  const misplacedOptionalVariables = optionalCiSecrets.filter((name) => variableNames.has(name));

  const output = {
    ok: missingRequiredSecrets.length === 0,
    repo,
    requiredCiSecrets,
    optionalCiSecrets,
    presentSecretCount: secretNames.size,
    presentVariableCount: variableNames.size,
    missingRequiredSecrets,
    missingOptionalSecrets,
    misplacedRequiredVariables,
    misplacedOptionalVariables,
  };

  console.log(JSON.stringify(output, null, 2));

  if (missingRequiredSecrets.length > 0) {
    process.exit(1);
  }
}

main();
