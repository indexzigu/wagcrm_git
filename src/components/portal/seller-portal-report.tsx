// 셀러 캠페인 리포트 본문 — 접근 경로와 무관한 공용 서버 컴포넌트.
// 두 진입점이 공유한다: /p/[token](레거시 토큰 링크) · /[slug](전용 주소 + 비밀번호 게이트).
// 인증·접근 자격 판정은 각 진입점(page)이 끝낸 뒤 이 컴포넌트를 렌더한다 — 여기서는 하지 않는다.
// 데이터는 반드시 toPortalCampaign 화이트리스트를 거친다(내부 경제성·운영 필드·PII 차단).
// 콘텐츠 성과(내 게시물 ER·발행·베스트)는 이 셀러 "본인" SalesCampaign 게시물만 조회한다
// — 타 셀러 데이터는 구조적으로 제외(§0-1 "타 셀러 실적 노출금지" 준수).
// 셀러는 카톡 링크로 폰에서 진입하므로 모바일 퍼스트 단일 컬럼.
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { getPrisma } from "@/lib/prisma";
import { fetchAndSyncCampaigns } from "@/app/order-converter/api/campaigns/campaigns-handler";
import {
  toPortalCampaign,
  selectSellerVisibleCampaigns,
  warnCrossSellerCampaigns,
  aggregateOptions,
  parseSalePeriodEndYmd,
  parseSalePeriodStartYmd,
  daysBetweenYmd,
  saleBoundaryMs,
  type PortalCampaign,
  type PortalDailyStat,
} from "@/lib/seller-portal";
import {
  computeCampaignPerformance,
  type CampaignPerformance,
} from "@/lib/campaign-performance-report";
import { ContentPerformanceSection } from "./content-performance";
import { CampaignCountdown } from "./campaign-countdown";
import type { EventReturningBuyers } from "@/lib/cross-campaign-repurchase";
import {
  getCachedSellerRepurchase,
} from "@/lib/cached-portal-data";

export type PortalSeller = {
  id: string;
  name: string;
  alias: string | null;
  currentFollowers: number;
};

function fmtWon(n: number): string {
  return `${n.toLocaleString()}원`;
}

function todayKstKey(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().split("T")[0];
}

