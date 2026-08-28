// 셀러 포털 화이트리스트 직렬화 — 이 파일이 내부 데이터 차단의 단일 방어선이다.
//
// campaigns route(fetchAndSyncCampaigns)의 응답에는 내부 경제성 정보(매핑 단가·원가,
// salesCampaigns의 netMarginRate·operatingProfit 등)와 운영 상태(발주/배송 카운트,
// 이메일 주소)가 포함된다. 셀러에게는 아래 명시 필드만 나간다.
// 원칙: 절대 스프레드(...) 금지 — 필드를 하나하나 옮겨 담는다. 새 필드 추가는
// "셀러가 봐도 되는가"를 확인한 뒤 여기와 테스트에 함께 추가할 것.

import { countDistinctSellerIds } from '@/lib/cross-seller';

type AnyCampaign = Record<string, any>;

export type PortalOption = { name: string; price: number; quantity: number; revenue: number };
export type PortalDailyStat = {
  date: string;
  orders: number;
  quantity: number;
  revenue: number;
  options: PortalOption[];
};

export type PortalInsights = {
  // 유입 중 "마케팅링크"(외부 SNS 링크) 발 주문 — 셀러 기여도의 근사치
  linkOrders: number;
  linkRatio: number;
  hourly: { hour: number; orders: number }[];
  // 주의: 캠페인 내 2회+ 구매(buyers.repeat)는 셀러 화면에서 "재구매"로 오독되어 제거함
  // (2026-07-10 소유자 피드백). 재구매 고객은 cross-campaign-repurchase의 회차간 비율을 쓴다.
  mobileRatio: number;
};

export type PortalCampaign = {
  id: string;
  name: string;
  salePeriod: string;
  isActive: boolean;
  thumbnailUrl: string | null;
  totalOrders: number; // 상품주문 라인수(내부 지표·비율 분모용) — "주문건수" 표시에는 쓰지 말 것
  distinctOrderCount: number; // 주문건수 = 결제(orderId) 단위 distinct. 셀러 노출 "주문 N건"·객단가(AOV) 분모의 정본
  totalQuantity: number;
  totalRevenue: number;
  dailyStats: PortalDailyStat[];
  insights: PortalInsights | null;
};

