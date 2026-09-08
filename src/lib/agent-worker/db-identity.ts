/**
 * Worker database identity guard (T-117).
 *
 * `infra/selfhost/run-agent-worker.sh` can only compare connection *strings*: it
 * refuses to start when the worker env file repeats the app's DATABASE_URL. That
 * check is a spelling check, not an identity check — the very same full-privilege
 * account passes it as soon as one option differs (`?sslmode=`, a pooler port, a
 * trailing slash). The boundary the worker actually depends on is "which role did
 * Postgres authenticate me as", and only the database can answer that.
 *
 * So the worker asks, once, at startup, and refuses to run as anything but the
 * least-privilege role. Both columns are checked and they answer different
 * questions:
 *   - `session_user`  = the role that logged in. Catches the wrong DATABASE_URL.
 *   - `current_user`  = the role privileges are evaluated against. Catches a
 *                       `SET ROLE` / `SECURITY DEFINER` escalation on top of a
 *                       correct login.
 * Checking only one of them leaves the other half of that pair unguarded.
 *
 * Fail closed: an unreadable answer is a failed verification, never a pass. The
 * thrown message names roles only — never the connection string (P0, public repo
 * and shared log files).
 */

/** The least-privilege role the worker must run as (see infra/selfhost/README.md). */
export const AGENT_WORKER_DB_ROLE = "wag_agent_worker";

export type AgentWorkerDbIdentity = {
  currentUser: string;
  sessionUser: string;
};

/**
 * Runs `SELECT current_user, session_user` and returns whatever the driver hands
 * back. Kept as a parameter so the guard is testable without a database.
 */
export type DbIdentityQuery = () => Promise<unknown>;

export class AgentWorkerDbIdentityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentWorkerDbIdentityError";
  }
}

function readRoleColumn(row: Record<string, unknown>, column: keyof AgentWorkerDbIdentity): string {
  const value = row[column];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentWorkerDbIdentityError(
      `database identity probe returned no ${column}; refusing to start (expected role ${AGENT_WORKER_DB_ROLE})`,
    );
  }
  return value.trim();
}

/** Shape-checks the probe result. Anything unexpected is a failed verification. */
export function parseDbIdentityRows(rows: unknown): AgentWorkerDbIdentity {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new AgentWorkerDbIdentityError(
      `database identity probe returned ${Array.isArray(rows) ? `${rows.length} rows` : "a non-array result"}; refusing to start`,
    );
  }
  const row = rows[0];
  if (typeof row !== "object" || row === null) {
    throw new AgentWorkerDbIdentityError("database identity probe returned a non-object row; refusing to start");
  }
  const record = row as Record<string, unknown>;
  return {
    currentUser: readRoleColumn(record, "currentUser"),
    sessionUser: readRoleColumn(record, "sessionUser"),
  };
}

/**
 * Asks the database which role this connection is, and throws unless both answers
 * are the least-privilege worker role.
 *
 * The query itself is wrapped: driver errors can carry the connection target in
 * their message, and this error is written to a log file, so only a generic
 * sentence is thrown (the original stays reachable as `cause`, which the worker
 * entrypoint does not print).
 */
export async function assertAgentWorkerDbIdentity(
  query: DbIdentityQuery,
  expectedRole: string = AGENT_WORKER_DB_ROLE,
): Promise<AgentWorkerDbIdentity> {
  let rows: unknown;
  try {
    rows = await query();
  } catch (error) {
    throw new AgentWorkerDbIdentityError(
      "could not verify the database role of this connection; refusing to start",
      { cause: error },
    );
  }

  const identity = parseDbIdentityRows(rows);
  if (identity.sessionUser !== expectedRole || identity.currentUser !== expectedRole) {
    throw new AgentWorkerDbIdentityError(
      `worker is connected as database role "${identity.sessionUser}" (acting as "${identity.currentUser}") but must be "${expectedRole}"; ` +
        "point DATABASE_URL in infra/selfhost/agent-worker.env at the least-privilege worker role",
    );
  }
  return identity;
}
