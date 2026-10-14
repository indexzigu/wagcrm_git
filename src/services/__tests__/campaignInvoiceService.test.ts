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
  /** 단위 전액 계산 입력(브랜드몰 = 영업수익 기준). 없으면 전액을 모른다 → 종전 동작 */
  settlementSales?: number | null;
  isManualSettlementSales?: boolean;
  /** 성숙 판정(M2) — 없으면 종료일만 본다(픽스처 종료일은 과거) */
  status?: string;
};
type Invoice = Record<string, unknown> & { id: string; campaignId: string; status: string; approvalNo: string | null };

const state = {
  campaigns: [] as Campaign[],
  groups: new Map<string, { supplierInvoiceIssuedAt: Date | null }>(),
  invoices: [] as Invoice[],
  activity: [] as Activity[],
  acks: [] as Ack[],
  seq: 0,
};

type Activity = {
  entityId: string;
  content: string;
  type?: string;
  fieldName?: string | null;
  previousValue?: string | null;
  newValue?: string | null;
  actor?: string;
};
type Ack = { id: string; campaignId: string; direction: string; fingerprint: string; acknowledgedBy: string; acknowledgedAt: Date };

/** `{ campaignId: { in }, direction, NOT: { campaignId } }` 정도만 — 확인 기록 목 전용 */
function matchesAck(ack: Ack, where: { campaignId?: { in: string[] } | string; direction?: string; NOT?: { campaignId: string } }): boolean {
  if (typeof where.campaignId === "string" && ack.campaignId !== where.campaignId) return false;
  if (where.campaignId && typeof where.campaignId === "object" && !where.campaignId.in.includes(ack.campaignId)) return false;
  if (where.direction && ack.direction !== where.direction) return false;
  if (where.NOT && ack.campaignId === where.NOT.campaignId) return false;
  return true;
}

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
    findMany: vi.fn(async ({ where }: { where: { groupId?: string | { in: string[] }; id?: { in: string[] } } }) => {
      const groupId = where.groupId;
      if (typeof groupId === "string") return state.campaigns.filter((c) => c.groupId === groupId).sort((a, b) => a.id.localeCompare(b.id));
      if (groupId) return state.campaigns.filter((c) => c.groupId !== null && groupId.in.includes(c.groupId));
      // 자동 기록 대상 조회(id 목록 없이 월정산·상태·기간 조건) — 상태·기간은 픽스처가 모두 해당한다고 본다.
      if (!where.id) return state.campaigns.filter((c) => c.monthly).map((c) => ({ id: c.id }));
      return state.campaigns
        .filter((c) => where.id?.in.includes(c.id) && c.monthly)
        .map((c) => ({ ...c, group: c.groupId ? state.groups.get(c.groupId) ?? null : null }));
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
    create: vi.fn(async ({ data }: { data: Activity }) => {
      state.activity.push({ ...data });
    }),
    // 출처 표지 조회 — 가장 최근(마지막으로 넣은) 것. where 는 entityId in · fieldName · type in 만 본다.
    findFirst: vi.fn(
      async ({ where }: { where: { entityId: { in: string[] }; fieldName: string; type: { in: string[] } } }) => {
        const hits = state.activity.filter(
          (a) => where.entityId.in.includes(a.entityId) && a.fieldName === where.fieldName && where.type.in.includes(a.type ?? ""),
        );
        const last = hits.at(-1);
        return last ? { type: last.type, newValue: last.newValue ?? null } : null;
      },
    ),
  },
  campaignInvoiceReviewAck: {
    findMany: vi.fn(async ({ where }: { where: Parameters<typeof matchesAck>[1] }) =>
      state.acks.filter((a) => matchesAck(a, where)).sort((a, b) => b.acknowledgedAt.getTime() - a.acknowledgedAt.getTime()),
    ),
    deleteMany: vi.fn(async ({ where }: { where: Parameters<typeof matchesAck>[1] }) => {
      const before = state.acks.length;
      state.acks = state.acks.filter((a) => !matchesAck(a, where));
      return { count: before - state.acks.length };
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { campaignId_direction: { campaignId: string; direction: string } };
        create: Omit<Ack, "id" | "acknowledgedAt">;
        update: Partial<Ack>;
      }) => {
        const key = where.campaignId_direction;
        const found = state.acks.find((a) => a.campaignId === key.campaignId && a.direction === key.direction);
        if (found) {
          Object.assign(found, update);
          return found;
        }
        const ack = { id: `ack-${++state.seq}`, acknowledgedAt: new Date(), ...create };
        state.acks.push(ack);
        return ack;
      },
    ),
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
  state.acks = [];
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
    expect(state.activity.filter((a) => a.entityId === "b" && a.type === "CAMPAIGN_INVOICE").length).toBe(2);
    // 롤업은 멤버마다 출처 표지를 남긴다(취소가 「이 기능이 채운 값」인지 가를 근거 — #3).
    expect(
      state.activity.filter((a) => a.type === "CAMPAIGN_INVOICE_LEGACY_ROLLUP").map((a) => [a.entityId, a.newValue]),
    ).toEqual([
      ["a", "2026-10-31"],
      ["b", "2026-10-31"],
    ]);
  });
});