function fmtSyncTime(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso);
  if (isNaN(t.getTime())) return "";
  const kst = new Date(t.getTime() + 9 * 60 * 60 * 1000);
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${mm}.${dd} ${hh}:${mi} 기준`;
}

// 마감/오픈 카운트다운 배지의 서버측 결정(§B+D 혼합). 근접도로 정적(무JS) vs 라이브(클라 island)를 가른다.
// 빨강은 오류 전용으로 예약 — 임박은 amber(마감)·blue(오픈)로만 알린다.
type TimingBadge =
  | { kind: "static"; label: string; className: string }
  | {
      kind: "live";
      targetMs: number;
      initialLabel: string;
      className: string;
      icon: "clock" | "flame";
      mode: "close" | "open";
    };

// 진행중 캠페인의 마감 카운트다운. 1~3일 라이브(amber), 당일 라이브+flame 강조.
// 열린 기간('계속')·형식불량은 null(미표기), 마감 지난 건은 정적 "판매 종료".
//
// ⛔ 4일 이상 남은 건에 정적 `D-N` 을 붙이지 말 것 (오너 지시 2026-08-26).
// "디데이가 필요한 곳에서는 쓰되 **판매 마감**에는 쓸 필요 없다"는 판단이고, 같은 날
// 모바일 상세 시트의 판매 마감 D-day 도 같은 기준으로 걷어냈다(formatDeadlineLabel 폐기).
// 남긴 것과 그 이유: ①1~3일·당일 **라이브 카운트다운**은 D-day 표기가 아니라 임박한
// 소수에만 켜지는 실시간 신호다(P8 「색은 주의가 필요한 소수에만」) ②"판매 종료"는
// 카운트다운이 아니라 상태 라벨이다 ③`openingBadge` 의 오픈 카운트다운은 마감이 아니라
// 시작 경계라 이 기준의 대상이 아니다.
function deadlineBadge(salePeriod: string, today: string): TimingBadge | null {
  const endYmd = parseSalePeriodEndYmd(salePeriod);
  if (!endYmd) return null;
  const days = daysBetweenYmd(today, endYmd);
  if (Number.isNaN(days)) return null;
  if (days < 0)
    return { kind: "static", label: "판매 종료", className: "bg-slate-100 text-slate-500 border-slate-200" };
  // 4일 이상 남았으면 아무것도 표기하지 않는다 — 위 ⛔ 참조.
  if (days > 3) return null;
  const targetMs = saleBoundaryMs(endYmd, "close");
  // initialLabel은 마운트 후 라이브 포맷과 같은 모양(하루 단위 접두 + --:--:--)으로 둔다 —
  // "D-2" → "2일 23:59:59"처럼 형태 자체가 바뀌면 폭이 튀는 플래시가 생긴다(ss-ux-designer 지적).
  if (days === 0)
    return { kind: "live", targetMs, initialLabel: "오늘 마감 --:--:--", className: "bg-amber-100 text-amber-800 border-amber-300", icon: "flame", mode: "close" };
  return { kind: "live", targetMs, initialLabel: `${days}일 --:--:--`, className: "bg-amber-50 text-amber-700 border-amber-200", icon: "clock", mode: "close" };
}

// 예정 캠페인의 오픈 카운트다운. 4일+ 정적 'D-N 오픈예정', 1~3일·당일 라이브(blue).
// 시작일이 이미 지났으면(진행중) null — 진행중 분기가 담당한다.
function openingBadge(salePeriod: string, today: string): TimingBadge | null {
  const startYmd = parseSalePeriodStartYmd(salePeriod);
  if (!startYmd) return null;
  const days = daysBetweenYmd(today, startYmd);
  if (Number.isNaN(days) || days < 0) return null;
  if (days > 3)
    return { kind: "static", label: `D-${days} 오픈예정`, className: "bg-slate-50 text-slate-500 border-slate-200" };
  const targetMs = saleBoundaryMs(startYmd, "open");
  const initialLabel = days === 0 ? "오픈까지 --:--:--" : `오픈까지 ${days}일 --:--:--`;
  return { kind: "live", targetMs, initialLabel, className: "bg-blue-50 text-blue-600 border-blue-200", icon: "clock", mode: "open" };
}

// 결정된 배지를 렌더 — 정적은 무JS span, 라이브는 클라이언트 카운트다운 island.
function TimingBadgeView({ badge }: { badge: TimingBadge }) {
  if (badge.kind === "static") {
    return (
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold border ${badge.className}`}
      >
        {badge.label}
      </span>
    );
  }
  return (
    <CampaignCountdown
      targetMs={badge.targetMs}
      initialLabel={badge.initialLabel}
      className={badge.className}
      icon={badge.icon}
      mode={badge.mode}
    />
  );
}

/** YYYY-MM-DD를 달력일수만큼 이동(UTC 자정 기준 — 시간대 드리프트 없음). 전일 키 산출용. */
function shiftYmd(ymd: string, deltaDays: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + deltaDays * 86_400_000;
  return new Date(t).toISOString().split("T")[0];
}

// 전일 대비 매출 증감(모멘텀, §3). 비교 대상 없으면 null. 감소는 빨강 대신 slate — 하루치 하락은
// 오류가 아니라 정상 변동이라 셀러를 놀래지 않는다(빨강은 오류 전용 예약).
function momentumMeta(
  todayRevenue: number,
  yesterdayStat: PortalDailyStat | undefined,
): { label: string; className: string } | null {
  if (!yesterdayStat) return null; // 첫날 등 비교 대상 없음
  const yesterdayRevenue = yesterdayStat.revenue;
  if (yesterdayRevenue === 0) {
    if (todayRevenue === 0) return null; // 0→0, 비교 무의미
    return { label: "신규", className: "text-emerald-600" };
  }
  const pct = Math.round(((todayRevenue - yesterdayRevenue) / yesterdayRevenue) * 100);
  if (pct === 0) return { label: "보합", className: "text-slate-500" };
  if (pct > 0) return { label: `▲ ${pct}%`, className: "text-emerald-600" };
  return { label: `▼ ${Math.abs(pct)}%`, className: "text-slate-500" };
}

