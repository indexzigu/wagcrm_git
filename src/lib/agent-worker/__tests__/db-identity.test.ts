import { describe, expect, it, vi } from "vitest";
import {
  AGENT_WORKER_DB_ROLE,
  AgentWorkerDbIdentityError,
  assertAgentWorkerDbIdentity,
} from "../db-identity";

const ok = [{ currentUser: AGENT_WORKER_DB_ROLE, sessionUser: AGENT_WORKER_DB_ROLE }];

describe("assertAgentWorkerDbIdentity", () => {
  it("passes only when the database answers with the least-privilege role, and asks once", async () => {
    const query = vi.fn().mockResolvedValue(ok);

    await expect(assertAgentWorkerDbIdentity(query)).resolves.toEqual({
      currentUser: AGENT_WORKER_DB_ROLE,
      sessionUser: AGENT_WORKER_DB_ROLE,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("refuses a full-privilege login — the case the wrapper's string compare lets through", async () => {
    const query = vi.fn().mockResolvedValue([{ currentUser: "postgres", sessionUser: "postgres" }]);

    await expect(assertAgentWorkerDbIdentity(query)).rejects.toThrow(AgentWorkerDbIdentityError);
    await expect(assertAgentWorkerDbIdentity(query)).rejects.toThrow(/"postgres".*"wag_agent_worker"/);
  });

  it("refuses an escalation on top of a correct login (SET ROLE)", async () => {
    const query = vi.fn().mockResolvedValue([{ currentUser: "postgres", sessionUser: AGENT_WORKER_DB_ROLE }]);

    await expect(assertAgentWorkerDbIdentity(query)).rejects.toThrow(AgentWorkerDbIdentityError);
  });

  it("refuses a correct acting role reached from the wrong login", async () => {
    const query = vi.fn().mockResolvedValue([{ currentUser: AGENT_WORKER_DB_ROLE, sessionUser: "postgres" }]);

    await expect(assertAgentWorkerDbIdentity(query)).rejects.toThrow(AgentWorkerDbIdentityError);
  });

  it.each([
    ["no rows", []],
    ["more than one row", [ok[0], ok[0]]],
    ["a non-array result", { currentUser: AGENT_WORKER_DB_ROLE }],
    ["a non-object row", ["wag_agent_worker"]],
    ["a missing column", [{ sessionUser: AGENT_WORKER_DB_ROLE }]],
    ["a blank column", [{ currentUser: "   ", sessionUser: AGENT_WORKER_DB_ROLE }]],
    ["a non-string column", [{ currentUser: 7, sessionUser: AGENT_WORKER_DB_ROLE }]],
  ])("fails closed when the probe returns %s", async (_label, rows) => {
    await expect(assertAgentWorkerDbIdentity(() => Promise.resolve(rows))).rejects.toThrow(
      AgentWorkerDbIdentityError,
    );
  });

  it("fails closed when the probe itself throws, without repeating the driver message", async () => {
    // Driver errors name the connection target ("Can't reach database server at
    // host:port"). This error is written to a shared log file, so the message must
    // not carry it — the original stays on `cause`, which nothing prints.
    const driverError = new Error("Can't reach database server at db.internal:55432");
    const query = vi.fn().mockRejectedValue(driverError);

    const caught = await assertAgentWorkerDbIdentity(query).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AgentWorkerDbIdentityError);
    expect((caught as Error).message).not.toContain("db.internal");
    expect((caught as Error).cause).toBe(driverError);
  });

  it("honours an explicit expected role", async () => {
    const query = vi.fn().mockResolvedValue([{ currentUser: "other_role", sessionUser: "other_role" }]);

    await expect(assertAgentWorkerDbIdentity(query, "other_role")).resolves.toEqual({
      currentUser: "other_role",
      sessionUser: "other_role",
    });
  });
});