describe("findLegacyDateWriteBlocker — 단일 날짜 직접 쓰기 게이트 (T-248)", () => {
  const OCT_31 = new Date("2026-10-31T00:00:00Z");

  it("계산서 0장·날짜 없는 단위에 날짜를 찍으면 막는다 — 찍히면 레거시 모드로 떨어져 완료 게이트를 우회한다", async () => {
    const blocker = await campaignInvoiceService.findLegacyDateWriteBlocker(db as never, "c1");
    expect(blocker).toContain("달별로 기록");
  });

  it("계산서가 있는 단위의 날짜(롤업 값)는 바꾸지도 비우지도 못한다", async () => {
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, issueId: "A-2", writtenDate: "2026-10-31" });
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe(OCT_31.toISOString());
    expect(await campaignInvoiceService.findLegacyDateWriteBlocker(db as never, "c1")).not.toBeNull();
  });

  it("레거시 모드(날짜 있음·계산서 0장)는 통과 — 화면의 단일 날짜 칸이 정정·달별 전환(비우기) 통로다", async () => {
    state.campaigns = [campaign({ supplierInvoiceIssuedAt: OCT_31 })];
    expect(await campaignInvoiceService.findLegacyDateWriteBlocker(db as never, "c1")).toBeNull();
  });

  it("그룹은 그룹 스칼라로 레거시 모드를 판정한다(CG-1)", async () => {
    state.groups.set("g1", { supplierInvoiceIssuedAt: OCT_31 });
    state.campaigns = [campaign({ id: "a", groupId: "g1" })];
    expect(await campaignInvoiceService.findLegacyDateWriteBlocker(db as never, "a")).toBeNull();
    state.groups.set("g1", { supplierInvoiceIssuedAt: null });
    expect(await campaignInvoiceService.findLegacyDateWriteBlocker(db as never, "a")).not.toBeNull();
  });

  it("월정산이 아니면 언제나 통과(기존 단일 날짜 동작 그대로)", async () => {
    state.campaigns = [campaign({ monthly: false })];
    expect(await campaignInvoiceService.findLegacyDateWriteBlocker(db as never, "c1")).toBeNull();
  });
});

describe("loadInvoiceProgress — 세무 보드의 「끝」 판정 (T-244)", () => {
  it("완료 게이트와 같은 판정이다 — 진행 n/m, 전부 「없음」이어도 끝, 레거시·비월정산은 결과에 없다", async () => {
    state.campaigns = [
      campaign(),
      campaign({ id: "plain", monthly: false }),
      campaign({ id: "legacy", supplierInvoiceIssuedAt: new Date("2026-10-31T00:00:00Z") }),
    ];
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    let progress = await campaignInvoiceService.loadInvoiceProgress(db as never, ["c1", "plain", "legacy"]);
    expect([...progress.keys()]).toEqual(["c1"]);
    expect(progress.get("c1")).toEqual({ done: 1, total: 2, openMonths: ["2026-10"], review: null });

    // 전부 「없음」으로 끝난 단위 — 레거시 날짜는 비어 있지만 끝이다(보드에서 빠져야 한다).
    state.campaigns = [campaign({ id: "w" })];
    state.invoices = [];
    await campaignInvoiceService.waiveMonth("w", "2026-09", null);
    await campaignInvoiceService.waiveMonth("w", "2026-10", null);
    progress = await campaignInvoiceService.loadInvoiceProgress(db as never, ["w"]);
    expect(progress.get("w")).toEqual({ done: 2, total: 2, openMonths: [], review: null });
    expect(state.campaigns[0].supplierInvoiceIssuedAt).toBeNull();
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "w")).toBeNull();
  });
});

