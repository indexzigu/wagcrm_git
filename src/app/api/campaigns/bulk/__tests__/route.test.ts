import { describe, it, expect, vi, beforeEach } from "vitest";

// bulk 캠페인 생성 회귀 테스트: POST /api/campaigns/bulk 는 prisma.salesCampaign.create를
// 직접 호출하면서 campaignName 자동 조합과 roundNumber 재계산을 건너뛰어, 이름/차수가
// 빈 캠페인을 만들었다. 수정 후에는 각 (dealId, sellerId) 생성이 트랜잭션 안에서
// recalculateCampaignRounds를 거쳐 "[딜이름] - [셀러명] (N차)" 이름을 부여받아야 한다.

type Row = {
  id: string;
  dealId: string;
  sellerId: string;
  startDate: Date;
  createdAt: Date;
  campaignName: string | null;
  roundNumber: number | null;
  [key: string]: unknown;
};

const deals: Record<string, { dealName: string; baseMarginPolicy: string }> = {
  "deal-1": { dealName: "락토핏 골드", baseMarginPolicy: "{}" },
};

const sellers: Record<string, { alias: string | null; name: string }> = {
  "seller-a": { alias: "뷰뷰", name: "유가명" },
  "seller-b": { alias: null, name: "박셀러" },
};

let rows: Row[] = [];
let seq = 0;

const txSalesCampaign = {
  create: async ({ data }: { data: Record<string, unknown> }) => {
    seq += 1;
    const row = {
      id: `c-${seq}`,
      campaignName: null,
      roundNumber: null,
      createdAt: new Date(2026, 0, 1, 0, 0, seq),
      ...data,
    } as Row;
    rows.push(row);
    return { ...row };
  },
  findMany: async ({ where }: { where: { dealId: string; sellerId: string } }) => {
    return rows
      .filter((r) => r.dealId === where.dealId && r.sellerId === where.sellerId)
      .sort(
        (a, b) =>
          a.startDate.getTime() - b.startDate.getTime() ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      )
      .map((r) => ({
        ...r,
        deal: { dealName: deals[r.dealId]?.dealName ?? null },
        seller: sellers[r.sellerId] ?? null,
      }));
  },
  update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const row = rows.find((r) => r.id === where.id);
    if (!row) throw new Error(`row not found: ${where.id}`);
    Object.assign(row, data);
    return { ...row };
  },
  findUnique: async ({ where }: { where: { id: string } }) => {
    const row = rows.find((r) => r.id === where.id);
    return row ? { ...row } : null;
  },
};

// recalculateCampaignRounds가 재계산 전 pg_advisory_xact_lock을 호출한다 — 이 tx
// mock엔 실제 postgres가 없으니 no-op으로 흉내낸다(락 직렬화 자체는
// campaignService.recalcRounds.test.ts에서 별도 검증).
const txExecuteRaw = vi.fn(async () => []);

const transactionMock = vi.fn(
  async (
    fn: (tx: {
      salesCampaign: typeof txSalesCampaign;
      $executeRaw: typeof txExecuteRaw;
    }) => Promise<unknown>,
  ) => fn({ salesCampaign: txSalesCampaign, $executeRaw: txExecuteRaw }),
);

const prismaMock = {
  deal: {
    findUnique: async ({ where }: { where: { id: string } }) =>
      deals[where.id]
        ? { id: where.id, baseMarginPolicy: deals[where.id].baseMarginPolicy }
        : null,
  },
  salesCampaign: txSalesCampaign,
  $transaction: (...args: unknown[]) =>
    transactionMock(...(args as Parameters<typeof transactionMock>)),
};

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => prismaMock,
}));

