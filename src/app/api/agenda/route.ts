import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { calculateFollowUp } from "@/lib/followup-engine";
import { buildOverdueSettlementItems } from "@/lib/agenda-settlements";
import { SETTLEMENT_STAGE_STATUSES } from "@/lib/settlement-stage";

export async function GET() {
  try {
    const prisma = getPrisma();
    const now = new Date();

    // 1. 활성 SalesTask 조회 (PROPOSED, TESTING 등 팔로업 대상 상태 위주)
    const activeTasks = await prisma.salesTask.findMany({
      where: {
        status: { in: ["PROPOSED", "NEGOTIATION", "TESTING", "SAMPLE_TESTING"] },
      },
      include: {
        seller: {
          select: {
            name: true,
            alias: true,
            snsType: true,
          },
        },
        deal: {
          select: {
            dealName: true,
          },
        },
      },
    });

    const todoTasks = activeTasks
      .map((task) => {
        // followup-engine 호환 입력 생성
        const engineInput = {
          status: task.status,
          proposalSentAt: task.proposalSentAt,
          updatedAt: task.updatedAt,
          createdAt: task.createdAt,
          nextReminderAt: task.nextReminderAt,
        };
        const followUp = calculateFollowUp(engineInput, now);
        if (!followUp) return null;

        const sellerDisplayName = task.seller.alias && task.seller.alias.trim() !== ""
          ? task.seller.alias
          : task.seller.name;

        return {
          id: task.id,
          type: "TASK" as const,
          status: task.status,
          title: `${task.deal.dealName} - ${sellerDisplayName}`,
          dealName: task.deal.dealName,
          sellerName: sellerDisplayName,
          dueDate: task.nextReminderAt ? task.nextReminderAt.toISOString() : null,
          followUpType: followUp.type,
          label: followUp.label,
          badgeColor: followUp.badgeColor,
          snsType: task.seller.snsType,
        };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    // 2. 지연된 정산 건 조회 — 정산 단계 전량을 가져와 JS에서 판정한다.
    // 그룹캠페인은 대금 완료 플래그의 SoT가 그룹이라(CG-1) 멤버 컬럼 where 프리필터로는
    // 오탐(그룹은 입금됐는데 멤버 플래그가 낡음)·누락(멤버 날짜 null, 그룹 날짜만 존재)이
    // 생긴다. 지연 판정·그룹 접기는 buildOverdueSettlementItems(순수)가 담당.
    const settlementStageCampaigns = await prisma.salesCampaign.findMany({
      where: {
        // ⛔ 상태 목록을 여기 다시 적지 말 것 — 모바일 대기 목록과 **같은 모집단**이어야
        // 한다(SSOT: `settlement-stage.SETTLEMENT_STAGE_STATUSES`). 종전엔 세 파일에
        // 각자 박혀 있어 한 곳만 넓히면 두 화면이 다른 것을 보게 되는 구조였다.
        status: { in: [...SETTLEMENT_STAGE_STATUSES] },
      },
      select: {
        id: true,
        status: true,
        // 슬롯 SSOT 입력 — 빠지면 자사몰이 셀러몰 슬롯으로 오판돼 공급사 지급 지연이
        // 통째로 감지되지 않는다(`buildOverdueSettlementItems` 헤더 주석).
        salesChannel: true,
        expectedDepositDate: true,
        expectedPayoutDate: true,
        expectedSupplierPayoutDate: true,
        isDepositReceived: true,
        isPayoutCompleted: true,
        isSupplierPayoutCompleted: true,
        settlementSales: true,
        actualPayoutAmount: true,
        groupId: true,
        group: {
          select: {
            name: true,
            expectedDepositDate: true,
            expectedPayoutDate: true,
            expectedSupplierPayoutDate: true,
            isDepositReceived: true,
            isPayoutCompleted: true,
            isSupplierPayoutCompleted: true,
          },
        },
        seller: {
          select: {
            name: true,
            alias: true,
            accountNumber: true,
            snsType: true,
          },
        },
        deal: {
          select: {
            dealName: true,
          },
        },
      },
    });

    const todoSettlements = buildOverdueSettlementItems(settlementStageCampaigns, now);

    return NextResponse.json({
      tasks: todoTasks,
      settlements: todoSettlements,
    });
  } catch (error) {
    console.error("Failed to fetch agenda data:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
