/**
 * 캠페인 계산서 여러 장(T-240 후속) 조회·쓰기·완료 게이트 SSOT.
 *
 * 판정은 `src/lib/campaign-invoices.ts` 가 소유한다. 여기는 DB 와 그 판정을 잇는다.
 *
 * 규칙:
 * - 대상은 공급사가 월정산(`Partner.monthlySettlement`)인 캠페인뿐이다. 그 외 캠페인은 지금까지의
 *   단일 날짜 칸 그대로다(`applicable: false`).
 * - 단위 = 그룹이면 멤버 전원, 아니면 캠페인 1건(오너 확정 2026-10-08: 그룹 = 계산서 1장).
 *   행은 확인한 캠페인에 붙고 읽기는 단위 멤버 전원의 행을 모은다.
 * - 「몇 월분」 = 작성일의 달. 화면이 보낸 달을 믿지 않고 작성일에서 다시 정한다.
 * - 쓰기의 근거는 오너의 클릭이다 — 메일 판정만으로 기록하지 않는다(명세 「사람 검수 없는 자동
 *   실행 금지」). 확인 없는 자동 기록은 T-242.
 * - 레거시 날짜(캠페인/그룹 `supplierInvoiceIssuedAt`)는 **모든 달이 끝났고 비어 있을 때만**
 *   기록한다. ⛔ 다른 경로(체크리스트·수취 승인·크론·직접 입력)가 넣은 값은 지우지 않는다 — 이 기능이
 *   그 값을 밀어내면 세무 보드에 「미완」이 되살아난다(반대 검토 2026-10-08 BLOCKER 2). 유일한 예외는
 *   「취소」로 달이 다시 열릴 때 **이 기능이 채운 값과 같은 날짜**를 비우는 것이다(아래 `revertRow`) —
 *   남겨 두면 행이 0개가 된 단위가 레거시 모드로 떨어져 계산서 없이 완료가 통과된다(코드 리뷰 2026-10-08).
 *   전부 「없음」인 단위는 기록할 작성일이 없어 레거시 날짜를 쓰지 않는다(완료 게이트는 통과).
 * - 레거시 모드: 레거시 날짜가 이미 있고 계산서 행이 0개면 지금까지의 단일 날짜 칸을 그대로 보인다
 *   (이 기능 이전에 끝난 캠페인을 「미발견」으로 되살리지 않는다). 완료 게이트도 통과다.
 */
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  buildInvoiceIncompleteMessage,
  formatInvoiceMonth,
  isValidYearMonth,
  listYearMonths,
  nextYearMonth,
  resolveLegacyInvoiceDate,
  resolveSupplierInvoiceDirection,
  summarizeInvoiceRows,
  type CampaignInvoiceRow,
  type CampaignInvoiceView,
  type InvoiceDirection,
  type InvoiceProgress,
} from "@/lib/campaign-invoices";

type Db = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/** 같은 승인번호 동시 저장(더블 클릭 등)은 500 이 아니라 409 로 말한다. */
async function translateDuplicate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new CampaignInvoiceError("같은 승인번호의 계산서가 이미 이 캠페인에 있습니다.", 409);
    }
    throw error;
  }
}
type InvoiceRecord = Prisma.CampaignInvoiceGetPayload<object>;

