// T3 전체 분석 리포트 (이식 스펙 §7) — 셀러 상세 시트(T2)의 딥다이브 확장.
// 저장된 SellerAiProfile만 렌더(추가 API 호출 없음 — 스냅샷 서빙, 스펙 §8). RSC + loading.tsx 바운더리.
// 원칙: 오디언스/도달 추정류 없음(측정 불가 명시), 신선도 라벨 필수, 썸네일은 인스타 CDN URL 참조(재호스팅 안 함).
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, AtSign, EyeOff, Loader2, Repeat, TrendingUp } from "lucide-react";
import { getPrisma } from "@/lib/prisma";
import { deriveSellerAiView } from "@/lib/seller-analysis/adapter";
import { estimateActiveFollowers, normalizeMetrics } from "@/lib/seller-analysis/scores";
import { PostPreviewCard } from "@/components/crm/post-preview-card";
import { ScoreCard } from "@/components/crm/seller-analysis/ScoreCard";
import { CategoryProfile } from "@/components/crm/seller-analysis/CategoryProfile";
import { CommentIntent, readCommentAnalysis } from "@/components/crm/seller-analysis/CommentIntent";
import { PrintReportButton } from "@/components/crm/seller-analysis/PrintReportButton";
import type { SellerCrossCampaignRepurchase } from "@/lib/cross-campaign-repurchase";
import { getCachedSellerRepurchase } from "@/lib/cached-portal-data";
import {
  summarizeSellerSalesPerformance,
  type SellerSalesPerformance,
} from "@/lib/seller-sales-performance";

// 동적 세그먼트 [id] 채택: 루트 레이아웃 체인(MobileBottomNav·PersistentSidebarLayout)이 <Suspense>로
// 감싸지면서 cacheComponents 셸 프리렌더가 통과한다(layout.tsx 참고). 과거 정적경로+쿼리(?id=) 우회는
// 이 레이아웃 수술로 해소되어 원래 의도한 동적 라우트로 복귀함.
type Params = { params: Promise<{ id: string }> };

function pct(v: number | null, digits = 2): string {
  return v === null ? "-" : `${(v * 100).toFixed(digits)}%`;
}

function relDays(iso: string | null, nowMs: number): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "-";
  const d = Math.floor((nowMs - t) / 86_400_000);
  if (d <= 0) return "오늘";
  if (d < 30) return `${d}일 전`;
  if (d < 365) return `${Math.floor(d / 30)}개월 전`;
  return `${Math.floor(d / 365)}년 전`;
}

// PALETTE_IMPL_SPEC.md (오너 승인, 2026-07-09): 비추천 배지를 status-urgent 토큰으로
// 통일(rose-50/rose-700 하드코딩 제거). border는 스펙에 지정된 토큰이 없어 rose-200
// 유지 — 추천/보류/미진행은 이번 스펙의 대상(orange/emerald/rose)이 아니라 그대로 둠.
// 평가 배지 — StatusBadge 스킴(P8 가드레일 2 정본)과 같은 토큰 짝. D2 곁다리, 오너 승인 2026-07-16.
//
// 이건 **반쪽 마이그레이션을 끝내는 것**이다: 비추천만 이미 토큰(`var(--status-urgent-*)`)이고 나머지는
// 리터럴이었다 — 그 결과 같은 "비추천" 배지가 목록(rose-700 #BE123C 크림슨)과 상세(#8F3C3C 벽돌)로
// **prod 에서 이미 갈라져 있었다**(border-rose-200 이 리터럴로 남은 게 중단된 마이그레이션의 흔적).
// 목록(`sellers-management.tsx`)을 같은 토큰으로 맞추면서 여기도 마저 옮긴다.
// 추천·보류는 hex 가 같아 픽셀 변화 0. 미진행은 그대로 — "판단 불가"는 의미축의 값이 아니다.
const FIT_BADGE: Record<string, string> = {
  추천: "bg-status-success-bg text-status-success border-transparent",
  보류: "bg-status-caution-bg text-status-caution border-transparent",
  비추천: "bg-status-urgent-bg text-status-urgent-text border-transparent",
  미진행: "bg-slate-100 text-slate-500 border-slate-200",
};

