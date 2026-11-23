/**
 * 봇 내부 창구 본체 — 판매캠페인 하나의 브랜드 정산 메일(첨부 「피벗」)과 CRM 품목 줄을 옵션 단위로 대조한다
 * (`get_settlement_reconciliation` v1). 봇 작업 실행기에는 메일 자격증명이 없어(`infra/selfhost/run-agent-worker.sh`)
 * 앱이 앱 권한으로 읽고, 봇은 결과 한 장만 받는다. **아무것도 쓰지 않는다.**
 *
 * 순서:
 *  1. 캠페인 단위(그룹이면 멤버 전부)의 셀러 이름·거래처 이름·기간·품목 줄·하위품목·매핑을 읽는다.
 *  2. 메일함을 기간(시작 −3일 ~ 종료 +60일)으로 읽는다 — 헤더 관문(정산서 제목 · 우리 회신 아님)을 지난 메일 중
 *     제목·보낸 사람 표시에 셀러·거래처 이름이 있는 것을 **먼저**(같으면 최근 순) 6통만 본문·첨부를 받는다
 *     (`scanStatementMailsWithAttachments`). 이름은 순서만 정하고 거르지 않는다 — 셀러 이름이 본문(프로모션명)에만 있는
 *     정산서가 있다(코드 리뷰 2026-11-23). 넘친 후보는 「못 본 후보」로 일부만 확인이 된다.
 *  3. 본문으로 「이 캠페인 것인가」를 가른다 — 정산서 화면·크론과 **같은 판정**(`statementFromCounterpart` ·
 *     `statementMentionsUnit` · 다른 셀러 이름도 걸리면 뺀다 = `collectStatementExpectations` 의 `otherUnitsLabels` 규칙).
 *  4. 첨부의 「피벗」만 읽는다(`readStatementPivot` — 발주서 시트는 해석하지 않는다).
 *  5. 옵션 대조(`reconcileSettlement`).
 *
 * ⛔ 결과·실패에는 고정 낱말과 화이트리스트 칸만 싣는다 — 셀 값·제목·보낸 사람·파일 이름·라이브러리 오류 문구를 싣지
 *    않고, console.* 로 데이터를 남기지 않는다. 예외는 전부 고정 코드(RECONCILE_FAILED)가 된다.
 */
