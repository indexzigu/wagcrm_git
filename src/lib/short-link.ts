import { randomInt } from "crypto";
import { pickConfirmedTargetLink } from "./campaign-link-surface";
import type { AppPrismaClient } from "./prisma-client";

/**
 * 유입추적 단축링크 발급/집계.
 *
 * 리다이렉트 자체는 wag-crm 이 처리하지 않는다 — go.ygrd.kr(Cloudflare Worker)이
 * 받아서 302 를 쏘고 LinkClick 만 적재한다. 이 모듈은 (1) 링크를 만들고
 * (2) 쌓인 클릭을 읽는 두 가지만 담당한다. 클릭 트래픽은 Vercel 함수를 전혀
 * 태우지 않으므로 캠페인이 터져도 CRM 사용량은 그대로다.
 */

const CODE_ALPHABET =
  "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 0/O/1/l/I 제외 — 구두 전달·오탈자 사고 방지
const CODE_LENGTH = 8;
const MAX_CODE_ATTEMPTS = 5;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 링크 만료 시각 = **KST 종료일 다음날 00:00**. 종료일 당일은 종일 유효하다.
 *
 * ⛔ 밀리초 덧셈(구 규칙 `endDate + 30일`)으로 되돌리지 말 것 — 그 식은 `endDate` 의 **시각
 * 성분**을 그대로 끌고 가서, 같은 "30일"이 저장된 시각에 따라 28일 뒤·30일 뒤로 갈렸다.
 * 만료는 "정확히 720시간 뒤"가 아니라 "며칠까지 살아 있나"라는 날짜 질문이다.
 *
 * 이 레포는 이미 KST 일자 경계를 쓴다(`toKstDate` 의 방문자 dedup, `getLinkStats` 의 일자
 * 분할) — 기준을 하나로 모은다.
 *
 * ⚠️ 이 함수가 **유일한 계산 지점**이다(발급·종료일 변경·소급 스크립트가 공유). SQL 로
 * 같은 계산을 다시 쓰면 두 벌이 되어 나중에 조용히 갈라진다.
 */
export function resolveLinkExpiry(endDate: Date | null): Date | null {
  if (!endDate) return null;
  // UTC 로 옮겨 놓고 UTC 달력 함수를 쓰면, 서버 로컬 타임존과 무관하게 KST 날짜가 나온다.
  const kst = new Date(endDate.getTime() + KST_OFFSET_MS);
  const nextKstMidnightAsUtc = Date.UTC(
    kst.getUTCFullYear(),
    kst.getUTCMonth(),
    kst.getUTCDate() + 1, // Date.UTC 는 말일 초과를 다음 달로 정규화한다(8/31+1 → 9/1)
  );
  return new Date(nextKstMidnightAsUtc - KST_OFFSET_MS);
}

/**
 * `syncCampaignLinkExpiry` 가 쓰는 클라이언트 표면. 트랜잭션 클라이언트(`Prisma.TransactionClient`)
 * 와 일반 클라이언트를 모두 받기 위해 **구조적 타입**으로 좁힌다 — 둘의 공통 조상 타입이 없다.
 */
export type LinkExpiryTx = {
  salesCampaign: {
    findMany(args: {
      where: { id?: string; groupId?: string };
      select: { id: true; endDate: true };
    }): Promise<Array<{ id: string; endDate: Date | null }>>;
  };
  trackedLink: {
    updateMany(args: {
      where: { salesCampaignId: { in: string[] } };
      data: { expiresAt: Date | null };
    }): Promise<{ count: number }>;
  };
};

/**
 * 캠페인의 **현재 저장된 종료일**로 그 캠페인 링크의 만료를 다시 계산한다.
 *
 * 그룹이면 형제 멤버까지 대상이다 — 조합 캠페인은 1개 실공구라 링크가 서로 다른 날 죽으면
 * 안 된다(실데이터의 절반이 그룹이다).
 *
 * ⚠️ **저장값을 읽는다 — 인자로 받은 새 종료일을 쓰지 않는다.** 그래서 호출 위치가 계약이
 * 된다: `fanOutMemberSchedule` 로 형제 종료일이 복사되고 본 update 로 원본 종료일이 저장된
 * **뒤**에 불러야 전원이 같은 날 죽는다. 앞에서 부르면 형제가 옛 날짜로 갱신된다.
 *
 * ⛔ `isActive` 를 건드리지 않는다 — 만료(시간 축)와 수동 중단(스위치 축)은 별개다.
 */
