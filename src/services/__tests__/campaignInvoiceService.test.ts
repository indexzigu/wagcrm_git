import { beforeEach, describe, expect, it, vi } from "vitest";

// 캠페인 계산서 여러 장(T-240 후속) 쓰기·완료 게이트 계약. 금액·이름은 가공이다(P0).

type Campaign = {
  id: string;
  startDate: Date;
  endDate: Date;
  salesChannel: string;
  groupId: string | null;
  supplierInvoiceIssuedAt: Date | null;
  monthly: boolean;
};
type Invoice = Record<string, unknown> & { id: string; campaignId: string; status: string; approvalNo: string | null };

const state = {
  campaigns: [] as Campaign[],
  groups: new Map<string, { supplierInvoiceIssuedAt: Date | null }>(),
  invoices: [] as Invoice[],
  activity: [] as Array<{ entityId: string; content: string }>,
  seq: 0,
};

function matches(row: Invoice, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown };
      if (c.in) return c.in.includes(value);
      if ("not" in c) return value !== c.not;
    }
    return value === cond;
  });
}

const db = {
  salesCampaign: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const c = state.campaigns.find((x) => x.id === where.id);
      if (!c) return null;
      return {
        ...c,
        group: c.groupId ? state.groups.get(c.groupId) ?? null : null,
        deal: { partner: { name: "브랜드A", businessNumber: "2222222222", monthlySettlement: c.monthly } },
      };
    }),
    findMany: vi.fn(async ({ where }: { where: { groupId?: string; id?: { in: string[] } } }) => {
      if (where.groupId) return state.campaigns.filter((c) => c.groupId === where.groupId).sort((a, b) => a.id.localeCompare(b.id));
      return state.campaigns.filter((c) => where.id?.in.includes(c.id) && c.monthly).map((c) => ({ id: c.id }));
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; supplierInvoiceIssuedAt: Date | null }; data: { supplierInvoiceIssuedAt: Date | null } }) => {
      const c = state.campaigns.find(
        (x) => x.id === where.id && (x.supplierInvoiceIssuedAt?.getTime() ?? null) === (where.supplierInvoiceIssuedAt?.getTime() ?? null),
      );
      if (c) c.supplierInvoiceIssuedAt = data.supplierInvoiceIssuedAt;
      return { count: c ? 1 : 0 };
    }),
  },
  campaignGroup: {
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; supplierInvoiceIssuedAt: Date | null }; data: { supplierInvoiceIssuedAt: Date | null } }) => {
      const g = state.groups.get(where.id);
      const hit = g && (g.supplierInvoiceIssuedAt?.getTime() ?? null) === (where.supplierInvoiceIssuedAt?.getTime() ?? null);
      if (g && hit) g.supplierInvoiceIssuedAt = data.supplierInvoiceIssuedAt;
      return { count: hit ? 1 : 0 };
    }),
  },
  campaignInvoice: {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => state.invoices.filter((r) => matches(r, where))),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => state.invoices.find((r) => matches(r, where)) ?? null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `inv-${++state.seq}`,
        writtenAt: null,
        approvalNo: null,
        supplyAmount: null,
        taxAmount: null,
        totalAmount: null,
        itemName: null,
        mailReceivedAt: null,
        note: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      } as unknown as Invoice;
      state.invoices.push(row);
      return row;
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = state.invoices.length;
      state.invoices = state.invoices.filter((r) => !matches(r, where));
      return { count: before - state.invoices.length };
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      state.invoices = state.invoices.filter((r) => r.id !== where.id);
    }),
  },
  activityLog: {
    create: vi.fn(async ({ data }: { data: { entityId: string; content: string } }) => {
      state.activity.push({ entityId: data.entityId, content: data.content });
    }),
  },
  $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
};

vi.mock("@/lib/prisma", () => ({ getPrisma: () => db }));

import { CampaignInvoiceError, campaignInvoiceService } from "../campaignInvoiceService";

// 9/28~10/4 KST 브랜드몰 캠페인 — 9월분·10월분 수수료 계산서를 우리가 발행한다.
function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "c1",
    startDate: new Date("2026-09-27T15:00:00Z"),
    endDate: new Date("2026-10-04T14:59:59Z"),
    salesChannel: "BRAND_MALL",
    groupId: null,
    supplierInvoiceIssuedAt: null,
    monthly: true,
    ...overrides,
  };
}