function HourlyChart({ hourly }: { hourly: { hour: number; orders: number }[] }) {
  const max = Math.max(1, ...hourly.map((h) => h.orders));
  return (
    <div className="flex items-end gap-[3px] h-24">
      {hourly.map((h) => (
        <div key={h.hour} className="flex-1 h-full flex flex-col items-center justify-end gap-1">
          <div
            className={`w-full rounded-t ${h.orders > 0 ? "bg-blue-400" : "bg-slate-100"}`}
            style={{ height: `${Math.max(h.orders > 0 ? 4 : 2, Math.round((h.orders / max) * 72))}px` }}
          ></div>
          <span className="text-[9px] text-slate-500 leading-none">{h.hour % 6 === 0 ? h.hour : ""}</span>
        </div>
      ))}
    </div>
  );
}

// 구성(옵션)별 판매 한 행 — Top-5 상시 노출과 접힌 나머지가 동일 마크업을 공유한다.
function OptionRow({ o }: { o: { name: string; quantity: number; revenue: number; ratio: number } }) {
  return (
    <div>
      <div className="flex justify-between items-baseline gap-2">
        <span className="text-xs font-medium text-slate-700 truncate">{o.name}</span>
        <span className="text-xs font-bold text-slate-800 shrink-0">
          {o.quantity.toLocaleString()}개 · {fmtWon(o.revenue)}
        </span>
      </div>
      <div className="mt-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${o.ratio}%` }}></div>
      </div>
    </div>
  );
}

