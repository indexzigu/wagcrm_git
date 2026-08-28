import type { AppPrismaClient } from "./prisma-client";
import { buildShortUrl } from "./short-link";

/**
 * 유입 리포트 — 발급된 단축링크 전체를 한 표로 본다.
 *
 * 캠페인 사이드패널의 카드는 "이 캠페인 링크가 살아있는가"만 답한다(총 클릭·순 방문자
 * 둘). 이 리포트는 그 위 질문 — **"어느 셀러가, 어느 경로로 유입을 만들었는가"** — 에
 * 답하려고 캠페인을 가로지른다.
 *
 * 링크별 채널·기기·콘텐츠 분해는 `getLinkStats`(short-link.ts)가 담당하고, 여기서는
 * 목록과 합계만 만든다. 두 곳이 같은 숫자를 각자 세지 않도록 **봇 제외 규칙을 공유**한다.
 */

export type InflowLinkRow = {
  code: string;
  shortUrl: string;
  label: string | null;
  campaignId: string | null;
  /** 캠페인명(자동 조합값). 없으면 딜명으로 대체한다. */
  campaignName: string | null;
  /** P2 Seller Alias Priority — 별칭이 있으면 실명 대신 별칭을 쓴다. */
  sellerName: string | null;
  roundNumber: number | null;
  startDate: Date | null;
  endDate: Date | null;
  isActive: boolean;
  expiresAt: Date | null;
  /** 사람 클릭 수(봇 제외) */
  clicks: number;
  /**
   * **방문 연인원이다 — 순 방문자가 아니다.**
   *
   * `visitorHash` 는 `sha256(salt|IP|UA|KST날짜)` 라 **날짜가 해시에 들어 있다**(개인정보
   * 최소수집을 위한 의도된 설계). 그래서 dedup 은 **하루 안에서만** 성립한다 — 5일짜리
   * 공구를 매일 눌러본 한 사람은 5 로 잡힌다.
   *
   * 일자별 표(`getLinkStats().byDay`)의 값만 진짜 순 방문자이고, 하루를 넘는 구간은
   * 전부 연인원이다. 라벨을 "순 방문자" 로 되돌리지 말 것 — 화면 라벨과 실제 집계가
   * 어긋난다(styleseed metric-integrity, 2026-07-31 오너 지적으로 정정).
   */
  visitDays: number;
  /** 제외된 봇 클릭 수 — 0 으로 접지 않는다(제외 사실을 화면이 말해야 한다) */
  botClicks: number;
  lastClickAt: Date | null;

  // ── 공유 미리보기 스냅샷 ───────────────────────────────────────────────────
  // 상세 시트의 「미리보기 새로고침」 행이 소비한다. 값이 null 인 것은 결함이
  // 아니라 아직 수집하지 않은 단계다(리다이렉터가 봇 요청 때 실시간으로 긁는다).
  ogTitle: string | null;
  ogImage: string | null;
  ogFetchedAt: Date | null;

  // ── 정산 조인 ──────────────────────────────────────────────────────────────
  // 리포트는 **시차를 담는 물건**이다(오너 2026-07-31). 진행 중이면 클릭만, 정산이
  // 확정되면 매출·순이익이 같은 행에 붙는다. 값이 없는 것은 결함이 아니라 단계다.
  /** 확정 매출. 정산 전이면 null */
  sales: number | null;
  salesSource: "settlement" | "actual" | null;
  /** 셀러 지급액(`SalesCampaign.sellerExpense`) */
  sellerExpense: number | null;
  /**
   * 캠페인 영업이익 — `campaign-financials.ts` 가 계산해 영속한 값을 **그대로 읽는다.**
   * 여기서 재계산하면 손익 리포트와 갈라진다(세금·운영비·기타비용이 전부 그 식에 있다).
   */
  operatingProfit: number | null;
  /** 확정 판매 **수량**. 주문 건수가 아니다(P7 Order-Count Vocabulary) */
  quantity: number | null;

  // ── 유입 1건의 값 (셀러 선정의 실질 기준) ───────────────────────────────────
  /** 확정 매출 ÷ 클릭 */
  revenuePerClick: number | null;
  /** 셀러 지급액 ÷ 클릭 — "이 셀러의 트래픽을 얼마에 샀나" */
  costPerClick: number | null;
  /** 영업이익 ÷ 클릭 — 재계약 판단의 정본 */
  profitPerClick: number | null;

  /**
   * 같은 딜·같은 셀러의 **직전 회차** 클릭 수. 없으면 null.
   *
   * "두 번째 게시물이 첫 번째보다 잘 나온다" 는 인플루언서 마케팅의 반복 효과를
   * 우리 데이터로 확인하는 축이다. 직전 회차에 링크가 없으면 비교 대상이 없으므로
   * null 이고, 이걸 0 으로 접으면 "클릭이 0이었다" 와 구분되지 않는다.
   */
  previousRoundClicks: number | null;
};

