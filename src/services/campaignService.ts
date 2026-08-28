import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { campaignRepository } from "@/repositories/campaignRepository";
import { resolveBaseMargin, parseMarginPolicy, withNet } from "@/lib/margin";
import { buildNaverTrackingLink } from "@/lib/tracking";
import {
  ensureCampaignChecklistForStatus,
  getWorkspaceStatuses,
} from "@/lib/campaign-checklist";
import { recordCampaignActivity } from "@/lib/campaign-activity";
import { googleDriveProvider, GOOGLE_DRIVE_PROVIDER } from "@/lib/asset-storage";
import type { CampaignStatus, SalesChannel, SnsType } from "@/lib/crm-types";
import { recalculateCampaignRounds } from "@/services/campaignRounds";
import { pickShortLink } from "@/lib/order-converter/review-link";
import { calculateDerivedCampaignFinancials } from "@/lib/campaign-financials";
import {
  isIndividualSeller,
  getSellerPayoutBase,
  calcIndividualIncomeTax,
} from "@/lib/seller-tax-utils";
import { fanOutMemberSchedule, recomputeGroupRollup } from "@/services/campaignGroupService";
import { syncCampaignLinkExpiry } from "@/lib/short-link";
import type { DecimalLike } from "@/lib/campaign-row";
import {
  normalizeSettlementItemMode,
  type SettlementCounterparty,
  type SettlementInvoiceMode,
} from "@/lib/settlement-items";
import type {
  CampaignUpdateData,
  PreviousCampaignForUpdate,
  SettlementStates,
  SettlementSync,
} from "@/lib/campaign-update-plan";

// Types matching the parsed inputs from the controller
interface CreateCampaignInput {
  dealId: string;
  sellerId: string;
  campaignName?: string;
  startDate: string;
  endDate: string;
  salesChannel: string;
  baseNaverLink: string;
  status: string;
  isManualMargin: boolean;
  totalMarginRate?: number;
  sellerMarginRate?: number;
  campaignDeals?: {
    dealId: string;
    quantity: number;
    actualSales: number;
    feeRate?: number | null;
    sellerMarginRate?: number | null;
    costPrice?: number | null;
    sellingPrice?: number | null;
  }[];
}

// 캠페인 상세 조회의 include 정의 — GET·PATCH previous 조회·PATCH tx update·
// PATCH 재조회(2곳)에서 동일하게 반복되던 것을 단일화(behavior-preserving 리팩터 1단계).
// 3단계에서 트랜잭션 본체가 이 파일로 오면서 라우트와 서비스가 같은 정의를 공유해야 해
// 여기로 옮겼다(라우트가 import 한다 — Next 라우트 파일은 핸들러 외 export 가 불가하다).
export const CAMPAIGN_DETAIL_INCLUDE = {
  deal: { include: { partner: true } },
  campaignDeals: { include: { deal: true } },
  seller: {
    include: {
      agency: true,
      histories: { orderBy: { snapshotDate: "asc" }, take: 12 },
    },
  },
  activities: { orderBy: { createdAt: "desc" }, take: 12 },
  notes: { orderBy: { createdAt: "desc" } },
  checklistItems: { orderBy: [{ status: "asc" }, { sortOrder: "asc" }] },
  settlementItems: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
  group: true,
} satisfies Prisma.SalesCampaignInclude;

export type CampaignDetail = Prisma.SalesCampaignGetPayload<{
  include: typeof CAMPAIGN_DETAIL_INCLUDE;
}>;

/**
 * 정산 부가 항목 쓰기 입력 — 라우트 zod 파싱 결과의 구조적 상위집합.
 * `id` 를 받지 않는 것은 의도다: 전체 교체라 기존 행을 지우고 다시 넣으므로
 * 클라이언트가 id 를 들고 있을 필요가 없다(id 를 받으면 "남의 캠페인 행 id 를
 * 보내면 어떻게 되나"라는 소유권 검증 부담이 생긴다).
 */
export type SettlementItemWriteInput = {
  invoiceMode: SettlementInvoiceMode;
  counterparty: SettlementCounterparty;
  amount: number;
  note?: string | null;
};

/** PATCH 페이로드에서 트랜잭션 본체가 실제로 읽는 필드(zod 파싱 결과의 구조적 상위집합). */
export type CampaignDealInput = {
  id?: string;
  dealId: string;
  quantity: number;
  actualSales: number;
  feeRate?: number | null;
  sellerMarginRate?: number | null;
  costPrice?: number | null;
  sellingPrice?: number | null;
};