// 판매 충성도 카드 — aiProfile 유무와 무관하게 재사용(early-return 화면·본문 양쪽). 회차간 재구매(네이버스토어 기준).
function SalesLoyaltyCard({ xc }: { xc: SellerCrossCampaignRepurchase }) {
  return (
    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-3">
      <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
        <Repeat className="w-5 h-5 text-slate-400" />
        <div className="text-[10px] text-slate-500 uppercase tracking-wider">판매 충성도</div>
      </div>
      {xc.eligibleEvents < 2 ? (
        <div className="text-[11px] text-slate-500 text-center py-2">
          회차 2개 이상부터 집계됩니다 (현재 {xc.eligibleEvents}개)
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="text-2xl font-bold text-slate-900 tabular-nums leading-tight">
            {xc.crossCampaignBuyers.toLocaleString()}
            <span className="text-xs font-normal text-slate-500 ml-1">명</span>
          </div>
          <div className="text-[10px] text-slate-500">
            전체 구매자 {xc.totalBuyers.toLocaleString()}명 · 회차간 재구매 {xc.crossCampaignRatio.toFixed(1)}% · 진행 회차 {xc.eventsWithOrders}개
          </div>
          <div className="flex items-start gap-1.5 text-[10px] text-slate-500 border-t border-slate-100 pt-3">
            <EyeOff className="size-3 mt-0.5 shrink-0" />
            <span>네이버스토어 주문 기준 하한값(타 채널 미포함) · 스냅샷이 쌓일수록 정확해집니다.</span>
          </div>
        </div>
      )}
    </div>
  );
}

// 실판매 성과 카드 — AI 점수(대리 지표) 옆에 CRM 실측(캠페인 실매출)을 병기한다(오너 승인 2026-08-08).
// 판정은 seller-sales-performance SSOT(그룹=1건 접기, 평균 분모=매출 확인 캠페인). 값은 판정·방향
// 축이 아니므로 무채색(P8 색 5축 밖), 초점 숫자는 캠페인당 평균 = "부르면 얼마 파는가".
function SalesPerformanceCard({ perf }: { perf: SellerSalesPerformance }) {
  const avgManwon =
    perf.avgSalesPerCampaign === null ? null : Math.round(perf.avgSalesPerCampaign / 10_000);
  return (
    <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-3">
      <div className="flex items-center gap-3 border-b border-slate-100 pb-3">
        <TrendingUp className="w-5 h-5 text-slate-400" />
        <div className="text-[10px] text-slate-500 uppercase tracking-wider">실판매 성과</div>
      </div>
      {perf.effectiveCount === 0 ? (
        <div className="text-[11px] text-slate-500 text-center py-2">진행한 캠페인이 없습니다</div>
      ) : perf.avgSalesPerCampaign === null ? (
        <div className="text-[11px] text-slate-500 text-center py-2">
          캠페인 {perf.effectiveCount}건 진행, 실매출 입력 전입니다
        </div>
      ) : (
        <div className="space-y-2.5">
          <div>
            {/* 분모를 라벨에 직접 명시한다(ss-ux P2) — 평균의 분모는 유효 캠페인 전체가 아니라
                실매출이 확인된 캠페인이다(매출 미입력을 0으로 평균 내지 않는 계약의 표시면). */}
            <div className="text-[10px] text-slate-500">
              캠페인당 평균 매출 (매출 확인 {perf.effectiveWithSales}건 기준)
            </div>
            <div className="text-2xl font-bold text-slate-900 tabular-nums leading-tight">
              {avgManwon!.toLocaleString()}
              <span className="text-xs font-normal text-slate-500 ml-1">만원</span>
            </div>
          </div>
          <div className="text-[10px] text-slate-500 tabular-nums">
            누적 실매출 {Math.round(perf.totalSales / 10_000).toLocaleString()}만원 · 유효 캠페인{" "}
            {perf.effectiveCount}건
          </div>
          <div className="flex items-start gap-1.5 text-[10px] text-slate-500 border-t border-slate-100 pt-3">
            <EyeOff className="size-3 mt-0.5 shrink-0" />
            <span>판매관리 실매출 기준. AI 점수는 SNS 반응 추정치이니 이 실측과 함께 판단하세요.</span>
          </div>
        </div>
      )}
    </div>
  );
}

