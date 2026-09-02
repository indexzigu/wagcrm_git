import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentJobRepository } from "../agentJobRepository";

const createMock = vi.fn();
const findFirstMock = vi.fn();
const findUniqueMock = vi.fn();
const updateManyMock = vi.fn();
const eventCreateMock = vi.fn();
const transactionMock = vi.fn();

const transactionClient = {
  agentJob: {
    findFirst: findFirstMock,
    updateMany: updateManyMock,
  },
  agentJobEvent: {
    create: eventCreateMock,
  },
};

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    $transaction: transactionMock,
    agentJob: {
      create: createMock,
      findUnique: findUniqueMock,
    },
  }),
}));

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

const persistedJob = {
  id: "job-1",
  idempotencyKey: "idempotency-1",
  payload: JSON.stringify(payload),
  status: "QUEUED",
  workerId: null,
  leaseExpiresAt: null,
  heartbeatAt: null,
  attempt: 0,
  result: null,
  failureCode: null,
  createdAt: new Date("2026-09-02T00:00:00.000Z"),
  updatedAt: new Date("2026-09-02T00:00:00.000Z"),
};

describe("AgentJobRepository", () => {
  beforeEach(() => {
    createMock.mockReset();
    findFirstMock.mockReset();
    findUniqueMock.mockReset();
    updateManyMock.mockReset();
    eventCreateMock.mockReset();
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (callback: (tx: typeof transactionClient) => unknown) =>
      callback(transactionClient),
    );
  });

  it("returns the existing queue row when the database unique idempotency guard wins a race", async () => {
    createMock.mockRejectedValue({ code: "P2002" });
    findUniqueMock.mockResolvedValue({ ...persistedJob, id: "job-existing" });

    await expect(AgentJobRepository.submit(payload, new Date("2026-09-02T00:00:00.000Z"))).resolves.toMatchObject({
      created: false,
      job: { id: "job-existing", payload },
    });
  });

  it("claims a queued row only through a status-and-lease conditional updateMany and appends its event", async () => {
    findFirstMock.mockResolvedValue(persistedJob);
    updateManyMock.mockResolvedValue({ count: 1 });
    eventCreateMock.mockResolvedValue({});

    await AgentJobRepository.claimNext("worker-1", new Date("2026-09-02T00:00:00.000Z"));

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "job-1", status: "QUEUED", leaseExpiresAt: null }),
      }),
    );
    expect(eventCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ jobId: "job-1", fromStatus: "QUEUED", toStatus: "CLAIMED" }) }),
    );
  });

  it("reclaims an expired lease in the same transaction and turns the capped attempt into FAILED_FINAL", async () => {
    findFirstMock.mockResolvedValue({ ...persistedJob, status: "RUNNING", attempt: 2 });
    updateManyMock.mockResolvedValue({ count: 1 });
    eventCreateMock.mockResolvedValue({});

    await AgentJobRepository.reclaimExpiredLease(new Date("2026-09-02T00:00:00.000Z"));

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "job-1", status: "RUNNING", attempt: 2 }),
        data: expect.objectContaining({ status: "FAILED_FINAL", attempt: { increment: 1 } }),
      }),
    );
    expect(eventCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ toStatus: "FAILED_FINAL" }) }),
    );
  });

  it("requeues a retryable failure only through a capped owner-and-lease conditional update", async () => {
    const now = new Date("2026-09-02T00:00:00.000Z");
    findFirstMock.mockResolvedValue({
      ...persistedJob,
      status: "FAILED_RETRYABLE",
      workerId: "worker-1",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      attempt: 2,
    });
    updateManyMock.mockResolvedValue({ count: 1 });
    eventCreateMock.mockResolvedValue({});

    await AgentJobRepository.requeue({
      jobId: "job-1",
      fromStatus: "FAILED_RETRYABLE",
      actor: "worker-1",
      workerId: "worker-1",
      attempt: 2,
      now,
    });

    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "job-1",
          status: "FAILED_RETRYABLE",
          workerId: "worker-1",
          attempt: 2,
          leaseExpiresAt: { gt: now },
        }),
        data: expect.objectContaining({ status: "FAILED_FINAL", attempt: { increment: 1 } }),
      }),
    );
    expect(eventCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ toStatus: "FAILED_FINAL" }) }),
    );
  });
});
