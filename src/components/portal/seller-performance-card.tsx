// 셀러 성과 카드 본문 (F2, GROWTH_FLYWHEEL_PLAN.md §F2) — 캠페인 1건의 성과를
// 셀러가 캡처해 동료에게 공유하기 좋은 "자랑 소재" 한 장으로 렌더한다.
// 접근 경로 공용: /p/[token]/card/*(레거시) · /[slug]/card/*(전용 주소) 둘 다 이 컴포넌트를 쓴다.
// 인증은 각 진입점(page)이 끝낸 뒤 렌더 — 여기서는 하지 않는다.
// 데이터는 포털과 동일하게 toPortalCampaign 화이트리스트만 통과한다(내부 경제성·PII 차단).
// 콘텐츠 성과(내 게시물 ER·발행·베스트)는 이 셀러 "본인" SalesCampaign에 붙은 게시물만
// 조회한다 — 타 셀러 데이터는 구조적으로 제외(§0-1 "타 셀러 실적 노출금지" 준수).
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPrisma } from "@/lib/prisma";
import { fetchAndSyncCampaigns } from "@/app/order-converter/api/campaigns/campaigns-handler";
import {
  toPortalCampaign,
  selectSellerVisibleCampaigns,
  warnCrossSellerCampaigns,
  aggregateOptions,
  type PortalCampaign,
} from "@/lib/seller-portal";
import { computeCampaignPerformance } from "@/lib/campaign-performance-report";
import { postMetricsLine } from "./content-performance";
import { getCachedSellerRepurchase } from "@/lib/cached-portal-data";
import type { PortalSeller } from "./seller-portal-report";

function fmtWon(n: number): string {
  return `${n.toLocaleString()}원`;
}

// 시간대별 주문 최다 구간 — 전부 0이면 null
function peakHour(hourly: { hour: number; orders: number }[]): number | null {
  let best: { hour: number; orders: number } | null = null;
  for (const h of hourly) {
    if (h.orders > 0 && (!best || h.orders > best.orders)) best = h;
  }
  return best ? best.hour : null;
}