describe("autoRecordMailInvoice — 확인 없는 자동 기록 (T-242)", () => {
  const AUTO = { campaignId: "c1", yearMonth: "2026-09", mail: MAIL, basis: "STATEMENT" as const, expectedTotal: 74_250, delta: 0 };

  it("발급 메일 출처(자동)로 기록하고, 보드 「자동 확정」 요약이 세는 type 으로 감사 기록을 남긴다", async () => {
    const row = await campaignInvoiceService.autoRecordMailInvoice(AUTO);
    expect(row).toMatchObject({ yearMonth: "2026-09", status: "RECORDED", source: "MAIL_AUTO", approvalNo: "A-1" });
    expect(state.activity.at(-1)?.type).toBe("TAX_INVOICE_AUTO_CONFIRM");
    expect(state.activity.at(-1)?.content).toContain("메일 자동 기록");
  });

  it("허용오차로 흡수한 차이는 type 을 가르고 문장에 싣는다", async () => {
    await campaignInvoiceService.autoRecordMailInvoice({ ...AUTO, delta: 40 });
    expect(state.activity.at(-1)?.type).toBe("TAX_INVOICE_AUTO_CONFIRM_TOLERATED");
    expect(state.activity.at(-1)?.content).toContain("40원 차이를 허용오차로 흡수했습니다");
  });

  it("그 사이 달이 채워졌거나(오너 확인·「없음」) 같은 계산서가 이미 기록됐으면 아무것도 쓰지 않는다", async () => {
    await campaignInvoiceService.waiveMonth("c1", "2026-09", null);
    const before = state.invoices.length;
    expect(await campaignInvoiceService.autoRecordMailInvoice(AUTO)).toBeNull();
    expect(state.invoices.length).toBe(before);

    state.invoices = [];
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    expect(await campaignInvoiceService.autoRecordMailInvoice({ ...AUTO })).toBeNull();
    expect(state.invoices.filter((r) => r.status === "RECORDED")).toHaveLength(1);
  });

  it("오너가 자동 기록을 취소하면 그 메일은 「이 메일이 아님」으로 남아 다음 실행이 다시 붙이지 않는다", async () => {
    const row = await campaignInvoiceService.autoRecordMailInvoice(AUTO);
    await campaignInvoiceService.revertRow("c1", row!.id);
    expect(state.invoices).toMatchObject([{ status: "DISMISSED", approvalNo: "A-1" }]);
    expect(await campaignInvoiceService.autoRecordMailInvoice(AUTO)).toBeNull();
    const { units } = await campaignInvoiceService.loadAutoRecordUnits(db as never, {
      sinceDays: 3650,
      now: new Date("2026-10-09T00:00:00Z"),
    });
    expect(units[0]?.dismissedIssueIds).toEqual(["A-1"]);
    // 오너가 직접 고르면 다시 기록할 수 있다(확인 경로가 표시를 걷어낸다).
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    expect(state.invoices.map((r) => r.status)).toEqual(["RECORDED"]);
  });

  it("수취(우리몰) 단위는 자동 기록하지 않는다", async () => {
    state.campaigns = [campaign({ salesChannel: "OWN_MALL" })];
    expect(await campaignInvoiceService.autoRecordMailInvoice(AUTO)).toBeNull();
    expect(state.invoices).toEqual([]);
  });

  it("마지막 달이 채워지면 레거시 날짜를 비어 있을 때만 채운다(다른 단일 날짜 소비처가 「끝」을 안다)", async () => {
    await campaignInvoiceService.waiveMonth("c1", "2026-10", null);
    await campaignInvoiceService.autoRecordMailInvoice(AUTO);
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
  });
});

