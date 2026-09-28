import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 스토어 판매기간 **확인 시각 기록 배선** 회귀 가드.
 *
 * 지켜야 하는 불변식: **간격 만기(유휴 4시간·임박 30분)가 이번 회차의 스토어 조회를 부른 경우에만**,
 * 그 회차에 **간격 구간 캠페인 전원**(유휴·임박 가리지 않고)의 `periodCheckedAt` 을 함께 찍는다
 * (두 조건이 짝이다).
 *
 * 🪤 만기가 된 캠페인에만 찍으면 캠페인마다 만기 시각이 어긋난 채 남아, 캠페인 수만큼 스토어
 * 호출이 따로 난다(위상 분산). 그러면 오너가 고른 "몇 시간에 한 번"이 전체 기준이 아니라
 * 캠페인당이 되고, `searchNaverProducts` 의 60초 TTL 은 동시 진입만 합칠 뿐 몇 시간짜리
 * 위상차는 못 합친다. 네이버 하루 요청 수가 이 레포의 상위 척도라 침묵형 비용 증가다.
 *
 * 🪤 거꾸로 **조회가 났다는 이유만으로 찍어도 안 된다** — 기간미확정(unset) 캠페인이 하나라도
 * 있으면 조회는 매 GET 나므로, 간격 구간 전원이 매 GET 쓰기를 받는다. 그 회차는 추가 호출을
 * 만든 주체도 아니라 위상을 모을 이유가 없다.
 *
 * **종료 임박 구간도 찍는다(오너 결정 2026-09-28).** 종전엔 임박이 "시각과 무관하게 항상 후보"라
 * 찍지 않았고 그래서 화면을 열 때마다 스토어를 물었다(화면 사용이 몰린 날 하루 수십 건 실측). 이제 임박 판정이
 * 30분 간격으로 `periodCheckedAt` 을 읽으므로, 찍지 않으면 매번 fail-open 으로 종전과 같아진다.
 * 그리고 **스토어 조회가 실패한 회차에는 아무도 찍지 않는다** — 확인하지 않은 것을 확인으로
 * 굳히면 다음 간격까지 기간 변경을 놓친다(P0 No Silent Failure).
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
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

/** 종료 임박 구간(리드 2일 안) 캠페인 — 만기 여부를 periodCheckedAt 으로 30분 간격에 가른다. */
const nearEndCampaign = (id: string, checkedAgoMs: number | null): StubCampaign => ({
  id,
  salePeriod: "2026.07.06 ~ 2026.07.13",
  endDate: new Date(now + HOUR),
  periodCheckedAt: checkedAgoMs === null ? null : new Date(now - checkedAgoMs),
});

/** 기간 미확정(unset) 캠페인 — 시각과 무관하게 항상 재동기화 후보라 매 GET 조회를 부른다. */
const unsetCampaign = (id: string): StubCampaign => ({
  id,
  salePeriod: "기간 미정",
  endDate: null,
  periodCheckedAt: null,
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
                // 확인 시각을 스텁에 되써 다음 fetchAndSyncCampaigns 호출이 "다음 GET"이 되게 한다 —
                // 이게 없으면 "30분 안에는 다시 묻지 않는다"를 한 파일 안에서 재현할 수 없다.
                const stub = stubCampaigns.find((c) => c.id === where.id);
                if (stub && data.periodCheckedAt instanceof Date) stub.periodCheckedAt = data.periodCheckedAt;
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

  it("임박 캠페인은 스토어를 읽은 뒤 확인 시각이 찍히고, 30분 안의 다음 GET 에서는 다시 묻지 않는다(오너 결정 2026-09-28)", async () => {
    // 종전 규칙(임박 = 매 조회)은 화면 사용이 몰린 날 하루 수십 건을 썼다. 이 테스트가 그 회귀를 막는다 —
    // 임박 판정을 다시 "항상 참"으로 되돌리면 두 번째 GET 이 스토어를 또 불러 여기서 빨개진다.
    stubCampaigns = [nearEndCampaign("near-end", null)];

    await fetchAndSyncCampaigns(false);
    expect(searchNaverProductsMock).toHaveBeenCalledTimes(1); // 기록 없음 → fail-open 으로 1회 조회
    expect(stampedIds()).toEqual(["near-end"]);

    // 다음 GET(방금 찍혔다) — 추가 조회 0, 추가 쓰기 0.
    searchNaverProductsMock.mockClear();
    orderCampaignUpdates.length = 0;
    await fetchAndSyncCampaigns(false);
    expect(searchNaverProductsMock).not.toHaveBeenCalled();
    expect(stampedIds()).toEqual([]);

    // 31분 뒤의 GET — 간격이 지났으니 다시 묻고 다시 찍는다.
    stubCampaigns[0].periodCheckedAt = new Date(now - 31 * MINUTE);
    await fetchAndSyncCampaigns(false);
    expect(searchNaverProductsMock).toHaveBeenCalledTimes(1);
    expect(stampedIds()).toEqual(["near-end"]);
  });

  it("임박 만기 때문에 조회가 났으면 아직 만기가 아닌 유휴 캠페인도 함께 찍는다 — 유휴가 임박 위상에 흡수된다", async () => {
    // 응답은 이미 손에 있어 추가 호출 0. 이렇게 안 하면 임박 30분 호출과 유휴 4시간 호출이 따로 나
    // 하루 상한이 48+6 이 된다. 종전엔 임박 회차가 매 GET 이라 이 합류가 곧 매 GET 쓰기였고 그래서
    // 유휴만 묶었다 — 임박이 30분 간격이 되면서 그 전제가 사라졌다.
    stubCampaigns = [nearEndCampaign("near-end", 31 * MINUTE), idleCampaign("idle-fresh", 1 * HOUR)];

    await fetchAndSyncCampaigns(false);

    expect(searchNaverProductsMock).toHaveBeenCalledTimes(1); // 임박 캠페인이 불렀다
    expect(stampedIds()).toEqual(["idle-fresh", "near-end"]);
  });

  it("유휴 만기 때문에 조회가 났으면 아직 만기가 아닌 임박 캠페인도 함께 찍는다", async () => {
    stubCampaigns = [idleCampaign("idle-due", 5 * HOUR), nearEndCampaign("near-end-fresh", 5 * MINUTE)];

    await fetchAndSyncCampaigns(false);

    expect(searchNaverProductsMock).toHaveBeenCalledTimes(1);
    expect(stampedIds()).toEqual(["idle-due", "near-end-fresh"]);
  });

  it("기간 미확정 캠페인이 매 GET 조회를 일으켜도, 간격 만기가 없으면 아무도 찍지 않는다", async () => {
    // 🪤 조회가 났다는 이유만으로 찍으면 간격 구간 전원이 **매 GET 쓰기**를 받는다(P7 egress).
    // 이 회차의 조회를 부른 것은 unset 캠페인이라 위상을 모을 이유도 없다.
    stubCampaigns = [unsetCampaign("unset"), idleCampaign("idle-fresh", 1 * HOUR), nearEndCampaign("near-end-fresh", 5 * MINUTE)];

    await fetchAndSyncCampaigns(false);

    expect(searchNaverProductsMock).toHaveBeenCalledTimes(1); // unset 캠페인이 불렀다
    expect(stampedIds()).toEqual([]);
  });

  it("아무도 만기가 아니면 스토어를 부르지 않고 아무것도 찍지 않는다", async () => {
    stubCampaigns = [idleCampaign("fresh-a", 1 * HOUR), idleCampaign("fresh-b", 2 * HOUR), nearEndCampaign("fresh-c", 10 * MINUTE)];

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