/** 성과 카드 본문 — basePath는 리포트 루트(예: "/p/<token>" 또는 "/<slug>") */
export async function SellerPerformanceCard({
  seller,
  campaignId,
  basePath,
}: {
  seller: PortalSeller;
  campaignId: string;
  basePath: string;
}) {
  const displayName = seller.alias || seller.name;

  const res = await fetchAndSyncCampaigns(false);
  const all = await res.json();
  // 이 셀러가 참여한 캠페인 중 요청 campaignId 매칭 — raw(원본)을 잡아 salesCampaigns.id에 접근한 뒤
  // 포털 화이트리스트로 직렬화한다(카드 본문 데이터는 여전히 toPortalCampaign만 통과).
  // 셀러 단일성 게이트는 리포트와 같은 SSOT(seller-portal.ts)를 쓴다 — 한 주문캠페인에 서로 다른
  // 셀러의 판매캠페인이 붙으면 이 카드의 매출·주문건수가 OC 단위 합산이라 타 셀러 실적이 섞인다.
  // 그런 건은 카드를 내주지 않고(notFound) 운영자 경고를 남긴다.
  const { visible, blocked } = selectSellerVisibleCampaigns(
    Array.isArray(all) ? all : [],
    seller.id,
  );
  warnCrossSellerCampaigns("card", blocked.filter((c: any) => String(c.id) === campaignId));
  const rawCamp = visible.find((c: any) => String(c.id) === campaignId);
  if (!rawCamp) notFound();
  const camp: PortalCampaign = toPortalCampaign(rawCamp);

  // 내 콘텐츠 성과 — 이 셀러 본인 SalesCampaign(들)에 등록된 게시물만(§0-1: 본인 데이터만).
  const sellerSalesCampaignIds: string[] = (rawCamp.salesCampaigns || [])
    .filter((sc: any) => sc.sellerId === seller.id)
    .map((sc: any) => String(sc.id));
  const postAssets =
    sellerSalesCampaignIds.length > 0
      ? await getPrisma().asset.findMany({
          where: {
            entityType: "CAMPAIGN",
            entityId: { in: sellerSalesCampaignIds },
            provider: "EXTERNAL_LINK",
            archivedAt: null,
            externalUrl: { not: null },
          },
          select: {
            id: true,
            fileName: true,
            externalUrl: true,
            thumbnailUrl: true,
            notes: true,
            likeCount: true,
            commentCount: true,
            likesHidden: true,
            mediaType: true,
          },
        })
      : [];
  const contentPerf = computeCampaignPerformance(postAssets, {
    followers: seller.currentFollowers,
    actualSales: camp.totalRevenue,
    itemCount: camp.totalQuantity,
    orderCount: camp.distinctOrderCount, // 객단가(AOV) = 매출 ÷ 주문건수(distinct)
  });
  const bestPost = contentPerf.posts[0] ?? null;

  const insights = camp.insights;
  const peak = insights ? peakHour(insights.hourly) : null;
  const soldDays = camp.dailyStats.filter((d) => d.orders > 0).length;
  const topOption = aggregateOptions(camp.dailyStats).sort((a, b) => b.quantity - a.quantity)[0];

  // 재구매 고객 = 이 셀러의 앞선 회차/다른 캠페인 구매이력자 비율(포털 본문과 동일 정의).
  // 첫 캠페인이면 정의가 성립하지 않아 셀을 숨긴다(캠페인 내 2회+ 구매와 혼동 금지).
  // 포털 본문과 동일한 셀러 단위 캐시(cached-portal-data)를 공유한다.
  const { returningByOrderCampaign } = await getCachedSellerRepurchase(seller.id);
  const returning = returningByOrderCampaign[campaignId];

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="max-w-sm mx-auto px-4 py-8">
        {/* 캡처 대상 카드 — 이 박스 안에 자랑 포인트를 밀도 있게 담는다 */}
        <div className="bg-white rounded-3xl border border-slate-200 shadow-soft-md overflow-hidden">
          <div className="px-6 pt-6 pb-4 bg-gradient-to-br from-slate-900 to-slate-700">
            <p className="text-[10px] font-bold tracking-widest text-slate-500 uppercase">
              WAG Performance Card
            </p>
            <h1 className="text-lg font-bold text-white mt-1.5 leading-snug">{camp.name}</h1>
            <p className="text-[11px] text-slate-300 mt-1">
              {displayName} {camp.salePeriod && <>· {camp.salePeriod}</>}
            </p>
          </div>

          <div className="px-6 py-5 border-b border-slate-100 text-center">
            <div className="text-[11px] font-bold text-slate-500 uppercase">누적 매출</div>
            <div className="text-3xl font-bold text-slate-900 mt-1">{fmtWon(camp.totalRevenue)}</div>
            <div className="text-xs text-slate-500 mt-1">
              주문 {camp.distinctOrderCount.toLocaleString()}건 · 수량 {camp.totalQuantity.toLocaleString()}개
              {soldDays > 0 && <> · {soldDays}일 판매</>}
            </div>
          </div>

          {/* 공유 카드 하이라이트 스탯 — 인디고→primary, PALETTE_IMPL_SPEC.md 2026-07-09 */}
          {insights && camp.totalOrders > 0 && (
            <div
              className={`grid ${returning ? "grid-cols-3" : "grid-cols-2"} divide-x divide-slate-100 border-b border-slate-100 bg-slate-50/50`}
            >
              <div className="px-3 py-4 text-center">
                <div className="text-lg font-bold text-primary">{insights.linkRatio.toFixed(0)}%</div>
                <div className="text-[10px] text-slate-500 mt-0.5 leading-tight">내 채널 유입</div>
              </div>
              {returning && (
                <div className="px-3 py-4 text-center">
                  <div className="text-lg font-bold text-primary">{returning.returningRatio.toFixed(0)}%</div>
                  <div className="text-[10px] text-slate-500 mt-0.5 leading-tight">재구매 고객</div>
                </div>
              )}
              <div className="px-3 py-4 text-center">
                <div className="text-lg font-bold text-primary">{peak != null ? `${peak}시` : "-"}</div>
                <div className="text-[10px] text-slate-500 mt-0.5 leading-tight">피크 시간대</div>
              </div>
            </div>
          )}

          {/* 내 콘텐츠 성과 — 등록된 셀러 게시물이 있을 때만. 본인 데이터만(§0-1). */}
          {contentPerf.postCount > 0 && (
            <div className="px-6 py-4 border-b border-slate-100">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] font-bold text-slate-500 uppercase shrink-0">
                  내 콘텐츠 성과
                </span>
                <span className="text-xs text-slate-500 text-right">
                  게시물 {contentPerf.postCount}건
                  {contentPerf.avgEr !== null && <> · 평균 ER {contentPerf.avgEr.toFixed(1)}%</>}
                </span>
              </div>
              {bestPost && (bestPost.likes !== null || bestPost.er !== null || bestPost.likesHidden || bestPost.comments !== null) && (
                <div className="mt-2.5 flex items-center gap-3">
                  {bestPost.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={bestPost.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-12 w-12 shrink-0 rounded-xl object-cover"
                    />
                  ) : null}
                  <div className="min-w-0">
                    {/* 라벨(숫자 아님) → info, PALETTE_IMPL_SPEC.md 인디고 분류 2026-07-09 */}
                    <div className="text-[10px] font-bold text-status-info uppercase">
                      베스트 게시물
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5">{postMetricsLine(bestPost)}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {topOption && (
            <div className="px-6 py-3.5 border-b border-slate-100 flex items-center justify-between gap-3">
              <span className="text-[11px] font-bold text-slate-500 shrink-0">베스트 구성</span>
              <span className="text-xs font-medium text-slate-700 truncate">
                {topOption.name} · {topOption.quantity.toLocaleString()}개
              </span>
            </div>
          )}

          <div className="px-6 py-4 text-center bg-slate-50/60">
            <p className="text-[11px] font-semibold text-slate-600">와이그라운드 공동구매</p>
            <p className="text-[10px] text-slate-500 mt-0.5">데이터로 함께 파는 파트너</p>
          </div>
        </div>

        {/* 카드 바깥 — 캡처에 안 담기는 안내 영역 */}
        <div className="mt-5 text-center space-y-3">
          <p className="text-[11px] text-slate-500">
            카드를 캡처해서 자유롭게 공유하세요.
          </p>
          <Link
            href={basePath}
            className="inline-block text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-full px-4 py-2 shadow-soft-sm"
          >
            ← 전체 캠페인 리포트로
          </Link>
        </div>
      </div>
    </div>
  );
}