describe("한 번에 끊은 월정산 — 계산서 합계가 캠페인 전액과 맞으면 끝 (2026-10-14)", () => {
  // 브랜드몰 영업수익 74,250원 → 보드 금액 67,500 + 6,750 = 74,250원(가공).
  beforeEach(() => {
    state.campaigns = [campaign({ settlementSales: 74_250 })];
  });

  it("9월 계산서 한 장이 전액이면 화면·세무 보드·완료 게이트가 같은 답(2/2 · 막힘 없음)이고 레거시 날짜가 롤업된다", async () => {
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    const view = await campaignInvoiceService.getView("c1");
    expect(view).toMatchObject({ applicable: true, expectedTotalAmount: 74_250, expectedFromManual: false });
    const progress = await campaignInvoiceService.loadInvoiceProgress(db as never, ["c1"]);
    expect(progress.get("c1")).toEqual({ done: 2, total: 2, openMonths: [], review: null });
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "c1")).toBeNull();
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
  });

  it("전액을 모르면 종전 그대로 — 10월이 남아 막힌다", async () => {
    state.campaigns = [campaign()];
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "c1")).toContain("10월분");
  });

  it("H8 — 전액 일치로 남은 달을 닫으면 자동 확정 type 으로 규칙·승인번호·합계·전액·차이·닫은 달을 남긴다", async () => {
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    const audit = state.activity.filter((a) => a.type === "TAX_INVOICE_AUTO_CONFIRM");
    expect(audit).toHaveLength(1);
    expect(audit[0].entityId).toBe("c1");
    expect(audit[0].content).toContain("FULL_AMOUNT_SINGLE");
    expect(audit[0].content).toContain("A-1");
    expect(audit[0].content).toContain("74,250원");
    expect(audit[0].content).toContain("차이 0원");
    expect(audit[0].content).toContain("계산서 없이 닫은 달 10월");
  });

  it("M3 — 달마다 자기 계산서가 있는 오너 클릭 완료에는 SYSTEM 기록이 없다(규칙이 한 일이 없다)", async () => {
    await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, totalAmount: 40_000 });
    await campaignInvoiceService.recordManualInvoice("c1", { writtenDate: "2026-10-31", totalAmount: 34_200, approvalNo: "A-2", note: null });
    expect(state.activity.some((a) => a.type?.startsWith("TAX_INVOICE_AUTO_CONFIRM"))).toBe(false);
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "c1")).toBeNull();
  });

  it("H8 — 여러 장의 합계가 계산서 없는 달을 닫으면 SUM_OF_INVOICES, 허용오차 흡수면 TOLERATED type", async () => {
    // 9/28~11/3 세 달 캠페인 — 9·10월 두 장의 합계가 전액이라 11월이 계산서 없이 닫힌다.
    state.campaigns = [campaign({ settlementSales: 74_250, status: "SETTLEMENT_IN_PROGRESS", endDate: new Date("2026-11-03T14:59:59Z") })];
    await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, totalAmount: 40_000 });
    await campaignInvoiceService.recordManualInvoice("c1", { writtenDate: "2026-10-31", totalAmount: 34_200, approvalNo: "A-2", note: null });
    const audit = state.activity.filter((a) => a.type?.startsWith("TAX_INVOICE_AUTO_CONFIRM"));
    expect(audit).toHaveLength(1);
    expect(audit[0].type).toBe("TAX_INVOICE_AUTO_CONFIRM_TOLERATED");
    expect(audit[0].content).toContain("SUM_OF_INVOICES");
    expect(audit[0].content).toContain("차이 -50원");
    expect(audit[0].content).toContain("계산서 없이 닫은 달 11월");
  });

  it("M3 — 크론 자동 기록이 달을 닫으면 자기 기록 문장에 붙이고 SYSTEM 줄은 하나다 · L1 분할 순번 문장", async () => {
    await campaignInvoiceService.autoRecordMailInvoice({
      campaignId: "c1", yearMonth: "2026-09", mail: MAIL, basis: "FULL_AMOUNT", expectedTotal: 74_250, delta: 0, split: null,
    });
    const system = state.activity.filter((a) => a.type?.startsWith("TAX_INVOICE_AUTO_CONFIRM"));
    expect(system).toHaveLength(1);
    expect(system[0].content).toContain("메일 자동 기록");
    expect(system[0].content).toContain("월정산 한 번 발행 완료(FULL_AMOUNT_SINGLE)");
    expect(system[0].content).toContain("계산서 없이 닫은 달 10월");

    state.invoices = []; state.activity = []; state.campaigns = [campaign({ settlementSales: 74_250 })];
    await campaignInvoiceService.autoRecordMailInvoice({
      campaignId: "c1", yearMonth: "2026-09", mail: { ...MAIL, totalAmount: 40_000 }, basis: "FULL_AMOUNT", expectedTotal: 74_250, delta: 0, split: { index: 1, count: 2 },
    });
    expect(state.activity.at(-1)?.content).toContain("분할 2장 중 1번째");
    expect(state.activity.at(-1)?.content).not.toContain("전액 74,250원 일치");
  });

  it("R0 — 기록한 합계가 어긋나면 진행에 review 가 실리고 게이트는 막지 않으며 크론 단위에도 들어간다", async () => {
    state.campaigns = [campaign({ settlementSales: 74_250, startDate: new Date("2026-09-09T15:00:00Z"), endDate: new Date("2026-09-20T14:59:59Z") })];
    await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, totalAmount: 72_000 });
    const progress = await campaignInvoiceService.loadInvoiceProgress(db as never, ["c1"]);
    expect(progress.get("c1")).toEqual({ done: 1, total: 1, openMonths: [], review: { reason: "MINOR_MISMATCH", label: "정산 오류 가능성 · 원인 확인 필요" } });
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "c1")).toBeNull();
    const { units } = await campaignInvoiceService.loadAutoRecordUnits(db as never, { sinceDays: 3650, now: new Date("2026-10-09T00:00:00Z") });
    expect(units[0]).toMatchObject({ openMonths: [], recordedMismatch: "MINOR_MISMATCH" });
    // 어긋난 채로는 레거시 날짜를 채우지 않는다(전액 일치가 아니다) — 열린 달이 없으니 종전 롤업 규칙으로는 채운다
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
  });

  it("M2 — 판매 중(정산 단계 아님·종료일 미래)이면 전액을 모르는 것으로 다룬다: 한 번에 끝 판정·롤업·자동 기록 전액 경로가 꺼진다", async () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    state.campaigns = [campaign({ settlementSales: 74_250, status: "ACTIVE", endDate: future })];
    expect(await campaignInvoiceService.getView("c1")).toMatchObject({ expectedTotalAmount: null });
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    expect((await campaignInvoiceService.loadInvoiceProgress(db as never, ["c1"])).get("c1")?.openMonths.length).toBeGreaterThan(0);
    expect(state.campaigns[0].supplierInvoiceIssuedAt).toBeNull();
    const { units } = await campaignInvoiceService.loadAutoRecordUnits(db as never, { sinceDays: 3650, now: new Date() });
    expect(units[0]?.expectedTotalAmount).toBeNull();
    // 정산 단계면 종료일이 미래여도 성숙이다
    state.campaigns = [campaign({ settlementSales: 74_250, status: "SETTLEMENT_IN_PROGRESS", endDate: future })];
    expect(await campaignInvoiceService.getView("c1")).toMatchObject({ expectedTotalAmount: 74_250 });
  });

  it("M2 — 종료일은 그 날 KST 하루 전체다: 마감일 당일에는 아직 판매 중(전액 모름), 다음 날 0시(KST)부터 성숙", async () => {
    // 종료일 9/16 = KST 9/16 하루 전체 → UTC 9/16 14:59:59.999 까지가 판매 중이다.
    state.campaigns = [campaign({ settlementSales: 74_250, status: "ACTIVE", endDate: new Date("2026-09-16T00:00:00Z") })];
    const duringLastDay = new Date("2026-09-16T10:00:00Z"); // KST 9/16 19:00 — 아직 그 날
    const afterLastDay = new Date("2026-09-16T15:00:01Z"); // KST 9/17 00:00:01
    const during = await campaignInvoiceService.loadAutoRecordUnits(db as never, { sinceDays: 3650, now: duringLastDay });
    expect(during.units[0]?.expectedTotalAmount).toBeNull();
    const after = await campaignInvoiceService.loadAutoRecordUnits(db as never, { sinceDays: 3650, now: afterLastDay });
    expect(after.units[0]?.expectedTotalAmount).toBe(74_250);
  });

  it("M2 — 전액이 바뀌어 「한 번에 끝」이 거짓이 된 뒤 취소해도 이 기능이 채운 날짜는 비워져 레거시 모드로 떨어지지 않는다", async () => {
    const row = await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
    state.campaigns[0].settlementSales = 99_000; // 오너가 영업수익을 고쳤다 → 전액이 바뀐다
    expect((await campaignInvoiceService.loadInvoiceProgress(db as never, ["c1"])).get("c1")?.openMonths).toEqual(["2026-10"]);
    await campaignInvoiceService.revertRow("c1", row.id);
    expect(state.campaigns[0].supplierInvoiceIssuedAt).toBeNull();
    expect(await campaignInvoiceService.getView("c1")).toMatchObject({ legacyMode: false });
  });

  it("전액 근거 자동 기록은 감사 문장에 「캠페인 전액」 근거를 싣고 단위를 끝낸다", async () => {
    const row = await campaignInvoiceService.autoRecordMailInvoice({
      campaignId: "c1",
      yearMonth: "2026-09",
      mail: MAIL,
      basis: "FULL_AMOUNT",
      expectedTotal: 74_250,
      delta: 0,
    });
    expect(row).toMatchObject({ source: "MAIL_AUTO" });
    expect(state.activity.some((a) => a.content.includes("대조 근거 캠페인 전액"))).toBe(true);
    expect(state.activity.some((a) => a.content.includes("FULL_AMOUNT_SINGLE"))).toBe(true);
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "c1")).toBeNull();
  });

  it("자동 기록 입력에 전액·수동 여부·기간 달·닫힌 달이 실린다", async () => {
    state.campaigns = [campaign({ settlementSales: 74_250, isManualSettlementSales: true })];
    const { units } = await campaignInvoiceService.loadAutoRecordUnits(db as never, {
      sinceDays: 3650,
      now: new Date("2026-10-09T00:00:00Z"),
    });
    expect(units[0]).toMatchObject({
      expectedTotalAmount: 74_250,
      expectedFromManual: true,
      recordedTotalAmount: 0,
      periodMonths: ["2026-09", "2026-10"],
      closedMonths: [],
    });
  });
});