// cacheComponents(Next 16) 규칙: 루트는 정적 셸만 — 동적 IO(params·prisma)는 Suspense 자식에서 수행
export default function SellerAnalysisReportPage({ params }: Params) {
  return (
    <Suspense
      fallback={
        <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          분석 리포트 불러오는 중…
        </div>
      }
    >
      <SellerAnalysisReport params={params} />
    </Suspense>
  );
}

async function SellerAnalysisReport({ params }: Params) {
  const { id } = await params;
  if (!id) notFound();
  const prisma = getPrisma();

  const seller = await prisma.seller.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      alias: true,
      snsHandle: true,
      snsType: true,
      currentFollowers: true,
      category: true,
      fitLevel: true,
      profilePicUrl: true,
    },
  });
  if (!seller) notFound();

  // 아래 3개는 서로 독립(전부 id 만 필요)이라 병렬로 받는다 — 순차 await 는 매 렌더 왕복을 누적시킨다.
  // - aiProfile: 분석 스냅샷
  // - xc: 판매 충성도(회차간 재구매, 네이버 주문 소스) — aiProfile 유무와 무관하게 노출해야 하므로
  //   early-return 위에서 계산한다. 전 기간 스냅샷 파싱 집계라 셀러 단위 use cache 공유(cached-portal-data).
  // - salesRows: 실판매 성과(CRM 실측) — select 2컬럼뿐인 경량 조회(블롭·스냅샷 미접촉).
  const [aiProfile, xc, salesRows] = await Promise.all([
    prisma.sellerAiProfile
      .findUnique({
        where: { sellerId: id },
        select: { aiTags: true, compositeScore: true, confidence: true, sourceTier: true, analyzedAt: true },
      })
      .catch(() => null),
    getCachedSellerRepurchase(id),
    prisma.salesCampaign.findMany({
      where: { sellerId: id },
      select: { actualSales: true, groupId: true },
    }),
  ]);

  // 요청당 1회 서버 렌더되는 async RSC라 Date.now()가 이 렌더 내에서 결정적이다
  // (클라이언트 재렌더 없음 — react-hooks/purity가 RSC를 구분 못 하는 false positive).
  // 상대 시각 라벨(relDays)용.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const displayName = seller.alias || seller.name;
  const perf = summarizeSellerSalesPerformance(salesRows);

  if (!aiProfile) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-8">
        <Link href="/sellers" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800">
          <ArrowLeft className="size-3.5" /> 셀러 목록
        </Link>
        <div className="mt-10 flex flex-col items-center gap-2 text-center">
          <div className="text-sm font-medium text-foreground">{displayName}: 아직 AI 분석 전입니다</div>
          <div className="text-xs text-muted-foreground">셀러 목록에서 상세를 열고 "분석 시작"을 실행하면 리포트가 생성됩니다.</div>
        </div>
        {(perf.effectiveCount > 0 || xc.eligibleEvents >= 2) && (
          // 카드 1장만 노출될 때 2열 트랙을 유지하면 왼쪽 절반에만 그려진다(ss-ux P1) —
          // 단일 카드는 종전처럼 좁은 중앙 정렬로 폴백한다.
          <div
            className={
              perf.effectiveCount > 0 && xc.eligibleEvents >= 2
                ? "mt-8 max-w-2xl mx-auto grid gap-3 sm:grid-cols-2"
                : "mt-8 max-w-sm mx-auto"
            }
          >
            {perf.effectiveCount > 0 && <SalesPerformanceCard perf={perf} />}
            {xc.eligibleEvents >= 2 && <SalesLoyaltyCard xc={xc} />}
          </div>
        )}
      </div>
    );
  }

  const view = deriveSellerAiView(aiProfile.aiTags);
  const m = normalizeMetrics(
    aiProfile.aiTags && typeof aiProfile.aiTags === "object"
      ? (aiProfile.aiTags as Record<string, unknown>).metrics
      : undefined
  );
  const commentAnalysis = readCommentAnalysis(aiProfile.aiTags);
  const analyzedRel = relDays(aiProfile.analyzedAt ? aiProfile.analyzedAt.toISOString() : null, nowMs);
  // 피드 표시 = 보존 정책과 정렬: 최신순 12장(재호스팅 캡 REHOST_MAX와 동일). 지표는 전체 postsPreview 기반이라 무영향.
  const posts = [...view.postsPreview]
    .sort((a, b) => (b.taken_at ? Date.parse(b.taken_at) : 0) - (a.taken_at ? Date.parse(a.taken_at) : 0))
    .slice(0, 12);
  // 셀프 멘션 제외 — 신규 분석은 metrics 단계에서 걸러지지만, 필터 도입 전 저장 레코드 대응
  const brandMentions = m.brandMentions.filter(
    (b) => b.handle !== seller.snsHandle.toLowerCase()
  );
  // 실질 반응 팔로워 추정 (오너 2026-07-16) — ER 해석 메시지를 운영자 암산에 맡기지 않고
  // "그래서 실질 몇 명짜리 계정인가"를 같은 카드에 병기한다. 팔로워는 분석 시점 스냅샷
  // (profileMeta)을 우선하고(ER과 같은 시점), 구버전 레코드는 현재 팔로워로 폴백한다.
  const followersForEstimate =
    view.profileMeta?.followerCount ?? (seller.currentFollowers > 0 ? seller.currentFollowers : null);
  const activeFollowersEstimate = estimateActiveFollowers(followersForEstimate, m.engagement.er);

  return (
    <div data-print-root className="mx-auto max-w-4xl px-6 py-6 space-y-5">
      {/* 헤더 */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <Link href="/sellers" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800">
            <ArrowLeft className="size-3.5" /> 셀러 목록
          </Link>
          <PrintReportButton name={displayName} />
        </div>
        <div className="mt-3 flex items-center gap-3">
          {seller.profilePicUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={seller.profilePicUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="size-11 rounded-full object-cover bg-slate-100"
            />
          ) : (
            <div className="size-11 rounded-full bg-slate-100" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900 truncate">{displayName}</h1>
              {seller.fitLevel && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${FIT_BADGE[seller.fitLevel] ?? FIT_BADGE.미진행}`}>
                  {seller.fitLevel}
                </span>
              )}
            </div>
            <div className="text-xs text-slate-500 font-mono">
              @{seller.snsHandle} · 팔로워 {seller.currentFollowers.toLocaleString()}
              {seller.category ? ` · ${seller.category}` : ""}
            </div>
          </div>
          <div className="text-right text-[10px] text-slate-500 shrink-0">
            <div>{analyzedRel} 분석</div>
            {aiProfile.sourceTier && <div>{aiProfile.sourceTier}</div>}
          </div>
        </div>
      </div>

      {/* 리스크 플래그 */}
      {view.riskFlags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {view.riskFlags.map((f) => (
            <span
              key={f.key}
              title={f.reason}
              className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full border cursor-help ${
                f.severity === "danger" ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-amber-50 text-amber-700 border-amber-200"
              }`}
            >
              <AlertTriangle className="size-3" />
              {f.label} <span className="font-normal opacity-70">{f.reason}</span>
            </span>
          ))}
        </div>
      )}

      {/* KPI 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
          <div className="text-[10px] text-slate-500">인게이지먼트율</div>
          <div className="text-lg font-bold text-slate-900 tabular-nums">{pct(m.engagement.er)}</div>
          <div className="text-[10px] text-slate-500">중앙값 {pct(m.engagement.medianEr)}</div>
          {activeFollowersEstimate !== null && (
            <div
              className="text-[10px] text-slate-500 tabular-nums"
              title="ER을 팔로워 구간 벤치마크와 비교해 역산한 휴리스틱 추정: 반응하는 실질 팔로워 규모"
            >
              실질 반응 팔로워 ~{activeFollowersEstimate.toLocaleString()}명 (추정)
            </div>
          )}
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
          <div className="text-[10px] text-slate-500">댓글 반응률</div>
          <div className="text-lg font-bold text-slate-900 tabular-nums">{pct(m.engagement.commentToLikeRatio, 1)}</div>
          <div className="text-[10px] text-slate-500">평균 댓글/좋아요</div>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
          <div className="text-[10px] text-slate-500">광고 비중</div>
          <div className="text-lg font-bold text-slate-900 tabular-nums">
            {m.ads.adShare === null ? "-" : `${Math.round(m.ads.adShare * 100)}%`}
          </div>
          <div className="text-[10px] text-slate-500">{m.ads.adCount}건 / {m.dataSufficiency.postCount}개</div>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
          <div className="text-[10px] text-slate-500">공구 게시물</div>
          <div className="text-lg font-bold text-slate-900 tabular-nums">{m.gongu.gonguCount}건</div>
          <div className="text-[10px] text-slate-500">
            {m.gongu.gonguShare === null ? "표본 내" : `비중 ${(m.gongu.gonguShare * 100).toFixed(1)}%`}
          </div>
        </div>
      </div>

      {/* 실측 축 2종 — 실판매 성과(CRM 정산)와 판매 충성도(네이버 주문). SNS 추정 지표(위)와
          분리된 별도 섹션으로 나란히 놓아 "추정 vs 실측"을 한 시야에서 대조하게 한다. */}
      <div className="grid gap-3 md:grid-cols-2">
        <SalesPerformanceCard perf={perf} />
        <SalesLoyaltyCard xc={xc} />
      </div>

      {/* 점수·카테고리 */}
      <div className="grid md:grid-cols-2 gap-3 items-start">
        <ScoreCard scores={view.scores} />
        <div className="space-y-3">
          {view.affinities.length > 0 && <CategoryProfile affinities={view.affinities} />}
          {commentAnalysis && <CommentIntent analysis={commentAnalysis} />}
          {brandMentions.length > 0 && (
            <div className="p-4 bg-slate-50 rounded-lg border border-slate-200">
              <div className="flex items-center gap-2 border-b border-slate-100 pb-2.5 mb-2">
                <AtSign className="w-4 h-4 text-slate-400" />
                <span className="text-[11px] text-slate-600 font-medium">협업 브랜드 후보</span>
                <span className="text-[10px] text-slate-500">(광고글 @멘션 집계)</span>
              </div>
              <div className="space-y-1.5">
                {brandMentions.map((b) => (
                  <div key={b.handle} className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono text-slate-700 flex-1 truncate">@{b.handle}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700">{b.count}회</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 피드 프리뷰 (스펙 §8 — 스냅샷 서빙, 캡션 미표시) */}
      {posts.length > 0 && (
        <div>
          <div className="flex items-baseline gap-2 mb-2">
            <h2 className="text-[13px] font-semibold text-slate-900">피드 프리뷰</h2>
            <span className="text-[10px] text-slate-500">
              최근 {posts.length}개 보존 · {analyzedRel} 수집 스냅샷 기준
            </span>
          </div>
          <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
            {posts.map((p, i) => (
              <PostPreviewCard key={i} post={p} nowMs={nowMs} />
            ))}
          </div>
        </div>
      )}
      {posts.length === 0 && (
        <div className="text-[11px] text-slate-500 border border-dashed border-slate-200 rounded-lg p-4 text-center">
          피드 프리뷰 없음. 이 분석은 프리뷰 저장 이전 버전입니다. 재분석하면 채워집니다.
        </div>
      )}

      {/* 측정 한계 명시 (스펙 §3 — 거짓 정밀도 금지) */}
      <div className="flex items-start gap-1.5 text-[10px] text-slate-500 border-t border-slate-100 pt-3">
        <EyeOff className="size-3 mt-0.5 shrink-0" />
        <span>
          오디언스 연령·성별·진짜 도달·저장·공유는 계정 연동 없이 측정 불가. 이 리포트에 포함하지 않습니다. 표시 값은 공개
          게시물 스냅샷 기준이며 "추정" 표기 항목은 휴리스틱입니다. 산출물은 내부 판단용입니다.
        </span>
      </div>
    </div>
  );
}