export async function syncCampaignLinkExpiry(
  tx: LinkExpiryTx,
  target: { campaignId: string; groupId?: string | null },
): Promise<number> {
  const campaigns = await tx.salesCampaign.findMany({
    where: target.groupId ? { groupId: target.groupId } : { id: target.campaignId },
    select: { id: true, endDate: true },
  });
  if (campaigns.length === 0) return 0;

  // 같은 만료로 묶어 쓰기를 최소화한다. 팬아웃 뒤라면 보통 한 덩어리(= updateMany 1회)다.
  const groups = new Map<string, { expiresAt: Date | null; ids: string[] }>();
  for (const campaign of campaigns) {
    const expiresAt = resolveLinkExpiry(campaign.endDate);
    const key = expiresAt?.toISOString() ?? "null";
    const bucket = groups.get(key) ?? { expiresAt, ids: [] };
    bucket.ids.push(campaign.id);
    groups.set(key, bucket);
  }

  let updated = 0;
  for (const bucket of groups.values()) {
    const { count } = await tx.trackedLink.updateMany({
      where: { salesCampaignId: { in: bucket.ids } },
      data: { expiresAt: bucket.expiresAt },
    });
    updated += count;
  }
  return updated;
}

export const DEFAULT_SHORT_LINK_BASE = "https://go.ygrd.kr";

export function getShortLinkBase(): string {
  const raw = process.env.NEXT_PUBLIC_SHORT_LINK_BASE_URL?.trim();
  if (!raw) return DEFAULT_SHORT_LINK_BASE;
  try {
    return new URL(raw).origin;
  } catch {
    return DEFAULT_SHORT_LINK_BASE;
  }
}

export function buildShortUrl(code: string): string {
  return `${getShortLinkBase()}/${code}`;
}

/**
 * 캐시 우회 꼬리의 접두. 코드 알파벳(base57)과 섞여도 사람이 "이건 꼬리다"를
 * 알아보게 하는 표시일 뿐, 리다이렉터는 이 값을 읽지 않는다.
 */
export const PREVIEW_REFRESH_PREFIX = "r";

/**
 * 메신저(카톡·메타)가 URL 단위로 굳혀 둔 링크 미리보기를 우회하는 공유용 URL.
 *
 * `go.ygrd.kr/{code}/r{ms-base36}` — **경로 꼬리**다. 리다이렉터는 코드를
 * `pathname` 첫 세그먼트에서만 읽고(`ygrd-link/src/index.ts`) 목적지 병합은
 * `searchParams` 만 보므로, 이 꼬리는 조회·통계·목적지 어디에도 닿지 않는다.
 * 덕분에 Worker 를 고치지 않고 CRM 한 레인으로 끝난다.
 *
 * ⛔ 쿼리(`?v=`)로 되돌리지 말 것 — 그 값은 `buildTargetUrl` 병합으로 브랜드사
 * 상품 URL 에 그대로 따라붙고, 카드가 안내하는 `?s=story1` 을 셀러가 덧붙이면
 * `?v=2?s=story1` 이 되어 **콘텐츠 구분자가 조용히 유실된다.**
 *
 * ⛔ 토큰을 `ogFetchedAt` 파생으로 바꾸지 말 것 — 수집이 실패하면 그 값이 안
 * 바뀌어 다시 눌러도 같은 URL 이 나오고, 캐시 우회가 성립하지 않는다. 토큰이
 * 따라야 하는 것은 "우리가 무엇을 성공했나"가 아니라 "운영자가 언제 눌렀나"다.
 *
 * 밀리초를 쓰는 이유: 초 단위면 2초 안의 연타가 같은 값을 낸다(트러블슈팅
 * 중에는 연타가 정상 사용이다).
 */
