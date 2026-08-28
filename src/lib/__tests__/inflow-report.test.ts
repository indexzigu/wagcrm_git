// 유입 리포트 집계 계약.
//
// 이 표의 숫자는 "다음 회차에 누구와 또 할 것인가" 판단에 직접 들어간다. 조용히 어긋나면
// 셀러 선정이 틀어지므로, 특히 **라벨과 실제 집계가 일치하는가**(styleseed metric-integrity)를
// 고정한다.

import { describe, expect, it, vi } from "vitest";
import type { AppPrismaClient } from "../prisma-client";
import { getInflowReport } from "../inflow-report";

type GroupRow = {
  code: string;
  visitorHash: string;
  isBot: boolean;
  _count: { _all: number };
  _max: { occurredAt: Date | null };
};

function prismaWith(links: unknown[], grouped: GroupRow[]) {
  const groupBy = vi.fn().mockResolvedValue(grouped);
  return {
    groupBy,
    prisma: {
      trackedLink: { findMany: vi.fn().mockResolvedValue(links) },
      linkClick: { groupBy },
    } as unknown as AppPrismaClient,
  };
}

const NOW = new Date("2026-08-05T00:00:00Z");

const campaign = (over: Record<string, unknown> = {}) => ({
  dealId: "d1",
  sellerId: "s1",
  campaignName: "여름 앰플 - 하늘무드",
  roundNumber: 3,
  startDate: new Date("2026-08-01"),
  endDate: new Date("2026-08-10"),
  settlementSales: null,
  actualSales: null,
  sellerExpense: null,
  operatingProfit: null,
  quantity: null,
  deal: { dealName: "여름 앰플" },
  seller: { name: "실명", alias: "하늘무드" },
  ...over,
});

const link = (over: Record<string, unknown> = {}) => ({
  code: "aaaa1111",
  label: null,
  isActive: true,
  expiresAt: null,
  salesCampaignId: "c1",
  salesCampaign: campaign(),
  ...over,
});

const humanRow = (code: string, hash: string, n: number, at = new Date("2026-08-02")): GroupRow => ({
  code,
  visitorHash: hash,
  isBot: false,
  _count: { _all: n },
  _max: { occurredAt: at },
});

