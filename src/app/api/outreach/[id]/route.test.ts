import { beforeEach, describe, expect, it, vi } from "vitest";

// PATCH 의 상태 전이 거절(422) 본문 계약. `error` 문구에는 영문 코드가 들어 있어 화면에 그대로
// 내면 안 된다 — 화면은 함께 실린 현재 상태·요청 상태 코드를 라벨 표로 바꿔 사유를 말한다.

const findUniqueMock = vi.fn();
let prismaOverride: unknown = null;

vi.mock("@/lib/prisma", () => ({
  getPrisma: () =>
    prismaOverride ?? {
      salesTask: { findUnique: (...args: unknown[]) => findUniqueMock(...args) },
    },
}));

vi.mock("@/lib/cache-tags", () => ({
  OUTREACH_INVALIDATION_TAGS: [],
  revalidateCrmTags: vi.fn(),
}));

vi.mock("@/lib/asset-storage", () => ({
  moveDriveShortcut: vi.fn(),
  googleDriveProvider: {},
  GOOGLE_DRIVE_PROVIDER: "GOOGLE_DRIVE",
}));

import { PATCH } from "./route";

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/outreach/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "task-1" }) },
  );
}

describe("PATCH /api/outreach/[id] — 상태 전이 거절", () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    prismaOverride = null;
  });

  it("422 본문에 기존 문구와 함께 현재 상태·요청 상태를 싣는다", async () => {
    findUniqueMock.mockResolvedValue({
      id: "task-1",
      status: "CONVERTED",
      deal: null,
      seller: null,
    });

    const res = await patch({ status: "TESTING" });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "허용되지 않는 상태 변경입니다: CONVERTED → TESTING",
      currentStatus: "CONVERTED",
      requestedStatus: "TESTING",
    });
  });
});

// T-313: two overlapping "캠페인 생성 (승인)" requests for the same task (two tabs, double
// submit) both read `linkedCampaignId = null`. The route must still create exactly one campaign:
// creation and the claim of the task row run in one transaction, and the claim is a conditional
// write (`linkedCampaignId: null`) so the losing request rolls back its campaign.
//
// The fake below models what Postgres does for us: writes made inside `$transaction` are only
// committed when the callback resolves, and a conditional updateMany sees the committed state.
// Writes made directly on the client (no transaction) commit immediately with no claim — that is
// the pre-fix code path, which creates two campaigns here.
function createConcurrencyFake() {
  const task = {
    id: "task-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    status: "PENDING_APPROVAL",
    linkedCampaignId: null as string | null,
    totalMarginRate: null,
    sellerMarginRate: null,
    negotiationMemo: null,
    proposalSentAt: new Date("2026-11-01T00:00:00Z"),
    confirmedAt: null,
    respondedAt: null,
    lastReminderAt: null,
    nextReminderAt: null,
    droppedAt: null,
    dropReason: null,
    proposalMessage: null,
    testingMemo: null,
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    deal: {
      dealName: "Deal",
      brandName: null,
      partner: null,
      baseMarginPolicy: null,
      costPrice: null,
      sellingPrice: null,
    },
    seller: {
      id: "seller-1",
      name: "Seller",
      alias: null,
      snsType: "INSTAGRAM",
      currentFollowers: 0,
      category: null,
    },
  };
  const committedCampaigns: string[] = [];
  let seq = 0;

  // Both requests must read the task before either writes: release the reads together.
  let pendingReads: Array<() => void> = [];
  const findTask = () =>
    new Promise((resolve) => {
      pendingReads.push(() => resolve({ ...task }));
      if (pendingReads.length === 2) {
        const release = pendingReads;
        pendingReads = [];
        release.forEach((fn) => fn());
      }
    });

  function client(staged: string[] | null, claims: { made: boolean } | null) {
    const commitCampaign = (id: string) => (staged ? staged.push(id) : committedCampaigns.push(id));
    return {
      salesTask: {
        findUnique: findTask,
        updateMany: async ({ where, data }: { where: { id: string; linkedCampaignId?: null }; data: { linkedCampaignId: string } }) => {
          if (where.id !== task.id) return { count: 0 };
          if ("linkedCampaignId" in where && task.linkedCampaignId !== null) return { count: 0 };
          task.linkedCampaignId = data.linkedCampaignId;
          if (claims) claims.made = true;
          return { count: 1 };
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(task, data);
          return { ...task };
        },
      },
      salesCampaign: {
        create: async () => {
          seq += 1;
          const id = `campaign-${seq}`;
          commitCampaign(id);
          return { id };
        },
        update: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
        findUnique: async () => ({ campaignName: null, deal: { dealName: "Deal" }, seller: { name: "Seller", alias: null } }),
      },
      campaignDeal: { create: async () => ({}) },
      deal: { findMany: async () => [] },
      asset: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    };
  }

  const prisma = {
    ...client(null, null),
    $transaction: async <T>(fn: (tx: ReturnType<typeof client>) => Promise<T>) => {
      const staged: string[] = [];
      const claims = { made: false };
      try {
        const result = await fn(client(staged, claims));
        committedCampaigns.push(...staged);
        return result;
      } catch (error) {
        // Roll back only what this transaction wrote.
        if (claims.made) task.linkedCampaignId = null;
        throw error;
      }
    },
  };

  return { prisma, task, committedCampaigns };
}