export function buildPreviewRefreshUrl(shortUrl: string, nowMs: number = Date.now()): string {
  // 후행 슬래시를 먹지 않으면 `//` 가 되어 첫 세그먼트가 빈 문자열이 된다 →
  // 리다이렉터가 코드를 못 읽고 폴백으로 떨어진다.
  const base = shortUrl.replace(/\/+$/, "");
  return `${base}/${PREVIEW_REFRESH_PREFIX}${nowMs.toString(36)}`;
}

export function generateCode(length = CODE_LENGTH): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

export type CreateTrackedLinkInput = {
  /** nt_* 파라미터까지 다 붙은 최종 목적지(= SalesCampaign.generatedTrackingLink) */
  targetUrl: string;
  /** 감사용 원본 링크(= SalesCampaign.baseNaverLink) */
  baseUrl?: string | null;
  label?: string | null;
  salesCampaignId?: string | null;
  sellerId?: string | null;
  dealId?: string | null;
  expiresAt?: Date | null;
};

export function assertHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("http/https 링크만 등록할 수 있습니다.");
  }
  return url;
}

/**
 * 코드 충돌은 8자 base57 기준 현실적으로 없지만, unique 제약이 터지면
 * 캠페인 생성 전체가 실패하므로 재시도로 흡수한다.
 */
export async function createTrackedLink(
  prisma: AppPrismaClient,
  input: CreateTrackedLinkInput,
) {
  assertHttpUrl(input.targetUrl);

  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generateCode();
    try {
      return await prisma.trackedLink.create({
        data: {
          code,
          targetUrl: input.targetUrl,
          baseUrl: input.baseUrl ?? null,
          label: input.label ?? null,
          salesCampaignId: input.salesCampaignId ?? null,
          sellerId: input.sellerId ?? null,
          dealId: input.dealId ?? null,
          expiresAt: input.expiresAt ?? null,
        },
      });
    } catch (error) {
      lastError = error;
      const code2 = (error as { code?: string })?.code;
      if (code2 !== "P2002") throw error; // unique 충돌만 재시도
    }
  }
  throw lastError ?? new Error("단축링크 코드 생성에 실패했습니다.");
}

/**
 * 캠페인당 1개 링크를 보장한다(멱등). 이미 있으면 그대로 돌려준다 —
 * 링크를 다시 발급하면 셀러가 이미 뿌린 링크의 통계가 갈라진다.
 */
export async function ensureCampaignTrackedLink(
  prisma: AppPrismaClient,
  campaignId: string,
) {
  const existing = await prisma.trackedLink.findFirst({
    where: { salesCampaignId: campaignId },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;

  const campaign = await prisma.salesCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      dealId: true,
      sellerId: true,
      baseNaverLink: true,
      generatedTrackingLink: true,
      endDate: true,
    },
  });
  if (!campaign) throw new Error("캠페인을 찾을 수 없습니다.");

  // 목적지 판정은 화면과 같은 SSOT 를 쓴다(`pickConfirmedTargetLink`). 자리표시자를
  // 건너뛰는 이유는 캠페인이 자리표시자로 태어나고 그 위에서 generatedTrackingLink 가
  // 만들어지기 때문이다 — 단순 `||` 는 나중에 저장한 진짜 상품 링크를 영원히 가린다.
  //
  // 화면 가드(`hasConfirmedTargetLink`)만으로는 부족하다 — 라우트·스크립트로 부르면
  // 그대로 통과한다. 실사고(2026-07-31)에서 `https://smartstore.naver.com` 자리표시자로
  // 링크가 발급돼 팔로워를 스토어 홈으로 보내는 상태가 됐다. 링크는 살아 있으므로
  // 에러가 나지 않아 캠페인이 끝날 때까지 아무도 모른다.
  const target = pickConfirmedTargetLink(campaign);
  if (!target) {
    // 값이 아예 없는 것과 자리표시자인 것을 구분해 말한다 — 운영자가 할 일이 다르다.
    const hasAnyValue = [campaign.generatedTrackingLink, campaign.baseNaverLink].some(
      (value) => (value ?? "").trim() !== "",
    );
    throw new Error(
      hasAnyValue
        ? "캠페인 링크가 상품 페이지가 아닙니다 (도메인 주소만 등록돼 있습니다). 상품 URL을 먼저 저장해 주세요."
        : "캠페인에 등록된 링크가 없습니다.",
    );
  }

  return createTrackedLink(prisma, {
    targetUrl: target,
    baseUrl: campaign.baseNaverLink,
    salesCampaignId: campaign.id,
    sellerId: campaign.sellerId,
    dealId: campaign.dealId,
    // 만료는 캠페인 종료일을 따라간다 — 계산은 `resolveLinkExpiry` 하나가 소유한다.
    expiresAt: resolveLinkExpiry(campaign.endDate),
  });
}

