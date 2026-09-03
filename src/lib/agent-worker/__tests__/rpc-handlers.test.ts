import { describe, expect, it, vi } from "vitest";
import { createRpcHandlers, type AgentJobQueue } from "../rpc-handlers";
import { RpcError } from "../socket-server";
import type { AgentJobRecord } from "@/repositories/agentJobRepository";

const payload = {
  schemaVersion: 1,
  taskType: "routine",
  skill: "pipeline_status",
  operation: "get_pipeline_status",
  input: {},
  origin: {
    source: "hermes_slack",
    correlationId: "correlation-1",
    requesterDigest: "requester-digest",
    threadDigest: "thread-digest",
  },
} as const;

function job(overrides: Partial<AgentJobRecord> = {}): AgentJobRecord {
  return {
    id: "job-1",
    idempotencyKey: "key-1",
    payload: { ...payload, input: {} },
    status: "QUEUED",
    workerId: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attempt: 0,
    result: null,
    failureCode: null,
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
    updatedAt: new Date("2026-09-02T00:00:00.000Z"),
    ...overrides,
  };
}

function build(queue: { submit?: ReturnType<typeof vi.fn>; findById?: ReturnType<typeof vi.fn> } = {}) {
  const submit = queue.submit ?? vi.fn(async () => ({ created: true, job: job() }));
  const findById = queue.findById ?? vi.fn(async () => job());
  const handlers = createRpcHandlers({
    queue: { submit, findById } as unknown as AgentJobQueue,
    workerId: "worker-test",
    startedAt: new Date("2026-09-02T00:00:00.000Z"),
    waitTimeoutMs: 60,
    pollIntervalMs: 10,
    activeJobs: () => 1,
  });
  return { handlers, submit, findById };
}

const context = () => ({ signal: new AbortController().signal });

describe("agent worker RPC handlers", () => {
  it("submit validates the payload and returns the queue identity", async () => {
    const { handlers, submit } = build();

    await expect(handlers.submit({ payload }, context())).resolves.toEqual({
      jobId: "job-1",
      created: true,
      status: "QUEUED",
    });
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ operation: "get_pipeline_status" }), expect.any(Date));
  });

  it("submit reports a duplicate as created=false with the existing job id", async () => {
    const submit = vi.fn(async () => ({ created: false, job: job({ id: "job-existing" }) }));
    const { handlers } = build({ submit });

    await expect(handlers.submit({ payload }, context())).resolves.toEqual({
      jobId: "job-existing",
      created: false,
      status: "QUEUED",
    });
  });

  it("submit rejects an invalid payload with INVALID_PAYLOAD before touching the queue", async () => {
    const { handlers, submit } = build();

    await expect(
      handlers.submit({ payload: { ...payload, operation: "drop_tables" } }, context()),
    ).rejects.toMatchObject({ name: "RpcError", code: "INVALID_PAYLOAD" });
    await expect(handlers.submit({}, context())).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("get returns the bounded job view or NOT_FOUND", async () => {
    const findById = vi.fn(async (id: string) => (id === "job-1" ? job({ status: "SUCCEEDED" }) : null));
    const { handlers } = build({ findById });

    await expect(handlers.get({ jobId: "job-1" }, context())).resolves.toEqual({
      jobId: "job-1",
      status: "SUCCEEDED",
      attempt: 0,
      failureCode: null,
      result: null,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    await expect(handlers.get({ jobId: "missing" }, context())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(handlers.get({}, context())).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("wait returns immediately for a terminal job", async () => {
    const { handlers, findById } = build({ findById: vi.fn(async () => job({ status: "FAILED_FINAL" })) });

    await expect(handlers.wait({ jobId: "job-1" }, context())).resolves.toMatchObject({
      status: "FAILED_FINAL",
      settled: true,
    });
    expect(findById).toHaveBeenCalledTimes(1);
  });

  it("wait long-polls until its deadline and then returns the non-terminal status unsettled", async () => {
    const findById = vi.fn(async () => job({ status: "RUNNING" }));
    const { handlers } = build({ findById });
    const startedAt = Date.now();

    const result = await handlers.wait({ jobId: "job-1" }, context());

    expect(result).toMatchObject({ status: "RUNNING", settled: false });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(findById.mock.calls.length).toBeGreaterThan(2);
  });

  it("wait stops polling when the connection signal aborts", async () => {
    const findById = vi.fn(async () => job({ status: "CLAIMED" }));
    const { handlers } = build({ findById });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 15);

    const result = await handlers.wait({ jobId: "job-1" }, { signal: controller.signal });

    expect(result).toMatchObject({ status: "CLAIMED", settled: false });
    expect(findById.mock.calls.length).toBeLessThan(5);
  });

  it("cancel_unclaimed fails closed because the frozen queue contract has no cancel transition", async () => {
    const { handlers } = build();

    await expect(handlers.cancel_unclaimed({ jobId: "job-1" }, context())).rejects.toBeInstanceOf(RpcError);
    await expect(handlers.cancel_unclaimed({ jobId: "job-1" }, context())).rejects.toMatchObject({
      code: "CANCEL_UNSUPPORTED_BY_QUEUE_CONTRACT",
    });
  });

  it("health reports the worker identity without any secret or path", async () => {
    const { handlers } = build();

    const result = await handlers.health({}, context());

    expect(result).toEqual({ ok: true, workerId: "worker-test", activeJobs: 1, uptimeMs: expect.any(Number) });
  });
});
