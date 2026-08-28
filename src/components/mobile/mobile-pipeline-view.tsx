"use client";

import { useState, useMemo } from "react";
import { AlertCircleIcon, SearchIcon, ChevronDownIcon } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import type { CampaignRow, CampaignStatus } from "@/lib/crm-types";
import type { StageFilter } from "@/hooks/use-stage-filter";
import { representativeStatus } from "@/lib/calendar-entities";
import { getZoneForStatus } from "@/lib/zone-config";
import { MobileCampaignCard } from "./mobile-campaign-card";
import { MobileTopBar } from "./mobile-top-bar";

/**
 * 모바일 캠페인 목록 뷰 (CEO Monitoring View)
 * - 기존 "진행캠페인 / 업무처리" 듀얼 탭 구조에서
 *   "캠페인 현황" 단일 모니터링 뷰로 간소화되었습니다.
 * - 오너 피드백(2026-07-15): 조합 캠페인(같은 groupId)은 개별 행이 아니라
 *   그룹 카드 1장으로 묶어 표시한다 — 캘린더(buildCalendarEntities)·상세 시트
 *   (campaignRowsToGroupDetailData)와 동일한 그룹 단위 세계관.
 */
type MobilePipelineViewProps = {
  campaigns: CampaignRow[];
  stageFilter: StageFilter;
  setStageFilter: (filter: StageFilter) => void;
  /**
   * @deprecated 캠페인 단위 카운트 — 그룹 단위 표시와 어긋나므로 더 이상 사용하지
   * 않는다. 상단 영업/진행/정산 카운트는 뷰 내부에서 그룹 엔티티 기준으로 계산한다.
   */
  counts?: Record<StageFilter, number>;
  isStageLocked?: boolean;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onOpenCampaign: (campaign: CampaignRow) => void;
  // Deprecated props, keeping them optional for type safety if used elsewhere
  mode?: "active" | "tasks";
  overdueReminders?: number;
};

export type MobilePipelineEntity = {
  kind: "campaign" | "group";
  /** 렌더/선택 키: 캠페인 id 또는 `group:${groupId}` — 일정탭 ID 규약과 동일. */
  key: string;
  /** 섹션 귀속·카운트용 상태 (그룹=가장 덜 진행된 멤버의 대표 상태). */
  status: CampaignStatus;
  /**
   * 카드 렌더용 행. 그룹이면 첫딜(startDate 오름차순) 기반 합성 행 —
   * 라벨 `첫딜명 외 N-1`, 기간 min~max, 대표 상태, 실매출 멤버 합산.
   */
  displayRow: CampaignRow;
  /** 상세 열기용 실제 멤버 행 (그룹=첫딜 멤버). 합성 행을 밖으로 내보내지 않는다. */
  representative: CampaignRow;
  memberCount: number;
};

/**
 * 캠페인 행을 그룹 단위 렌더 엔티티로 변환한다. 같은 groupId 멤버가 2건 이상이면
 * 그룹 엔티티 1개(첫 멤버의 원래 위치), 1건이면 개별 엔티티로 폴백한다(캘린더의
 * 월 윈도우 폴백과 동일 규칙 — 검색으로 멤버가 걸러져도 동작이 자연스럽다).
 *
 * 그룹 라벨은 `첫딜명 외 N-1` 고정이다 — CampaignRow에는 CampaignGroup.name이
 * 실려오지 않으므로(campaign-row.ts 매핑에 없음) 상세 시트
 * (campaignRowsToGroupDetailData)와 동일한 폴백 제목을 사용해 카드↔시트 제목을
 * 일치시킨다. "첫딜" 정의(startDate→dealName ko 정렬)도 시트와 동일.
 */