describe("레거시 날짜 출처 표지 — 취소는 이 기능이 채운 날짜만 비운다 (리뷰 2026-10-15 #3)", () => {
  const OCT_31 = new Date("2026-10-31T00:00:00Z");

  it("레거시 모드에서 들어 있던 날짜는 같은 작성일의 계산서를 기록했다 취소해도 지우지 않는다", async () => {
    // 오너가 레거시 칸에 실제 작성일(10/31)을 넣어 둔 단위 — 뒤에 같은 날짜의 계산서를 기록한다.
    state.campaigns = [campaign({ supplierInvoiceIssuedAt: OCT_31 })];
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    const oct = await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, issueId: "A-2", writtenDate: "2026-10-31" });
    const kept = state.activity.filter((a) => a.type === "CAMPAIGN_INVOICE_LEGACY_KEPT");
    expect(kept.map((a) => a.newValue)).toEqual(["2026-10-31"]); // 첫 행에서 한 번만
    await campaignInvoiceService.revertRow("c1", oct.id);
    // 종전 규칙(날짜 == 취소 전 최신 작성일)이면 여기서 오너의 날짜가 지워졌다.
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe(OCT_31.toISOString());
  });

  it("「없음」으로 레거시 모드를 벗어나도 들어 있던 날짜를 표지로 남긴다", async () => {
    state.campaigns = [campaign({ supplierInvoiceIssuedAt: OCT_31 })];
    await campaignInvoiceService.waiveMonth("c1", "2026-09", null);
    expect(state.activity.filter((a) => a.type === "CAMPAIGN_INVOICE_LEGACY_KEPT")).toHaveLength(1);
  });

  it("이 기능이 채운 날짜는 비우고, 남은 기록만으로 다 끝났으면 남은 최신 작성일로 다시 채운다", async () => {
    // 한 달짜리 캠페인에 9월 계산서 두 장 — 첫 장(9/15)으로 달이 닫혀 9/15 가 롤업된다.
    state.campaigns = [campaign({ startDate: new Date("2026-09-10T00:00:00Z"), endDate: new Date("2026-09-16T00:00:00Z") })];
    const first = await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, writtenDate: "2026-09-15" });
    await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, issueId: "A-2", writtenDate: "2026-09-30" });
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    await campaignInvoiceService.revertRow("c1", first.id);
    // 종전 규칙은 9/15 ≠ 취소 전 최신(9/30)이라 지워진 계산서의 날짜를 그대로 남겼다.
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
    const markers = state.activity.filter((a) => a.type === "CAMPAIGN_INVOICE_LEGACY_ROLLUP").map((a) => a.newValue);
    expect(markers).toEqual(["2026-09-15", null, "2026-09-30"]);
  });

  it("롤업 뒤 다른 경로가 바꾼 날짜(표지 값과 다름)는 지우지 않는다", async () => {
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL);
    const oct = await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, issueId: "A-2", writtenDate: "2026-10-31" });
    state.campaigns[0].supplierInvoiceIssuedAt = new Date("2026-11-02T00:00:00Z");
    await campaignInvoiceService.revertRow("c1", oct.id);
    expect(state.campaigns[0].supplierInvoiceIssuedAt?.toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });

  it("표지가 없는 옛 데이터(표지 도입 이전 롤업)는 종전 규칙 — 취소 전 최신 작성일과 같으면 비운다", async () => {
    state.campaigns = [
      campaign({ startDate: new Date("2026-09-10T00:00:00Z"), endDate: new Date("2026-09-16T00:00:00Z"), supplierInvoiceIssuedAt: new Date("2026-09-30T00:00:00Z") }),
    ];
    state.invoices = [
      { id: "old-1", campaignId: "c1", direction: "ISSUE", yearMonth: "2026-09", status: "RECORDED", writtenAt: new Date("2026-09-30T00:00:00Z"), approvalNo: "A-1", source: "MAIL", totalAmount: 74_250, supplyAmount: null, taxAmount: null, itemName: null, mailReceivedAt: null, note: null, createdAt: new Date(), updatedAt: new Date() },
    ];
    await campaignInvoiceService.revertRow("c1", "old-1");
    expect(state.campaigns[0].supplierInvoiceIssuedAt).toBeNull();
  });
});