import type { PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { toKstYmd } from "@/lib/date-utils";
import { statementFromCounterpart, statementMentionsUnit } from "@/lib/campaign-invoices";
import { sellerLabelsOf } from "@/services/campaignInvoiceService";
import {
  scanStatementMailsWithAttachments,
  type StatementAttachmentMail,
  type StatementAttachmentScanResult,
} from "@/lib/tax-invoice-mail/brand-statement-scan";
import { MAX_STATEMENT_ATTACHMENT_BYTES, readStatementPivot, type PivotRow } from "@/lib/tax-invoice-mail/statement-pivot-xls";
import {
  MAX_RECON_MAILS,
  reconcileSettlement,
  settlementReconciliationDataSchema,
  type ReconCatalog,
  type ReconMail,
  type SettlementReconciliationData,
} from "@/lib/tax-invoice-mail/settlement-reconcile";
import { agentInternalFailure, type AgentInternalFailure } from "./api-contract";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 메일 조회 기간 — 캠페인 시작 3일 전부터(사전 안내) 종료 60일 뒤까지(월정산 다음 달 메일). */
export const RECON_MAIL_LEAD_DAYS = 3;
export const RECON_MAIL_TAIL_DAYS = 60;
/** 창구 안 시간 예산 — 부르는 쪽 시간 제한(60초, `internal-api-client.ts`) 안에 결과를 돌려주려고. */
export const RECON_SCAN_BUDGET_MS = 35_000;

export type ReconUnit = {
  campaignId: string;
  sellerLabels: string[];
  counterpartLabel: string;
  periodStart: Date;
  periodEnd: Date;
  /** 같은 거래처와 기간이 겹치는 **다른 셀러**들의 이름 묶음 — 그 이름도 걸린 메일은 어느 쪽 것인지 모른다 */
  otherSellerLabels: string[][];
  /** 같은 거래처·같은 셀러의 다른 회차 중 메일 기간이 겹치는 수 */
  overlappingRounds: number;
  catalog: ReconCatalog;
};

export type SettlementReconciliationDeps = {
  loadUnit: (campaignId: string) => Promise<ReconUnit | null>;
  scan: typeof scanStatementMailsWithAttachments;
};

type ReconClient = Pick<PrismaClient, "salesCampaign" | "campaignDeal" | "deal" | "productMapping">;

const EXCLUDED_STATUSES = ["DROPPED", "PROPOSAL"];

/**
 * 캠페인 단위 읽기(앱 권한). 그룹 캠페인은 멤버 전부가 한 단위다 — 정산 메일 한 통이 그룹 옵션을 다 담는다.
 * 행을 펼쳐 넘기지 않고 쓰는 칸만 고른다(원가·마진 칸은 읽지 않는다).
 */
export async function loadReconUnit(db: ReconClient, campaignId: string): Promise<ReconUnit | null> {
  const campaignSelect = {
    id: true,
    groupId: true,
    dealId: true,
    startDate: true,
    endDate: true,
    orderCampaignId: true,
  } as const;
  const campaign = await db.salesCampaign.findUnique({
    where: { id: campaignId },
    select: {
      ...campaignSelect,
      sellerId: true,
      seller: { select: { name: true, alias: true } },
      deal: { select: { partnerId: true, partner: { select: { name: true } } } },
    },
  });
  if (!campaign) return null;
  const members = campaign.groupId
    ? await db.salesCampaign.findMany({ where: { groupId: campaign.groupId }, select: campaignSelect, orderBy: { id: "asc" } })
    : [campaign];
  const memberIds = members.map((member) => member.id);
  const mainDealIds = [...new Set(members.map((member) => member.dealId))];
  const orderCampaignIds = [...new Set(members.map((member) => member.orderCampaignId).filter((id): id is string => Boolean(id)))];
  const periodStart = new Date(Math.min(...members.map((member) => member.startDate.getTime())));
  const periodEnd = new Date(Math.max(...members.map((member) => member.endDate.getTime())));
  const partnerId = campaign.deal?.partnerId ?? null;
  const windowStart = new Date(periodStart.getTime() - RECON_MAIL_LEAD_DAYS * DAY_MS);
  const windowEnd = new Date(periodEnd.getTime() + RECON_MAIL_TAIL_DAYS * DAY_MS);

  const [lines, mainDeals, optionDeals, mappings, neighbours] = await Promise.all([
    db.campaignDeal.findMany({ where: { campaignId: { in: memberIds } }, select: { id: true, dealId: true, quantity: true } }),
    db.deal.findMany({ where: { id: { in: mainDealIds } }, select: { id: true, dealName: true } }),
    db.deal.findMany({
      where: { parentDealId: { in: mainDealIds }, dealType: "OPTION" },
      select: { id: true, parentDealId: true, dealName: true },
    }),
    orderCampaignIds.length > 0
      ? db.productMapping.findMany({
          where: { campaignId: { in: orderCampaignIds } },
          select: { optionName: true, campaignDealId: true },
        })
      : Promise.resolve([]),
    // 같은 거래처의 다른 캠페인 중 메일이 이 기간에 올 수 있는 것: 그쪽 [시작, 종료 + 60일] 이 이쪽 기간과 겹친다.
    partnerId
      ? db.salesCampaign.findMany({
          where: {
            id: { notIn: memberIds },
            deal: { partnerId },
            status: { notIn: EXCLUDED_STATUSES },
            startDate: { lte: windowEnd },
            endDate: { gte: new Date(windowStart.getTime() - RECON_MAIL_TAIL_DAYS * DAY_MS) },
          },
          select: { id: true, groupId: true, sellerId: true, seller: { select: { name: true, alias: true } } },
        })
      : Promise.resolve([]),
  ]);

  const sameSellerRounds = new Set(
    neighbours.filter((other) => other.sellerId === campaign.sellerId).map((other) => other.groupId ?? other.id),
  );
  const otherSellerLabels = [
    ...new Map(
      neighbours
        .filter((other) => other.sellerId !== campaign.sellerId)
        .map((other) => [other.sellerId, sellerLabelsOf(other.seller)] as const),
    ).values(),
  ].filter((labels) => labels.length > 0);

  return {
    campaignId: campaign.id,
    sellerLabels: sellerLabelsOf(campaign.seller),
    counterpartLabel: campaign.deal?.partner?.name?.trim() ?? "",
    periodStart,
    periodEnd,
    otherSellerLabels,
    overlappingRounds: sameSellerRounds.size,
    catalog: {
      mainDeals: mainDeals.map((deal) => ({ id: deal.id, name: deal.dealName })),
      optionDeals: optionDeals
        .filter((deal): deal is typeof deal & { parentDealId: string } => deal.parentDealId !== null)
        .map((deal) => ({ id: deal.id, parentDealId: deal.parentDealId, name: deal.dealName })),
      lines: lines.map((line) => ({ id: line.id, dealId: line.dealId, quantity: line.quantity })),
      mappings,
    },
  };
}

const defaultDeps: SettlementReconciliationDeps = {
  loadUnit: (campaignId) => loadReconUnit(getPrisma(), campaignId),
  scan: scanStatementMailsWithAttachments,
};

/**
 * 본문을 받을 순서의 우선도 — 제목·보낸 사람 표시에 셀러 이름(2) · 거래처 이름(1). 판정이 아니라 순서다(같은 낱말 비교
 * `statementMentionsUnit` 을 재사용한다). 결정은 본문 판정(`judgeMail`)이 한다.
 */
export function headerPriority(header: { subject: string; from: string }, unit: Pick<ReconUnit, "sellerLabels" | "counterpartLabel">): number {
  const text = { promotionLabel: header.from, subject: header.subject };
  return (statementMentionsUnit(text, unit.sellerLabels) ? 2 : 0) + (statementMentionsUnit(text, [unit.counterpartLabel]) ? 1 : 0);
}

/** 정산서가 말하는 정산 달 — 이월 블록이 있으면 가장 늦은 달. */
function statementMonth(mail: StatementAttachmentMail): string | null {
  const months = (mail.statement?.invoices ?? []).map((invoice) => invoice.yearMonth).filter((m) => /^\d{4}-\d{2}$/.test(m));
  return months.length > 0 ? [...months].sort()[months.length - 1] : null;
}

type MailJudgment =
  | { kind: "skip" }
  | { kind: "unparsed" }
  | { kind: "ambiguous" }
  | { kind: "unreadable" }
  | { kind: "layout" }
  | { kind: "mail"; mail: ReconMail };

function judgeMail(mail: StatementAttachmentMail, unit: ReconUnit): MailJudgment {
  const statement = mail.statement;
  const yearMonth = statementMonth(mail);
  if (!statement || !yearMonth) return { kind: "unparsed" };
  // 이 캠페인 거래처가 보낸 것 · 이 셀러 이름이 걸린 것만(정산서 화면·크론과 같은 판정).
  if (!statementFromCounterpart(statement, unit.counterpartLabel)) return { kind: "skip" };
  if (!statementMentionsUnit(statement, unit.sellerLabels)) return { kind: "skip" };
  if (unit.otherSellerLabels.some((labels) => statementMentionsUnit(statement, labels))) return { kind: "ambiguous" };

  const base = { key: mail.messageKey, yearMonth, receivedDate: toKstYmd(mail.receivedAt) };
  if (mail.spreadsheets.length === 0) {
    return mail.oversized > 0 ? { kind: "unreadable" } : { kind: "mail", mail: { ...base, source: "NONE", rows: null } };
  }
  let layoutChanged = false;
  for (const content of mail.spreadsheets) {
    const read = readStatementPivot(content);
    if (read.ok) return { kind: "mail", mail: { ...base, source: "XLS", rows: read.rows as PivotRow[] } };
    if (read.code === "SHEET_LAYOUT_CHANGED") layoutChanged = true;
  }
  return layoutChanged ? { kind: "layout" } : { kind: "unreadable" };
}

function scanFailure(result: Extract<StatementAttachmentScanResult, { ok: false }>): AgentInternalFailure {
  return result.code === "MAIL_NOT_CONFIGURED"
    ? agentInternalFailure("MAIL_NOT_CONFIGURED", "CRM 앱에 메일 수신 설정이 없습니다.")
    : agentInternalFailure("MAIL_FETCH_FAILED", "메일함을 읽지 못했습니다. 잠시 뒤 다시 조회해 주세요.");
}

export type SettlementReconciliationResult = { ok: true; data: SettlementReconciliationData } | AgentInternalFailure;

async function run(campaignId: string, deps: SettlementReconciliationDeps): Promise<SettlementReconciliationResult> {
  const unit = await deps.loadUnit(campaignId);
  if (!unit) return agentInternalFailure("CAMPAIGN_NOT_FOUND", "판매캠페인을 찾을 수 없습니다.");
  if (unit.sellerLabels.length === 0 || unit.counterpartLabel === "") {
    return agentInternalFailure("STATEMENT_NOT_FOUND", "셀러 이름이나 거래처 이름이 없어 정산 메일을 고를 수 없습니다.");
  }

  const scan = await deps.scan({
    since: new Date(unit.periodStart.getTime() - RECON_MAIL_LEAD_DAYS * DAY_MS),
    before: new Date(unit.periodEnd.getTime() + (RECON_MAIL_TAIL_DAYS + 1) * DAY_MS),
    priority: (header) => headerPriority(header, unit),
    maxMessages: MAX_RECON_MAILS,
    maxAttachmentBytes: MAX_STATEMENT_ATTACHMENT_BYTES,
    budgetMs: RECON_SCAN_BUDGET_MS,
  });
  if (!scan.ok) return scanFailure(scan);

  const mails: ReconMail[] = [];
  let truncated = scan.truncated;
  let unreadable = 0;
  let ambiguous = 0;
  for (const scanned of scan.mails) {
    const judged = judgeMail(scanned, unit);
    if (judged.kind === "layout") {
      // 양식이 바뀌었으면 멈춘다 — 짐작으로 읽지 않는다.
      return agentInternalFailure("SHEET_LAYOUT_CHANGED", "정산 메일 첨부의 피벗 표 양식이 바뀌어 읽지 않았습니다.");
    }
    if (judged.kind === "unparsed") truncated += 1;
    else if (judged.kind === "ambiguous") ambiguous += 1;
    else if (judged.kind === "unreadable") unreadable += 1;
    else if (judged.kind === "mail") mails.push(judged.mail);
  }

  if (mails.length === 0) {
    if (unreadable > 0 && truncated === 0 && ambiguous === 0 && !scan.timedOut) {
      return agentInternalFailure("ATTACHMENT_UNREADABLE", "정산 메일 첨부를 열 수 없습니다(암호·크기·손상).");
    }
    if (unreadable === 0 && truncated === 0 && ambiguous === 0 && !scan.timedOut) {
      return agentInternalFailure("STATEMENT_NOT_FOUND", "이 캠페인의 정산 메일을 찾지 못했습니다.");
    }
  }

  const data = reconcileSettlement({
    campaignId: unit.campaignId,
    mails,
    catalog: unit.catalog,
    scan: { truncated, unreadable, ambiguous, overlappingRounds: unit.overlappingRounds, timedOut: scan.timedOut },
  });
  if (data.mails.length === 0 && !data.partial) {
    return agentInternalFailure("STATEMENT_NOT_FOUND", "이 캠페인의 정산 메일을 찾지 못했습니다.");
  }
  const parsed = settlementReconciliationDataSchema.safeParse(data);
  if (!parsed.success) return agentInternalFailure("RECONCILE_FAILED", "정산 대조 결과를 만들지 못했습니다.");
  return { ok: true, data: parsed.data };
}

/** 창구 본체 — 어떤 예외도 고정 코드로 바꾼다(오류 문구에 메일·셀 값이 섞일 수 있다). */
export async function getSettlementReconciliation(
  campaignId: string,
  deps: SettlementReconciliationDeps = defaultDeps,
): Promise<SettlementReconciliationResult> {
  try {
    return await run(campaignId, deps);
  } catch {
    return agentInternalFailure("RECONCILE_FAILED", "정산 대조 중 오류가 났습니다.");
  }
}