const MAIL = {
  issueId: "A-1",
  writtenDate: "2026-09-30",
  supplyAmount: 67_500,
  taxAmount: 6_750,
  totalAmount: 74_250,
  itemName: "9월 판매수수료",
  mailReceivedAt: "2026-10-06T02:00:00.000Z",
};

beforeEach(() => {
  state.campaigns = [campaign()];
  state.groups = new Map();
  state.invoices = [];
  state.activity = [];
  state.seq = 0;
});

describe("getView", () => {
  it("월정산이 아니면 해당 없음 — 기존 단일 날짜 칸 그대로", async () => {
    state.campaigns = [campaign({ monthly: false })];
    expect(await campaignInvoiceService.getView("c1")).toEqual({ applicable: false });
  });

  it("레거시 날짜가 있고 계산서 행이 없으면 레거시 모드(이 기능 이전에 끝난 캠페인을 되살리지 않는다)", async () => {
    state.campaigns = [campaign({ supplierInvoiceIssuedAt: new Date("2026-10-31T00:00:00Z") })];
    const view = await campaignInvoiceService.getView("c1");
    expect(view).toMatchObject({ applicable: true, direction: "ISSUE", legacyMode: true, legacyDate: "2026-10-31" });
  });
});

describe("confirmMailInvoice — 오너가 확인한 메일 계산서를 기록", () => {
  it("「몇 월분」은 작성일의 달로 정하고 활동 기록을 남긴다", async () => {
    const row = await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    expect(row).toMatchObject({ yearMonth: "2026-09", status: "RECORDED", approvalNo: "A-1", writtenAt: "2026-09-30", source: "MAIL" });
    expect(state.activity).toHaveLength(1);
    expect(state.activity[0].content).toContain("9월분");
  });

  it("모든 달이 끝나야 레거시 날짜를 쓴다 — 첫 달만으로는 쓰지 않는다", async () => {
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    expect(state.campaigns[0].supplierInvoiceIssuedAt).toBeNull();
    await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, issueId: "A-2", writtenDate: "2026-10-31" });
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe("2026-10-31T00:00:00.000Z");
  });

  it("이미 있는 레거시 날짜는 덮지 않는다(다른 경로가 넣은 값)", async () => {
    // 레거시 날짜가 있어도 계산서 행이 생기면 달별 칸으로 넘어간다 — 그래도 날짜는 그대로다.
    state.campaigns = [campaign({ supplierInvoiceIssuedAt: new Date("2026-10-01T00:00:00Z") })];
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, issueId: "A-2", writtenDate: "2026-10-31" });
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("다른 캠페인에 이미 기록된 계산서는 거부한다", async () => {
    state.campaigns.push(campaign({ id: "c2" }));
    await campaignInvoiceService.confirmMailInvoice("c2", MAIL);
    await expect(campaignInvoiceService.confirmMailInvoice("c1", MAIL)).rejects.toMatchObject({ status: 409 });
  });

  it("캠페인 기간과 먼 달의 계산서는 거부한다(다른 캠페인 것을 잘못 고른 경우)", async () => {
    await expect(
      campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, issueId: "Z", writtenDate: "2027-03-31" }),
    ).rejects.toBeInstanceOf(CampaignInvoiceError);
  });

  it("월정산이 아닌 캠페인에는 쓰지 않는다", async () => {
    state.campaigns = [campaign({ monthly: false })];
    await expect(campaignInvoiceService.confirmMailInvoice("c1", MAIL)).rejects.toMatchObject({ status: 409 });
  });

  it("「이 메일이 아님」으로 뺐던 계산서를 다시 고르면 제외 기록을 걷어내고 기록한다", async () => {
    await campaignInvoiceService.dismissMailInvoice("c1", "A-1", "2026-09-30");
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    expect(state.invoices.map((r) => r.status)).toEqual(["RECORDED"]);
  });
});