// ──────────────────────────────────────────────────────────────────────────────
// 셀러 단일성 게이트 — 화이트리스트가 막지 못하는 "집계 범위" 축의 방어선.
//
// toPortalCampaign이 받는 totalRevenue·distinctOrderCount·dailyStats·insights는
// campaigns-handler가 **OrderCampaign(주문캠페인) 단위**로 계산한 값이고 그 집계 루프에는
// sellerId 필터가 없다. 반면 포털은 salesCampaigns 중 **하나라도** 이 셀러 것이면 그 캠페인을
// "내 것"으로 포함한다. 따라서 한 주문캠페인에 서로 다른 셀러의 판매캠페인이 붙으면
// **셀러 A 화면에 A+B 합산 매출이 A의 실적으로 표시된다** — AGENTS.md P0
// 「Seller-Facing Data Exposure」(타 셀러 정보·셀러 간 집계 노출 금지) 위반이다.
//
// ⛔ **이 상태는 정상 운영에 존재하지 않는 형태다(오너 확정 2026-08-05).** 같은 상품을 다른
// 셀러로 다시 공구할 때는 **판매캠페인을 새로 만들고 새로 파생된 주문캠페인에 연결**한다 —
// 주문캠페인은 셀러·회차마다 새로 생긴다. 프로덕션 실측 0건이 이 관행과 일치한다.
// **따라서 이 게이트에 걸리는 캠페인은 데이터 이상 신호이지 정상 케이스가 아니다.**
// 게이트를 "과한 방어"로 읽고 풀지 말 것 — 걸렸다는 건 매핑이 잘못됐다는 뜻이고, 해소는
// 게이트 완화가 아니라 주문캠페인 매핑에서 딜 연결을 한 셀러로 정리하는 것이다.
//
// 그 상태를 강제하는 DB 제약은 없다. 프로덕션 실측(2026-08-04)으로는 0건이지만
// **구조적으로 막혀 있지 않을 뿐**이고, 다중 셀러 연결을 만들 수 있는 쓰기 경로가 2개 있다:
//  ① 퍼지 자동매핑(mapping-service.autoMapOrderCampaign)은 옵션마다 독립적으로 최고점
//     판매캠페인을 골라 Set에 누적한다 — 옵션별 승자가 다른 셀러여도 검사가 없다.
//  ② 수동 매핑 저장(order-converter/api/campaigns/[id])은 옵션별 campaignDealId에서 파생한
//     판매캠페인 집합을 그대로 연결한다 — 추천 드롭다운이 sellerScore>0인 **모든 셀러**의
//     딜을 나열하므로 운영자 오클릭 한 번이면 이 상태가 만들어진다.
//
// ⛔ **이 판정을 productId(또는 주문↔캠페인 귀속)로 바꾸지 말 것.** 주문 귀속은 productId가
// 아니라 **상품명·옵션명 문자열의 양방향 부분일치**(order-converter/campaign-orders.ts
// `orderMatchesCampaign`)로 이뤄진다. 즉 이름이 겹치면 자동매핑뿐 아니라 **귀속 단계에서도**
// 셀러가 흔들린다 — productId 판정은 이 위험을 덜 잡는다. 게이트는 실제로 화면에 합산이
// 흘러드는 조건 그 자체, 즉 **링크 관계(salesCampaigns의 distinct sellerId)**를 본다.
//
// 처방 범위(오너 확정 2026-08-04): 집계를 셀러 단위로 재계산하는 것은 **보류**다 — blast
// radius가 오너 대시보드·정산 리포트까지 번지는데 현재 수혜자가 0명이다. 지금은 셀러 대면
// 표면에서 **표시 제외 + 운영자 경고**만 한다.
// 쓰기 경로 차단(위 ①②가 애초에 다중 셀러를 연결하지 못하게)은 **착지했다**(2026-08-05) —
// 종전 보류 사유("같은 링크로 셀러를 교체하는 운영을 막을 수 있다")가 오너 확정으로 거짓임이
// 확정됐기 때문이다(주문캠페인은 셀러·회차마다 새로 만든다). 정책은 **전체 거부**다:
// ①자동매핑은 옵션별 승자가 갈리면 쓰기 0건으로 되돌리고 ②수동 저장은 400 으로 롤백한다.
// 판정 규칙은 `@/lib/cross-seller` 가 SSOT 이고 이 파일의 `countLinkedSellers` 도 그것을 쓴다.
//
// ⛔ **그래도 이 게이트를 제거하지 말 것.** 이제 이중 방어이지 중복이 아니다 —
//  · 쓰기 차단은 **미래의 새 writer** 를 덮지 못한다(스크립트·마이그레이션·아직 없는 라우트).
//  · 차단 이전에 만들어진 **기존 데이터**를 소급 정리하지 않는다(현재 prod 0건이지만 보장은 아니다).
// 즉 쓰기 차단은 "새로 생기지 않게", 이 게이트는 "있어도 안 새게" — 서로 다른 축이다.

/**
 * 이 캠페인에 연결된 판매캠페인들의 서로 다른 셀러 수(빈 sellerId는 귀속 불가라 제외).
 *
 * 세는 규칙 자체는 `@/lib/cross-seller` 의 `countDistinctSellerIds` 에 위임한다 — 같은
 * 불변식을 쓰기 차단 경로 2곳(자동매핑·수동 저장)이 함께 보기 때문이다. 여기서 다시 세면
 * "표시 제외는 걸리는데 쓰기는 통과"(또는 그 반대)로 갈라진다.
 */
export function countLinkedSellers(camp: AnyCampaign): number {
  const list = Array.isArray(camp?.salesCampaigns) ? camp.salesCampaigns : [];
  return countDistinctSellerIds(list.map((sc: AnyCampaign) => sc?.sellerId));
}

/** 서로 다른 셀러의 판매캠페인이 2곳 이상 붙은 캠페인 = 집계가 셀러별로 갈리지 않는 상태. */
export function isCrossSellerCampaign(camp: AnyCampaign): boolean {
  return countLinkedSellers(camp) > 1;
}

/**
 * 셀러 대면 표면이 쓸 캠페인 선별 — "내 캠페인"에서 셀러 단일성이 깨진 건을 **분리**한다.
 * `visible`만 렌더하고 `blocked`는 화면에서 빼되, 호출부가 반드시 경고를 남긴다(아래).
 */
export function selectSellerVisibleCampaigns<T extends AnyCampaign>(
  campaigns: T[],
  sellerId: string,
): { visible: T[]; blocked: T[] } {
  const visible: T[] = [];
  const blocked: T[] = [];
  for (const camp of campaigns) {
    const list = Array.isArray(camp?.salesCampaigns) ? camp.salesCampaigns : [];
    if (!list.some((sc: AnyCampaign) => sc?.sellerId === sellerId)) continue;
    if (isCrossSellerCampaign(camp)) blocked.push(camp);
    else visible.push(camp);
  }
  return { visible, blocked };
}