export class CampaignInvoiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CampaignInvoiceError";
  }
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 저장된 작성일은 `YYYY-MM-DDT00:00:00Z`(수취 승인·크론과 같은 규약) — 날짜 부분이 곧 KST 날짜다. */
function toYmd(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function fromYmd(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function toInvoiceRowDto(row: InvoiceRecord): CampaignInvoiceRow {
  return {
    id: row.id,
    campaignId: row.campaignId,
    direction: row.direction as InvoiceDirection,
    yearMonth: row.yearMonth,
    status: row.status as CampaignInvoiceRow["status"],
    writtenAt: toYmd(row.writtenAt),
    approvalNo: row.approvalNo,
    supplyAmount: row.supplyAmount,
    taxAmount: row.taxAmount,
    totalAmount: row.totalAmount,
    itemName: row.itemName,
    source: row.source as CampaignInvoiceRow["source"],
    mailReceivedAt: row.mailReceivedAt?.toISOString() ?? null,
    note: row.note,
  };
}

type InvoiceUnit = {
  campaignId: string;
  groupId: string | null;
  memberIds: string[];
  direction: InvoiceDirection;
  periodStart: Date;
  periodEnd: Date;
  legacyDate: Date | null;
  counterpartBusinessNumber: string | null;
  counterpartLabel: string;
};

/** 월정산 단위를 읽는다. 월정산이 아니면 null. */
async function loadInvoiceUnit(db: Db, campaignId: string): Promise<InvoiceUnit | null> {
  const campaign = await db.salesCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      salesChannel: true,
      groupId: true,
      supplierInvoiceIssuedAt: true,
      group: { select: { supplierInvoiceIssuedAt: true } },
      deal: { select: { partner: { select: { name: true, businessNumber: true, monthlySettlement: true } } } },
    },
  });
  if (!campaign) throw new CampaignInvoiceError("캠페인을 찾을 수 없습니다.", 404);
  const partner = campaign.deal?.partner;
  if (!partner?.monthlySettlement) return null;

  const members = campaign.groupId
    ? await db.salesCampaign.findMany({
        where: { groupId: campaign.groupId },
        select: { id: true, startDate: true, endDate: true },
        orderBy: { id: "asc" },
      })
    : [{ id: campaign.id, startDate: campaign.startDate, endDate: campaign.endDate }];

  // 그룹 기간은 멤버 기간의 포락선이다(그룹 스칼라 복사본은 정본이 아니다 — schema.prisma 주석).
  const periodStart = new Date(Math.min(...members.map((m) => m.startDate.getTime())));
  const periodEnd = new Date(Math.max(...members.map((m) => m.endDate.getTime())));

  return {
    campaignId: campaign.id,
    groupId: campaign.groupId,
    memberIds: members.map((m) => m.id),
    direction: resolveSupplierInvoiceDirection(campaign.salesChannel),
    periodStart,
    periodEnd,
    // CG-1: 그룹 소속이면 그룹 값이 정본이다.
    legacyDate: campaign.groupId ? (campaign.group?.supplierInvoiceIssuedAt ?? null) : campaign.supplierInvoiceIssuedAt,
    counterpartBusinessNumber: partner.businessNumber,
    counterpartLabel: partner.name,
  };
}

async function loadUnitRows(db: Db, unit: InvoiceUnit): Promise<InvoiceRecord[]> {
  return db.campaignInvoice.findMany({
    where: { campaignId: { in: unit.memberIds }, direction: unit.direction },
    orderBy: [{ yearMonth: "asc" }, { createdAt: "asc" }],
  });
}

function isLegacyMode(unit: InvoiceUnit, rows: readonly InvoiceRecord[]): boolean {
  return unit.legacyDate !== null && !rows.some((row) => row.status !== "DISMISSED");
}

/**
 * 계산서를 받을 수 있는 달인가 — 기간의 달 + 종료 뒤 두 달(이월분 정산서가 다음 달에 온다).
 * 그보다 먼 달은 다른 캠페인의 계산서를 잘못 고른 것일 가능성이 커 거부한다.
 */
function assertAcceptableMonth(unit: InvoiceUnit, yearMonth: string) {
  const months = listYearMonths(unit.periodStart, unit.periodEnd);
  const last = nextYearMonth(nextYearMonth(months[months.length - 1]));
  if (yearMonth < months[0] || yearMonth > last) {
    throw new CampaignInvoiceError(
      `${formatInvoiceMonth(yearMonth)}분은 이 캠페인 기간(${formatInvoiceMonth(months[0])}~${formatInvoiceMonth(months[months.length - 1])})과 맞지 않습니다.`,
      409,
    );
  }
}

