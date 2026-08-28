// 유입추적 단축링크 — 코드 발급 · 통계 집계 계약.
//
// 리다이렉트 자체는 이 레포가 처리하지 않는다(go.ygrd.kr = Cloudflare Worker).
// 여기서 지키는 것은 wag-crm 쪽 두 가지다: (1) 발급되는 코드의 모양 (2) 쌓인 클릭을
// 읽어 만드는 숫자의 정의. 특히 (2)는 셀러 선정 판단에 직접 들어가므로 봇 제외·
// KST 일자 경계·순방문자 dedup 이 조용히 어긋나면 판단이 통째로 틀어진다.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "../prisma-client";
import {
  DEFAULT_SHORT_LINK_BASE,
  assertHttpUrl,
  buildShortUrl,
  ensureCampaignTrackedLink,
  generateCode,
  getCampaignFunnel,
  getLinkStats,
  getShortLinkBase,
} from "../short-link";

const ORIGINAL_BASE = process.env.NEXT_PUBLIC_SHORT_LINK_BASE_URL;

afterEach(() => {
  if (ORIGINAL_BASE === undefined) delete process.env.NEXT_PUBLIC_SHORT_LINK_BASE_URL;
  else process.env.NEXT_PUBLIC_SHORT_LINK_BASE_URL = ORIGINAL_BASE;
});

describe("코드 발급", () => {
  it("8자이고, 구두 전달에서 헷갈리는 문자를 쓰지 않는다", () => {
    // 셀러에게 전화·메신저로 불러주는 일이 있어 0/O·1/l/I 를 알파벳에서 뺐다.
    // 이 제외가 사라지면 오탈자 클릭이 전부 폴백(ygrd.kr)으로 새고, 그 유실은
    // 로그에 "존재하지 않는 코드" 로만 남아 원인을 되짚기 어렵다.
    const codes = Array.from({ length: 200 }, () => generateCode());
    for (const code of codes) {
      expect(code).toHaveLength(8);
      expect(code).toMatch(/^[a-zA-Z2-9]+$/);
      expect(code).not.toMatch(/[0O1lI]/);
    }
    // 난수인지 최소한으로 확인 — 상수를 돌려주는 고장을 잡는다.
    expect(new Set(codes).size).toBeGreaterThan(190);
  });

  it("http/https 가 아닌 목적지는 거부한다", () => {
    expect(() => assertHttpUrl("https://example.com/a")).not.toThrow();
    expect(() => assertHttpUrl("javascript:alert(1)")).toThrow();
    expect(() => assertHttpUrl("not-a-url")).toThrow();
  });
});

describe("단축 URL 베이스", () => {
  it("환경변수가 없으면 go.ygrd.kr 로, 있으면 그 origin 으로 만든다", () => {
    delete process.env.NEXT_PUBLIC_SHORT_LINK_BASE_URL;
    expect(getShortLinkBase()).toBe(DEFAULT_SHORT_LINK_BASE);
    expect(buildShortUrl("a7Kd9xQm")).toBe("https://go.ygrd.kr/a7Kd9xQm");

    // 경로가 섞여 들어와도 origin 만 취한다 — `//` 이중 슬래시 링크가 셀러에게 나가지 않게.
    process.env.NEXT_PUBLIC_SHORT_LINK_BASE_URL = "https://go.example.com/sub/";
    expect(buildShortUrl("abc")).toBe("https://go.example.com/abc");
  });

  it("깨진 값은 기본값으로 흡수한다", () => {
    // 링크 발급은 캠페인 운영 흐름 한가운데라, 환경변수 오타로 여기서 throw 하면 안 된다.
    process.env.NEXT_PUBLIC_SHORT_LINK_BASE_URL = "그냥 문자열";
    expect(getShortLinkBase()).toBe(DEFAULT_SHORT_LINK_BASE);
  });
});

type ClickRow = {
  occurredAt: Date;
  visitorHash: string;
  channel: string;
  device: string;
  subId: string | null;
  isBot: boolean;
};