/**
 * 표시 제외를 **조용히** 하지 않는다(P0 No Silent Failure) — 오너가 "셀러 화면에서 빠진
 * 캠페인이 있다"는 사실 자체를 알아야 해소(매핑 정정)를 할 수 있다. 경고 형식은
 * campaigns-handler의 sharedLinkConflicts 경고와 같은 계열(운영자용 서버 로그)이다.
 * ⚠️ 셀러 실명·캠페인명·실측 수치를 로그에 싣지 않는다 — 식별자만 남긴다(P0, 레포 public).
 */
export function warnCrossSellerCampaigns(surface: string, blocked: AnyCampaign[]): void {
  if (blocked.length === 0) return;
  console.warn(
    `[portal:${surface}] 한 주문캠페인에 서로 다른 셀러의 판매캠페인이 연결돼 있어 ` +
      `집계가 셀러별로 갈리지 않습니다 — 합산 노출을 막기 위해 셀러 화면에서 제외했습니다. ` +
      `주문캠페인 매핑에서 딜 연결을 한 셀러로 정리하세요: ` +
      blocked
        .map((c) => `${String(c?.id ?? 'unknown')}(sellers=${countLinkedSellers(c)})`)
        .join(', '),
  );
}

export function toPortalCampaign(camp: AnyCampaign): PortalCampaign {
  const dailyStats: PortalDailyStat[] = (Array.isArray(camp.dailyStats) ? camp.dailyStats : []).map(
    (d: AnyCampaign) => ({
      date: String(d.date || ''),
      orders: Number(d.orders) || 0,
      quantity: Number(d.quantity) || 0,
      revenue: Number(d.revenue) || 0,
      options: (Array.isArray(d.options) ? d.options : []).map((o: AnyCampaign) => ({
        name: String(o.name || ''),
        price: Number(o.price) || 0,
        quantity: Number(o.quantity) || 0,
        revenue: Number(o.revenue) || 0,
      })),
    })
  );

  let insights: PortalInsights | null = null;
  if (camp.insights) {
    const i = camp.insights;
    // linkOrders(마케팅링크 유입)는 이제 결제(orderId) distinct 기준이므로 비율 분모도 결제 단위
    // 주문건수(distinctOrderCount)로 맞춘다 — 라인수(totalOrders)로 나누면 셀러 기여도가 축소돼 보인다.
    const orderCount = Number(camp.distinctOrderCount) || Number(camp.totalOrders) || 0;
    const link = (Array.isArray(i.inflow) ? i.inflow : []).find(
      (r: AnyCampaign) => r.path === '마케팅링크'
    );
    const linkOrders = link ? Number(link.orders) || 0 : 0;
    const deviceTotal =
      (Number(i.device?.mobile) || 0) + (Number(i.device?.pc) || 0) + (Number(i.device?.unknown) || 0);
    insights = {
      linkOrders,
      linkRatio: orderCount > 0 ? (linkOrders / orderCount) * 100 : 0,
      hourly: (Array.isArray(i.hourly) ? i.hourly : []).map((h: AnyCampaign) => ({
        hour: Number(h.hour) || 0,
        orders: Number(h.orders) || 0,
      })),
      mobileRatio: deviceTotal > 0 ? ((Number(i.device?.mobile) || 0) / deviceTotal) * 100 : 0,
    };
  }

  return {
    id: String(camp.id),
    name: String(camp.name || ''),
    // 셀러에게 보이는 판매기간은 **집계 창(periodLabel)** 이어야 한다 — 이 화면은 기간 문구·D-day를
    // 매출 수치 바로 옆에 찍는데, 원시 salePeriod(스토어 관측값)를 쓰면 매출은 새 창으로 늘었는데 기간은
    // 옛날 그대로인 불일치가 셀러 눈앞에서 벌어진다(#170과 같은 계열, 셀러 대면이라 더 나쁘다).
    // periodLabel은 formatKstPeriodLabel이 만든 동일 포맷(`YYYY.MM.DD ~ YYYY.MM.DD` | `~ 계속`)이라
    // parseSalePeriodEndYmd/StartYmd의 D-day 파싱이 그대로 동작한다. 폴백은 미연결 캠페인용.
    salePeriod: String(camp.periodLabel || camp.salePeriod || ''),
    isActive: camp.isActive !== false,
    thumbnailUrl: camp.thumbnailUrl ? String(camp.thumbnailUrl) : null,
    totalOrders: Number(camp.totalOrders) || 0,
    // distinct 우선, 미백필 과거 마감 캠페인은 totalOrders(라인수)로 폴백 — order-dashboard 카드와 동일 규칙.
    distinctOrderCount: Number(camp.distinctOrderCount ?? camp.totalOrders) || 0,
    totalQuantity: Number(camp.totalQuantity) || 0,
    totalRevenue: Number(camp.totalRevenue) || 0,
    dailyStats,
    insights,
  };
}