describe("getInflowReport — 기본", () => {
  it("링크가 없으면 조회를 건너뛰고 0 으로 채운다", async () => {
    const { prisma, groupBy } = prismaWith([], []);
    const report = await getInflowReport(prisma, NOW);

    expect(report.links).toEqual([]);
    expect(report.attention).toEqual({
      noClickLinks: 0,
      activeNoClickLinks: 0,
      expiringSoonLinks: 0,
      awaitingSettlementLinks: 0,
    });
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("셀러는 별칭을 우선 표기한다 (P2 Seller Alias Priority)", async () => {
    const { prisma } = prismaWith([link()], []);
    const report = await getInflowReport(prisma, NOW);
    expect(report.links[0].sellerName).toBe("하늘무드");
  });

  it("별칭이 비어 있을 때만 실명으로 내려간다", async () => {
    for (const alias of [null, "", "   "]) {
      const { prisma } = prismaWith(
        [link({ salesCampaign: campaign({ seller: { name: "실명", alias } }) })],
        [],
      );
      const report = await getInflowReport(prisma, NOW);
      expect(report.links[0].sellerName, `alias=${JSON.stringify(alias)}`).toBe("실명");
    }
  });

  it("캠페인이 안 붙은 수동 링크도 목록에 남는다", async () => {
    const { prisma } = prismaWith(
      [link({ label: "수동 링크", salesCampaignId: null, salesCampaign: null })],
      [humanRow("aaaa1111", "v1", 5)],
    );
    const report = await getInflowReport(prisma, NOW);

    expect(report.links[0].campaignName).toBeNull();
    expect(report.links[0].label).toBe("수동 링크");
    expect(report.links[0].clicks).toBe(5);
  });
});

describe("봇 · 방문 연인원", () => {
  it("봇은 클릭에서 빼고 따로 센다", async () => {
    const { prisma } = prismaWith(
      [link()],
      [
        humanRow("aaaa1111", "v1", 3),
        humanRow("aaaa1111", "v2", 1, new Date("2026-08-03")),
        { code: "aaaa1111", visitorHash: "bot1", isBot: true, _count: { _all: 7 }, _max: { occurredAt: new Date("2026-08-09") } },
      ],
    );
    const report = await getInflowReport(prisma, NOW);

    expect(report.links[0].clicks).toBe(4);
    expect(report.links[0].visitDays).toBe(2);
    expect(report.links[0].botClicks).toBe(7);
  });

  it("⚠️ visitDays 는 순 방문자가 아니라 **연인원**이다", async () => {
    // visitorHash = sha256(salt|IP|UA|**KST날짜**) — 날짜가 해시에 들어 있어 dedup 이
    // 하루 안에서만 성립한다. 같은 사람이 3일 동안 매일 누르면 해시가 3개 생기므로
    // 여기서 3 이 된다. 필드명을 uniqueVisitors 로 되돌리면 라벨이 다시 거짓말을 한다.
    const { prisma } = prismaWith(
      [link()],
      [
        humanRow("aaaa1111", "sameperson-0801", 1),
        humanRow("aaaa1111", "sameperson-0802", 1),
        humanRow("aaaa1111", "sameperson-0803", 1),
      ],
    );
    const report = await getInflowReport(prisma, NOW);

    expect(report.links[0].clicks).toBe(3);
    expect(report.links[0].visitDays).toBe(3); // 사람은 1명이지만 연인원은 3
  });

  it("마지막 클릭은 사람 기준이다", async () => {
    // 봇 미리보기 시각이 "최근 반응" 으로 보이면 죽은 링크가 살아 있는 것처럼 읽힌다.
    const { prisma } = prismaWith(
      [link()],
      [
        humanRow("aaaa1111", "v1", 1, new Date("2026-08-02T05:00:00Z")),
        { code: "aaaa1111", visitorHash: "bot1", isBot: true, _count: { _all: 1 }, _max: { occurredAt: new Date("2026-08-09T05:00:00Z") } },
      ],
    );
    const report = await getInflowReport(prisma, NOW);
    expect(report.links[0].lastClickAt?.toISOString()).toBe("2026-08-02T05:00:00.000Z");
  });
});

describe("정산 조인 — 리포트는 시차를 담는다", () => {
  it("정산 전이면 금액이 전부 null 이다 (0 이 아니다)", async () => {
    // 🪤 0 으로 접으면 "아직 정산 전" 과 "정산했는데 0원" 이 구분되지 않는다.
    const { prisma } = prismaWith([link()], [humanRow("aaaa1111", "v1", 10)]);
    const report = await getInflowReport(prisma, NOW);
    const row = report.links[0];

    expect(row.clicks).toBe(10);
    expect(row.sales).toBeNull();
    expect(row.salesSource).toBeNull();
    expect(row.operatingProfit).toBeNull();
    expect(row.revenuePerClick).toBeNull();
    expect(row.profitPerClick).toBeNull();
    expect(report.attention.awaitingSettlementLinks).toBe(1);
  });

  it("정산이 붙으면 클릭당 매출·비용·순이익이 나온다", async () => {
    const { prisma } = prismaWith(
      [
        link({
          salesCampaign: campaign({
            settlementSales: 1_000_000,
            sellerExpense: 300_000,
            operatingProfit: 400_000,
            quantity: 40,
          }),
        }),
      ],
      [humanRow("aaaa1111", "v1", 100)],
    );
    const report = await getInflowReport(prisma, NOW);
    const row = report.links[0];

    expect(row.salesSource).toBe("settlement");
    expect(row.revenuePerClick).toBe(10_000);
    expect(row.costPerClick).toBe(3_000);
    expect(row.profitPerClick).toBe(4_000);
    expect(row.quantity).toBe(40);
    expect(report.attention.awaitingSettlementLinks).toBe(0);
  });

  it("정산 매출이 없으면 실매출로 내려간다", async () => {
    const { prisma } = prismaWith(
      [link({ salesCampaign: campaign({ settlementSales: null, actualSales: 500_000 }) })],
      [humanRow("aaaa1111", "v1", 50)],
    );
    const report = await getInflowReport(prisma, NOW);

    expect(report.links[0].salesSource).toBe("actual");
    expect(report.links[0].revenuePerClick).toBe(10_000);
  });

  it("클릭이 0 이면 비율을 만들지 않는다", async () => {
    // 0 으로 나누면 Infinity 가 화면에 샌다.
    const { prisma } = prismaWith(
      [link({ salesCampaign: campaign({ settlementSales: 1_000_000, operatingProfit: 1 }) })],
      [],
    );
    const report = await getInflowReport(prisma, NOW);

    expect(report.links[0].clicks).toBe(0);
    expect(report.links[0].revenuePerClick).toBeNull();
    expect(report.links[0].profitPerClick).toBeNull();
  });

  it("영업이익은 영속된 값을 그대로 읽는다 (재계산하지 않는다)", async () => {
    // `campaign-financials.ts` 가 세금·운영비·기타비용까지 넣어 계산한 값이다.
    // 여기서 매출 - 셀러비용으로 다시 만들면 손익 리포트와 갈라진다.
    const { prisma } = prismaWith(
      [
        link({
          salesCampaign: campaign({
            settlementSales: 1_000_000,
            sellerExpense: 300_000,
            operatingProfit: 123_456, // 매출-비용(700,000) 과 일부러 다르게
          }),
        }),
      ],
      [humanRow("aaaa1111", "v1", 1)],
    );
    const report = await getInflowReport(prisma, NOW);
    expect(report.links[0].operatingProfit).toBe(123_456);
    expect(report.links[0].profitPerClick).toBe(123_456);
  });
});

describe("직전 회차 대비", () => {
  const twoRounds = (round2Clicks: number) => ({
    links: [
      link({ code: "r2", salesCampaign: campaign({ roundNumber: 2 }) }),
      link({ code: "r1", salesCampaign: campaign({ roundNumber: 1 }) }),
    ],
    grouped: [
      humanRow("r2", "a", round2Clicks),
      humanRow("r1", "b", 100),
    ],
  });

  it("같은 딜·셀러의 직전 회차 클릭을 붙인다", async () => {
    const { links, grouped } = twoRounds(150);
    const { prisma } = prismaWith(links, grouped);
    const report = await getInflowReport(prisma, NOW);

    expect(report.links.find((r) => r.code === "r2")?.previousRoundClicks).toBe(100);
  });

  it("1회차이거나 직전 회차 링크가 없으면 null 이다 (0 이 아니다)", async () => {
    // 🪤 0 으로 접으면 "직전에 클릭이 0이었다" 와 "비교 대상이 없다" 가 같아진다.
    const { prisma } = prismaWith(
      [link({ code: "r1", salesCampaign: campaign({ roundNumber: 1 }) })],
      [humanRow("r1", "a", 10)],
    );
    const first = await getInflowReport(prisma, NOW);
    expect(first.links[0].previousRoundClicks).toBeNull();

    const orphan = prismaWith(
      [link({ code: "r5", salesCampaign: campaign({ roundNumber: 5 }) })],
      [humanRow("r5", "a", 10)],
    );
    const gap = await getInflowReport(orphan.prisma, NOW);
    expect(gap.links[0].previousRoundClicks).toBeNull();
  });

  it("다른 셀러의 같은 회차를 끌어오지 않는다", async () => {
    // 음성 대조군 — 키가 딜·셀러를 안 보고 회차만 보면 여기서 걸린다.
    const { prisma } = prismaWith(
      [
        link({ code: "mine", salesCampaign: campaign({ roundNumber: 2 }) }),
        link({ code: "other", salesCampaign: campaign({ roundNumber: 1, sellerId: "s2" }) }),
      ],
      [humanRow("mine", "a", 10), humanRow("other", "b", 999)],
    );
    const report = await getInflowReport(prisma, NOW);
    expect(report.links.find((r) => r.code === "mine")?.previousRoundClicks).toBeNull();
  });
});

describe("조치가 필요한 것 (요약 행)", () => {
  it("판매 기간 안에서 클릭이 0 인 링크를 따로 센다", async () => {
    // "발급했는데 아무도 안 눌렀다" 중에서도 **지금 판매 중인 것**이 급하다.
    const { prisma } = prismaWith(
      [
        // 판매 중(08-01~08-10, now=08-05) · 클릭 0
        link({ code: "active0" }),
        // 이미 끝난 캠페인 · 클릭 0
        link({
          code: "past0",
          salesCampaign: campaign({
            startDate: new Date("2026-06-01"),
            endDate: new Date("2026-06-10"),
          }),
        }),
        // 판매 중 · 클릭 있음
        link({ code: "activeOk" }),
      ],
      [humanRow("activeOk", "v1", 3)],
    );
    const report = await getInflowReport(prisma, NOW);

    expect(report.attention.noClickLinks).toBe(2);
    expect(report.attention.activeNoClickLinks).toBe(1);
  });

  it("7일 안에 만료되는 링크를 센다 — 단, 종료된 캠페인만", async () => {
    // 만료 규칙이 "종료일+30일" → "KST 종료일 다음날 00:00"로 좁혀지면서
    // (resolveLinkExpiry, short-link.ts) 진행 중 캠페인도 마지막 한 주 내내
    // "만료 임박"에 걸리게 됐다. isWithinSalePeriod 로 진행 중 캠페인을 빼야
    // "조치가 필요한, 이미 끝난 캠페인의 링크"라는 원래 의미가 유지된다.
    const endedCampaign = campaign({
      startDate: new Date("2026-06-01"),
      endDate: new Date("2026-06-10"),
    });
    const { prisma } = prismaWith(
      [
        // 종료된 캠페인 · 7일 안에 만료 → 센다
        link({ code: "soon", salesCampaign: endedCampaign, expiresAt: new Date("2026-08-09T00:00:00Z") }),
        // 진행 중 캠페인(now=08-05, 08-01~08-10) · 7일 안에 만료 → 세지 않는다(핵심)
        link({ code: "activeSoon", expiresAt: new Date("2026-08-09T00:00:00Z") }),
        // 종료된 캠페인 · 만료가 멀다 → 세지 않는다
        link({ code: "later", salesCampaign: endedCampaign, expiresAt: new Date("2026-09-30T00:00:00Z") }),
        // 종료된 캠페인 · 이미 만료됨 → 세지 않는다
        link({ code: "already", salesCampaign: endedCampaign, expiresAt: new Date("2026-07-01T00:00:00Z") }),
        // 캠페인 없음(수동 링크) · 만료값 없음 → 세지 않는다
        link({ code: "never", expiresAt: null }),
      ],
      [],
    );
    const report = await getInflowReport(prisma, NOW);
    expect(report.attention.expiringSoonLinks).toBe(1);
  });
});