export function buildMobilePipelineEntities(campaigns: CampaignRow[]): MobilePipelineEntity[] {
  const membersByGroup = new Map<string, CampaignRow[]>();
  for (const campaign of campaigns) {
    if (!campaign.groupId) continue;
    const list = membersByGroup.get(campaign.groupId) ?? [];
    list.push(campaign);
    membersByGroup.set(campaign.groupId, list);
  }

  const entities: MobilePipelineEntity[] = [];
  const emittedGroups = new Set<string>();

  for (const campaign of campaigns) {
    const groupId = campaign.groupId ?? null;
    const members = groupId ? (membersByGroup.get(groupId) ?? []) : [];

    if (!groupId || members.length < 2) {
      entities.push({
        kind: "campaign",
        key: campaign.id,
        status: campaign.status,
        displayRow: campaign,
        representative: campaign,
        memberCount: 1,
      });
      continue;
    }

    if (emittedGroups.has(groupId)) continue;
    emittedGroups.add(groupId);

    const sorted = [...members].sort(
      (a, b) => a.startDate.localeCompare(b.startDate) || a.dealName.localeCompare(b.dealName, "ko"),
    );
    const first = sorted[0];
    const startDate = sorted.reduce(
      (min, member) => (member.startDate < min ? member.startDate : min),
      first.startDate,
    );
    const endDate = sorted.reduce(
      (max, member) => (member.endDate > max ? member.endDate : max),
      first.endDate,
    );
    const salesValues = sorted
      .map((member) => member.actualSales)
      .filter((value): value is number => value != null);
    const status = representativeStatus(sorted.map((member) => member.status));

    entities.push({
      kind: "group",
      key: `group:${groupId}`,
      status,
      displayRow: {
        ...first,
        dealName: `${first.dealName} 외 ${sorted.length - 1}`,
        status,
        startDate,
        endDate,
        actualSales: salesValues.length > 0 ? salesValues.reduce((sum, value) => sum + value, 0) : null,
        hasPriceViolation: sorted.some((member) => member.hasPriceViolation),
        violatedDealCount: sorted.reduce((sum, member) => sum + (member.violatedDealCount ?? 0), 0),
      },
      representative: first,
      memberCount: sorted.length,
    });
  }

  return entities;
}

type Section = {
  key: string;
  title: string;
  description: string;
  items: MobilePipelineEntity[];
};

/** 섹션(판매 중/준비 중/완료) 귀속은 그룹 대표 상태 기준. */
function buildActiveSections(entities: MobilePipelineEntity[]): Section[] {
  return [
    {
      key: "selling",
      title: "판매 중",
      description: "현재 판매가 진행되고 있는 캠페인",
      items: entities.filter((entity) => entity.status === "ACTIVE"),
    },
    {
      key: "preparation",
      title: "준비 중",
      description: "오픈 대기 및 준비 단계 캠페인",
      items: entities.filter((entity) => entity.status === "PREPARATION"),
    },
    {
      key: "completed",
      title: "완료 / 정산대기",
      description: "판매 종료 후 처리 중인 캠페인",
      items: entities.filter((entity) =>
        ["CLOSED", "SETTLEMENT_WAIT", "SETTLEMENT_IN_PROGRESS", "COMPLETED"].includes(entity.status),
      ),
    }
  ].filter((section) => section.items.length > 0);
}

/**
 * 상단 영업/진행/정산 카운트 — 그룹 단위 엔티티 기준(대표 상태의 zone 매핑).
 * crm-dashboard의 stageFilterCounts(SALES/PROGRESS=DEAL_EXECUTION/SETTLEMENT)와
 * 동일한 zone 구획을 쓰되, 분모만 캠페인 행 → 그룹 엔티티로 바꾼다.
 */
export function buildEntityStageCounts(
  entities: MobilePipelineEntity[],
): { SALES: number; PROGRESS: number; SETTLEMENT: number } {
  const counts = { SALES: 0, PROGRESS: 0, SETTLEMENT: 0 };
  for (const entity of entities) {
    const zone = getZoneForStatus(entity.status);
    if (zone === "SALES") counts.SALES += 1;
    else if (zone === "DEAL_EXECUTION") counts.PROGRESS += 1;
    else if (zone === "SETTLEMENT") counts.SETTLEMENT += 1;
  }
  return counts;
}