/**
 * salePeriod 문자열에서 마감일(YYYY-MM-DD)을 뽑는다 — D-day 표기용(§3 실시간 리포트).
 * campaigns-handler가 포털에 넘기는 salePeriod는 `YYYY.MM.DD ~ YYYY.MM.DD`(또는 `~ 계속`)로
 * 정규화돼 있다(그 파일의 formatDt·campEnd 규약과 동일). 열린 기간(`계속`)·미등록·형식 불량은
 * null(=D-day 미표기). 마감일이 곧 셀러 화면 카운트다운의 정본이다.
 */
export function parseSalePeriodEndYmd(salePeriod: string): string | null {
  if (!salePeriod) return null;
  const parts = salePeriod.split('~').map((s) => s.trim());
  if (parts.length < 2) return null;
  const end = parts[1];
  if (!end || end === '계속') return null;
  const m = /^(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})$/.exec(end);
  if (!m) return null;
  const mm = m[2].padStart(2, '0');
  const dd = m[3].padStart(2, '0');
  return `${m[1]}-${mm}-${dd}`;
}

/**
 * salePeriod 문자열에서 시작일(YYYY-MM-DD)을 뽑는다 — 진행중/예정 분리·오픈 카운트다운용(§예정 섹션).
 * `YYYY.MM.DD ~ ...` 정규화 규약(campaigns-handler formatDt와 동일)의 앞부분(parts[0])을 파싱한다.
 * 미등록·기간 미정·형식 불량은 null(=시작일 판정 불가 → 진행중으로 폴백).
 */
export function parseSalePeriodStartYmd(salePeriod: string): string | null {
  if (!salePeriod) return null;
  const start = salePeriod.split('~')[0]?.trim();
  if (!start || start === '기간 미정' || start === '미등록') return null;
  const m = /^(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})$/.exec(start);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/**
 * 두 YYYY-MM-DD 사이의 달력일 차(to - from). 시간대 드리프트를 피하려고 UTC 자정 기준으로 뺀다.
 * 양수=아직 남음, 0=같은 날(=마감 당일), 음수=지남. 호출부는 KST '오늘' 키를 from으로 넘긴다.
 */
export function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const [ty, tm, td] = toYmd.split('-').map(Number);
  if ([fy, fm, fd, ty, tm, td].some((n) => !Number.isFinite(n))) return NaN;
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/**
 * YYYY-MM-DD의 KST 경계 절대시각(epoch ms). 라이브 카운트다운의 목표 시각으로 클라이언트에 넘긴다.
 * `open`=그 날 00:00:00 KST(오픈 순간), `close`=그 날 23:59:59.999 KST(마감 순간, campaigns-handler campEnd 규약과 동일).
 * KST 오프셋을 문자열에 고정하므로 서버 타임존과 무관하게 결정적이다. 형식 불량이면 NaN.
 */
export function saleBoundaryMs(ymd: string, edge: 'open' | 'close'): number {
  const time = edge === 'open' ? 'T00:00:00.000+09:00' : 'T23:59:59.999+09:00';
  return Date.parse(`${ymd}${time}`);
}

// 전체 누적 옵션 집계 (SalesReportModal의 overallOptions와 동일 로직의 서버판)
export function aggregateOptions(dailyStats: PortalDailyStat[]): (PortalOption & { ratio: number })[] {
  const map: Record<string, PortalOption> = {};
  let totalQuantity = 0;
  for (const d of dailyStats) {
    totalQuantity += d.quantity;
    for (const o of d.options) {
      const name = o.name.replace(/^제품:\s*/, '');
      if (!map[name]) {
        map[name] = { name, price: o.price, quantity: 0, revenue: 0 };
      } else if (!map[name].price && o.price) {
        map[name].price = o.price;
      }
      map[name].quantity += o.quantity;
      map[name].revenue += o.revenue;
    }
  }
  // 판매량 내림차순(동률 시 매출 내림차순) — Top-N을 잘라도 "잘 팔리는 순"이 되게.
  // 주의: seller-performance-card의 topOption은 자체적으로 quantity 재정렬하므로 이 순서와 무관.
  return Object.values(map)
    .map((o) => ({ ...o, ratio: totalQuantity > 0 ? (o.quantity / totalQuantity) * 100 : 0 }))
    .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue);
}
