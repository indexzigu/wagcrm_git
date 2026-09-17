import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 스토어 판매기간 **확인 시각 기록 배선** 회귀 가드.
 *
 * 지켜야 하는 불변식: 스토어를 실제로 읽은 회차에는 **유휴 구간 캠페인 전원**의
 * `periodCheckedAt` 을 함께 찍는다.
 *
 * 🪤 만기가 된 캠페인에만 찍으면 캠페인마다 만기 시각이 어긋난 채 남아, 캠페인 수만큼 스토어
 * 호출이 따로 난다(위상 분산). 그러면 오너가 고른 "몇 시간에 한 번"이 전체 기준이 아니라
 * 캠페인당이 되고, `searchNaverProducts` 의 60초 TTL 은 동시 진입만 합칠 뿐 몇 시간짜리
 * 위상차는 못 합친다. 네이버 하루 요청 수가 이 레포의 상위 척도라 침묵형 비용 증가다.
 *
 * 같은 이유로 **종료 임박 구간은 찍지 않는다** — 그 구간의 판정은 시각을 읽지 않으므로
 * 찍으면 대시보드 GET 마다 캠페인 수만큼 쓰기만 늘어난다(P7 egress 규율).
 * 그리고 **스토어 조회가 실패한 회차에는 아무도 찍지 않는다** — 확인하지 않은 것을 확인으로
 * 굳히면 다음 간격까지 기간 변경을 놓친다(P0 No Silent Failure).
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const now = Date.now();

type StubCampaign = {
  id: string;
  salePeriod: string | null;
  endDate: Date | null;
  periodCheckedAt: Date | null;
};

/** 유휴 구간(종료가 리드 창 밖) 캠페인 — 만기 여부만 periodCheckedAt 으로 가른다. */
const idleCampaign = (id: string, checkedAgoMs: number | null): StubCampaign => ({
  id,
  salePeriod: "2026.07.06 ~ 2026.07.20",
  endDate: new Date(now + 8 * DAY),
  periodCheckedAt: checkedAgoMs === null ? null : new Date(now - checkedAgoMs),
});

/** 종료 임박 구간 캠페인 — 시각과 무관하게 항상 재동기화 후보다. */
const nearEndCampaign = (id: string): StubCampaign => ({
  id,
  salePeriod: "2026.07.06 ~ 2026.07.13",
  endDate: new Date(now + HOUR),
  periodCheckedAt: new Date(now - 10 * DAY),
});

let stubCampaigns: StubCampaign[] = [];
let searchShouldThrow = false;
const searchNaverProductsMock = vi.fn(async () => {
  if (searchShouldThrow) throw new Error("store unreachable");
  // 매칭되는 상품이 없는 응답 — 기존 값은 그대로 두고 '확인했다'만 남기는 경로를 태운다.
  return { contents: [] };
});
/** orderCampaign.update 호출 인자(확인 시각이 찍힌 캠페인을 여기서 센다). */
const orderCampaignUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];

const prismaStub: unknown = new Proxy(
  {},
  {
    get: (_target, model: string) =>
      new Proxy(
        {},
        {
          get: (_m, method: string) => {
            if (model === "orderCampaign" && method === "findMany") {
              return vi.fn(async () =>
                stubCampaigns.map((c) => ({
                  ...c,
                  name: c.id,
                  isActive: true,
                  category: "카테고리",
                  productStatus: "SALE",
                  startDate: new Date(now - DAY),
                  tasks: [],
                  mappings: [],
                  salesCampaigns: [],
                })),
              );
            }
            if (model === "orderCampaign" && method === "update") {
              return vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                orderCampaignUpdates.push({ id: where.id, data });
                return { ...data, id: where.id };
              });
            }
            return vi.fn(async () => (method === "findMany" ? [] : method === "count" ? 0 : null));
          },
        },
      ),
  },
);

