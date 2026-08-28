"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  resolveSellerScoreBand,
  SELLER_SCORE_BAND_TEXT,
  SELLER_SCORE_BAND_TEXT_UNSET,
} from "@/lib/seller-score-band";
import { useFilterParams } from "@/hooks/use-filter-params";
import { useSellers } from "@/hooks/useSellers";
import { PlusIcon, SearchIcon, Loader2, SparklesIcon, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataEmpty } from "@/components/ui/empty";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  type DashboardData,
  type SellerSummary,
} from "@/lib/crm-types";
import { CrmShell } from "./crm-shell";
import { DataSourceBanner } from "./data-source-banner";
import { InlineDataGrid, type GridColumn } from "./inline-data-grid";
import { SellersPanel } from "./sellers-panel";
import { SellerBulkCreateDialog } from "./seller-bulk-create-dialog";
import { ReferralNetworkDialog } from "./referral-network-dialog";
import { SegmentToggle } from "./segment-toggle";
import { FollowerBarCell } from "./follower-bar-cell";
import {
  computeDormancyTier,
  DORMANCY_TIER_LABEL,
  DORMANT_DAYS,
  EXCLUDE_DAYS,
} from "@/lib/seller-dormancy";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileSellersView } from "@/components/mobile/mobile-sellers-view";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { analysisStaleLabel } from "@/lib/seller-analysis/staleness";
import {
  campaignRecency,
  isRecentlyRegistered,
  NEW_SELLER_WINDOW_DAYS,
} from "@/lib/partner-seller-display";
import {
  type SellerSegment,
  filterSellersBySegment,
} from "@/lib/seller-segment";

type SellerRow = SellerSummary;

// 프로필/팔로워 수집 크론은 주 1회(월요일)라, 마지막 수집이 이 일수를 넘으면 "오래됨"으로 강조한다
// (재수집 후보 스캔용). 미수집(스냅샷 0건)은 최우선 후보로 별도 강조.
const STALE_SYNC_DAYS = 30;

// "AI 점수" 컬럼의 render가 컴포넌트 상태(진행 중 id)와 핸들러(분석 실행)에 접근해야 해서,
// 모듈 레벨 배열을 팩토리로 승격한다. 나머지 컬럼 render는 그대로 옮긴다.
type SellerColumnsContext = {
  onAnalyze: (id: string) => void;
  analyzingId: string | null;
};

type SellersManagementProps = {
  initialSellers: SellerRow[];
  dataSource?: DashboardData["dataSource"];
  dataSourceMessage?: string;
};

