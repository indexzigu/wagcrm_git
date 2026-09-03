/**
 * Guard for the opt-in `worker-role-privileges.realpg.test.ts`: decides whether the
 * PostgreSQL URL it was pointed at is a disposable throw-away database.
 *
 * Why this lives in its own module: the test that uses it is opt-in and therefore
 * skipped by `npm run test:ci`, so a guard written inline would never be exercised.
 * Here the judgment is a plain function with hermetic unit tests beside it.
 *
 * The criteria are NOT invented here. They rest on two sources of truth:
 *   - "does this URL point at a real database" -> `isRemoteDatabaseUrl()` in
 *     `src/lib/prisma-client.ts` (AGENTS.md P0). It splits on sqlite-ness, not on
 *     host, so a loopback PostgreSQL still counts as remote.
 *   - "which database is production" -> the repository `.env` (`DATABASE_URL` /
 *     `DIRECT_URL`), which AGENTS.md P0 "Repo .env Is Production DB" declares to be
 *     the production connection string.
 * On top of those sits the self-hosted stack's documented set of doors (P9).
 *
 * Connection strings are never echoed: comparison happens on host:port only and
 * failure messages name variables, never values (public repository, P0).
 */
import { vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The self-hosted production stack's ports, per P9 "프로덕션 DB 로 가는 문은 전부
 * 루프백 전용이다": PostgreSQL itself on 55432, the Supavisor pooler on 5432/6543.
 */
const PRODUCTION_PORTS = new Set(["55432", "5432", "6543"]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const CONFIGURED_URL_KEYS = ["DATABASE_URL", "DIRECT_URL"] as const;

/**
 * Every connection string this repository is configured against: the ambient
 * environment (a shell that ran `set -a; source .env` has them) plus the `.env` file
 * itself (an operator who copied the production URL into the opt-in variable by hand
 * leaves no trace in the environment).
 *
 * Values are returned for host:port comparison only. A missing `.env` — fresh clone,
 * CI — simply contributes nothing; the other checks still apply.
 */
export function readConfiguredDatabaseUrls(repositoryRoot = process.cwd()): string[] {
  const collected: Array<string | undefined> = CONFIGURED_URL_KEYS.map((key) => process.env[key]);
  const envPath = join(repositoryRoot, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?(DATABASE_URL|DIRECT_URL)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      collected.push(match[2].trim().replace(/^(["'])(.*)\1$/, "$2"));
    }
  }
  return collected.filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

function endpointOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port}`;
  } catch {
    return null;
  }
}

/**
 * The caller mocks `@/lib/prisma-client`, so a plain import would resolve to the mock
 * and the guard would judge with whatever the caller supplied. Resolving the real
 * module keeps the verdict out of the caller's reach.
 */
async function resolveIsRemoteDatabaseUrl(): Promise<(url?: string) => boolean> {
  const actual = await vi.importActual<typeof import("@/lib/prisma-client")>("@/lib/prisma-client");
  return actual.isRemoteDatabaseUrl;
}

/**
 * Throws unless `adminUrl` is a disposable database. Refuses, in order: anything off
 * loopback, the documented production ports, and any endpoint this repository is
 * already configured against.
 */
export async function assertDisposablePostgresUrl(
  adminUrl: string,
  configuredUrls: readonly string[] = readConfiguredDatabaseUrls(),
): Promise<void> {
  const parsed = new URL(adminUrl);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error("privilege test refuses non-loopback databases");
  }
  if (PRODUCTION_PORTS.has(parsed.port)) {
    throw new Error("privilege test refuses the self-hosted production ports (55432/5432/6543)");
  }

  const isRemoteDatabaseUrl = await resolveIsRemoteDatabaseUrl();
  const target = endpointOf(adminUrl);
  for (const configured of configuredUrls) {
    // sqlite and empty values are not a production database (isRemoteDatabaseUrl).
    if (!isRemoteDatabaseUrl(configured)) continue;
    if (endpointOf(configured) === target) {
      throw new Error(
        "privilege test refuses the database this repository is configured against " +
          "(DATABASE_URL/DIRECT_URL — AGENTS.md P0: the repo .env is the production DB)",
      );
    }
  }
}