// `after()` 콜백은 버린다 — 확인 시각 기록은 핸들러 본문에서 끝나고 이 테스트는 그 배선만 본다.
// (형제 테스트 `campaigns-handler.entry-sync.test.ts` 는 진입 동기화가 after 안에 있어 드레인한다.)
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {},
}));
vi.mock("@/lib/order-converter/prisma", () => ({ prisma: prismaStub }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => prismaStub }));
vi.mock("@/lib/demo-mode", () => ({ isDemoMode: () => false }));
vi.mock("@/lib/order-converter/naver-commerce-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/order-converter/naver-commerce-api")>()),
  searchNaverProducts: () => searchNaverProductsMock(),
}));
vi.mock("@/repositories/naverOrderSnapshotRepository", () => ({
  naverOrderSnapshotRepository: {
    findRangeMeta: vi.fn(async () => []),
    findByDates: vi.fn(async () => []),
    findRange: vi.fn(async () => []),
    latestSyncMeta: vi.fn(async () => ({ lastCallTime: new Date(now - 10 * 60 * 1000), syncType: "CHANGED" })),
    parseOrders: vi.fn(() => []),
  },
}));

const { fetchAndSyncCampaigns } = await import("./campaigns-handler");

/** 확인 시각이 찍힌 캠페인 id 집합. */
function stampedIds(): string[] {
  return orderCampaignUpdates
    .filter((u) => u.data.periodCheckedAt instanceof Date)
    .map((u) => u.id)
    .sort();
}

describe("campaigns-handler — 스토어 확인 시각 기록 배선", () => {
  beforeEach(() => {
    orderCampaignUpdates.length = 0;
    searchNaverProductsMock.mockClear();
    searchShouldThrow = false;
  });

  it("만기 캠페인 하나 때문에 조회가 났으면, 아직 만기가 아닌 유휴 캠페인도 함께 찍는다", async () => {
    // 이걸 안 하면 두 캠페인의 만기 시각이 영영 어긋난 채 남아 스토어 호출이 두 번으로 갈린다.
    stubCampaigns = [idleCampaign("due", 5 * HOUR), idleCampaign("not-due", 1 * HOUR)];

    await fetchAndSyncCampaigns(false);

    expect(searchNaverProductsMock).toHaveBeenCalledTimes(1);
    expect(stampedIds()).toEqual(["due", "not-due"]);
  });

  it("종료 임박 구간 캠페인은 찍지 않는다 — 그 구간 판정은 확인 시각을 읽지 않는다", async () => {
    stubCampaigns = [idleCampaign("idle", 5 * HOUR), nearEndCampaign("near-end")];

    await fetchAndSyncCampaigns(false);

    expect(stampedIds()).toEqual(["idle"]);
  });

  it("임박 캠페인이 매 GET 조회를 일으켜도, 유휴 만기가 없으면 아무도 찍지 않는다", async () => {
    // 🪤 조회가 났다는 이유만으로 찍으면 유휴 캠페인 전원이 **매 GET 쓰기**를 받는다 —
    // 임박 구간을 기록에서 뺀 바로 그 이유(P7 egress)가 유휴로 옮겨갈 뿐이다.
    // 이 회차의 조회를 부른 것은 임박 캠페인이라 위상을 모을 이유도 없다.
    stubCampaigns = [nearEndCampaign("near-end"), idleCampaign("idle-fresh", 1 * HOUR)];

    await fetchAndSyncCampaigns(false);

    expect(searchNaverProductsMock).toHaveBeenCalledTimes(1); // 임박 캠페인이 불렀다
    expect(stampedIds()).toEqual([]);
  });

  it("아무도 만기가 아니면 스토어를 부르지 않고 아무것도 찍지 않는다", async () => {
    stubCampaigns = [idleCampaign("fresh-a", 1 * HOUR), idleCampaign("fresh-b", 2 * HOUR)];

    await fetchAndSyncCampaigns(false);

    expect(searchNaverProductsMock).not.toHaveBeenCalled();
    expect(stampedIds()).toEqual([]);
  });

  it("스토어 조회가 실패하면 아무도 찍지 않는다 — 확인하지 않은 것을 확인으로 굳히지 않는다", async () => {
    searchShouldThrow = true;
    stubCampaigns = [idleCampaign("due", 5 * HOUR), idleCampaign("not-due", 1 * HOUR)];

    await fetchAndSyncCampaigns(false);

    expect(searchNaverProductsMock).toHaveBeenCalledTimes(1);
    expect(stampedIds()).toEqual([]);
  });
});