export type UpdateCampaignData = Omit<
  CampaignUpdateData,
  "status" | "salesChannel" | "salesTask" | "campaignDeals"
> & {
  status?: CampaignStatus;
  salesChannel?: SalesChannel;
  salesTask?: {
    contactChannel?: string | null;
    proposalMessage?: string | null;
    negotiationMemo?: string | null;
    testingMemo?: string | null;
  };
  campaignDeals?: CampaignDealInput[];
  /** 정산 부가 항목 — 보낸 배열이 곧 최종 상태(전체 교체), 생략하면 무변경. */
  settlementItems?: SettlementItemWriteInput[];
  settlementSales?: number | null;
  sellerExpense?: number | null;
  taxExpense?: number | null;
  sellerTaxType?: string | null;
  baseNaverLink?: string;
  assignedTo?: string;
};

/** 라우트가 `previous` 로 부르는 PATCH 이전 행 중 트랜잭션 본체가 읽는 필드. */
export type PreviousCampaignForTransaction = PreviousCampaignForUpdate & {
  settlementSales: DecimalLike;
  sellerExpense: DecimalLike;
  taxExpense: DecimalLike;
  sellerTaxType: string | null;
  seller: { agency: { businessNumber: string | null } | null } | null;
};

/**
 * 2단계 순수 함수(`src/lib/campaign-update-plan.ts`)의 파생 결과 + 라우트가 계산한
 * 인수인계 여부. 서비스는 이 값들을 **다시 계산하지 않는다** — 라우트가 no-op 단락·
 * 검증에 이미 쓴 것과 같은 값이어야 동작이 갈리지 않는다.
 */
export type CampaignUpdatePlan = {
  settlementStates: SettlementStates;
  /** 라우트의 캘린더·활동로그 판정 + 트랜잭션 본체의 만료 재계산 게이트("end date")가 읽는다. */
  changedFields: string[];
  periodChanged: boolean;
  settlementSync: SettlementSync;
  resolvedReturnPeriodEndDate: Date | null | undefined;
  autoStatus: string | undefined;
  isHandoff: boolean;
};

/**
 * 409 프로토콜의 명시화 — 종전에는 "tx 콜백이 null 을 반환하면 라우트가 409" 라는 암묵
 * 규약이었다. 판별 유니온으로 바꿔 호출부가 분기를 놓치지 못하게 한다.
 */
export type UpdateCampaignResult =
  | { ok: true; campaign: CampaignDetail; fannedOutSiblings: number }
  | { ok: false; reason: "membership-changed" };

