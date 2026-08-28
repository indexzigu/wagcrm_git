import { getPrisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/**
 * CG-1 CampaignGroup 저장소 (블루프린트 §3 불변식).
 *
 * 멤버십 변경은 오직 `setGroupId(campaignId, groupId|null, tx)` 단일 필드 시그니처로만
 * 노출한다 — 호출자가 같은 콜에서 dealId/sellerId를 건드릴 구조적 여지를 없앤다.
 * 그룹 스칼라 갱신(update)도 롤업/이름 필드로 좁혀 sellerId 변경을 차단한다.
 */

/** 그룹 스칼라 롤업/이름 갱신 — sellerId 등 앵커 필드는 의도적으로 제외한다. */
export type CampaignGroupRollupUpdate = {
  name?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  // 정산 이벤트 블록 — 그룹 형성 시 멤버 잔존값 승계(virgin 블록 한정, 서비스가 판정).
  expectedDepositDate?: Date | null;
  depositReceivedAt?: Date | null;
  isDepositReceived?: boolean;
  expectedPayoutDate?: Date | null;
  payoutCompletedAt?: Date | null;
  isPayoutCompleted?: boolean;
  expectedSupplierPayoutDate?: Date | null;
  supplierPayoutCompletedAt?: Date | null;
  isSupplierPayoutCompleted?: boolean;
};

/** 그룹 상세/멤버 조회 시 공통 include. */
const memberInclude = {
  members: {
    include: {
      deal: { include: { partner: true } },
      seller: { include: { agency: true } },
      // 부가 항목 — 그룹 상세를 소비하는 「신고자료출력」이 보드와 **같은 금액**을
      // 말하려면 멤버 각자의 항목이 필요하다(설계 §9-2). 빼면 사이드패널만 부가
      // 항목을 뺀 금액을 보여주는데, 오너가 그 숫자를 홈택스에 손으로 넣는 경로라
      // 이 갈림이 곧 오신고다 — 이 레포가 여섯 번 고친 「화면과 파일이 갈린다」 패턴.
      // 정렬은 `campaignService` 의 select 와 동일하게 맞춘다.
      settlementItems: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
    },
    orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
  },
  seller: { include: { agency: true } },
} satisfies Prisma.CampaignGroupInclude;

export const campaignGroupRepository = {
  /** 그룹 생성. 항상 서비스 트랜잭션 내에서 호출한다. */
  create(data: Prisma.CampaignGroupUncheckedCreateInput, tx: Prisma.TransactionClient) {
    return tx.campaignGroup.create({ data });
  },

  async findByIdOrThrow(id: string) {
    return getPrisma().campaignGroup.findUniqueOrThrow({
      where: { id },
      include: memberInclude,
    });
  },

  async findById(id: string) {
    return getPrisma().campaignGroup.findUnique({
      where: { id },
      include: memberInclude,
    });
  },

  async findManyForSeller(sellerId: string) {
    return getPrisma().campaignGroup.findMany({
      where: { sellerId },
      include: memberInclude,
      orderBy: { updatedAt: "desc" },
    });
  },

  /**
   * 합류 후보 그룹 조회(경로 ⓑ suggest). 동일 셀러 + 날짜 포락선 겹침
   * (그룹 롤업 `startDate <= rangeEnd AND endDate >= rangeStart`).
   * excludeCampaignId가 주어지면 그 캠페인이 이미 속한 그룹은 제외한다
   * (이미 속한 그룹을 "합류하시겠어요?"로 재제안하지 않음).
   */
  async findSuggestions(params: {
    sellerId: string;
    rangeStart: Date;
    rangeEnd: Date;
    excludeCampaignId?: string;
  }) {
    const { sellerId, rangeStart, rangeEnd, excludeCampaignId } = params;
    return getPrisma().campaignGroup.findMany({
      where: {
        sellerId,
        startDate: { lte: rangeEnd },
        endDate: { gte: rangeStart },
        ...(excludeCampaignId
          ? { NOT: { members: { some: { id: excludeCampaignId } } } }
          : {}),
      },
      include: memberInclude,
      orderBy: { startDate: "asc" },
    });
  },

  /** 롤업/이름 스칼라 갱신(트랜잭션 내). sellerId·멤버 필드는 시그니처상 건드릴 수 없다. */
  update(id: string, data: CampaignGroupRollupUpdate, tx: Prisma.TransactionClient) {
    return tx.campaignGroup.update({ where: { id }, data });
  },

  /** 그룹 삭제(멤버는 FK onDelete: SetNull로 자동 언그룹). 트랜잭션 내. */
  delete(id: string, tx: Prisma.TransactionClient) {
    return tx.campaignGroup.delete({ where: { id } });
  },

  /** 그룹 멤버(SalesCampaign) 목록 — 롤업/불변식 재계산용 최소 필드. */
  listMembers(groupId: string, tx: Prisma.TransactionClient) {
    return tx.salesCampaign.findMany({
      where: { groupId },
      select: {
        id: true,
        dealId: true,
        sellerId: true,
        groupId: true,
        startDate: true,
        endDate: true,
        expectedDepositDate: true,
        depositReceivedAt: true,
        isDepositReceived: true,
        expectedPayoutDate: true,
        payoutCompletedAt: true,
        isPayoutCompleted: true,
        expectedSupplierPayoutDate: true,
        supplierPayoutCompletedAt: true,
        isSupplierPayoutCompleted: true,
        deal: { select: { dealName: true } },
        seller: { select: { name: true, alias: true } },
      },
      orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
    });
  },

  /** 멤버 조회(id 배열) — 소속/셀러 검증용 최소 필드. */
  findCampaignsByIds(campaignIds: string[], tx: Prisma.TransactionClient) {
    return tx.salesCampaign.findMany({
      where: { id: { in: campaignIds } },
      select: {
        id: true,
        dealId: true,
        sellerId: true,
        groupId: true,
        startDate: true,
        endDate: true,
        deal: { select: { dealName: true } },
        seller: { select: { name: true, alias: true } },
      },
      orderBy: [{ startDate: "asc" }, { createdAt: "asc" }],
    });
  },

  /**
   * 멤버십 유일 변경 지점 — groupId 단일 필드만 쓴다.
   * tx 필수: 그룹 오퍼레이션(생성/추가/제거/해체)의 advisory lock 구간 안에서만 호출.
   */
  setGroupId(campaignId: string, groupId: string | null, tx: Prisma.TransactionClient) {
    return tx.salesCampaign.update({
      where: { id: campaignId },
      data: { groupId },
      select: { id: true, groupId: true },
    });
  },
};