export function MobilePipelineView({
  campaigns,
  searchQuery,
  setSearchQuery,
  onOpenCampaign,
}: MobilePipelineViewProps) {
  const [visibleCount, setVisibleCount] = useState(20);
  const entities = useMemo(() => buildMobilePipelineEntities(campaigns), [campaigns]);
  const sections = useMemo(() => buildActiveSections(entities), [entities]);
  const stageCounts = useMemo(() => buildEntityStageCounts(entities), [entities]);
  const isEmpty = sections.length === 0;

  // 전체 엔티티를 일렬로 펼친 후 visibleCount 만큼만 잘라서 보여주도록 합니다.
  // 섹션 타이틀 유지를 위해, 보여질 목록에 포함된 아이템만 필터링합니다.
  const flatItems = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const visibleItems = new Set(flatItems.slice(0, visibleCount).map((item) => item.key));
  const hasMore = visibleCount < flatItems.length;

  const visibleSections = sections.map((section) => ({
    ...section,
    items: section.items.filter((item) => visibleItems.has(item.key))
  })).filter((section) => section.items.length > 0);

  return (
    <div className="mobile-tab-safe-top flex min-h-[calc(100dvh+1px)] flex-1 flex-col gap-4 bg-slate-50/50 px-5 pb-24">
      {/* 상단바 — 일정탭 카드 디자인 공용 셸(오너 피드백: 3탭 통일).
          N건 배지·영업/진행/정산 카운트 모두 그룹 단위(엔티티) 기준. */}
      <MobileTopBar
        title="캠페인 현황"
        right={
          <Badge variant="secondary" className="shrink-0 bg-slate-100 text-slate-600 border border-slate-200">
            {entities.length}건
          </Badge>
        }
      >
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs tabular-nums text-muted-foreground">
          <span>
            영업 <span className="font-semibold text-foreground">{stageCounts.SALES}</span>
          </span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          <span>
            진행 <span className="font-semibold text-foreground">{stageCounts.PROGRESS}</span>
          </span>
          <span aria-hidden="true" className="text-muted-foreground/40">
            ·
          </span>
          <span>
            정산 <span className="font-semibold text-foreground">{stageCounts.SETTLEMENT}</span>
          </span>
        </p>
      </MobileTopBar>

      {/* Search Bar */}
      <InputGroup className="h-11 rounded-2xl border border-white/60 bg-white/80 backdrop-blur-sm shadow-soft-sm transition-all focus-within:bg-white focus-within:ring-2 focus-within:ring-focus-ring">
        <InputGroupAddon>
          <SearchIcon className="text-slate-400 size-4 ml-1" />
        </InputGroupAddon>
        <InputGroupInput
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="캠페인명, 셀러, 거래처 검색..."
          className="h-full border-0 text-[13px] focus-visible:ring-0 bg-transparent placeholder:text-slate-400"
        />
      </InputGroup>

      {/* List */}
      {!isEmpty ? (
        <div className="flex flex-col gap-6 mt-1">
          {visibleSections.map((section) => (
            <section key={section.key} className="flex flex-col gap-3">
              <div className="px-1">
                <h2 className="text-sm font-bold text-slate-800">{section.title}</h2>
                <p className="text-[11px] text-slate-500 mt-0.5">{section.description}</p>
              </div>
              <div className="flex flex-col gap-3">
                {section.items.map((entity) => (
                  <MobileCampaignCard
                    key={entity.key}
                    campaign={entity.displayRow}
                    groupMemberCount={entity.kind === "group" ? entity.memberCount : undefined}
                    variant="pipeline"
                    // 그룹 카드는 합성 행이 아니라 실제 첫 멤버 행을 올려보낸다 —
                    // crm-dashboard가 campaignRowsToGroupDetailData로 그룹 시트를 연다.
                    onOpen={() => onOpenCampaign(entity.representative)}
                  />
                ))}
              </div>
            </section>
          ))}
          {hasMore && (
            <button
              onClick={() => setVisibleCount((prev) => prev + 20)}
              className="mt-2 flex items-center justify-center gap-1.5 rounded-2xl bg-white border border-slate-200 py-3 text-[13px] font-medium text-slate-600 shadow-soft-sm transition-[filter] duration-150 active:brightness-[0.93]"
            >
              더 보기 <ChevronDownIcon className="size-4 opacity-70" />
            </button>
          )}
        </div>
      ) : (
        <Empty className="border border-white/60 bg-white/50 backdrop-blur-sm shadow-soft-sm py-12 rounded-2xl mt-2">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="bg-slate-100/50 text-slate-400">
              <AlertCircleIcon />
            </EmptyMedia>
            <EmptyTitle className="text-sm font-semibold text-slate-700">
              조회된 캠페인이 없습니다.
            </EmptyTitle>
            <EmptyDescription className="text-xs text-slate-500">
              검색어를 변경하거나 등록된 캠페인을 확인해주세요.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