export const campaignService = {
  async getCampaignsList(params: {
    status?: string | null;
    workspace?: string | null;
    assignedTo?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    sortBy?: string | null;
    sortDir?: "asc" | "desc" | null;
  }) {
    const { status, workspace, assignedTo, startDate, endDate, sortBy, sortDir } = params;

    const where: Record<string, unknown> = {};
    const workspaceStatuses = getWorkspaceStatuses(workspace ?? null);
    if (workspaceStatuses) {
      where.status = { in: workspaceStatuses };
    } else if (status) {
      where.status = status.includes(",") ? { in: status.split(",") } : status;
    }
    if (assignedTo) where.assignedTo = assignedTo;
    if (startDate || endDate) {
      where.startDate = {};
      if (startDate) (where.startDate as Record<string, unknown>).gte = new Date(startDate);
      if (endDate) (where.startDate as Record<string, unknown>).lte = new Date(endDate);
    }

    const orderBy = sortBy
      ? { [sortBy]: sortDir || "asc" }
      : { updatedAt: "desc" as const };

    return campaignRepository.findMany({
      where,
      orderBy,
      include: {
        deal: { include: { partner: true } },
        campaignDeals: { include: { deal: true } },
        seller: {
          include: {
            agency: true,
            histories: { orderBy: { snapshotDate: "asc" }, take: 12 },
          },
        },
        activities: { orderBy: { createdAt: "desc" }, take: 12 },
        notes: { orderBy: { createdAt: "desc" } },
        checklistItems: { orderBy: [{ status: "asc" }, { sortOrder: "asc" }] },
        // 정산 워크스페이스의 재무 카드가 목록 응답만으로 렌더된다(상세를 다시 조회하지
        // 않는다) — 여기 빠지면 부가 항목이 **조용히 빈 배열**로 내려가 카드가 항목을
        // 통째로 못 보여준다. 행 수가 적고 필드가 작아 egress 영향은 checklistItems 수준이다.
        settlementItems: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        group: true,
      },
    });
  },

  async createCampaign(input: CreateCampaignInput, authContext: { userId: string; email: string }) {
    const prisma = getPrisma();
    const [deal, seller] = await Promise.all([
      prisma.deal.findUnique({ where: { id: input.dealId } }),
      prisma.seller.findUnique({ where: { id: input.sellerId } }),
    ]);

    if (!deal || !seller) {
      throw new Error("Deal or seller not found");
    }

    const automaticRate = resolveBaseMargin(
      parseMarginPolicy(deal.baseMarginPolicy),
      input.salesChannel as SalesChannel,
    );
    
    const selectedRate = input.isManualMargin
      ? {
          totalMarginRate: input.totalMarginRate ?? automaticRate.totalMarginRate,
          sellerMarginRate: input.sellerMarginRate ?? automaticRate.sellerMarginRate,
        }
      : automaticRate;
    const rate = withNet(selectedRate);

    const campaignDealsInput = input.campaignDeals || [{
      dealId: input.dealId,
      quantity: 0,
      actualSales: 0,
    }];

    let totalActualSales = 0;
    let totalOrderCount = 0;

    for (const cd of campaignDealsInput) {
      totalActualSales += cd.actualSales;
      totalOrderCount += cd.quantity;
    }

    const createdCampaign = await campaignRepository.createWithDeals(
      {
        dealId: input.dealId,
        sellerId: input.sellerId,
        campaignName: input.campaignName ?? null,
        startDate: new Date(input.startDate),
        endDate: new Date(input.endDate),
        salesChannel: input.salesChannel,
        baseNaverLink: input.baseNaverLink,
        generatedTrackingLink: "pending",
        actualSales: totalActualSales,
        quantity: totalOrderCount,
        totalMarginRate: rate.totalMarginRate,
        sellerMarginRate: rate.sellerMarginRate,
        netMarginRate: rate.netMarginRate,
        status: input.status,
        isManualMargin: input.isManualMargin,
        assignedTo: authContext.userId,
      },
      campaignDealsInput.map(cd => ({
        dealId: cd.dealId,
        quantity: cd.quantity,
        actualSales: cd.actualSales,
        feeRate: cd.feeRate ?? null,
        sellerMarginRate: cd.sellerMarginRate ?? null,
        costPrice: cd.costPrice ?? null,
        sellingPrice: cd.sellingPrice ?? null,
      }))
    );

    const generatedTrackingLink = buildNaverTrackingLink({
      baseUrl: input.baseNaverLink,
      snsType: seller.snsType as SnsType,
      sellerId: seller.id,
      campaignId: createdCampaign.id,
    });

    const updated = await campaignRepository.update(createdCampaign.id, {
      generatedTrackingLink,
    });

    await ensureCampaignChecklistForStatus(
      prisma,
      updated.id,
      updated.status as CampaignStatus,
    );

    await recordCampaignActivity({
      campaignId: updated.id,
      action: "CREATED",
      label: "Campaign created",
      details: `${updated.status} · ${updated.salesChannel}`,
      actor: authContext.userId,
    });

    await prisma.activityLog.create({
      data: {
        entityType: "CAMPAIGN",
        entityId: updated.id,
        type: "CREATE",
        fieldName: "assignedTo",
        newValue: authContext.userId,
        content: `Campaign created and assigned to ${authContext.email}`,
        actor: authContext.userId,
      },
    });

    // Google Drive integration
    const driveName = updated.campaignName || `${deal.dealName} - ${seller.name}`;
    prisma.storageIntegration.findUnique({
      where: { provider: GOOGLE_DRIVE_PROVIDER },
    }).then(async (driveIntegration) => {
      if (driveIntegration?.status === "CONNECTED" && driveIntegration.rootFolderId) {
        await googleDriveProvider.createFolderForEntity({
          entityType: "CAMPAIGN",
          entityId: updated.id,
          entityName: driveName,
          section: "PRODUCT_INTRO",
        });
      }
    }).catch(() => undefined);

    // 리뷰 해석 캐시 리셋(오너 데이터 경로 ②): 새 캠페인이 유효한 공구 단축링크를 가져오면,
    // 해석 실패(FAILED, 7일 TTL)로 잠긴 딜의 캐시만 풀어 다음 collect-reviews 크론이 즉시
    // 재해석하게 한다. RESOLVED는 유지 — 회차 신설은 잦아서 정상 캐시까지 지우면 실행당
    // 해석 상한(REVIEW_RESOLVE_MAX_PER_RUN)만 낭비한다(명시 수정은 PATCH 라우트가 무조건 리셋).
    if (pickShortLink([input.baseNaverLink])) {
      await prisma.dealStoreLink.deleteMany({ where: { dealId: input.dealId, status: "FAILED" } });
    }

    // 차수 및 이름 자동 계산 실행
    await prisma.$transaction(async (tx) => {
      await recalculateCampaignRounds(input.dealId, input.sellerId, tx);
    });

    return campaignRepository.findByIdOrThrow(updated.id);
  },

  /**
   * `PATCH /api/campaigns/[id]` 의 **DB 트랜잭션 본체** — 3계층 이관 3단계.
   *
   * 라우트가 소유하는 것: zod 파싱·검증·인가·previous 조회·no-op 단락·2단계 순수 함수
   * 호출·트랜잭션 이후 전부(캠페인명 재생성·DealStoreLink 리셋·`after()` 캘린더·체크리스트·
   * 드랍 노트·ActivityLog·캐시 무효화·응답 조립). ⚠️ 외부 IO 는 계속 라우트의 `after()` 가
   * 소유한다(`docs/agents/codebase-map.md`) — 이 메서드에 캘린더·메일을 넣지 말 것.
   *
   * 실행 순서는 **불변**이다: 그룹 updateMany → fanOutMemberSchedule → salesTask →
   * campaignDeals → 재무 파생 → 본 update → recomputeGroupRollup.
   */
  async updateCampaign(input: {
    id: string;
    data: UpdateCampaignData;
    previous: PreviousCampaignForTransaction;
    plan: CampaignUpdatePlan;
  }): Promise<UpdateCampaignResult> {
    const { id, data, previous, plan } = input;
    const {
      settlementStates,
      changedFields,
      periodChanged,
      settlementSync,
      resolvedReturnPeriodEndDate,
      autoStatus,
      isHandoff,
    } = plan;
    const { isGrouped, invoiceInfo } = settlementStates;
    const prisma = getPrisma();

    const campaignSharedEventUpdates = {
      ...settlementSync,
      ...(data.supplierInvoiceIssuedAt !== undefined
        ? { supplierInvoiceIssuedAt: data.supplierInvoiceIssuedAt ? new Date(data.supplierInvoiceIssuedAt) : null }
        : {}),
      ...(data.sellerInvoiceIssuedAt !== undefined
        ? { sellerInvoiceIssuedAt: data.sellerInvoiceIssuedAt ? new Date(data.sellerInvoiceIssuedAt) : null }
        : {}),
      ...(data.expectedDepositDate !== undefined
        ? { expectedDepositDate: data.expectedDepositDate ? new Date(data.expectedDepositDate) : null }
        : {}),
      ...(data.expectedPayoutDate !== undefined
        ? { expectedPayoutDate: data.expectedPayoutDate ? new Date(data.expectedPayoutDate) : null }
        : {}),
      ...(data.expectedSupplierPayoutDate !== undefined
        ? { expectedSupplierPayoutDate: data.expectedSupplierPayoutDate ? new Date(data.expectedSupplierPayoutDate) : null }
        : {}),
      ...(data.accountingCompletedAt !== undefined
        ? { accountingCompletedAt: data.accountingCompletedAt ? new Date(data.accountingCompletedAt) : null }
        : {}),
    };
    // ⚠️ 반품기간 종료일은 `campaignSharedEventUpdates`(그룹이면 멤버에 안 쓰는 집합)가 아니라
    // **여기에만** 넣는다 — 멤버 컬럼은 대시보드 카운터가 Prisma `where` 로 직접 읽으므로
    // 계속 써야 하고(팬아웃이 형제까지 맞춘다), 그룹 행은 `campaign-group-row` 표시용 미러다.
    const groupSharedEventUpdates = {
      ...campaignSharedEventUpdates,
      ...(invoiceInfo !== undefined ? { invoiceInfo } : {}),
      ...(resolvedReturnPeriodEndDate !== undefined
        ? { returnPeriodEndDate: resolvedReturnPeriodEndDate }
        : {}),
    };

    // 이번 요청이 형제 멤버 몇 건에 일정을 함께 반영했는가(응답 고지용 — 영속 아님).
    let fannedOutSiblings = 0;

    const campaign = await prisma.$transaction(async (tx) => {
      if (isGrouped && previous.groupId && Object.keys(groupSharedEventUpdates).length > 0) {
        const groupUpdate = await tx.campaignGroup.updateMany({
          where: { id: previous.groupId, members: { some: { id } } },
          data: groupSharedEventUpdates,
        });
        if (groupUpdate.count !== 1) return null;
      }

      // 그룹 일정 통합 연동 — 기간·반품기간은 그룹 스칼라가 아니라 **형제 멤버에 팬아웃**한다
      // (근거는 `fanOutMemberSchedule` 주석: 멤버 컬럼을 직접 읽는 프리필터 3곳).
      // 기간은 **실제로 바뀐 경우에만**(`periodChanged`) 복사한다 — 같은 값이 실려 와도 형제를
      // 건드리지 않는다.
      if (isGrouped && previous.groupId) {
        fannedOutSiblings = await fanOutMemberSchedule(
          previous.groupId,
          id,
          {
            ...(periodChanged && data.startDate ? { startDate: new Date(data.startDate) } : {}),
            ...(periodChanged && data.endDate ? { endDate: new Date(data.endDate) } : {}),
            ...(resolvedReturnPeriodEndDate !== undefined
              ? { returnPeriodEndDate: resolvedReturnPeriodEndDate }
              : {}),
          },
          tx,
        );
      }

      if (data.salesTask !== undefined) {
        const task = await tx.salesTask.findFirst({
          where: { linkedCampaignId: id },
        });
        if (task) {
          await tx.salesTask.update({
            where: { id: task.id },
            data: {
              contactChannel: data.salesTask.contactChannel !== undefined ? data.salesTask.contactChannel : undefined,
              proposalMessage: data.salesTask.proposalMessage !== undefined ? data.salesTask.proposalMessage : undefined,
              negotiationMemo: data.salesTask.negotiationMemo !== undefined ? data.salesTask.negotiationMemo : undefined,
              testingMemo: data.salesTask.testingMemo !== undefined ? data.salesTask.testingMemo : undefined,
            },
          });
        }
      }

      if (data.campaignDeals !== undefined) {
        const existingDeals = await tx.campaignDeal.findMany({ where: { campaignId: id } });
        const incomingDealIds = data.campaignDeals.map((d) => d.dealId);

        // 삭제된 딜 처리
        const dealsToDelete = existingDeals.filter(ed => !incomingDealIds.includes(ed.dealId));
        if (dealsToDelete.length > 0) {
          await tx.campaignDeal.deleteMany({
            where: { id: { in: dealsToDelete.map(d => d.id) } }
          });
        }

        let totalActualSales = 0;
        let totalOrderCount = 0;

        for (const cd of data.campaignDeals) {
          totalActualSales += cd.actualSales;
          totalOrderCount += cd.quantity;

          const existing = existingDeals.find(ed => ed.dealId === cd.dealId);

          if (existing) {
            await tx.campaignDeal.update({
              where: { id: existing.id },
              data: {
                quantity: cd.quantity,
                actualSales: cd.actualSales,
                feeRate: cd.feeRate,
                sellerMarginRate: cd.sellerMarginRate,
                costPrice: cd.costPrice,
                sellingPrice: cd.sellingPrice,
              },
            });
          } else {
            await tx.campaignDeal.create({
              data: {
                campaignId: id,
                dealId: cd.dealId,
                quantity: cd.quantity,
                actualSales: cd.actualSales,
                feeRate: cd.feeRate,
                sellerMarginRate: cd.sellerMarginRate,
                costPrice: cd.costPrice,
                sellingPrice: cd.sellingPrice,
              },
            });
          }
        }

        // ⚠️ 입력 객체를 **의도적으로 변이**시킨다 — 바로 아래 `nextActualSales` 와 본 update 의
        // 스프레드(`data.actualSales !== undefined ...`·`quantity`·`itemCount`)가 이 변이된 값을
        // 읽는다. "변이 후 읽기" 순서가 동작의 일부라 지역 변수로 바꾸지 않는다(이관 3단계 대전제:
        // 동작 변화 0).
        data.actualSales = totalActualSales;
        data.quantity = totalOrderCount;
        data.itemCount = data.campaignDeals.length;
      }

      const nextActualSales =
        data.actualSales !== undefined
          ? data.actualSales
          : previous.actualSales == null
            ? null
            : Number(previous.actualSales.toString());
      const nextOperatingExpense =
        data.operatingExpense !== undefined
          ? Number(data.operatingExpense ?? 0)
          : Number(previous.operatingExpense?.toString() ?? 0);
      const nextMiscExpense = Number(previous.miscExpense?.toString() ?? 0);
      const resolvedMiscExpense =
        data.miscExpense !== undefined ? Number(data.miscExpense ?? 0) : nextMiscExpense;
      const nextTotalMarginRate =
        data.totalMarginRate !== undefined
          ? data.totalMarginRate
          : Number(previous.totalMarginRate?.toString() ?? 0);
      const nextSellerMarginRate =
        data.sellerMarginRate !== undefined
          ? data.sellerMarginRate
          : Number(previous.sellerMarginRate?.toString() ?? 0);
      const nextNetMarginRate = Number((nextTotalMarginRate - nextSellerMarginRate).toFixed(2));

      const nextIsManualSettlementSales =
        data.isManualSettlementSales !== undefined
          ? data.isManualSettlementSales
          : previous.isManualSettlementSales;
      const nextIsManualSellerExpense =
        data.isManualSellerExpense !== undefined
          ? data.isManualSellerExpense
          : previous.isManualSellerExpense;
      const nextIsManualTaxExpense =
        data.isManualTaxExpense !== undefined
          ? data.isManualTaxExpense
          : previous.isManualTaxExpense;

      const nextSettlementSales =
        data.settlementSales !== undefined
          ? (data.settlementSales != null ? Number(data.settlementSales) : null)
          : (previous.settlementSales != null ? Number(previous.settlementSales.toString()) : null);
      const nextSellerExpense =
        data.sellerExpense !== undefined
          ? (data.sellerExpense != null ? Number(data.sellerExpense) : null)
          : (previous.sellerExpense != null ? Number(previous.sellerExpense.toString()) : null);
      const nextTaxExpense =
        data.taxExpense !== undefined
          ? (data.taxExpense != null ? Number(data.taxExpense) : null)
          : (previous.taxExpense != null ? Number(previous.taxExpense.toString()) : null);

      const resolvedSellerTaxType =
        data.sellerTaxType !== undefined ? data.sellerTaxType : previous.sellerTaxType;

      const derivedFinancials =
        nextActualSales == null
          ? {}
          : calculateDerivedCampaignFinancials({
              actualSales: nextActualSales,
              operatingExpense: nextOperatingExpense,
              miscExpense: resolvedMiscExpense,
              totalMarginRate: nextTotalMarginRate,
              sellerMarginRate: nextSellerMarginRate,
              sellerTaxType: resolvedSellerTaxType,
              sellerCompanyBusinessNumber: previous.seller?.agency?.businessNumber ?? null,
              isManualSettlementSales: nextIsManualSettlementSales,
              isManualSellerExpense: nextIsManualSellerExpense,
              isManualTaxExpense: nextIsManualTaxExpense,
              manualSettlementSales: nextSettlementSales,
              manualSellerExpense: nextSellerExpense,
              manualTaxExpense: nextTaxExpense,
            });

      // 개별 품목(option)별 차등 수수료율 보정 로직 주입
      if (nextActualSales != null && "sellerExpense" in derivedFinancials) {
        let dealsList = [];
        if (data.campaignDeals !== undefined) {
          dealsList = data.campaignDeals;
        } else {
          dealsList = await tx.campaignDeal.findMany({ where: { campaignId: id } });
        }

        if (dealsList.length > 0) {
          let calculatedSellerExpenseSum = 0;
          let calculatedTotalMarginSum = 0;
          let calculatedTaxExpenseSum = 0;

          const isIndividual = isIndividualSeller({
            sellerTaxType: resolvedSellerTaxType,
            sellerCompanyBusinessNumber: previous.seller?.agency?.businessNumber ?? null,
          });

          for (const cd of dealsList) {
            const sRate = cd.sellerMarginRate != null ? Number(cd.sellerMarginRate) : nextSellerMarginRate;
            const tRate = cd.feeRate != null ? Number(cd.feeRate) : nextTotalMarginRate;
            const salesVal = cd.actualSales != null ? Number(cd.actualSales.toString()) : 0;

            calculatedTotalMarginSum += Math.round(salesVal * (tRate / 100));

            const sellerBase = getSellerPayoutBase(salesVal, isIndividual);
            const preTaxPayout = Math.round(sellerBase * (sRate / 100));

            if (isIndividual) {
              const tax = calcIndividualIncomeTax(preTaxPayout);
              calculatedTaxExpenseSum += tax;
              calculatedSellerExpenseSum += preTaxPayout;
            } else {
              calculatedSellerExpenseSum += preTaxPayout;
            }
          }

          const financials = derivedFinancials as {
            settlementSales: number;
            sellerExpense: number;
            taxExpense: number;
            operatingProfit: number;
          };

          if (!nextIsManualSettlementSales) {
            financials.settlementSales = calculatedTotalMarginSum;
          }
          if (!nextIsManualSellerExpense) {
            financials.sellerExpense = calculatedSellerExpenseSum;
          }

          const netCommission = financials.settlementSales - financials.sellerExpense;

          if (!nextIsManualTaxExpense) {
            financials.taxExpense = isIndividual
              ? calculatedTaxExpenseSum + Math.round(financials.settlementSales - (financials.settlementSales / 1.1))
              : Math.round(netCommission - (netCommission / 1.1));
          }

          financials.operatingProfit = netCommission - nextOperatingExpense - financials.taxExpense - resolvedMiscExpense;
        }
      }

      const updated = await tx.salesCampaign.update({
        where: { id },
        data: {
          ...(data.status
            ? { status: data.status satisfies CampaignStatus }
            : autoStatus
            ? { status: autoStatus as CampaignStatus }
            : {}),
          ...(data.salesChannel
            ? { salesChannel: data.salesChannel satisfies SalesChannel }
            : {}),
          ...(data.actualSales !== undefined ? { actualSales: data.actualSales } : {}),
          ...(data.operatingExpense !== undefined ? { operatingExpense: data.operatingExpense } : {}),
          ...(data.miscExpense !== undefined ? { miscExpense: data.miscExpense } : {}),
          ...(data.quantity !== undefined ? { quantity: data.quantity } : {}),
          ...(data.itemCount !== undefined ? { itemCount: data.itemCount } : {}),
          ...(data.totalMarginRate != null
            ? { totalMarginRate: data.totalMarginRate }
            : {}),
          ...(data.sellerMarginRate != null
            ? { sellerMarginRate: data.sellerMarginRate }
            : {}),
          netMarginRate: nextNetMarginRate,
          ...(data.isManualMargin != null ? { isManualMargin: data.isManualMargin } : {}),
          ...(data.isManualSettlementSales !== undefined ? { isManualSettlementSales: data.isManualSettlementSales } : {}),
          ...(data.isManualSellerExpense !== undefined ? { isManualSellerExpense: data.isManualSellerExpense } : {}),
          ...(data.isManualTaxExpense !== undefined ? { isManualTaxExpense: data.isManualTaxExpense } : {}),
          ...(data.startDate ? { startDate: new Date(data.startDate) } : {}),
          ...(data.endDate ? { endDate: new Date(data.endDate) } : {}),
          ...(data.roundNumber !== undefined ? { roundNumber: data.roundNumber } : {}),
          ...(data.campaignName !== undefined ? { campaignName: data.campaignName } : {}),
          ...(data.dealId !== undefined ? { dealId: data.dealId } : {}),
          ...(data.sellerId !== undefined ? { sellerId: data.sellerId } : {}),
          ...(data.baseNaverLink !== undefined ? { baseNaverLink: data.baseNaverLink } : {}),
          ...(data.notesFromImport !== undefined && !isGrouped ? { notesFromImport: data.notesFromImport } : {}),
          ...(data.sellerTaxType !== undefined ? { sellerTaxType: data.sellerTaxType } : {}),
          ...(isHandoff ? { assignedTo: data.assignedTo } : {}),
          // 그룹이어도 **멤버 컬럼에 계속 쓴다** — 대시보드 카운터가 이 컬럼을 프리필터로
          // 직접 읽는다(`fanOutMemberSchedule` 주석). 형제 멤버는 위 팬아웃이 맞춘다.
          ...(resolvedReturnPeriodEndDate !== undefined
            ? { returnPeriodEndDate: resolvedReturnPeriodEndDate }
            : {}),
          ...(data.settlementSupplyCost !== undefined ? { settlementSupplyCost: data.settlementSupplyCost } : {}),
          ...(data.settlementGoodsCost !== undefined ? { settlementGoodsCost: data.settlementGoodsCost } : {}),
          ...(!isGrouped ? campaignSharedEventUpdates : {}),
          ...derivedFinancials,
          // 정산 부가 항목 — 전체 교체(deleteMany + createMany)를 **같은 트랜잭션 안에서**
          // 한다. 별도 라우트로 빼면 재무 카드 저장이 두 요청으로 갈려 한쪽만 성공하는
          // 상태가 생긴다(부가 항목은 금액 표시에 직접 들어가므로 그 불일치가 곧 오독이다).
          //
          // ⛔ 그룹 캠페인이어도 **멤버 자신에게만** 쓴다 — 부가 항목은 정산일 계열과 달리
          //    그룹 공유 필드가 아니다. 광고비·반품배송비는 멤버(딜)마다 실제로 다르고,
          //    형제에 팬아웃하면 한 건의 비용이 멤버 수만큼 부풀어 지급·손익이 전부 틀어진다.
          ...(data.settlementItems !== undefined
            ? {
                settlementItems: {
                  deleteMany: {},
                  create: data.settlementItems.map((item, index) => ({
                    // 대상=자사면 방식을 NO_INVOICE 로 정규화한다 — UI 는 자동 전환으로
                    // 막지만 API 직접 호출은 그 게이트를 우회한다(설계 §2-2 보완 ③).
                    invoiceMode: normalizeSettlementItemMode(item.counterparty, item.invoiceMode),
                    counterparty: item.counterparty,
                    amount: item.amount,
                    note: item.note?.trim() ? item.note.trim() : null,
                    sortOrder: index,
                  })),
                },
              }
            : {}),
        },
        include: CAMPAIGN_DETAIL_INCLUDE,
      });

      // 단축링크 만료는 캠페인 종료일을 따라간다 — 종료일이 실제로 바뀐 경우에만 다시 쓴다.
      //
      // ⚠️ 위치가 계약이다. 팬아웃(형제 종료일 복사)과 본 update(원본 종료일 저장)가 **끝난
      // 뒤**라야 `syncCampaignLinkExpiry` 가 읽는 저장값이 전원 최신이다. 앞으로 옮기면 같은
      // 공구의 링크가 서로 다른 날 죽는다 — 그 사실은 링크가 만료된 뒤에야 드러난다.
      // 고정 장치는 `linkExpiryFollowsCampaign.contract.test.ts`.
      if (changedFields.includes("end date")) {
        await syncCampaignLinkExpiry(tx, { campaignId: id, groupId: previous.groupId });
      }

      // 그룹 롤업 재동기화 — 그룹 행의 startDate/endDate 는 멤버 포락선의 비정규화 복사본이고
      // 갱신 주체가 `recomputeGroup`(멤버십 변경 전용)뿐이라, 멤버 기간 수정이 복사본을 낡게
      // 만들었다(prod 실측 2건, 종료 최대 11일 차). 위 정산일 계열이 그룹으로 전파되는 것과
      // 같은 자리에서 기간도 함께 맞춘다. 기간이 실제로 바뀐 경우에만 부른다.
      if (previous.groupId && periodChanged) {
        const rolled = await recomputeGroupRollup(previous.groupId, tx);
        // 위 include 가 롤업 갱신 **전**의 그룹을 담았으므로 응답용으로 교체한다 —
        // 안 하면 저장 직후 화면이 한 박자 낡은 그룹 기간을 보여준다(다음 조회에서야 맞음).
        if (rolled) updated.group = rolled;
      }

      return updated;
    });

    if (!campaign) return { ok: false, reason: "membership-changed" };

    return { ok: true, campaign, fannedOutSiblings };
  },
};

// bulk 생성 라우트와 공유하기 위해 campaignRounds.ts로 이전됨(advisory lock 포함).
// 기존 import 경로(../campaignService)를 쓰는 테스트/호출부 호환을 위해 재수출.
export { recalculateCampaignRounds };