/**
 * 지금 손을 써야 하는 것 — 요약 행이 답해야 할 유일한 질문.
 *
 * ⛔ **전 기간 누적(총 클릭·총 방문자)을 여기에 되돌리지 말 것**(오너 판단 2026-07-31).
 * 단조증가하는 수치라 어떤 결정도 걸리지 않는 허영 지표이고, 인플루언서 마케팅에서
 * reach·EMV 로 판단하지 말라는 원칙과 같은 축이다. 셀러 비교는 아래 링크 표가 한다.
 */
export type InflowAttention = {
  /** 발급했는데 클릭이 0 인 링크 — 아직 안 뿌렸거나 셀러가 게시를 안 했다 */
  noClickLinks: number;
  /** 판매 기간 안인데 클릭이 0 인 링크 — 위보다 급하다 */
  activeNoClickLinks: number;
  /** 7일 안에 만료되는 링크 */
  expiringSoonLinks: number;
  /** 클릭은 쌓였는데 정산 수치가 아직 안 붙은 링크 — 시차가 정상이라 경고는 아니다 */
  awaitingSettlementLinks: number;
};

export type InflowReport = {
  attention: InflowAttention;
  links: InflowLinkRow[];
};

/**
 * 셀러 표기 — 별칭 우선(P2). 별칭이 비어 있을 때만 실명으로 내려간다.
 *
 * ⚠️ 이 리포트는 오너 전용 내부 화면이다. 셀러 표면(`/p/[token]`·`/<slug>`)에
 * 이 데이터를 그대로 넘기지 말 것 — 타 셀러 유입이 함께 보인다(P0).
 */
function resolveSellerName(seller: { alias: string | null; name: string } | null): string | null {
  if (!seller) return null;
  const alias = seller.alias?.trim();
  return alias && alias !== "" ? alias : seller.name;
}