describe("waiveMonth · revertRow", () => {
  it("기록이 있는 달은 「없음」으로 바꿀 수 없다", async () => {
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    await expect(campaignInvoiceService.waiveMonth("c1", "2026-09", null)).rejects.toMatchObject({ status: 409 });
  });

  it("취소로 달이 다시 열리면 이 기능이 채운 레거시 날짜는 비운다", async () => {
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    const waived = await campaignInvoiceService.waiveMonth("c1", "2026-10", null);
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
    await campaignInvoiceService.revertRow("c1", waived.id);
    expect(state.campaigns[0].supplierInvoiceIssuedAt).toBeNull();
  });

  it("다른 경로가 넣은 레거시 날짜는 취소해도 지우지 않는다", async () => {
    state.campaigns = [campaign({ supplierInvoiceIssuedAt: new Date("2026-10-01T00:00:00Z") })];
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    const oct = await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, issueId: "A-2", writtenDate: "2026-10-31" });
    await campaignInvoiceService.revertRow("c1", oct.id);
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("한 달짜리 캠페인: 확인 → 취소하면 레거시 모드로 떨어지지 않고 완료가 다시 막힌다", async () => {
    state.campaigns = [campaign({ startDate: new Date("2026-09-10T00:00:00Z"), endDate: new Date("2026-09-16T00:00:00Z") })];
    const row = await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "c1")).toBeNull();
    await campaignInvoiceService.revertRow("c1", row.id);
    expect(state.campaigns[0].supplierInvoiceIssuedAt).toBeNull();
    expect(await campaignInvoiceService.getView("c1")).toMatchObject({ legacyMode: false });
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "c1")).toContain("9월분");
  });

  it("「이 메일이 아님」으로 뺀 승인번호를 직접 입력해도 409·500 없이 기록된다", async () => {
    await campaignInvoiceService.dismissMailInvoice("c1", "A-1", "2026-09-30");
    const row = await campaignInvoiceService.recordManualInvoice("c1", {
      writtenDate: "2026-09-30",
      totalAmount: 74_250,
      approvalNo: "A-1",
      note: null,
    });
    expect(row.source).toBe("MANUAL");
    expect(state.invoices.map((r) => r.status)).toEqual(["RECORDED"]);
  });
});

describe("완료 게이트", () => {
  it("남은 달이 있으면 막고 그 달을 말한다", async () => {
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    const blocker = await campaignInvoiceService.findCompletionBlocker(db as never, "c1");
    expect(blocker).toContain("10월분");
  });

  it("모든 달이 끝났거나, 월정산이 아니거나, 레거시 모드면 통과", async () => {
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    await campaignInvoiceService.waiveMonth("c1", "2026-10", null);
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "c1")).toBeNull();

    state.campaigns = [campaign({ id: "c3", monthly: false })];
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "c3")).toBeNull();

    state.campaigns = [campaign({ id: "c4", supplierInvoiceIssuedAt: new Date("2026-10-31T00:00:00Z") })];
    state.invoices = [];
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "c4")).toBeNull();
  });

  it("그룹은 계산서 1장을 공유한다 — 한 멤버에 기록해도 형제 전원이 같은 답", async () => {
    state.groups.set("g1", { supplierInvoiceIssuedAt: null });
    state.campaigns = [
      campaign({ id: "a", groupId: "g1" }),
      campaign({ id: "b", groupId: "g1", startDate: new Date("2026-10-05T00:00:00Z"), endDate: new Date("2026-10-10T00:00:00Z") }),
    ];
    await campaignInvoiceService.confirmMailInvoice("a", MAIL);
    let blocked = await campaignInvoiceService.findCompletionBlockers(db as never, ["a", "b"]);
    expect([...blocked.keys()].sort()).toEqual(["a", "b"]);
    await campaignInvoiceService.confirmMailInvoice("b", { ...MAIL, issueId: "A-2", writtenDate: "2026-10-31" });
    blocked = await campaignInvoiceService.findCompletionBlockers(db as never, ["a", "b"]);
    expect(blocked.size).toBe(0);
    // 레거시 날짜는 그룹 스칼라에 쓴다(CG-1).
    expect(state.groups.get("g1")?.supplierInvoiceIssuedAt?.toISOString()).toBe("2026-10-31T00:00:00.000Z");
    expect(state.activity.filter((a) => a.entityId === "b").length).toBe(2);
  });
});