function prismaWithClicks(rows: ClickRow[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return {
    prisma: { linkClick: { findMany } } as unknown as AppPrismaClient,
    findMany,
  };
}

describe("getLinkStats", () => {
  it("봇을 쿼리에서 거르지 않는다 — 안 그러면 botClicks 가 영원히 0 이다", async () => {
    // 🪤 종전 구현은 `where: { isBot: false }` 로 걸렀다. 그러면 제외된 봇이 몇 건인지
    // 셀 수가 없어 화면이 "봇 N건 제외됨" 을 말할 수 없다 — 제외가 있었는지조차 모르는
    // 집계가 된다. 전량을 읽고 메모리에서 나눈다(봇은 소수라 비용 차이가 없다).
    const { prisma, findMany } = prismaWithClicks([]);
    await getLinkStats(prisma, "a7Kd9xQm");
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty("isBot");
  });

  const mixedClicks: ClickRow[] = [
    {
      occurredAt: new Date("2026-07-31T01:00:00Z"),
      visitorHash: "bot1",
      channel: "direct",
      device: "desktop",
      subId: null,
      isBot: true,
    },
    {
      occurredAt: new Date("2026-07-31T02:00:00Z"),
      visitorHash: "v2",
      channel: "kakaotalk",
      device: "mobile",
      subId: null,
      isBot: false,
    },
  ];

  it("기본은 사람 클릭만 세고, 봇 수는 따로 보고한다", async () => {
    // 링크를 톡방에 올리는 순간 미리보기 크롤러가 붙는다. 이걸 안 빼면 게시 직후
    // 클릭이 부풀어 "초반 반응이 좋다" 는 잘못된 초기 판단이 나온다.
    const { prisma } = prismaWithClicks(mixedClicks);

    const stats = await getLinkStats(prisma, "a7Kd9xQm");
    expect(stats.totalClicks).toBe(1);
    expect(stats.botClicks).toBe(1);
    expect(stats.byChannel).toEqual([
      { key: "kakaotalk", clicks: 1, byDay: [{ date: "2026-07-31", clicks: 1 }] },
    ]);
  });

  it("봇 포함이면 분해표까지 모집단이 바뀐다", async () => {
    // 🪤 종전에는 `botClicks` 하나만 달라지고 분해표는 항상 사람 클릭이라, 토글을 켜도
    // 봇이 **어느 경로로** 들어왔는지 볼 수 없었다(토글이 반쪽이었다).
    const { prisma } = prismaWithClicks(mixedClicks);

    const stats = await getLinkStats(prisma, "a7Kd9xQm", { includeBots: true });
    expect(stats.totalClicks).toBe(2);
    expect(stats.botClicks).toBe(1); // includeBots 와 무관하게 항상 실제 값
    expect(stats.byChannel).toEqual([
      { key: "direct", clicks: 1, byDay: [{ date: "2026-07-31", clicks: 1 }] },
      { key: "kakaotalk", clicks: 1, byDay: [{ date: "2026-07-31", clicks: 1 }] },
    ]);
    expect(stats.byDevice).toEqual([
      { key: "desktop", clicks: 1 },
      { key: "mobile", clicks: 1 },
    ]);
  });

  it("순방문자는 visitorHash 로 dedup 하고, 일자는 KST 로 가른다", async () => {
    // visitorHash 에 KST 날짜가 섞여 있어 같은 사람도 날이 바뀌면 다른 값이 된다.
    // 그래서 일자 버킷도 반드시 KST 여야 한다 — UTC 로 자르면 09:00 이전 클릭이
    // 전날로 밀려 "일별 순방문자 합 ≠ 총 순방문자" 가 설명 불가하게 어긋난다.
    const { prisma } = prismaWithClicks([
      // KST 2026-07-31 23:30 (같은 사람이 두 번)
      {
        occurredAt: new Date("2026-07-31T14:30:00Z"),
        visitorHash: "v1",
        channel: "instagram",
        device: "mobile",
        subId: "story1",
        isBot: false,
      },
      {
        occurredAt: new Date("2026-07-31T14:40:00Z"),
        visitorHash: "v1",
        channel: "instagram",
        device: "mobile",
        subId: "story1",
        isBot: false,
      },
      // KST 2026-08-01 00:30 — UTC 로는 아직 07-31 이다.
      {
        occurredAt: new Date("2026-07-31T15:30:00Z"),
        visitorHash: "v2",
        channel: "direct",
        device: "desktop",
        subId: null,
        isBot: false,
      },
    ]);

    const stats = await getLinkStats(prisma, "a7Kd9xQm");
    expect(stats.totalClicks).toBe(3);
    expect(stats.visitDays).toBe(2);
    expect(stats.byDay).toEqual([
      // KST 23:30 클릭 2건 — UTC 로 자르면 14시대라 시간대까지 함께 어긋난다.
      { date: "2026-07-31", clicks: 2, uniqueVisitors: 1, byHour: [{ hour: 23, clicks: 2 }] },
      { date: "2026-08-01", clicks: 1, uniqueVisitors: 1, byHour: [{ hour: 0, clicks: 1 }] },
    ]);
    expect(stats.byDevice).toEqual([
      { key: "mobile", clicks: 2 },
      { key: "desktop", clicks: 1 },
    ]);
    // ?s= 를 안 붙인 클릭은 콘텐츠별 분해에 끼지 않는다(안 붙여도 되는 것이 규약이다).
    expect(stats.bySub).toEqual([{ key: "story1", clicks: 2 }]);
  });

  it("시간대 분포는 KST 기준 24칸 고정이고, 경로별 일자 추이가 함께 나온다", async () => {
    // 분포 차트는 "기록 없는 시간대"가 자리를 가져야 모양이 성립한다 — 희소 배열로
    // 바꾸면 피크만 남고 축이 사라진다. 시각 버킷이 UTC 로 갈리면 일자 버킷(KST)과
    // 경계가 어긋나 "23시 클릭이 전날 14시"로 보인다.
    const { prisma } = prismaWithClicks([
      // KST 2026-07-31 09:00
      {
        occurredAt: new Date("2026-07-31T00:00:00Z"),
        visitorHash: "v1",
        channel: "instagram",
        device: "mobile",
        subId: null,
        isBot: false,
      },
      // KST 2026-07-31 21:10 · 21:40
      {
        occurredAt: new Date("2026-07-31T12:10:00Z"),
        visitorHash: "v2",
        channel: "instagram",
        device: "mobile",
        subId: null,
        isBot: false,
      },
      {
        occurredAt: new Date("2026-07-31T12:40:00Z"),
        visitorHash: "v3",
        channel: "kakaotalk",
        device: "mobile",
        subId: null,
        isBot: false,
      },
      // KST 2026-08-01 21:00 — 인스타그램이 이틀에 걸친다.
      {
        occurredAt: new Date("2026-08-01T12:00:00Z"),
        visitorHash: "v4",
        channel: "instagram",
        device: "mobile",
        subId: null,
        isBot: false,
      },
    ]);

    const stats = await getLinkStats(prisma, "a7Kd9xQm");

    expect(stats.byHour).toHaveLength(24);
    expect(stats.byHour[9]).toEqual({ hour: 9, clicks: 1 });
    expect(stats.byHour[21]).toEqual({ hour: 21, clicks: 3 });
    // 나머지 22칸은 0 으로 존재한다.
    expect(stats.byHour.reduce((sum, r) => sum + r.clicks, 0)).toBe(4);
    expect(stats.byHour.filter((r) => r.clicks === 0)).toHaveLength(22);

    expect(stats.byChannel).toEqual([
      {
        key: "instagram",
        clicks: 3,
        byDay: [
          { date: "2026-07-31", clicks: 2 },
          { date: "2026-08-01", clicks: 1 },
        ],
      },
      { key: "kakaotalk", clicks: 1, byDay: [{ date: "2026-07-31", clicks: 1 }] },
    ]);
  });
});

function funnelPrisma(campaign: unknown, link: unknown, clicks: Array<{ visitorHash: string }>) {
  return {
    salesCampaign: { findUnique: vi.fn().mockResolvedValue(campaign) },
    trackedLink: { findFirst: vi.fn().mockResolvedValue(link) },
    linkClick: { findMany: vi.fn().mockResolvedValue(clicks) },
  } as unknown as AppPrismaClient;
}

describe("ensureCampaignTrackedLink — 자리표시자 목적지 차단 (실사고 2026-07-31)", () => {
  function campaignPrisma(campaign: Record<string, unknown>) {
    const create = vi.fn();
    return {
      create,
      prisma: {
        trackedLink: { findFirst: vi.fn().mockResolvedValue(null), create },
        salesCampaign: { findUnique: vi.fn().mockResolvedValue(campaign) },
      } as unknown as AppPrismaClient,
    };
  }

  it("도메인 루트만 등록된 캠페인은 발급을 거부한다", async () => {
    // 화면 가드만으로는 부족하다 — 라우트·스크립트로 부르면 그대로 통과해서, 실제로
    // 팔로워를 스토어 홈으로 보내는 링크가 프로덕션에 발급됐다. 링크가 살아 있어
    // 에러가 안 나므로 캠페인이 끝날 때까지 드러나지 않는 부류다.
    const { prisma, create } = campaignPrisma({
      id: "c1",
      dealId: "d1",
      sellerId: "s1",
      baseNaverLink: "https://smartstore.naver.com",
      generatedTrackingLink: "https://smartstore.naver.com/?nt_source=INSTAGRAM",
      endDate: null,
    });

    await expect(ensureCampaignTrackedLink(prisma, "c1")).rejects.toThrow("상품 페이지가 아닙니다");
    expect(create).not.toHaveBeenCalled();
  });

  it("상품 경로가 있으면 정상 발급한다", async () => {
    // 양성 대조군 — 가드가 과하게 넓어져 전부 막으면 이쪽이 먼저 깨진다.
    const { prisma, create } = campaignPrisma({
      id: "c1",
      dealId: "d1",
      sellerId: "s1",
      baseNaverLink: "https://opuscom.shop.blogpay.co.kr/view/good/dPY6hE",
      generatedTrackingLink: "",
      endDate: null,
    });
    create.mockResolvedValue({ code: "abcd2345" });

    await expect(ensureCampaignTrackedLink(prisma, "c1")).resolves.toMatchObject({
      code: "abcd2345",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("트래킹 링크가 자리표시자여도 상품 링크가 있으면 그것으로 발급한다", async () => {
    // 캠페인은 자리표시자로 태어나고 그 위에서 generatedTrackingLink 가 만들어진다.
    // 운영자는 나중에 브랜드사 상품 링크를 baseNaverLink 에 저장한다. 목적지를
    // `generatedTrackingLink || baseNaverLink` 로 고르면 자리표시자 파생값이 먼저 이겨
    // **발급이 영원히 거절된다** — 입력 폼을 붙여도 기능이 죽는 지점이다.
    const { prisma, create } = campaignPrisma({
      id: "c1",
      dealId: "d1",
      sellerId: "s1",
      baseNaverLink: "https://brand.example.com/view/good/AbC123",
      generatedTrackingLink: "https://smartstore.naver.com/?nt_source=INSTAGRAM",
      endDate: null,
    });
    create.mockResolvedValue({ code: "abcd2345" });

    await ensureCampaignTrackedLink(prisma, "c1");

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({
      targetUrl: "https://brand.example.com/view/good/AbC123",
    });
  });
});

describe("getCampaignFunnel", () => {
  it("정산 매출이 있으면 그쪽을 쓰고, 판매 수량은 수량으로만 노출한다", async () => {
    // ⚠️ 분자는 주문 **건수** 가 아니라 판매 **수량** 이다(P7 Order-Count Vocabulary).
    // 필드명이 quantityPerVisitor 인 것은 그래서다 — "전환율" 로 되돌리면 이 레포가
    // orderCount → quantity 리네임으로 이미 한 번 고친 오독이 그대로 재발한다.
    const prisma = funnelPrisma(
      { id: "c1", quantity: 40, actualSales: 900000, settlementSales: 1000000 },
      { code: "a7Kd9xQm" },
      [{ visitorHash: "v1" }, { visitorHash: "v1" }, { visitorHash: "v2" }, { visitorHash: "v3" }],
    );

    const funnel = await getCampaignFunnel(prisma, "c1");
    expect(funnel).toMatchObject({
      code: "a7Kd9xQm",
      clicks: 4,
      visitDays: 3,
      quantity: 40,
      sales: 1000000,
      salesSource: "settlement",
    });
    expect(funnel.quantityPerVisitDay).toBeCloseTo(40 / 3);
    expect(funnel.revenuePerClick).toBe(250000);
    expect(funnel).not.toHaveProperty("conversionRate");
  });

  it("링크가 없으면 클릭을 조회하지 않고 비율은 null 이다", async () => {
    // 0 을 돌려주면 "링크를 아직 안 뿌렸다" 와 "뿌렸는데 아무도 안 눌렀다" 가
    // 화면에서 구분되지 않는다. 전자는 운영 미조치, 후자는 셀러 성과 신호다.
    const prisma = funnelPrisma({ id: "c1", quantity: 40, actualSales: null, settlementSales: null }, null, []);

    const funnel = await getCampaignFunnel(prisma, "c1");
    expect(funnel.code).toBeNull();
    expect(funnel.clicks).toBe(0);
    expect(funnel.sales).toBeNull();
    expect(funnel.salesSource).toBeNull();
    expect(funnel.quantityPerVisitDay).toBeNull();
    expect(funnel.revenuePerClick).toBeNull();
    expect(prisma.linkClick.findMany).not.toHaveBeenCalled();
  });
});