/** Prisma `Decimal` · number · null 을 유한한 number 로. 아니면 null. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 분모가 0 이면 비율을 만들지 않는다 — Infinity 가 화면에 새는 것을 막는다. */
function perClick(total: number | null, clicks: number): number | null {
  if (total === null || clicks <= 0) return null;
  return total / clicks;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getInflowReport(
  prisma: AppPrismaClient,
  now: Date = new Date(),
): Promise<InflowReport> {
  const links = await prisma.trackedLink.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      code: true,
      label: true,
      isActive: true,
      expiresAt: true,
      ogTitle: true,
      ogImage: true,
      ogFetchedAt: true,
      salesCampaignId: true,
      salesCampaign: {
        select: {
          dealId: true,
          sellerId: true,
          campaignName: true,
          roundNumber: true,
          startDate: true,
          endDate: true,
          // 정산 조인 — 값이 없는 것은 결함이 아니라 "아직 그 단계" 다.
          settlementSales: true,
          actualSales: true,
          sellerExpense: true,
          operatingProfit: true,
          quantity: true,
          deal: { select: { dealName: true } },
          seller: { select: { name: true, alias: true } },
        },
      },
    },
  });

  if (links.length === 0) {
    return {
      attention: {
        noClickLinks: 0,
        activeNoClickLinks: 0,
        expiringSoonLinks: 0,
        awaitingSettlementLinks: 0,
      },
      links: [],
    };
  }

  const codes = links.map((link) => link.code);

  // 코드 × 방문자 × 봇여부로 묶으면 한 번의 groupBy 로 세 숫자가 다 나온다 —
  // 행 수는 클릭 수가 아니라 **순 방문자 수**에 비례해 상한이 낮다.
  // (`/api/tracked-links` 목록이 쓰는 것과 같은 관용구다.)
  const grouped = await prisma.linkClick.groupBy({
    by: ["code", "visitorHash", "isBot"],
    where: { code: { in: codes } },
    _count: { _all: true },
    _max: { occurredAt: true },
  });

  type Tally = { clicks: number; visitors: Set<string>; bots: number; last: Date | null };
  const tally = new Map<string, Tally>();
  for (const row of grouped) {
    const bucket = tally.get(row.code) ?? { clicks: 0, visitors: new Set<string>(), bots: 0, last: null };
    if (row.isBot) {
      bucket.bots += row._count._all;
    } else {
      bucket.clicks += row._count._all;
      bucket.visitors.add(row.visitorHash);
      // 마지막 클릭은 **사람 기준**이다 — 봇 미리보기 시각이 "최근 반응" 으로 보이면
      // 죽은 링크가 살아 있는 것처럼 읽힌다.
      const occurred = row._max.occurredAt;
      if (occurred && (!bucket.last || occurred > bucket.last)) bucket.last = occurred;
    }
    tally.set(row.code, bucket);
  }

  // 같은 딜·셀러의 회차별 클릭 — 직전 회차 대비를 만들려면 먼저 색인이 필요하다.
  const clicksByRound = new Map<string, number>();
  for (const link of links) {
    const campaign = link.salesCampaign;
    if (!campaign || campaign.roundNumber == null) continue;
    const key = `${campaign.dealId}|${campaign.sellerId}|${campaign.roundNumber}`;
    clicksByRound.set(key, (clicksByRound.get(key) ?? 0) + (tally.get(link.code)?.clicks ?? 0));
  }

  const rows: InflowLinkRow[] = links.map((link) => {
    const bucket = tally.get(link.code);
    const campaign = link.salesCampaign;
    const clicks = bucket?.clicks ?? 0;

    const settlement = toNumber(campaign?.settlementSales);
    const actual = toNumber(campaign?.actualSales);
    const sales = settlement ?? actual;
    const sellerExpense = toNumber(campaign?.sellerExpense);
    const operatingProfit = toNumber(campaign?.operatingProfit);

    const previousRoundClicks =
      campaign && campaign.roundNumber != null && campaign.roundNumber > 1
        ? clicksByRound.get(
            `${campaign.dealId}|${campaign.sellerId}|${campaign.roundNumber - 1}`,
          ) ?? null
        : null;

    return {
      code: link.code,
      shortUrl: buildShortUrl(link.code),
      ogTitle: link.ogTitle,
      ogImage: link.ogImage,
      ogFetchedAt: link.ogFetchedAt,
      label: link.label,
      campaignId: link.salesCampaignId,
      campaignName: campaign?.campaignName ?? campaign?.deal?.dealName ?? null,
      sellerName: resolveSellerName(campaign?.seller ?? null),
      roundNumber: campaign?.roundNumber ?? null,
      startDate: campaign?.startDate ?? null,
      endDate: campaign?.endDate ?? null,
      isActive: link.isActive,
      expiresAt: link.expiresAt,
      clicks,
      visitDays: bucket?.visitors.size ?? 0,
      botClicks: bucket?.bots ?? 0,
      lastClickAt: bucket?.last ?? null,

      sales,
      salesSource: settlement !== null ? "settlement" : actual !== null ? "actual" : null,
      sellerExpense,
      operatingProfit,
      quantity: campaign?.quantity ?? null,

      revenuePerClick: perClick(sales, clicks),
      costPerClick: perClick(sellerExpense, clicks),
      profitPerClick: perClick(operatingProfit, clicks),

      previousRoundClicks,
    };
  });

  const nowMs = now.getTime();
  const isWithinSalePeriod = (row: InflowLinkRow) =>
    row.startDate != null &&
    row.endDate != null &&
    row.startDate.getTime() <= nowMs &&
    nowMs <= row.endDate.getTime() + DAY_MS;

  return {
    attention: {
      noClickLinks: rows.filter((row) => row.clicks === 0).length,
      activeNoClickLinks: rows.filter((row) => row.clicks === 0 && isWithinSalePeriod(row)).length,
      // 만료 규칙이 "종료일 +30일"에서 "KST 종료일 다음날 00:00"로 좁혀지면서
      // (resolveLinkExpiry, short-link.ts) 진행 중 캠페인도 마지막 한 주 내내
      // 여기 걸리게 됐다 — 그러면 건강하게 돌아가는 공구가 상시 "주의 필요"로
      // 잡힌다. isWithinSalePeriod 로 진행 중인 캠페인을 모집단에서 빼서
      // "조치가 필요한, 이미 끝난 캠페인의 링크"라는 원래 의미를 지킨다.
      expiringSoonLinks: rows.filter(
        (row) =>
          row.expiresAt != null &&
          row.expiresAt.getTime() >= nowMs &&
          row.expiresAt.getTime() <= nowMs + 7 * DAY_MS &&
          !isWithinSalePeriod(row),
      ).length,
      // 클릭은 들어왔는데 매출이 아직 안 붙은 것 — 정산 시차라 정상이다. 경고가 아니라
      // "언제 다시 볼지" 의 표시다.
      awaitingSettlementLinks: rows.filter((row) => row.clicks > 0 && row.sales === null).length,
    },
    links: rows,
  };
}
