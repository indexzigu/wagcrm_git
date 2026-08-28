// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  MobilePipelineView,
  buildMobilePipelineEntities,
  buildEntityStageCounts,
} from "../mobile-pipeline-view";
import type { CampaignRow } from "@/lib/crm-types";

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "camp-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    dealName: "글로우 앰플",
    partnerName: "코링코",
    sellerName: "미나",
    snsType: "INSTAGRAM",
    snsHandle: "@mina_beauty",
    startDate: "2026-07-01",
    endDate: "2026-07-05",
    salesChannel: "OWN_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: null,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    status: "ACTIVE",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-07-01T00:00:00Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    ...overrides,
  } as CampaignRow;
}

const viewProps = {
  stageFilter: "ALL" as const,
  setStageFilter: () => {},
  searchQuery: "",
  setSearchQuery: () => {},
};

describe("buildMobilePipelineEntities — 조합 캠페인 그룹 1카드 병합", () => {
  it("같은 groupId 멤버 2건 이상이면 그룹 엔티티 1개로 병합한다 (라벨=첫딜명 외 N-1, 기간 min~max, 대표 상태)", () => {
    const entities = buildMobilePipelineEntities([
      makeCampaign({
        id: "a",
        groupId: "g1",
        dealName: "앰플",
        startDate: "2026-07-01",
        endDate: "2026-07-05",
        status: "CLOSED",
        actualSales: 100,
      }),
      makeCampaign({
        id: "b",
        groupId: "g1",
        dealName: "세럼",
        startDate: "2026-07-03",
        endDate: "2026-07-10",
        status: "ACTIVE",
        actualSales: 50,
      }),
      makeCampaign({ id: "c", dealName: "단독딜" }),
    ]);

    expect(entities).toHaveLength(2);
    const group = entities[0];
    expect(group.kind).toBe("group");
    // 일정탭과 동일한 `group:${groupId}` 키 규약
    expect(group.key).toBe("group:g1");
    expect(group.memberCount).toBe(2);
    expect(group.displayRow.dealName).toBe("앰플 외 1");
    // 기간 = 멤버 min(startDate) ~ max(endDate)
    expect(group.displayRow.startDate).toBe("2026-07-01");
    expect(group.displayRow.endDate).toBe("2026-07-10");
    // 대표 상태 = 가장 덜 진행된 멤버 (ACTIVE < CLOSED)
    expect(group.status).toBe("ACTIVE");
    expect(group.displayRow.status).toBe("ACTIVE");
    // 실매출은 멤버 합산
    expect(group.displayRow.actualSales).toBe(150);
    // 상세 열기용 대표는 합성 행이 아니라 실제 첫 멤버 행
    expect(group.representative.id).toBe("a");
    expect(group.representative.dealName).toBe("앰플");
  });

  it("그룹 멤버가 1건뿐이면 개별 캠페인 엔티티로 폴백한다", () => {
    const entities = buildMobilePipelineEntities([
      makeCampaign({ id: "a", groupId: "g1" }),
      makeCampaign({ id: "c", dealName: "단독딜" }),
    ]);
    expect(entities).toHaveLength(2);
    expect(entities[0].kind).toBe("campaign");
    expect(entities[0].key).toBe("a");
    expect(entities[0].memberCount).toBe(1);
  });

  it("멤버 실매출이 전부 null이면 그룹 실매출도 null을 유지한다", () => {
    const entities = buildMobilePipelineEntities([
      makeCampaign({ id: "a", groupId: "g1", actualSales: null }),
      makeCampaign({ id: "b", groupId: "g1", actualSales: null, dealName: "세럼" }),
    ]);
    expect(entities[0].displayRow.actualSales).toBeNull();
  });

  it("최저가 위반은 멤버 중 하나라도 있으면 그룹에 승격되고 위반 딜 수는 합산된다", () => {
    const entities = buildMobilePipelineEntities([
      makeCampaign({ id: "a", groupId: "g1", hasPriceViolation: false, violatedDealCount: 0 }),
      makeCampaign({
        id: "b",
        groupId: "g1",
        dealName: "세럼",
        hasPriceViolation: true,
        violatedDealCount: 2,
      }),
    ]);
    expect(entities[0].displayRow.hasPriceViolation).toBe(true);
    expect(entities[0].displayRow.violatedDealCount).toBe(2);
  });
});