function yearMonthOf(writtenDate: string): string {
  if (!YMD_RE.test(writtenDate)) throw new CampaignInvoiceError("작성일 형식이 올바르지 않습니다.", 400);
  const yearMonth = writtenDate.slice(0, 7);
  if (!isValidYearMonth(yearMonth)) throw new CampaignInvoiceError("작성일 형식이 올바르지 않습니다.", 400);
  return yearMonth;
}

async function requireUnit(tx: Prisma.TransactionClient, campaignId: string): Promise<InvoiceUnit> {
  const unit = await loadInvoiceUnit(tx, campaignId);
  if (!unit) throw new CampaignInvoiceError("월정산 거래처의 캠페인이 아닙니다.", 409);
  return unit;
}

/**
 * 모든 달이 끝났고 레거시 날짜가 비어 있으면 가장 늦은 작성일을 기록한다. 지우지 않는다.
 * 기존 소비처(세무 보드·정산 목록·메일 엔진의 「이미 기록됨」)가 이 값을 읽으므로 그들이
 * 계산서 여러 장을 몰라도 「끝」을 같은 시점에 알게 된다.
 */
async function rollupLegacyDate(tx: Prisma.TransactionClient, unit: InvoiceUnit) {
  if (unit.legacyDate) return;
  const rows = (await loadUnitRows(tx, unit)).map(toInvoiceRowDto);
  const value = resolveLegacyInvoiceDate({ periodStart: unit.periodStart, periodEnd: unit.periodEnd, rows });
  if (!value) return;
  if (unit.groupId) {
    await tx.campaignGroup.updateMany({
      where: { id: unit.groupId, supplierInvoiceIssuedAt: null },
      data: { supplierInvoiceIssuedAt: fromYmd(value) },
    });
  } else {
    await tx.salesCampaign.updateMany({
      where: { id: unit.campaignId, supplierInvoiceIssuedAt: null },
      data: { supplierInvoiceIssuedAt: fromYmd(value) },
    });
  }
}

async function logActivity(tx: Prisma.TransactionClient, unit: InvoiceUnit, content: string) {
  // ⚠️ `content` 는 사람이 읽는 문장이다 — 타임라인은 모르는 type 의 content 를 그대로 그린다.
  for (const campaignId of unit.memberIds) {
    await tx.activityLog.create({
      data: { entityType: "CAMPAIGN", entityId: campaignId, type: "CAMPAIGN_INVOICE", content },
    });
  }
}

function won(value: number | null): string {
  return value === null ? "" : ` ${value.toLocaleString("ko-KR")}원`;
}

export type ConfirmMailInvoiceInput = {
  issueId: string;
  writtenDate: string;
  supplyAmount: number | null;
  taxAmount: number | null;
  totalAmount: number | null;
  itemName: string | null;
  mailReceivedAt: string | null;
};

export type ManualInvoiceInput = {
  writtenDate: string;
  totalAmount: number | null;
  approvalNo: string | null;
  note: string | null;
};