export type LinkStats = {
  code: string;
  /** 집계 모집단의 크기. `includeBots` 에 따라 사람만 / 전체가 된다. */
  totalClicks: number;
  /**
   * **방문 연인원이다 — 순 방문자가 아니다.** `visitorHash` 에 KST 날짜가 섞여 있어
   * dedup 이 하루 안에서만 성립한다(개인정보 최소수집 설계). 아래 `byDay[].uniqueVisitors`
   * 만 진짜 순 방문자다. 이름을 되돌리면 라벨이 다시 거짓말을 한다(2026-07-31 정정).
   */
  visitDays: number;
  /**
   * 기간 안의 봇 클릭 수. **`includeBots` 와 무관하게 항상 실제 값**이다 —
   * 화면이 "봇 N건 제외됨" 을 말할 수 있어야 하기 때문이다(0 으로 접히면 제외된 게
   * 있는지조차 알 수 없다).
   */
  botClicks: number;
  firstClickAt: Date | null;
  lastClickAt: Date | null;
  /**
   * 경로별 클릭 + 그 경로의 일자별 추이. `byDay` 는 클릭이 있는 날짜만 담는다(희소).
   * "어느 경로가 며칠까지 살아 있었나"(스토리는 하루, 피드는 며칠 등)를 가르는 축이다.
   */
  byChannel: Array<{ key: string; clicks: number; byDay: Array<{ date: string; clicks: number }> }>;
  byDevice: Array<{ key: string; clicks: number }>;
  /// 셀러가 ?s= 로 붙인 콘텐츠 구분자별 성과(스토리 vs 피드 등). 미사용 시 빈 배열.
  bySub: Array<{ key: string; clicks: number }>;
  /**
   * 시간대별(KST 0~23시) 클릭 분포 — 기간 전체 합산. **24칸 고정**이다(클릭 0인
   * 시간대 포함) — 차트가 "기록 없는 시간대"를 자리로 보여줘야 분포 모양이 성립한다.
   */
  byHour: Array<{ hour: number; clicks: number }>;
  /** 일자별 합계 + 그 날의 시간대 상세. `byHour` 는 클릭이 있는 시간대만 담는다(희소). */
  byDay: Array<{
    date: string;
    clicks: number;
    uniqueVisitors: number;
    byHour: Array<{ hour: number; clicks: number }>;
  }>;
};