describe("buildEntityStageCounts — 상단 영업/진행/정산 카운트 그룹 단위 정합", () => {
  it("그룹은 대표 상태의 zone으로 1건만 계상한다", () => {
    const entities = buildMobilePipelineEntities([
      // 그룹: PROPOSAL(영업) + COMPLETED → 대표 PROPOSAL → SALES 1건
      makeCampaign({ id: "a", groupId: "g1", status: "PROPOSAL" }),
      makeCampaign({ id: "b", groupId: "g1", status: "COMPLETED", dealName: "세럼" }),
      // 단독 ACTIVE → DEAL_EXECUTION(진행)
      makeCampaign({ id: "c", status: "ACTIVE" }),
      // 단독 SETTLEMENT_IN_PROGRESS → SETTLEMENT(정산)
      makeCampaign({ id: "d", status: "SETTLEMENT_IN_PROGRESS" }),
    ]);
    expect(buildEntityStageCounts(entities)).toEqual({
      SALES: 1,
      PROGRESS: 1,
      SETTLEMENT: 1,
    });
  });
});

describe("MobilePipelineView — 그룹 카드 렌더", () => {
  const groupedCampaigns = [
    makeCampaign({
      id: "a",
      groupId: "g1",
      dealName: "앰플",
      startDate: "2026-07-01",
      endDate: "2026-07-05",
      status: "ACTIVE",
    }),
    makeCampaign({
      id: "b",
      groupId: "g1",
      dealName: "세럼",
      startDate: "2026-07-03",
      endDate: "2026-07-10",
      status: "CLOSED",
    }),
    makeCampaign({ id: "c", dealName: "단독딜", status: "ACTIVE" }),
  ];

  it("그룹 멤버 2건은 카드 1장(그룹명 + N개 딜 배지)으로, 상단 배지는 그룹 단위 건수로 렌더한다", () => {
    render(
      <MobilePipelineView campaigns={groupedCampaigns} onOpenCampaign={() => {}} {...viewProps} />,
    );

    // 카드 1장으로 병합 — 개별 멤버 카드 없음
    expect(screen.getByText("앰플 외 1")).toBeInTheDocument();
    expect(screen.queryByText("세럼")).not.toBeInTheDocument();
    expect(screen.getByText("2개 딜")).toBeInTheDocument();
    // 기간 = min ~ max
    expect(screen.getByText("07-01 ~ 07-10")).toBeInTheDocument();
    // 상단 N건 배지 = 엔티티 수(그룹 1 + 단독 1)
    expect(screen.getByText("2건")).toBeInTheDocument();
  });

  it("그룹 카드 탭 시 onOpenCampaign에 실제 첫 멤버 행을 전달한다 (합성 행 금지)", () => {
    const onOpenCampaign = vi.fn();
    render(
      <MobilePipelineView
        campaigns={groupedCampaigns}
        onOpenCampaign={onOpenCampaign}
        {...viewProps}
      />,
    );

    fireEvent.click(screen.getByText("앰플 외 1"));
    expect(onOpenCampaign).toHaveBeenCalledTimes(1);
    const passed = onOpenCampaign.mock.calls[0][0] as CampaignRow;
    expect(passed.id).toBe("a");
    expect(passed.dealName).toBe("앰플");
  });

  it("섹션 귀속은 그룹 대표 상태 기준이다 (ACTIVE+CLOSED 그룹 → 판매 중)", () => {
    render(
      <MobilePipelineView
        campaigns={[groupedCampaigns[0], groupedCampaigns[1]]}
        onOpenCampaign={() => {}}
        {...viewProps}
      />,
    );
    expect(screen.getByText("판매 중")).toBeInTheDocument();
    expect(screen.queryByText("완료 / 정산대기")).not.toBeInTheDocument();
  });
});