export const campaignInvoiceService = {
  async getView(campaignId: string): Promise<CampaignInvoiceView> {
    const prisma = getPrisma();
    const unit = await loadInvoiceUnit(prisma, campaignId);
    if (!unit) return { applicable: false };
    const rows = await loadUnitRows(prisma, unit);
    const excluded = await prisma.campaignInvoice.findMany({
      where: {
        approvalNo: { not: null },
        OR: [{ status: "RECORDED" }, { status: "DISMISSED", campaignId: { in: unit.memberIds } }],
      },
      select: { approvalNo: true },
    });
    return {
      applicable: true,
      direction: unit.direction,
      counterpartBusinessNumber: unit.counterpartBusinessNumber,
      counterpartLabel: unit.counterpartLabel,
      periodStart: unit.periodStart.toISOString(),
      periodEnd: unit.periodEnd.toISOString(),
      memberCount: unit.memberIds.length,
      legacyDate: toYmd(unit.legacyDate),
      legacyMode: isLegacyMode(unit, rows),
      rows: rows.map(toInvoiceRowDto),
      excludedIssueIds: [...new Set(excluded.map((row) => row.approvalNo as string))],
    };
  },

  /** 메일에서 찾은 계산서를 오너가 확인 — 이 단위의 그 달 계산서로 기록한다. */
  async confirmMailInvoice(campaignId: string, input: ConfirmMailInvoiceInput) {
    const prisma = getPrisma();
    return translateDuplicate(() => prisma.$transaction(async (tx) => {
      const unit = await requireUnit(tx, campaignId);
      const yearMonth = yearMonthOf(input.writtenDate);
      assertAcceptableMonth(unit, yearMonth);
      const recordedElsewhere = await tx.campaignInvoice.findFirst({
        where: { approvalNo: input.issueId, status: "RECORDED" },
        select: { campaignId: true },
      });
      if (recordedElsewhere) {
        throw new CampaignInvoiceError(
          unit.memberIds.includes(recordedElsewhere.campaignId)
            ? "이미 기록한 계산서입니다."
            : "이 계산서는 다른 캠페인에 이미 기록되어 있습니다.",
          409,
        );
      }
      // 「이 메일이 아님」으로 뺐던 계산서를 다시 고른 경우 — 제외 행을 걷어낸다(같은 승인번호 유일 제약).
      await tx.campaignInvoice.deleteMany({
        where: { campaignId: { in: unit.memberIds }, approvalNo: input.issueId, status: "DISMISSED" },
      });
      const row = await tx.campaignInvoice.create({
        data: {
          campaignId,
          direction: unit.direction,
          yearMonth,
          status: "RECORDED",
          writtenAt: fromYmd(input.writtenDate),
          approvalNo: input.issueId,
          supplyAmount: input.supplyAmount,
          taxAmount: input.taxAmount,
          totalAmount: input.totalAmount,
          itemName: input.itemName,
          source: "MAIL",
          mailReceivedAt: input.mailReceivedAt ? new Date(input.mailReceivedAt) : null,
        },
      });
      await logActivity(tx, unit, `${formatInvoiceMonth(yearMonth)}분 공급사 계산서를 메일에서 확인해 기록했습니다(작성일 ${input.writtenDate}${won(input.totalAmount)}).`);
      await rollupLegacyDate(tx, unit);
      return toInvoiceRowDto(row);
    }));
  },

  /** 메일에 없는 계산서를 직접 입력. 작성일은 필수다(오늘 날짜로 대신 찍지 않는다). */
  async recordManualInvoice(campaignId: string, input: ManualInvoiceInput) {
    const prisma = getPrisma();
    return translateDuplicate(() => prisma.$transaction(async (tx) => {
      const unit = await requireUnit(tx, campaignId);
      const yearMonth = yearMonthOf(input.writtenDate);
      assertAcceptableMonth(unit, yearMonth);
      const approvalNo = input.approvalNo?.trim() || null;
      if (approvalNo) {
        const duplicate = await tx.campaignInvoice.findFirst({
          where: { approvalNo, status: "RECORDED" },
          select: { id: true },
        });
        if (duplicate) throw new CampaignInvoiceError("같은 승인번호의 계산서가 이미 기록되어 있습니다.", 409);
        // 「이 메일이 아님」으로 뺐던 그 계산서를 직접 입력하는 경우 — 제외 기록을 걷어낸다(유일 제약).
        await tx.campaignInvoice.deleteMany({
          where: { campaignId: { in: unit.memberIds }, approvalNo, status: "DISMISSED" },
        });
      }
      const row = await tx.campaignInvoice.create({
        data: {
          campaignId,
          direction: unit.direction,
          yearMonth,
          status: "RECORDED",
          writtenAt: fromYmd(input.writtenDate),
          approvalNo,
          totalAmount: input.totalAmount,
          source: "MANUAL",
          note: input.note?.trim() || null,
        },
      });
      await logActivity(tx, unit, `${formatInvoiceMonth(yearMonth)}분 공급사 계산서를 직접 입력했습니다(작성일 ${input.writtenDate}${won(input.totalAmount)}).`);
      await rollupLegacyDate(tx, unit);
      return toInvoiceRowDto(row);
    }));
  },

  /** 「이 달은 계산서 없음」 — 그 달 줄은 지우지 않고 「없음」으로 남긴다(오너 결정 2026-10-08). */
  async waiveMonth(campaignId: string, yearMonth: string, note: string | null) {
    if (!isValidYearMonth(yearMonth)) throw new CampaignInvoiceError("달 형식이 올바르지 않습니다.", 400);
    const prisma = getPrisma();
    return prisma.$transaction(async (tx) => {
      const unit = await requireUnit(tx, campaignId);
      assertAcceptableMonth(unit, yearMonth);
      const existing = await tx.campaignInvoice.findFirst({
        where: {
          campaignId: { in: unit.memberIds },
          direction: unit.direction,
          yearMonth,
          status: { in: ["RECORDED", "WAIVED"] },
        },
        select: { status: true },
      });
      if (existing?.status === "RECORDED") {
        throw new CampaignInvoiceError("이 달에는 이미 기록한 계산서가 있습니다. 먼저 기록을 취소해 주세요.", 409);
      }
      if (existing?.status === "WAIVED") throw new CampaignInvoiceError("이미 「없음」으로 표시한 달입니다.", 409);
      const row = await tx.campaignInvoice.create({
        data: {
          campaignId,
          direction: unit.direction,
          yearMonth,
          status: "WAIVED",
          source: "MANUAL",
          note: note?.trim() || null,
        },
      });
      await logActivity(tx, unit, `${formatInvoiceMonth(yearMonth)}분은 공급사 계산서를 끊지 않는 달로 표시했습니다.`);
      await rollupLegacyDate(tx, unit);
      return toInvoiceRowDto(row);
    });
  },

  /** 「이 메일이 아님」 — 이 단위의 후보에서 그 계산서를 뺀다(다른 캠페인에는 계속 후보로 뜬다). */
  async dismissMailInvoice(campaignId: string, issueId: string, writtenDate: string) {
    const prisma = getPrisma();
    return prisma.$transaction(async (tx) => {
      const unit = await requireUnit(tx, campaignId);
      const yearMonth = yearMonthOf(writtenDate);
      const existing = await tx.campaignInvoice.findFirst({
        where: { campaignId: { in: unit.memberIds }, approvalNo: issueId },
        select: { id: true },
      });
      if (existing) return null;
      const row = await tx.campaignInvoice.create({
        data: { campaignId, direction: unit.direction, yearMonth, status: "DISMISSED", approvalNo: issueId, source: "MAIL" },
      });
      return toInvoiceRowDto(row);
    });
  },

  /**
   * 기록·「없음」·제외를 취소한다. 모든 달이 끝나 이 기능이 레거시 날짜를 채운 뒤 한 달을 취소하면,
   * 레거시 날짜가 **그때 채운 값과 같을 때만** 비운다(헤더 규칙의 유일한 예외) — 그러지 않으면
   * 한 달짜리 캠페인은 행이 0개가 되어 레거시 모드로 떨어지고 계산서 없이 완료가 통과된다.
   */
  async revertRow(campaignId: string, rowId: string) {
    const prisma = getPrisma();
    return prisma.$transaction(async (tx) => {
      const unit = await requireUnit(tx, campaignId);
      const row = await tx.campaignInvoice.findFirst({
        where: { id: rowId, campaignId: { in: unit.memberIds } },
      });
      if (!row) throw new CampaignInvoiceError("취소할 기록을 찾을 수 없습니다.", 404);
      const rollupBefore = resolveLegacyInvoiceDate({
        periodStart: unit.periodStart,
        periodEnd: unit.periodEnd,
        rows: (await loadUnitRows(tx, unit)).map(toInvoiceRowDto),
      });
      await tx.campaignInvoice.delete({ where: { id: row.id } });
      if (rollupBefore && row.status !== "DISMISSED" && toYmd(unit.legacyDate) === rollupBefore) {
        const where = { supplierInvoiceIssuedAt: fromYmd(rollupBefore) };
        if (unit.groupId) {
          await tx.campaignGroup.updateMany({ where: { id: unit.groupId, ...where }, data: { supplierInvoiceIssuedAt: null } });
        } else {
          await tx.salesCampaign.updateMany({ where: { id: unit.campaignId, ...where }, data: { supplierInvoiceIssuedAt: null } });
        }
      }
      if (row.status !== "DISMISSED") {
        await logActivity(
          tx,
          unit,
          row.status === "WAIVED"
            ? `${formatInvoiceMonth(row.yearMonth)}분 「계산서 없음」 표시를 취소했습니다.`
            : `${formatInvoiceMonth(row.yearMonth)}분 공급사 계산서 기록을 취소했습니다.`,
        );
      }
      return toInvoiceRowDto(row);
    });
  },

  /**
   * 완료 게이트 — 이 캠페인을 지금 정산 완료로 바꾸면 안 되는가. 막히면 오너에게 보일 문구를 준다.
   * 월정산이 아닌 거래처·레거시 모드면 언제나 통과(기존 동작 그대로).
   */
  async findCompletionBlocker(db: Db, campaignId: string): Promise<string | null> {
    const blocked = await this.findCompletionBlockers(db, [campaignId]);
    return blocked.get(campaignId) ?? null;
  },

  /**
   * 자동 전이 게이트 — 입금·지급 플래그가 부른 「정산 완료」 자동 전이를 계산서가 막으면 상태 전이만
   * 보류한다(플래그는 호출부가 그대로 저장). 세 경로(캠페인 PATCH · 정산 토글 · 어시스턴트 확정)가
   * 이 한 함수를 지나야 「보류」의 모양이 갈라지지 않는다.
   */
  async gateAutoCompletion(
    db: Db,
    campaignId: string,
    previousStatus: string,
    autoStatus: string | null | undefined,
  ): Promise<{ status: string | undefined; blockedReason: string | null }> {
    if (autoStatus !== "COMPLETED" || previousStatus === "COMPLETED") {
      return { status: autoStatus ?? undefined, blockedReason: null };
    }
    const blockedReason = await this.findCompletionBlocker(db, campaignId);
    return { status: blockedReason ? undefined : autoStatus, blockedReason };
  },

  /**
   * 여러 캠페인(조합 캠페인 형제) 판정 — 막힌 캠페인 id → 문구. 그룹은 계산서를 공유하므로
   * 멤버 전원이 같은 답을 받는다(전부 막히거나 전부 통과).
   * ⛔ 달이 0개인 단위는 없다(`listYearMonths` 가 최소 1달) — 「줄 0개 = 통과」 같은 공허 판정 금지.
   */
  async findCompletionBlockers(db: Db, campaignIds: readonly string[]): Promise<Map<string, string>> {
    const blocked = new Map<string, string>();
    for (const [campaignId, progress] of await evaluateUnits(db, campaignIds)) {
      if (progress.openMonths.length > 0) blocked.set(campaignId, buildInvoiceIncompleteMessage(progress.openMonths));
    }
    return blocked;
  },

  /**
   * 달별 기록 진행(n/m) — 세무 보드가 월정산 공급사 행을 「끝」으로 볼지 「조회 n/m」으로 그릴지
   * 정한다(T-244). 완료 게이트와 **같은 판정**(`evaluateUnits`)이다 — 둘이 갈라지면 보드에서
   * 사라진 캠페인의 정산 완료가 막히거나 그 반대가 된다.
   * 월정산이 아니거나 레거시 모드인 캠페인은 결과에 없다(그 캠페인은 단일 날짜가 정본).
   */
  async loadInvoiceProgress(db: Db, campaignIds: readonly string[]): Promise<Map<string, InvoiceProgress>> {
    return evaluateUnits(db, campaignIds);
  },
};