function toKstDate(value: Date): string {
  return new Date(value.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** KST 시각(0~23). 일자 버킷(`toKstDate`)과 반드시 같은 오프셋을 써야 경계가 안 갈린다. */
function toKstHour(value: Date): number {
  return new Date(value.getTime() + KST_OFFSET_MS).getUTCHours();
}

function tally(rows: Array<{ key: string }>): Array<{ key: string; clicks: number }> {
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.key, (map.get(row.key) ?? 0) + 1);
  return [...map.entries()]
    .map(([key, clicks]) => ({ key, clicks }))
    .sort((a, b) => b.clicks - a.clicks);
}

/**
 * 봇(카톡·메타 링크 미리보기 크롤러)은 기본 제외한다. 미리보기 1회가
 * 사람 클릭 1회로 잡히면 초반 유입이 통째로 부풀어 판단을 망친다.
 */
export async function getLinkStats(
  prisma: AppPrismaClient,
  code: string,
  options: { from?: Date; to?: Date; includeBots?: boolean } = {},
): Promise<LinkStats> {
  // ⚠️ 봇을 **쿼리에서 거르지 않는다.** 걸러버리면 `botClicks` 가 항상 0 이 되어
  // "봇 N건 제외됨" 을 화면에서 말할 수 없다 — 제외된 게 있는지조차 모르는 집계가 된다.
  // 대신 전량을 읽고 여기서 나눈다. 봇은 소수라 비용 차이가 없다.
  const clicks = await prisma.linkClick.findMany({
    where: {
      code,
      ...(options.from || options.to
        ? {
            occurredAt: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.to ? { lte: options.to } : {}),
            },
          }
        : {}),
    },
    select: {
      occurredAt: true,
      visitorHash: true,
      channel: true,
      device: true,
      subId: true,
      isBot: true,
    },
    orderBy: { occurredAt: "asc" },
  });

  // `includeBots` 는 **집계 모집단**을 정한다 — 분해표(채널·기기·콘텐츠·일자)까지 함께
  // 바뀐다. 종전에는 `botClicks` 하나만 달라지고 분해표는 항상 사람 클릭이라, "봇 포함"
  // 토글을 켜도 봇이 **어느 경로로** 들어왔는지 볼 수 없었다(토글이 반쪽이었다).
  const population = options.includeBots ? clicks : clicks.filter((c) => !c.isBot);
  const botClicks = clicks.filter((c) => c.isBot).length;

  const byDayMap = new Map<
    string,
    { clicks: number; visitors: Set<string>; hours: Map<number, number> }
  >();
  // 시간대 분포는 24칸 고정 — 빈 시간대도 자리를 가져야 분포 모양이 성립한다.
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, clicks: 0 }));
  const byChannelMap = new Map<string, { clicks: number; days: Map<string, number> }>();
  for (const click of population) {
    const day = toKstDate(click.occurredAt);
    const hour = toKstHour(click.occurredAt);
    const bucket =
      byDayMap.get(day) ??
      { clicks: 0, visitors: new Set<string>(), hours: new Map<number, number>() };
    bucket.clicks += 1;
    bucket.visitors.add(click.visitorHash);
    bucket.hours.set(hour, (bucket.hours.get(hour) ?? 0) + 1);
    byDayMap.set(day, bucket);

    byHour[hour].clicks += 1;

    const channel =
      byChannelMap.get(click.channel) ?? { clicks: 0, days: new Map<string, number>() };
    channel.clicks += 1;
    channel.days.set(day, (channel.days.get(day) ?? 0) + 1);
    byChannelMap.set(click.channel, channel);
  }

  return {
    code,
    totalClicks: population.length,
    visitDays: new Set(population.map((c) => c.visitorHash)).size,
    botClicks,
    firstClickAt: population[0]?.occurredAt ?? null,
    lastClickAt: population[population.length - 1]?.occurredAt ?? null,
    byChannel: [...byChannelMap.entries()]
      .map(([key, v]) => ({
        key,
        clicks: v.clicks,
        byDay: [...v.days.entries()]
          .map(([date, clicks]) => ({ date, clicks }))
          .sort((a, b) => a.date.localeCompare(b.date)),
      }))
      .sort((a, b) => b.clicks - a.clicks),
    byDevice: tally(population.map((c) => ({ key: c.device }))),
    bySub: tally(
      population.filter((c) => c.subId).map((c) => ({ key: c.subId as string })),
    ),
    byHour,
    byDay: [...byDayMap.entries()]
      .map(([date, v]) => ({
        date,
        clicks: v.clicks,
        uniqueVisitors: v.visitors.size,
        byHour: [...v.hours.entries()]
          .map(([hour, clicks]) => ({ hour, clicks }))
          .sort((a, b) => a.hour - b.hour),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export type CampaignFunnel = {
  campaignId: string;
  code: string | null;
  clicks: number;
  visitDays: number;
  /**
   * 정산으로 확정된 **판매 수량**(`SalesCampaign.quantity`). 정산 전이면 null.
   *
   * ⚠️ 주문 **건수**가 아니다(P7 Order-Count Vocabulary). 진짜 주문건수
   * (`cachedDistinctOrderCount`)는 `OrderCampaign` 단위로만 영속되는데, 주문캠페인
   * 1개가 판매캠페인 4~5개를 공유하는 것이 표준이라 셀러별로 쪼갤 수 없다.
   * 셀러 단위로 정확한 확정치는 이 수량뿐이다.
   */
  quantity: number | null;
  /** 정산으로 확정된 매출. 정산 전이면 null */
  sales: number | null;
  salesSource: "settlement" | "actual" | null;
  /**
   * 판매 수량 ÷ 방문 연인원. **전환율이 아니다** — 분자가 주문 건수가 아니라 수량이고,
   * 셀러 링크를 안 거친 주문도 분자에 섞이므로 절대값이 아닌 셀러 간 비교용 추정치다.
   * (구 필드명 `conversionRate`는 이 둘을 동시에 오독하게 만들어 폐기했다 — 오너 확정
   * 2026-07-31. `SalesCampaign.quantity`가 `orderCount`에서 리네임된 이유와 같은 축이다.)
   */
  quantityPerVisitDay: number | null;
  /** 클릭 1회가 만든 매출(원). 다음 캠페인 셀러 선정의 실질 기준 */
  revenuePerClick: number | null;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 클릭(우리 데이터) × 매출(정산 데이터)을 캠페인 단위로 잇는다.
 *
 * 브랜드사 스토어 관리자에 접근할 수 없으므로 실시간 전환은 볼 수 없다. 대신
 * 공구는 정산 자체가 셀러별 매출을 확정해서 들어오므로, 캠페인이 끝난 뒤
 * 여기서 클릭당 매출과 방문자당 판매 수량이 산출된다. 실시간 대시보드는 못 되지만
 * "다음에 누구와 또 할 것인가"에는 이 숫자가 정확히 필요한 답이다.
 *
 * ⚠️ 개인 단위 어트리뷰션이 아니다. 셀러 링크를 안 거치고 유입된 주문도 매출에
 * 포함되므로 두 비율 모두 상한이 아니라 추정치다 — 셀러 간 비교에는 쓰되 절대값을
 * 성과 지표로 못 박지 말 것. 셀러에게 숫자를 통보하는 용도가 아니다(A-Z §I).
 */
export async function getCampaignFunnel(
  prisma: AppPrismaClient,
  campaignId: string,
): Promise<CampaignFunnel> {
  const [campaign, link] = await Promise.all([
    prisma.salesCampaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        quantity: true,
        actualSales: true,
        settlementSales: true,
      },
    }),
    prisma.trackedLink.findFirst({
      where: { salesCampaignId: campaignId },
      orderBy: { createdAt: "asc" },
      select: { code: true },
    }),
  ]);
  if (!campaign) throw new Error("캠페인을 찾을 수 없습니다.");

  const clicks = link
    ? await prisma.linkClick.findMany({
        where: { code: link.code, isBot: false },
        select: { visitorHash: true },
      })
    : [];

  const visitDays = new Set(clicks.map((c) => c.visitorHash)).size;
  const settlement = toNumber(campaign.settlementSales);
  const actual = toNumber(campaign.actualSales);
  const sales = settlement ?? actual;
  const quantity = campaign.quantity ?? null;

  return {
    campaignId,
    code: link?.code ?? null,
    clicks: clicks.length,
    visitDays,
    quantity,
    sales,
    salesSource: settlement !== null ? "settlement" : actual !== null ? "actual" : null,
    quantityPerVisitDay:
      quantity !== null && visitDays > 0 ? quantity / visitDays : null,
    revenuePerClick: sales !== null && clicks.length > 0 ? sales / clicks.length : null,
  };
}