describe("「확인함」 — 기록 합계 어긋남을 오너가 확인 (오너 승인 2026-10-15)", () => {
  // 한 달짜리 캠페인(9/10~9/20 KST), 전액 74,250원인데 기록 72,000원 → 정산 오류 가능성.
  const FINGERPRINT = "v1|MINOR_MISMATCH|72000|74250";
  beforeEach(async () => {
    state.campaigns = [campaign({ settlementSales: 74_250, startDate: new Date("2026-09-09T15:00:00Z"), endDate: new Date("2026-09-20T14:59:59Z") })];
    await campaignInvoiceService.confirmMailInvoice("c1", { ...MAIL, totalAmount: 72_000 });
  });
  const progressOf = async () => (await campaignInvoiceService.loadInvoiceProgress(db as never, ["c1"])).get("c1");
  const unitsNow = async () =>
    (await campaignInvoiceService.loadAutoRecordUnits(db as never, { sinceDays: 3650, now: new Date("2026-10-09T00:00:00Z") })).units;

  it("지문이 같으면 기록하고, 세무 보드 진행·크론 단위에서 빠지며 완료 게이트는 그대로 통과다", async () => {
    expect((await progressOf())?.review?.reason).toBe("MINOR_MISMATCH");
    expect(await unitsNow()).toHaveLength(1);
    const ack = await campaignInvoiceService.acknowledgeReview("c1", { fingerprint: FINGERPRINT, actor: "owner-1" });
    expect(ack).toMatchObject({ fingerprint: FINGERPRINT, acknowledgedBy: "owner-1" });
    expect(await progressOf()).toEqual({ done: 1, total: 1, openMonths: [], review: null });
    expect(await unitsNow()).toEqual([]);
    expect(await campaignInvoiceService.findCompletionBlocker(db as never, "c1")).toBeNull();
    const view = await campaignInvoiceService.getView("c1");
    expect(view).toMatchObject({ reviewAcks: [{ fingerprint: FINGERPRINT, acknowledgedBy: "owner-1" }] });
    const log = state.activity.filter((a) => a.type === "CAMPAIGN_INVOICE").at(-1);
    expect(log).toMatchObject({ actor: "owner-1" });
    expect(log?.content).toContain("금액 차이를 확인했습니다");
    expect(log?.content).toContain("72,000원");
  });

  it("금액이 바뀌면(지문이 달라지면) 「확인 필요」가 저절로 다시 뜨고 크론 단위에도 돌아온다", async () => {
    await campaignInvoiceService.acknowledgeReview("c1", { fingerprint: FINGERPRINT, actor: "owner-1" });
    // 같은 달에 1,000원짜리 계산서가 더 기록됐다 → 합계 73,000원(여전히 오류 가능성이지만 다른 차이다).
    await campaignInvoiceService.recordManualInvoice("c1", { writtenDate: "2026-09-30", totalAmount: 1_000, approvalNo: "A-9", note: null });
    expect((await progressOf())?.review?.reason).toBe("MINOR_MISMATCH");
    expect(await unitsNow()).toHaveLength(1);
    // 전액이 바뀌어도 마찬가지다.
    state.acks = [];
    await campaignInvoiceService.acknowledgeReview("c1", { fingerprint: "v1|MINOR_MISMATCH|73000|74250", actor: "owner-1" });
    expect((await progressOf())?.review).toBeNull();
    state.campaigns[0].settlementSales = 75_000;
    expect((await progressOf())?.review?.reason).toBe("MINOR_MISMATCH");
  });

  it("화면이 본 지문이 지금 차이와 다르면 409 — 오너가 보지 않은 차이를 확인한 것으로 만들지 않는다", async () => {
    await expect(
      campaignInvoiceService.acknowledgeReview("c1", { fingerprint: "v1|MINOR_MISMATCH|70000|74250", actor: "owner-1" }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("금액이 바뀌었습니다") });
    expect(state.acks).toEqual([]);
  });

  it("확인할 차이가 없으면 409", async () => {
    state.invoices = [];
    await campaignInvoiceService.confirmMailInvoice("c1", MAIL); // 74,250원 — 전액과 맞다
    await expect(
      campaignInvoiceService.acknowledgeReview("c1", { fingerprint: FINGERPRINT, actor: "owner-1" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("「확인 취소」는 확인을 걷어내 「확인 필요」를 되살리고, 확인이 없으면 아무것도 하지 않는다", async () => {
    await campaignInvoiceService.acknowledgeReview("c1", { fingerprint: FINGERPRINT, actor: "owner-1" });
    expect(await campaignInvoiceService.revokeReviewAck("c1", { actor: "owner-1" })).toEqual({ removed: 1 });
    expect((await progressOf())?.review?.reason).toBe("MINOR_MISMATCH");
    expect(state.activity.filter((a) => a.type === "CAMPAIGN_INVOICE").at(-1)?.content).toContain("확인을 취소했습니다");
    const logsBefore = state.activity.length;
    expect(await campaignInvoiceService.revokeReviewAck("c1", { actor: "owner-1" })).toBeNull();
    expect(state.activity.length).toBe(logsBefore);
  });

  it("그룹은 기준 캠페인(멤버 id 오름차순 첫째) 한 줄에 쓰고 멤버 전원이 같은 답을 받는다", async () => {
    state.groups.set("g1", { supplierInvoiceIssuedAt: null });
    state.campaigns = [
      campaign({ id: "b", groupId: "g1", settlementSales: 40_000, startDate: new Date("2026-09-09T15:00:00Z"), endDate: new Date("2026-09-20T14:59:59Z") }),
      campaign({ id: "a", groupId: "g1", settlementSales: 34_250, startDate: new Date("2026-09-09T15:00:00Z"), endDate: new Date("2026-09-20T14:59:59Z") }),
    ];
    state.invoices = [];
    await campaignInvoiceService.confirmMailInvoice("b", { ...MAIL, totalAmount: 72_000 });
    // 옛 확인이 다른 멤버에 남아 있어도 걷어낸다.
    state.acks = [{ id: "old", campaignId: "b", direction: "ISSUE", fingerprint: "v1|x", acknowledgedBy: "x", acknowledgedAt: new Date(0) }];
    await campaignInvoiceService.acknowledgeReview("b", { fingerprint: FINGERPRINT, actor: "owner-1" });
    expect(state.acks.map((a) => a.campaignId)).toEqual(["a"]);
    const progress = await campaignInvoiceService.loadInvoiceProgress(db as never, ["a", "b"]);
    expect([progress.get("a")?.review, progress.get("b")?.review]).toEqual([null, null]);
  });
});