/**
 * 캠페인별 달별 기록 요약. 그룹은 계산서를 공유하므로 멤버 전원이 같은 값을 받는다.
 * 월정산이 아닌 캠페인·레거시 모드 단위는 넣지 않는다(기존 단일 날짜 동작 그대로).
 * ⛔ 달이 0개인 단위는 없다(`listYearMonths` 가 최소 1달) — 「줄 0개 = 끝」 같은 공허 판정 금지.
 *
 * 세무 보드가 열릴 때마다 정산 단계의 월정산 캠페인 전부를 본다 — 캠페인마다 조회하면 쌓이는
 * 만큼 느려지므로 **조회 3번**(대상·그룹 멤버·계산서 행)으로 묶는다(코드 리뷰 2026-10-09).
 * 단위 판정 규칙은 `loadInvoiceUnit`·`isLegacyMode` 와 같다 — 여기서 규칙을 바꾸면 그쪽도 바꿀 것.
 */
async function evaluateUnits(db: Db, campaignIds: readonly string[]): Promise<Map<string, InvoiceProgress>> {
  const result = new Map<string, InvoiceProgress>();
  if (campaignIds.length === 0) return result;
  const targets = await db.salesCampaign.findMany({
    where: { id: { in: [...campaignIds] }, deal: { partner: { monthlySettlement: true } } },
    select: {
      id: true,
      groupId: true,
      startDate: true,
      endDate: true,
      salesChannel: true,
      supplierInvoiceIssuedAt: true,
      group: { select: { supplierInvoiceIssuedAt: true } },
    },
  });
  if (targets.length === 0) return result;

  const groupIds = [...new Set(targets.map((t) => t.groupId).filter((id): id is string => id !== null))];
  const groupMembers = groupIds.length
    ? await db.salesCampaign.findMany({
        where: { groupId: { in: groupIds } },
        select: { id: true, groupId: true, startDate: true, endDate: true },
      })
    : [];

  type Member = { id: string; startDate: Date; endDate: Date };
  const membersByUnit = new Map<string, Member[]>();
  for (const member of groupMembers) {
    const list = membersByUnit.get(member.groupId as string) ?? [];
    list.push(member);
    membersByUnit.set(member.groupId as string, list);
  }
  for (const target of targets) if (!target.groupId) membersByUnit.set(target.id, [target]);

  const allMemberIds = [...membersByUnit.values()].flat().map((m) => m.id);
  const rows = await db.campaignInvoice.findMany({
    where: { campaignId: { in: allMemberIds } },
    orderBy: [{ yearMonth: "asc" }, { createdAt: "asc" }],
  });

  const byUnitKey = new Map<string, InvoiceProgress | null>();
  for (const target of targets) {
    const unitKey = target.groupId ?? target.id;
    if (!byUnitKey.has(unitKey)) {
      const members = membersByUnit.get(unitKey) ?? [target];
      const memberIds = new Set(members.map((m) => m.id));
      const direction = resolveSupplierInvoiceDirection(target.salesChannel);
      const unitRows = rows.filter((row) => memberIds.has(row.campaignId) && row.direction === direction);
      // CG-1: 그룹 소속이면 그룹 값이 정본이다.
      const legacyDate = target.groupId ? (target.group?.supplierInvoiceIssuedAt ?? null) : target.supplierInvoiceIssuedAt;
      const legacy = legacyDate !== null && !unitRows.some((row) => row.status !== "DISMISSED");
      byUnitKey.set(
        unitKey,
        legacy
          ? null
          : summarizeInvoiceRows({
              // 그룹 기간은 멤버 기간의 포락선이다(그룹 스칼라 복사본은 정본이 아니다).
              periodStart: new Date(Math.min(...members.map((m) => m.startDate.getTime()))),
              periodEnd: new Date(Math.max(...members.map((m) => m.endDate.getTime()))),
              rows: unitRows.map(toInvoiceRowDto),
            }),
      );
    }
    const progress = byUnitKey.get(unitKey);
    if (progress) result.set(target.id, progress);
  }
  return result;
}