import { POST } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("https://example.com/api/campaigns/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/campaigns/bulk — campaignName/roundNumber 자동 조합 회귀", () => {
  beforeEach(() => {
    rows = [];
    seq = 0;
    transactionMock.mockClear();
  });

  it("bulk 생성 캠페인에 '[딜이름] - [셀러명]' 자동 조합 이름이 부여된다 (alias 우선)", async () => {
    const res = await POST(
      makeRequest({
        dealId: "deal-1",
        sellerIds: ["seller-a", "seller-b"],
        startDate: "2026-06-01",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.failed).toEqual([]);
    expect(body.created).toHaveLength(2);

    const bySeller = Object.fromEntries(
      body.created.map((c: Row) => [c.sellerId, c]),
    );
    // seller-a: alias(뷰뷰)가 실명(유가명)보다 우선
    expect(bySeller["seller-a"].campaignName).toBe("락토핏 골드 - 뷰뷰");
    // seller-b: alias 없음 → 실명
    expect(bySeller["seller-b"].campaignName).toBe("락토핏 골드 - 박셀러");
    // 각 셀러의 첫 캠페인이므로 차수 없음
    expect(bySeller["seller-a"].roundNumber).toBeNull();
    expect(bySeller["seller-b"].roundNumber).toBeNull();

    // 응답만이 아니라 저장된 행 자체가 갱신되어야 한다
    for (const row of rows) {
      expect(row.campaignName).not.toBeNull();
    }
  });

  it("기존 캠페인이 있는 (딜, 셀러)에 bulk 추가 시 기존/신규 모두 N차가 재계산된다", async () => {
    rows.push({
      id: "c-existing",
      dealId: "deal-1",
      sellerId: "seller-a",
      startDate: new Date("2026-01-01"),
      createdAt: new Date("2026-01-01"),
      campaignName: "락토핏 골드 - 뷰뷰",
      roundNumber: null,
    });

    const res = await POST(
      makeRequest({
        dealId: "deal-1",
        sellerIds: ["seller-a"],
        startDate: "2026-06-01",
      }),
    );
    const body = await res.json();

    expect(body.created).toHaveLength(1);
    expect(body.created[0].campaignName).toBe("락토핏 골드 - 뷰뷰 2차");
    expect(body.created[0].roundNumber).toBe(2);

    const existing = rows.find((r) => r.id === "c-existing");
    expect(existing?.campaignName).toBe("락토핏 골드 - 뷰뷰 1차");
    expect(existing?.roundNumber).toBe(1);
  });

  it("셀러별 생성+재계산이 각각 하나의 트랜잭션으로 실행된다", async () => {
    await POST(
      makeRequest({
        dealId: "deal-1",
        sellerIds: ["seller-a", "seller-b"],
        startDate: "2026-06-01",
      }),
    );

    expect(transactionMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * 제거된 표면 회귀 가드 (2026-08-27).
 *
 * 이 모듈이 `PATCH` 를 내보내면 Next 가 그 메서드를 그대로 라우트로 노출한다.
 * 종전 핸들러는 그룹(CG-1)을 조회하지 않은 채 `isDepositReceived`/
 * `isPayoutCompleted` 를 `salesCampaign.updateMany` 로 멤버 행에 직접 썼다 —
 * 조합 캠페인에서는 그룹 스칼라가 SoT 라서, 되살아나면 화면·지연 판정·정산
 * 목록이 **조용히 옛 값**을 보여준다(사유 전문은 `../route.ts` 하단 주석).
 *
 * 앱 안 호출부가 0건이라 타입도 기존 테스트도 이 복원을 못 잡는다 — 그래서
 * 「없다」를 명시적으로 단언한다.
 */
describe("PATCH /api/campaigns/bulk — 제거된 표면", () => {
  it("PATCH 핸들러를 내보내지 않는다", async () => {
    const mod = await import("../route");

    // 양성 대조군: `in` 판정 자체가 살아 있음을 먼저 확인한다.
    // 이게 없으면 import 가 깨져도 아래 단언이 초록으로 보인다.
    expect("POST" in mod).toBe(true);

    expect("PATCH" in mod).toBe(false);
  });
});