function ActiveCampaignSection({
  camp,
  basePath,
  today,
  contentPerf,
  returning,
}: {
  camp: PortalCampaign;
  basePath: string;
  today: string;
  contentPerf?: CampaignPerformance;
  returning?: EventReturningBuyers;
}) {
  const todayStat = camp.dailyStats.find((d) => d.date === today);
  const yesterdayStat = camp.dailyStats.find((d) => d.date === shiftYmd(today, -1));
  const momentum = momentumMeta(todayStat?.revenue || 0, yesterdayStat);
  const options = aggregateOptions(camp.dailyStats);
  // 일자별 매출 셀 배경 바 기준값 — 캠페인 내 최대 일매출(0이면 바 미표시).
  const maxDailyRevenue = Math.max(0, ...camp.dailyStats.map((d) => d.revenue));
  const insights = camp.insights;
  // 마감 카운트다운(§B+D) — 4일+ 정적, 임박·당일 라이브. 열린 기간·형식불량이면 null(미표기).
  const deadline = deadlineBadge(camp.salePeriod, today);

  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-soft-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-bold border border-emerald-200">
            판매중
          </span>
          <h2 className="font-bold text-slate-800 text-sm truncate">{camp.name}</h2>
          {/* F2 성과 카드 — 캡처·공유용 한 장 뷰 */}
          <Link
            href={`${basePath}/card/${camp.id}`}
            className="ml-auto shrink-0 text-[10px] font-bold text-blue-500"
          >
            성과 카드 →
          </Link>
        </div>
        {camp.salePeriod && (
          <div className="flex items-center gap-1.5 mt-1">
            <p className="text-[11px] text-slate-500">{camp.salePeriod}</p>
            {deadline && <TimingBadgeView badge={deadline} />}
          </div>
        )}
      </div>

      {/* 헤드라인: 누적 + 오늘 */}
      <div className="grid grid-cols-2 divide-x divide-slate-100 border-b border-slate-100">
        <div className="px-5 py-4">
          <div className="text-[11px] font-bold text-slate-500 uppercase">누적 매출</div>
          <div className="text-xl font-bold text-slate-900 mt-0.5">{fmtWon(camp.totalRevenue)}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            주문 {camp.distinctOrderCount.toLocaleString()}건 · 수량 {camp.totalQuantity.toLocaleString()}개
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="text-[11px] font-bold text-blue-500 uppercase">오늘 매출</div>
          <div className="flex items-baseline gap-1.5 mt-0.5">
            <div className="text-xl font-bold text-blue-600">{fmtWon(todayStat?.revenue || 0)}</div>
            {momentum && (
              <span
                className={`text-[10px] font-bold ${momentum.className}`}
                aria-label={`전일 대비 ${momentum.label}`}
              >
                {momentum.label}
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            주문 {(todayStat?.orders || 0).toLocaleString()}건 · 수량 {(todayStat?.quantity || 0).toLocaleString()}개
          </div>
        </div>
      </div>

      {/* 강조 스탯: 링크 유입 · 재구매 고객 · 모바일 (인디고→primary, PALETTE_IMPL_SPEC.md 2026-07-09)
          재구매 고객 = 이 셀러의 앞선 회차/다른 캠페인 구매이력자 비율(cross-campaign-repurchase).
          첫 캠페인(앞선 회차 없음)이면 정의가 성립하지 않아 셀 자체를 숨긴다. */}
      {insights && camp.totalOrders > 0 && (
        <div
          className={`grid ${returning ? "grid-cols-3" : "grid-cols-2"} divide-x divide-slate-100 border-b border-slate-100 bg-slate-50/50`}
        >
          <div className="px-4 py-3 text-center">
            <div className="text-base font-bold text-primary">{insights.linkRatio.toFixed(0)}%</div>
            <div className="text-[10px] text-slate-500 mt-0.5">링크 유입 주문</div>
          </div>
          {returning && (
            <div className="px-4 py-3 text-center">
              <div className="text-base font-bold text-primary">{returning.returningRatio.toFixed(0)}%</div>
              <div className="text-[10px] text-slate-500 mt-0.5">재구매 고객</div>
            </div>
          )}
          <div className="px-4 py-3 text-center">
            <div className="text-base font-bold text-primary">{insights.mobileRatio.toFixed(0)}%</div>
            <div className="text-[10px] text-slate-500 mt-0.5">모바일 주문</div>
          </div>
        </div>
      )}

      {/* 내 콘텐츠 성과 — 캠페인 기간 수집 게시물 "전체" 리스트(좋아요·댓글·숨김=비공개 표기).
          등록된 셀러 게시물이 있을 때만. 본인 데이터만(§0-1). */}
      {contentPerf && contentPerf.postCount > 0 && (
        <ContentPerformanceSection contentPerf={contentPerf} />
      )}

      {/* 시간대별 주문 */}
      {insights && camp.totalOrders > 0 && (
        <div className="px-5 pt-4 pb-2 border-b border-slate-100">
          <h3 className="text-xs font-bold text-slate-500 mb-3">시간대별 주문</h3>
          <HourlyChart hourly={insights.hourly} />
        </div>
      )}

      {/* 구성(옵션)별 판매 — 판매량순. Top-5 상시 노출, 나머지는 네이티브 <details>로 접기(무JS). */}
      {options.length > 0 && (
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-xs font-bold text-slate-500 mb-3">구성별 판매</h3>
          <div className="space-y-2.5">
            {options.slice(0, 5).map((o) => (
              <OptionRow key={o.name} o={o} />
            ))}
          </div>
          {options.length > 5 && (
            <details className="group mt-2.5">
              <summary className="list-none [&::-webkit-details-marker]:hidden marker:hidden flex items-center justify-between gap-1.5 cursor-pointer -mx-1 px-1 py-1.5 rounded-md text-[11px] font-semibold text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors">
                <span>나머지 {options.length - 5}종 보기</span>
                <span className="flex items-center gap-1 text-slate-500">
                  합계 {options.slice(5).reduce((s, o) => s + o.quantity, 0).toLocaleString()}개 ·{" "}
                  {fmtWon(options.slice(5).reduce((s, o) => s + o.revenue, 0))}
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180" />
                </span>
              </summary>
              <div className="mt-2 pt-2 border-t border-slate-50 space-y-2.5">
                {options.slice(5).map((o) => (
                  <OptionRow key={o.name} o={o} />
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      {/* 일자별 현황 */}
      {camp.dailyStats.length > 0 && (
        <div className="px-5 py-4">
          <h3 className="text-xs font-bold text-slate-500 mb-2">일자별 현황</h3>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-slate-100">
                <th className="text-left py-1.5 font-medium">날짜</th>
                <th className="text-right py-1.5 font-medium">주문</th>
                <th className="text-right py-1.5 font-medium">수량</th>
                <th className="text-right py-1.5 font-medium">매출</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {camp.dailyStats.map((d) => (
                <tr key={d.date}>
                  <td className="py-1.5 text-slate-600">{d.date.slice(5).replace("-", ".")}</td>
                  <td className="py-1.5 text-right text-slate-600">{d.orders.toLocaleString()}</td>
                  <td className="py-1.5 text-right text-slate-600">{d.quantity.toLocaleString()}</td>
                  {/* 매출 셀: 정확한 숫자는 그대로 읽히고, 배경 바로 매출 흐름이 눈에 보이게(무JS) */}
                  <td className="relative py-1.5 text-right font-bold text-slate-800">
                    {maxDailyRevenue > 0 && (
                      <div
                        aria-hidden="true"
                        className="absolute inset-y-0.5 right-0 bg-blue-500/10 rounded-l-sm"
                        style={{ width: `${(d.revenue / maxDailyRevenue) * 100}%` }}
                      ></div>
                    )}
                    <span className="relative">{fmtWon(d.revenue)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// 예정(오픈 전) 캠페인 — 매출 데이터가 아직 없으므로 진행중 카드처럼 무겁게 그리지 않고
// 이름 + 오픈까지 카운트다운만 담은 가벼운 카드. 시작일이 미래인(아직 안 열린) 캠페인만 여기로 온다.
// 진행중 카드(흰 배경+shadow)보다 한 단계 낮은 무게(연한 배경, 그림자 없음)로 위계를 눈에 보이게
// 낸다 — 헤더 라벨만으로는 부족하다는 지적(ss-ux-designer) 반영.
// 상태 배지도 blue가 아니라 slate로 — 오픈 임박(≤3일) 시 라이브 카운트다운이 blue를 쓰므로,
// 상태 배지까지 blue면 두 파란 알약이 붙어 흐려 보인다(같은 지적). blue는 카운트다운 전용으로 예약.
function UpcomingCampaignSection({ camp, today }: { camp: PortalCampaign; today: string }) {
  const opening = openingBadge(camp.salePeriod, today);
  return (
    <section className="bg-slate-50/60 rounded-2xl border border-slate-200/70 px-5 py-4">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[11px] font-bold border border-slate-200">
          예정
        </span>
        <h2 className="font-bold text-slate-700 text-sm truncate">{camp.name}</h2>
        {opening && (
          <span className="ml-auto shrink-0">
            <TimingBadgeView badge={opening} />
          </span>
        )}
      </div>
      {camp.salePeriod && (
        <p className="text-[11px] text-slate-500 mt-1">{camp.salePeriod} 오픈 예정</p>
      )}
    </section>
  );
}

/** 캠페인 리포트 본문 — basePath는 진입 경로 루트(예: "/p/<token>" 또는 "/<slug>") */
export async function SellerPortalReport({
  seller,
  basePath,
}: {
  seller: PortalSeller;
  basePath: string;
}) {
  // 셀러 별칭 우선 표기 (P2 Seller Alias Priority)
  const displayName = seller.alias || seller.name;

  const res = await fetchAndSyncCampaigns(false);
  const lastSync = res.headers.get("X-Naver-Last-Sync");
  const all = await res.json();
  // "내 캠페인" 선별 + 셀러 단일성 게이트(seller-portal.ts SSOT). 한 주문캠페인에 서로 다른
  // 셀러의 판매캠페인이 붙어 있으면 집계가 OrderCampaign 단위라 A+B 합산이 A 화면에 흘러든다
  // — 그런 건은 렌더에서 빼고 운영자 경고를 남긴다(조용히 숨기지 않는다).
  const { visible: mineRaw, blocked: crossSellerRaw } = selectSellerVisibleCampaigns(
    Array.isArray(all) ? all : [],
    seller.id,
  );
  warnCrossSellerCampaigns("report", crossSellerRaw);
  const mine: PortalCampaign[] = mineRaw.map((c: any) => toPortalCampaign(c));

  const active = mine.filter((c) => c.isActive);
  const today = todayKstKey();
  // 활성 캠페인을 시작일 기준으로 진행중(이미 오픈) vs 예정(오픈 전)으로 나눈다(§예정 섹션).
  // 시작일이 없거나 형식불량이면 판정 불가 → 진행중으로 폴백(안전). 지금은 오픈 전인데 "판매중"으로
  // 잘못 뜨던 것도 이 분리로 교정된다.
  const upcoming = active.filter((c) => {
    const s = parseSalePeriodStartYmd(c.salePeriod);
    return !!s && s > today;
  });
  const upcomingIds = new Set(upcoming.map((c) => c.id));
  const inProgress = active.filter((c) => !upcomingIds.has(c.id));

  // 진행 중 캠페인별 "내 콘텐츠 성과" — 이 셀러 본인 SalesCampaign 게시물만(§0-1: 본인 데이터만).
  // 여러 캠페인 게시물을 1쿼리로 모아 SalesCampaign별로 나눈 뒤 캠페인별로 R6 코어로 집계한다.
  // 예정 캠페인은 아직 판매·게시물이 없어 대상에서 제외한다.
  const inProgressIds = new Set(inProgress.map((c) => c.id));
  const salesCampaignIdsByCampaign = new Map<string, string[]>();
  const allSalesCampaignIds: string[] = [];
  for (const c of mineRaw) {
    if (!inProgressIds.has(String(c.id))) continue;
    const ids: string[] = (c.salesCampaigns || [])
      .filter((sc: any) => sc.sellerId === seller.id)
      .map((sc: any) => String(sc.id));
    salesCampaignIdsByCampaign.set(String(c.id), ids);
    allSalesCampaignIds.push(...ids);
  }
  const postAssets =
    allSalesCampaignIds.length > 0
      ? await getPrisma().asset.findMany({
          where: {
            entityType: "CAMPAIGN",
            entityId: { in: allSalesCampaignIds },
            provider: "EXTERNAL_LINK",
            archivedAt: null,
            externalUrl: { not: null },
          },
          select: {
            id: true,
            entityId: true,
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
  const postsBySalesCampaign = new Map<string, typeof postAssets>();
  for (const a of postAssets) {
    const arr = postsBySalesCampaign.get(a.entityId) ?? [];
    arr.push(a);
    postsBySalesCampaign.set(a.entityId, arr);
  }
  const contentPerfByCampaign = new Map<string, CampaignPerformance>();
  for (const c of inProgress) {
    const scIds = salesCampaignIdsByCampaign.get(c.id) ?? [];
    const posts = scIds.flatMap((id) => postsBySalesCampaign.get(id) ?? []);
    contentPerfByCampaign.set(
      c.id,
      computeCampaignPerformance(posts, {
        followers: seller.currentFollowers,
        actualSales: c.totalRevenue,
        itemCount: c.totalQuantity,
        orderCount: c.distinctOrderCount, // 객단가(AOV) = 매출 ÷ 주문건수(distinct)
      }),
    );
  }

  // 회차간(크로스캠페인) 재구매 — 셀러 본인 데이터만(§0-1). 카운트만 노출, 구매자 식별정보·타셀러 비교 없음.
  // 게이트: 2회+ (캠페인 2개+ & 재구매자 1명+)일 때만 표기 — crossCampaignBuyers>=1이 캠페인 2개+를 함의.
  // returningByOrderCampaign은 진행 캠페인별 "재구매 고객"(앞선 회차 구매이력자) 비율 스탯에 쓴다.
  // 전 기간 스냅샷 파싱이 필요한 최중량 집계라 셀러 단위로 캐시한다(cached-portal-data).
  const { crossCampaignBuyers, returningByOrderCampaign } =
    await getCachedSellerRepurchase(seller.id);

  return (
    // 이 화면은 shadcn 사이드바 래퍼(display:flex) 안의 flex 아이템이다(flex:0 1 auto).
    // 그대로 두면 flex 라인을 채우지 않고 "콘텐츠 폭에 shrink-wrap" 되어, 아코디언을 열어
    // 콘텐츠(옵션명 등)가 길어지면 그만큼 이 컨테이너와 안쪽 카드가 좌우로 흔들린다.
    // flex-1로 라인 전체를 채워(폭이 콘텐츠와 무관하게 고정) 안쪽 max-w-lg 카드를 항상
    // 같은 폭으로 중앙 정렬한다. min-w-0은 좁은 화면에서 라인보다 넓은 콘텐츠를 shrink 허용(오버플로 방지).
    <div className="min-h-screen w-full flex-1 min-w-0 bg-slate-50">
      <div className="max-w-lg mx-auto px-4 py-8">
        <header className="mb-6">
          <p className="text-[11px] font-bold tracking-widest text-slate-500 uppercase">WAG Campaign Report</p>
          <h1 className="text-xl font-bold text-slate-900 mt-1">{displayName}님의 캠페인 리포트</h1>
          {lastSync && <p className="text-[11px] text-slate-500 mt-1">집계 {fmtSyncTime(lastSync)}</p>}
        </header>

        {inProgress.length === 0 && upcoming.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500">
            현재 공유 중인 캠페인 리포트가 없습니다.
          </div>
        ) : (
          <div className="space-y-5">
            {inProgress.map((c) => (
              <ActiveCampaignSection
                key={c.id}
                camp={c}
                basePath={basePath}
                today={today}
                contentPerf={contentPerfByCampaign.get(c.id)}
                returning={returningByOrderCampaign[c.id]}
              />
            ))}

            {/* 예정 캠페인 — 오픈 전(시작일 미래) 캠페인을 진행중 아래에 가볍게 노출(오픈까지 카운트다운). */}
            {upcoming.length > 0 && (
              <div className="space-y-2.5">
                {/* 다른 섹션 제목과 같은 타이포 위계(text-xs font-bold text-slate-500, 비-uppercase) —
                    이전엔 페이지 eyebrow 라벨 스타일을 빌려와 파일 내 제목 관례와 어긋났다(ss-ux-designer 지적). */}
                <h2 className="text-xs font-bold text-slate-500 px-1">예정 · 곧 오픈하는 캠페인</h2>
                {upcoming.map((c) => (
                  <UpcomingCampaignSection key={c.id} camp={c} today={today} />
                ))}
              </div>
            )}

            {/* 단골 고객 — 회차간 재구매(§0-1: 본인 카운트만). crossCampaignBuyers>=1일 때만. */}
            {crossCampaignBuyers >= 1 && (
              <section className="bg-white rounded-2xl border border-slate-200 shadow-soft-sm overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-100">
                  <h2 className="text-xs font-bold text-slate-500">단골 고객</h2>
                </div>
                <div className="px-5 py-4">
                  <div className="text-xl font-bold text-indigo-600">{crossCampaignBuyers.toLocaleString()}명</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">여러 캠페인에서 다시 찾아주신 단골 고객이에요</div>
                  <div className="text-[10px] text-slate-500 mt-1">네이버스토어 주문 기준</div>
                </div>
              </section>
            )}

          </div>
        )}

        <footer className="mt-8 text-center text-[10px] text-slate-300">
          본 리포트는 와이그라운드가 제공하는 판매 현황 자료입니다.
        </footer>
      </div>
    </div>
  );
}