describe("PATCH /api/outreach/[id] — 캠페인 생성 동시 요청", () => {
  beforeEach(() => {
    prismaOverride = null;
  });

  it("같은 테스크에 겹친 두 요청이 와도 캠페인은 하나만 만들어지고 둘 다 그 캠페인을 가리킨다", async () => {
    const fake = createConcurrencyFake();
    prismaOverride = fake.prisma;

    const body = { status: "PENDING_APPROVAL", autoCreateCampaign: true };
    const [first, second] = await Promise.all([patch(body), patch(body)]);

    expect(fake.committedCampaigns).toHaveLength(1);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const [a, b] = [await first.json(), await second.json()];
    expect(a.linkedCampaignId).toBe(fake.committedCampaigns[0]);
    expect(b.linkedCampaignId).toBe(fake.committedCampaigns[0]);
    expect(a.status).toBe("CONVERTED");
    expect(b.status).toBe("CONVERTED");
  });
});

// T-313 Part A: a campaign created from outreach has no period yet ("기간 미정"). Its NOT NULL dates
// are stored as a placeholder and `periodPlaceholderAt` marks them — all three must be the same
// instant, or `isCampaignPeriodUnset` would read the campaign as dated.
describe("PATCH /api/outreach/[id] — 캠페인 생성은 기간 미정으로 만든다", () => {
  beforeEach(() => {
    prismaOverride = null;
  });

  it("create 에 periodPlaceholderAt 을 시작일·종료일과 같은 시각으로 싣는다", async () => {
    const fake = createConcurrencyFake();
    const createdData: Array<Record<string, unknown>> = [];
    const baseTransaction = fake.prisma.$transaction;
    prismaOverride = {
      ...fake.prisma,
      // The concurrency fake holds reads until two requests arrive; this test sends one.
      salesTask: { ...fake.prisma.salesTask, findUnique: async () => ({ ...fake.task }) },
      $transaction: <T>(fn: (tx: never) => Promise<T>) =>
        baseTransaction(async (tx) => {
          const create = tx.salesCampaign.create;
          tx.salesCampaign.create = async (args?: { data: Record<string, unknown> }) => {
            if (args) createdData.push(args.data);
            return create();
          };
          return fn(tx as never);
        }),
    };

    const res = await patch({ status: "PENDING_APPROVAL", autoCreateCampaign: true });

    expect(res.status).toBe(200);
    expect(createdData).toHaveLength(1);
    const data = createdData[0];
    expect(data.status).toBe("PREPARATION");
    expect(data.periodPlaceholderAt).toBeInstanceOf(Date);
    const marker = (data.periodPlaceholderAt as Date).getTime();
    expect((data.startDate as Date).getTime()).toBe(marker);
    expect((data.endDate as Date).getTime()).toBe(marker);
  });
});