function buildSellerColumns(ctx: SellerColumnsContext): GridColumn<SellerRow>[] {
  return [
  {
    key: "name",
    label: "이름",
    width: 200,
    render: (row) => {
      const displayName = row.alias || row.name;
      const subName = row.alias ? ` (${row.name})` : "";
      const fullName = `${displayName}${subName}`;

      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-col justify-center py-0.5 leading-tight max-w-full cursor-help overflow-hidden">
                <div className="flex items-center gap-1.5 min-w-0 max-w-full">
                  {row.isMonitored && (
                    <span className="relative flex h-2 w-2 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                    </span>
                  )}
                  <span className="font-semibold text-slate-900 truncate block">{displayName}</span>
                  {/* 신규(등록 7일 이내) 마커 — 등록일 정렬 없이도 목록에서 바로 구분(오너 확정 2026-07-23).
                      브랜드 네이비 틴트라 상태 hue(성공/주의/경고) 축과 겹치지 않는다(P8 §1). */}
                  {isRecentlyRegistered(row.createdAt, Date.now()) && (
                    <span
                      title={`등록 ${NEW_SELLER_WINDOW_DAYS}일 이내`}
                      className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-semibold shrink-0"
                    >
                      신규
                    </span>
                  )}
                  {row.alias && (
                    <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded font-normal shrink-0 truncate max-w-[80px]">
                      {row.name}
                    </span>
                  )}
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" align="start">
              <p className="text-xs font-medium">{fullName}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    },
  },
  {
    key: "channelUrl",
    label: "채널",
    width: 160,
    render: (row) => {
      const targetUrl = row.channelUrl || (
        row.snsType === "YOUTUBE"
          ? (row.snsHandle.startsWith("UC") ? `https://www.youtube.com/channel/${row.snsHandle}` : `https://www.youtube.com/@${row.snsHandle}`)
          : row.snsType === "X"
          ? `https://x.com/${row.snsHandle}`
          : `https://www.instagram.com/${row.snsHandle}`
      );
      return (
        <a
          href={targetUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-blue-600 hover:underline font-mono overflow-hidden"
        >
          {row.snsType === "INSTAGRAM" ? (
            <InstagramIcon className="size-3.5 text-pink-500/70 shrink-0" />
          ) : row.snsType === "YOUTUBE" ? (
            <YoutubeIcon className="size-3.5 text-red-500/70 shrink-0" />
          ) : row.snsType === "X" ? (
            <span className="text-[10px] font-bold text-slate-800 border border-slate-300 px-1 rounded bg-slate-50 mr-0.5 select-none shrink-0">X</span>
          ) : null}
          <span className="truncate">@{row.snsHandle}</span>
        </a>
      );
    }
  },
  {
    key: "currentFollowers",
    label: "팔로워",
    width: 180,
    align: "center",
    render: (row) => <FollowerBarCell count={row.currentFollowers} />,
  },
  { key: "category", label: "카테고리", width: 100, align: "center" },
  {
    key: "campaignCount",
    label: "누적 캠페인",
    width: 112,
    align: "right",
    render: (row) => {
      const count = row.campaignCount ?? row.campaigns?.length ?? 0;
      // 이 컬럼의 판단 가치는 "거래 이력이 있는 셀러인가" + **재접촉 타이밍**이다(P2 Decision-Value,
      // 오너 확정 2026-07-16 2차: 색상 변경이 아니라 시각 설계 차원의 개선). 발굴 후보가
      // 다수라 0이 대부분 — 0은 저강도로 가라앉히고 이력 있는 소수만 또렷하게(무채색 위계).
      // ⚠️ 0을 대시(—)로 그리지 말 것(ss-ux P0, 2026-07-16): 대시는 이 앱에서 "값 모름"의
      // 확립된 관용구다(InlineDataGrid null 렌더·상세 "—"). 여기 0은 "확인된 0"이라 단어로
      // 말한다. slate-300도 금지 — 1.48:1로 데이터 텍스트 대비 미달(신뢰도 회수와 같은 논거).
      if (count === 0) {
        return (
          <span aria-label="거래 이력 없음" className="text-xs text-slate-500 tabular-nums">
            0회
          </span>
        );
      }
      // 서브라벨 = 최근성(진행 중 / 시작 예정 / N개월 전 종료) — 성장 전략이 재거래 플라이휠이라
      // "많이 했는데 오래 멈춘" 셀러가 재접촉 후보다. 표의 기존 2단 리듬(갱신일·AI점수) 재사용.
      // 판정 근거는 row의 캡 무관 서버 집계 신호(hasActiveCampaign 등, seller-summary.ts)가
      // 우선이고, row.campaigns(startDate desc 12건 캡)는 신호 부재 시 폴백이다.
      // 무채색 유지(ss-ux Q4): 이 행엔 이미 색 캐리어가 2개(평가 배지·점수 밴드) — 생애주기
      // hue를 세 번째로 얹으면 D2가 회수한 "행당 무지개"가 재발한다. 바/도트 시각화는 기각됐다
      // (ss-ux Q3: 같은 행 팔로워 바와 이중 바 경쟁 + 캠페인 수엔 자연 분모가 없음).
      const recency = campaignRecency(row.campaigns, Date.now(), row);
      // 그룹은 1건으로 센다(campaign-group-count.ts) — 딜 단위 행 수가 더 크면 "·N딜"로
      // 병기해 숫자 축소가 데이터 유실로 오독되지 않게 한다(오너 G3, 2026-07-30).
      const dealRows = row.campaignRowCount ?? 0;
      return (
        <span className="inline-flex flex-col items-end leading-tight">
          <span className="text-xs font-medium text-slate-700 tabular-nums">
            {count}회
            {dealRows > count && (
              // "N개 딜"은 mobile-campaign-card 그룹 배지의 확립 표기 — 축약형 "N딜"로 갈라지지 않는다.
              // 두 자릿수 조합("12회 · 15개 딜")을 위해 컬럼 폭 112(ss-ux P2).
              <span className="font-normal text-[10px] text-slate-500"> · {dealRows}개 딜</span>
            )}
          </span>
          {recency && <span className="text-[10px] text-slate-500">{recency.label}</span>}
        </span>
      );
    },
  },
  {
    key: "lastRunStartAt",
    label: "거래 리듬",
    width: 104,
    align: "center",
    render: (row) => {
      // F1 1단계 — 마지막 진행 이후 경과로 본 휴면 티어(D20: 건강<90 · 휴면90~180 · 제외180+).
      // 판정 SSOT는 `src/lib/seller-dormancy.ts`. 이 열은 **관찰 전용**이다 — 정렬·필터의
      // 기본 기준으로 쓰지 않고 `fitLevel`(옆 '평가' 열)과 합산하지도 않는다(D10).
      //
      // 왜 '평가'와 나란히 두 축으로 두나: 계정 신호(평가)와 거래 실적(이 열)이 실제로
      // 어긋난다는 것이 확인됐다(D10). 합치면 그 불일치가 숫자 하나 뒤로 숨는다.
      //
      // 색: **휴면만 유채색**이다. 이 행엔 이미 색 캐리어가 2개(평가 배지·AI 점수 밴드)라
      // 세 번째 hue를 상시로 얹으면 D2가 회수한 "행당 무지개"가 재발한다(ss-ux Q4).
      // 건강·제외는 무채색 — "볼 것 없음" 등급의 선언이지 랭크 부재가 아니다(P8 §2).
      // 재접촉 검토 대상은 휴면 구간뿐이라, 색이 뜨는 순간이 곧 "지금 봐야 할 셀러가
      // 생겼다"는 신호가 된다.
      if (row.runCount === undefined) {
        // 집계 실패(구 페이로드 포함) — "0회"로 그리면 거래 이력을 지워 보여주게 된다.
        return <span className="text-xs text-slate-500">—</span>;
      }
      const verdict = computeDormancyTier(row.lastRunStartAt ?? null);
      if (verdict.tier === "UNKNOWN") {
        // 과거 진행 0건은 '판정 불가'다 — 0일(=건강)로 취급하지 않는다. 대시는 이 앱에서
        // "값 모름"의 확립된 관용구인데, 여기 대시는 수치가 아니라 **판정 근거의 부재**를
        // 가리키므로 "0을 대시로 그리지 말 것"(옆 누적 캠페인 열) 규칙과 충돌하지 않는다.
        // ⚠️ 원인을 "이력 없음"으로 단정하지 않는다 — 미래 시작일뿐인 셀러도 여기로 온다.
        // 진행 횟수는 그래도 보여준다: 이미 아는 값이고, 다른 티어와 2단 레이아웃이 맞는다.
        return (
          <span className="inline-flex flex-col items-center leading-tight">
            <span
              aria-label="휴면 판정 불가"
              className="text-xs text-slate-500"
              title="판정에 필요한 과거 진행 기록이 없습니다"
            >
              —
            </span>
            <span className="text-[10px] text-slate-500 tabular-nums">진행 {row.runCount}회</span>
          </span>
        );
      }
      return (
        <span className="inline-flex flex-col items-center leading-tight">
          <span
            className={cn(
              "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold shrink-0",
              verdict.tier === "DORMANT"
                ? "bg-status-caution-bg text-status-caution"
                : "border border-slate-200 bg-slate-100 text-slate-500",
            )}
            title={`마지막 진행 시작 후 ${verdict.daysSinceLastRun}일 경과 (휴면 ${DORMANT_DAYS}일 · 제외 ${EXCLUDE_DAYS}일 기준)`}
          >
            {DORMANCY_TIER_LABEL[verdict.tier]}
          </span>
          {/* 진행 횟수를 함께 노출한다 — "재접촉으로 되살릴 휴면"과 "첫 거래 후 이탈"은
              개입이 다른데, 횟수가 없으면 둘이 구분되지 않는다. 제외 구간의 상당수가
              진행 1회뿐이라 이 구분이 실제로 갈린다.
              옆 '누적 캠페인'과 모수가 다르다(저기는 전 상태, 여기는 실제 진행분). */}
          <span className="text-[10px] text-slate-500 tabular-nums">진행 {row.runCount}회</span>
        </span>
      );
    },
  },
  {
    key: "collaborationScore",
    label: "평가",
    width: 90,
    align: "center",
    render: (row) => {
      const fit = row.fitLevel || "비추천";
      // 리터럴 → 상태 토큰 정렬(D2 곁다리). 이 배지는 **회수 대상이 아니다** — 평가는 판단이라 색이
      // 맞다. 바꾼 건 색의 유무가 아니라 "표준을 가리키지 않고 직접 적어둔 것"이다.
      //
      // 정렬 대상은 발명이 아니라 P8 가드레일 2의 정본이다 — `status-badge.tsx` 가 같은 세 토큰 짝을
      // 이미 쓴다(COMPLETED = success-bg/success · SETTLEMENT_WAIT = caution-bg/caution ·
      // DROPPED = urgent-bg/urgent-text). 즉 이 배지가 앱의 상태 배지와 같은 언어를 쓰게 되는 것이다.
      // 실측: 추천 emerald-700(#047857) == --status-success · 보류 amber-700(#B45309) == --status-caution
      // 이라 **픽셀 변화 0**. 어긋난 건 비추천 rose-700(#BE123C 다홍) 하나뿐이라 --status-urgent-text
      // (#8F3C3C 벽돌)로 맞춘다 — 바로 옆 칸 점수의 빨강과 같은 값이어야 "맞추려다 실패한 것"처럼 안 보인다.
      // 테두리는 뗀다: 정본도 `border-transparent` 로 **보이지 않게** 두므로 시각 결과가 같고,
      // 이 span 은 shadcn Badge 가 아니라 border 기본값이 없어 클래스를 안 주면 그만이다.
      // 미진행은 **그대로** — "판단 불가"는 의미축의 값이 아니라 토큰 짝이 없는 게 정상이다.
      // 테두리도 원래대로 유지한다(base 에서 `border` 를 뺐으므로 이 항목에만 되돌려 준다) —
      // 상세(`app/sellers/[id]/page.tsx` FIT_BADGE)의 미진행도 `border-slate-200` 을 그대로 두므로
      // 두 표면이 어긋나지 않는다. 상태 3종만 무테다(정본의 `border-transparent` 와 같은 결과).
      const badgeColors: Record<string, string> = {
        추천: "bg-status-success-bg text-status-success",
        보류: "bg-status-caution-bg text-status-caution",
        비추천: "bg-status-urgent-bg text-status-urgent-text",
        미진행: "border border-slate-200 bg-slate-100 text-slate-500",
      };

      return (
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${badgeColors[fit] || badgeColors.비추천} shrink-0`}>
          {fit}
        </span>
      );
    },
  },
  {
    key: "aiComposite",
    label: "AI 점수",
    width: 84,
    align: "center",
    render: (row) => {
      if (row.aiComposite == null) {
        // 미분석 IG 계정: 정적 텍스트 대신 그 자리서 분석을 트리거하는 버튼 (UX 감사 P0-3 — 분석 동선 단축).
        // 비IG는 분석 API가 400을 주므로 버튼 없이 안내 텍스트만 유지한다.
        if (row.snsType !== "INSTAGRAM") {
          return (
            <span
              className="text-xs text-slate-500"
              title="인스타그램 계정만 분석할 수 있습니다"
            >
              미분석
            </span>
          );
        }
        const isAnalyzing = ctx.analyzingId === row.id;
        return (
          <button
            type="button"
            disabled={isAnalyzing}
            onClick={(e) => {
              e.stopPropagation(); // 행 클릭(상세 열기)과 분리
              ctx.onAnalyze(row.id);
            }}
            title="AI 분석 실행 (1~2분 소요)"
            className="inline-flex items-center gap-1 rounded-md border border-input bg-transparent px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
          >
            {isAnalyzing ? (
              <>
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                분석 중…
              </>
            ) : (
              <>
                <SparklesIcon aria-hidden="true" className="size-3" />
                분석
              </>
            )}
          </button>
        );
      }
      // 신뢰도는 목록에서 텍스트 줄을 받지 않는다(오너 확정 2026-07-16 2차: "목록에서 보여줄
      // 필요가 있는거야?" — 신뢰도의 홈은 상세 ScoreCard·리포트다). 1차의 "캐비앗(보통/부족)만
      // 노출"도 회수. 단, 완전 비가시(title만)는 발견 가능성 0이라 커밋 불가(ss-ux P0) —
      // medium/low일 때 점수 숫자에 **무채색 점선 밑줄**(abbr 관용구)로 "단서 있음"만 알리고
      // 설명은 title이 담당한다. 판정 축(밴드 색)과 다른 채널이라 축 혼합이 없다.
      // 'high'는 아무 표시도 없다 — 정상 상태는 침묵("높음" 도배가 평가로 오독되던 문제).
      const lowConfidence = row.aiConfidence === "medium" || row.aiConfidence === "low";
      // 오래된 분석의 점수를 최신처럼 신뢰·정렬하지 않도록 경과를 함께 노출 (재분석은 상세에서 수동 트리거)
      const staleLabel = analysisStaleLabel(row.aiAnalyzedAt);
      // "이 셀러를 쓸지 말지"를 정하는 값인데 41점과 87점이 같은 slate-800이었다 — 규칙은 이미
      // 있었고(추천 65 / 보류 48, 상세 ScoreCard가 "추천 구간"이라고 말로만 쓰던 그 경계) 색만 없었다.
      const scoreBand = resolveSellerScoreBand(row.aiComposite);
      return (
        <span className="inline-flex flex-col items-center leading-tight">
          <span
            className={cn(
              "text-xs font-bold tabular-nums",
              scoreBand ? SELLER_SCORE_BAND_TEXT[scoreBand] : SELLER_SCORE_BAND_TEXT_UNSET,
              lowConfidence &&
                "cursor-help underline decoration-dotted decoration-slate-400 underline-offset-2",
            )}
            title={
              lowConfidence
                ? `신뢰도 ${row.aiConfidence === "medium" ? "보통" : "부족"}: 수집 표본이 부족해 점수를 온전히 신뢰하기 어렵습니다. 상세의 신뢰도 근거 참고`
                : undefined
            }
          >
            {row.aiComposite}
          </span>
          {staleLabel && (
            <span
              className="text-[10px] text-[var(--status-caution-text)]"
              title="분석이 오래되어 현재 계정 상태와 다를 수 있습니다. 셀러 상세에서 재분석"
            >
              {staleLabel}
            </span>
          )}
        </span>
      );
    },
  },
  {
    key: "lastSyncedAt",
    label: "최근 정보 갱신일",
    width: 124,
    align: "center",
    render: (row) => {
      // 미수집: 한 번도 프로필/팔로워를 긁은 적 없음 → 재수집 최우선 후보로 caution 강조
      if (!row.lastSyncedAt) {
        return (
          <span
            className="text-xs font-medium text-[var(--status-caution-text)]"
            title="한 번도 수집된 적이 없습니다. 재수집 후보"
          >
            미수집
          </span>
        );
      }
      const dateStr = row.lastSyncedAt.slice(0, 10); // "YYYY-MM-DD"
      const yyMmDd = dateStr.length === 10 ? `${dateStr.slice(2, 4)}-${dateStr.slice(5, 7)}-${dateStr.slice(8, 10)}` : dateStr;
      const days = Math.floor((Date.now() - new Date(row.lastSyncedAt).getTime()) / 86_400_000);
      const isStale = days > STALE_SYNC_DAYS;
      const ageLabel = days <= 0 ? "오늘" : `${days}일 전`;
      // 경과일이 메인, 실제 날짜가 서브(오너 확정 2026-07-16) — 이 컬럼의 판단은 "얼마나
      // 오래됐나"(재수집 후보 선별)이지 달력 좌표가 아니다. 날짜는 근거로 아래 줄에 남긴다.
      return (
        <span
          className={`inline-flex flex-col items-center leading-tight ${isStale ? "text-[var(--status-caution-text)]" : "text-slate-600"}`}
          title={isStale ? `${STALE_SYNC_DAYS}일 이상 미수집: 재수집 후보` : undefined}
        >
          <span className={`text-xs tabular-nums ${isStale ? "font-medium" : ""}`}>{ageLabel}</span>
          <span className="text-[10px] tabular-nums text-slate-500">{yyMmDd}</span>
        </span>
      );
    },
  },
  ];
}

export function SellersManagement({
  initialSellers,
  dataSource,
  dataSourceMessage,
}: SellersManagementProps) {
  const isMobile = useIsMobile();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { filters, setFilter } = useFilterParams();
  const query = filters.q || "";

  // --- useSellers Custom Hook integration ---
  const {
    sellers,
    setSellers,
    selectedSeller,
    setSelectedSeller,
    sellerPanelMode,
    setSellerPanelMode,
    handleInlinePatch,
    handleSellerUpdated,
    handleSellerCreated,
    handleSellersBulkCreated,
    handleSellerDeleted,
    refetchSellers,
  } = useSellers(initialSellers);

  const [localQuery, setLocalQuery] = useState(query);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  // 파생 세그먼트 (§12-3): 거래 이력·분석 유무로 자동 분기 — 유지 비용 0 (상태 아님, 계산되는 사실)
  const [segment, setSegment] = useState<SellerSegment>("all");
  // 원클릭 분석 진행 중인 셀러 id (중복 클릭 가드 + 스피너 표시). null이면 유휴.
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const isComposingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local query when URL param changes externally
  useEffect(() => {
    setLocalQuery(query);
  }, [query]);

  // Debounced search
  const debouncedSetFilter = useCallback(
    (value: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        if (!isComposingRef.current) {
          setFilter("q", value);
        }
      }, 350);
    },
    [setFilter]
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  // 원클릭 AI 분석 — 리스트에서 미분석 IG 셀러를 그 자리서 분석 (UX 감사 P0-3: 상세 6번째 아코디언까지
  // 내려가야만 실행 가능하던 유일 동선을 리스트로 끌어올림). 성공 시 응답 점수로 해당 row를 낙관적으로
  // 갱신해 전체 재조회 없이 즉시 반영한다(setSellers는 react-query 캐시에 write → GET /api/sellers 갱신
  // 경로와도 정합). maxDuration 300s의 장시간 요청이라 진행 상태를 스피너로 노출한다.
  const handleAnalyze = useCallback(
    async (id: string) => {
      // 중복 클릭 가드 — 이미 어떤 셀러든 분석 중이면 무시(요청이 무거워 병렬 실행을 막는다).
      if (analyzingId) return;
      setAnalyzingId(id);
      toast("분석을 시작합니다 · 1~2분 걸립니다");
      try {
        const response = await fetch(`/api/sellers/${id}/analyze`, { method: "POST" });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error || "분석에 실패했습니다");
        }
        // 응답 형태: { success, data: { scores: { composite, confidence }, analyzedAt, applied } }
        const scores = payload?.data?.scores ?? {};
        const analyzedAt: string | null = payload?.data?.analyzedAt ?? new Date().toISOString();
        // 서버가 자동 반영한 지표 필드(오너 확정 2026-07-16 — 검토 확정 게이트 제거).
        // fitLevel은 서버 합산 규칙이 재계산한 값이라 함께 낙관 갱신해야 '평가' 배지가 안 낡는다.
        const applied = payload?.data?.applied ?? null;
        setSellers((prev) =>
          prev.map((seller) =>
            seller.id === id
              ? {
                  ...seller,
                  ...(applied?.fields ?? {}),
                  ...(applied?.fitLevel ? { fitLevel: applied.fitLevel } : {}),
                  aiComposite: scores.composite ?? seller.aiComposite ?? null,
                  aiConfidence: scores.confidence ?? seller.aiConfidence ?? null,
                  aiAnalyzedAt: analyzedAt,
                }
              : seller
          )
        );
        const appliedCount = applied?.fields ? Object.keys(applied.fields).length : 0;
        toast.success(
          appliedCount > 0
            ? `AI 분석 완료 · 지표 ${appliedCount}건 자동 반영`
            : "AI 분석이 완료되었습니다.",
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "분석 중 오류가 발생했습니다");
      } finally {
        setAnalyzingId(null);
      }
    },
    [analyzingId, setSellers]
  );

  // 상태·핸들러를 주입해 컬럼을 조립 (모듈 레벨 배열은 render에서 상태 접근 불가라 팩토리로 승격).
  const sellerColumns = useMemo(
    () => buildSellerColumns({ onAnalyze: handleAnalyze, analyzingId }),
    [handleAnalyze, analyzingId]
  );

  const sellerStats = useMemo(() => {
    const instagramCount = sellers.filter(
      (s) => s.snsType === "INSTAGRAM"
    ).length;
    const youtubeCount = sellers.filter(
      (s) => s.snsType === "YOUTUBE"
    ).length;
    const xCount = sellers.filter(
      (s) => s.snsType === "X"
    ).length;
    // 유효 캠페인 수(그룹=1건, 서버 캡 무관 집계) 우선 — 아래 행별 "누적 캠페인" 컬럼과
    // 같은 정의를 써야 헤더 합계와 행 합이 한 화면에서 어긋나지 않는다. campaigns 배열은
    // 12건 캡이라 폴백으로만 쓴다.
    const totalCampaigns = sellers.reduce(
      (sum, s) => sum + (s.campaignCount ?? s.campaigns?.length ?? 0),
      0
    );
    return { instagramCount, youtubeCount, xCount, totalCampaigns };
  }, [sellers]);

  const filteredSellers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const list = normalized
      ? sellers.filter((s) => {
          const nameMatch = s.name.toLowerCase().includes(normalized);
          const aliasMatch = s.alias?.toLowerCase().includes(normalized) ?? false;
          const handleMatch = s.snsHandle.toLowerCase().includes(normalized);
          const categoryMatch = s.category?.toLowerCase().includes(normalized) ?? false;
          return nameMatch || aliasMatch || handleMatch || categoryMatch;
        })
      : sellers;

    // 파생 세그먼트 필터: 전체 / 거래 셀러(campaignCount>0) / 발굴 후보(=0) / 미분석(aiComposite==null).
    // 순수 함수(seller-segment.ts)로 분리 — property test로 기존 active/prospect 계약 + 신규 unanalyzed 검증.
    const segmented = filterSellersBySegment(list, segment);

    return [...segmented].sort((a, b) => {
      const aMonitored = a.isMonitored ? 1 : 0;
      const bMonitored = b.isMonitored ? 1 : 0;
      if (aMonitored !== bMonitored) {
        return bMonitored - aMonitored;
      }
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });
  }, [sellers, query, segment]);

  // Auto-open seller details if present in query parameters
  useEffect(() => {
    const selId = filters.selectedSeller;
    if (selId) {
      const found = sellers.find((s) => s.id === selId);
      if (found) {
        // Intentional URL-driven panel sync for deep links.
         
        setSelectedSeller(found);
        setSellerPanelMode("view");
      }
    }
  }, [filters.selectedSeller, sellers, setSelectedSeller, setSellerPanelMode]);

  if (isMobile) {
    return (
      <>
        <MobileSellersView
          sellers={filteredSellers}
          totalCount={sellers.length}
          instagramCount={sellerStats.instagramCount}
          youtubeCount={sellerStats.youtubeCount}
          xCount={sellerStats.xCount}
          totalCampaigns={sellerStats.totalCampaigns}
          localQuery={localQuery}
          setLocalQuery={setLocalQuery}
          commitSearch={debouncedSetFilter}
          onOpenSeller={(seller) => {
            setSellerPanelMode("view");
            setSelectedSeller(seller);
          }}
        />
        <SellersPanel
          seller={selectedSeller ?? null}
          open={selectedSeller !== null || sellerPanelMode === "create"}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedSeller(null);
              setSellerPanelMode("view");
            }
          }}
          mode={sellerPanelMode}
          onUpdated={handleSellerUpdated}
          onCreated={handleSellerCreated}
          onDeleted={handleSellerDeleted}
        />
      </>
    );
  }

  return (
    <CrmShell>
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        {/* 1줄 통계 요약 바 (유리 박스 외부 상단 배치)

            플랫폼별 hue(인스타=emerald · 유튜브=red · X=sky · 총캠페인=amber)를 회수했다 —
            D2, 오너 승인 2026-07-16. 라벨이 이미 "Instagram:"이라고 말하므로 색은 라벨을 반복할 뿐이고,
            숫자가 84가 되든 3이 되든 늘 같은 색이라 **색이 값의 함수가 아니었다**(범주는 색을 받지 않는다).
            게다가 그 4색 중 3개가 12px 본문 대비 AA 미달이었다(emerald-600 3.77 · amber-600 3.19 ·
            sky-600 4.10 / red-600 4.83만 통과). 회수 대상 slate-800 은 14.63 — 가독성도 같이 개선된다.
            색은 판단 지점인 AI 점수 밴드(seller-score-band.ts)로 옮겼다. 여기에 hue 를 다시 넣지 말 것.

            `dark:` 분기도 함께 제거했다 — 이 파일의 dark: 는 전부 이 바 안에 있었고, 전부 **발화 불가능**했다:
            globals.css 의 dark 는 클래스 variant(`&:is(.dark *)`)인데 layout.tsx 의 <html> 에 dark 클래스가
            없고, ThemeProvider 도 classList 토글도 없다(globals.css 주석도 ".dark는 현재 미사용(확인됨)").
            회수한 줄을 새로 쓰면서 죽은 분기를 같이 저술할 이유가 없어 뺐다. 레포의 나머지 dark: 는
            이 작업 범위가 아니다 — 다크모드를 켜게 되면 그때 일괄로 다룰 일이다. */}
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200/60 bg-white/80 px-4 py-2.5 text-xs text-slate-600 shadow-soft-sm backdrop-blur-sm shrink-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-medium">전체 셀러:</span>
            <span className="font-semibold text-slate-800">{sellers.length}명</span>
          </div>
          <span className="hidden md:inline text-slate-200">|</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-medium">Instagram:</span>
            <span className="font-semibold text-slate-800">{sellerStats.instagramCount}</span>
          </div>
          <span className="hidden md:inline text-slate-200">|</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-medium">YouTube:</span>
            <span className="font-semibold text-slate-800">{sellerStats.youtubeCount}</span>
          </div>
          <span className="hidden md:inline text-slate-200">|</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-medium">X (Twitter):</span>
            <span className="font-semibold text-slate-800">{sellerStats.xCount}</span>
          </div>
          <span className="hidden md:inline text-slate-200">|</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-medium">총 캠페인:</span>
            <span className="font-semibold text-slate-800">{sellerStats.totalCampaigns}건</span>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
          {dataSource === "mock" && dataSourceMessage ? (
            <div className="px-5 pt-5">
              <DataSourceBanner message={dataSourceMessage} />
            </div>
          ) : null}
          <section className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/70 px-5 py-3">
            <div className="flex-1">
              <h2 className="text-sm font-bold text-foreground">셀러 목록</h2>
            </div>
            {/* 파생 세그먼트 토글 (§12-3) — 공용 SegmentToggle(radiogroup a11y·h-9 정렬) */}
            <SegmentToggle<SellerSegment>
              ariaLabel="셀러 목록 보기"
              value={segment}
              onValueChange={setSegment}
              options={[
                { value: "all", label: "전체" },
                { value: "active", label: "거래 셀러" },
                { value: "prospect", label: "발굴 후보" },
                { value: "unanalyzed", label: "미분석" },
              ]}
            />
            <InputGroup className="w-48 shrink-0 border border-slate-200 bg-white h-9 rounded-lg shadow-soft-sm">
              <InputGroupAddon>
                {localQuery !== query ? (
                  <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <SearchIcon aria-hidden="true" className="h-4 w-4 text-slate-500" />
                )}
              </InputGroupAddon>
              <InputGroupInput
                value={localQuery}
                onChange={(e) => {
                  const val = e.target.value;
                  setLocalQuery(val);
                  if (!isComposingRef.current) {
                    debouncedSetFilter(val);
                  }
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={(e) => {
                  isComposingRef.current = false;
                  const val = (e.target as HTMLInputElement).value;
                  debouncedSetFilter(val);
                }}
                placeholder="검색"
                aria-label="셀러 검색"
                className="h-full border-0 focus-visible:ring-0 text-xs"
              />
            </InputGroup>
            {/* 검색 상태 스크린리더 고지 (4.1.3) */}
            <span className="sr-only" role="status" aria-live="polite">
              {localQuery !== query ? "검색 중" : `셀러 ${filteredSellers.length}건`}
            </span>
            {/* 액션 버튼 — 검색창과 높이 정렬(h-9), 딜 페이지 표준 패턴 */}
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 rounded-lg h-9 text-xs"
              onClick={() => setReferralOpen(true)}
            >
              소개 네트워크
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 rounded-lg h-9 text-xs"
              onClick={() => setBulkOpen(true)}
            >
              발굴 대량등록
            </Button>
            <Button
              size="sm"
              className="shrink-0 rounded-lg h-9 text-xs"
              onClick={() => {
                setSelectedSeller(null);
                setSellerPanelMode("create");
              }}
            >
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              신규 셀러
            </Button>
          </section>

          {sellers.length === 0 && !query ? (
            <div className="flex h-64 items-center justify-center">
              <DataEmpty
                icon={Users}
                title="등록된 셀러가 없습니다"
                description="셀러를 추가하여 인플루언서를 관리하세요."
              >
                <Button
                  size="sm"
                  onClick={() => {
                    setSelectedSeller(null);
                    setSellerPanelMode("create");
                  }}
                >
                  <PlusIcon aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                  신규 셀러 등록
                </Button>
              </DataEmpty>
            </div>
          ) : (
            <InlineDataGrid
              rows={filteredSellers}
              columns={sellerColumns}
              globalFilter=""
              disableInlineEdit
              persistId="sellers-grid"
              onRowClick={(row) => {
                setSellerPanelMode("view");
                setSelectedSeller(row);
              }}
              onPatch={handleInlinePatch}
            />
          )}
        </div>
      </section>

      {/* Side Panels */}
      <SellersPanel
        seller={selectedSeller ?? null}
        open={selectedSeller !== null || sellerPanelMode === "create"}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedSeller(null);
            setSellerPanelMode("view");
            const selId = filters.selectedSeller || filters.sellerId;
            if (selId) {
              const params = new URLSearchParams(searchParams.toString());
              params.delete("selectedSeller");
              params.delete("sellerId");
              const queryString = params.toString();
              router.push(`/sellers${queryString ? `?${queryString}` : ""}`);
            }
          }
        }}
        mode={sellerPanelMode}
        onUpdated={handleSellerUpdated}
        onCreated={handleSellerCreated}
        onDeleted={handleSellerDeleted}
      />

      {/* 발굴 셀러 대량 등록 유입 경로 */}
      <SellerBulkCreateDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onBulkCreated={handleSellersBulkCreated}
        onRefetch={refetchSellers}
      />

      {/* F3 소개 네트워크 — 유입 경로 분포 + 커넥터 리더보드 */}
      <ReferralNetworkDialog open={referralOpen} onOpenChange={setReferralOpen} sellers={sellers} />
    </CrmShell>
  );
}

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17z" />
      <polygon points="10 15 15 12 10 9" />
    </svg>
  );
}
