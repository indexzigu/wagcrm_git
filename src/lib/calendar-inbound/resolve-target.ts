// [캘린더수집] 해석된 일정 의도 → 대상 캠페인·칸·기안 초안.
// 설계 정본: docs/private/specs/2026-10-21-calendar-inbound-sync-design.md §3·§5·§8-b.
//
// ⛔ 기대값(`expected`)을 여기서 따로 계산하지 말 것 — 실행기(`update-record.ts`)가 대조에 쓰는
//    `readRecordSnapshot`·`currentValueOf`·`toComparableValue` 를 그대로 부른다. 묶음(조합) 캠페인의
//    대금 일정·완료 플래그는 묶음 행이 정본이라, 멤버 행 잔존값으로 기안하면 승인 때 늘 「지금 값이
//    기안 때와 다릅니다」로 실패한다.
import type { Prisma, PrismaClient } from "@prisma/client";
import { generateCampaignName } from "@/lib/campaign-name";
import type { CandidateEvent } from "@/lib/google-calendar-sync";
import { recordFieldLabel } from "@/lib/record-update-labels";
import { sellerDisplayName } from "@/lib/seller-display-name";
import { resolveCampaignMoneySlots, type CampaignMoneySlot } from "@/lib/tax-filing-board";
import {
  currentValueOf,
  readRecordSnapshot,
  sameComparable,
  toComparableValue,
  type RecordSnapshot,
} from "@/lib/agent/record-update-entities";
import { updateRecordActionArgsSchema } from "@/lib/agent/write-actions/update-record";
import type { InboundKind, ParsedCalendarIntent } from "./types";

export const WARN_AUTO_LATEST = "가장 최근 회차로 자동 지정";
/** 더 최근 회차의 채널에 그 대금 칸이 없어 이전 회차를 대상으로 잡았을 때. */
export const WARN_SKIPPED_NEWER_ROUND = "최근 회차는 이 칸이 없어 이전 회차로 지정";
export const WARN_CHECK_END_DATE = "종료일 확인 필요";
// ⛔ 화면 문구에 em-dash 를 쓰지 않는다(`ui-copy-em-dash.contract.test.ts`) — 설계서 문구의 「 — 」를 괄호로 바꿨다.
/** 회차 번호는 같은 셀러×판매 조건 안에서 시작일 순서로 다시 매겨진다 — 제목에 적은 N차와 어긋날 수 있다. */
export function warnRoundNumberMayDiffer(round: number | null): string {
  const titled = round === null ? "회차" : `${round}차`;
  return `회차 번호는 시작일 순서로 정해져 일정 제목의 ${titled}와 다를 수 있습니다.`;
}
// adopt=false 면 승인해도 원본 일정을 장부에 넘겨받지 않는다 — 손으로 적은 일정이 캘린더에 그대로 남는다(사실 그대로).
export const WARN_PROPOSAL_NOT_ADOPTED = "이 캠페인은 아직 제안 단계라 승인해도 손으로 적은 캘린더 일정은 그대로 남습니다.";

export type CreateCampaignRoundDraftArgs = { dealId: string; sellerId: string; startDate: string; endDate: string };

export type ProposalDraft = {
  action: "create_campaign_round" | "update_record";
  /** noop 이면 null — 기안을 만들지 않는다. 호출부(스캔)는 처리 끝으로만 적고 장부는 건드리지 않는다. */
  args: unknown;
  title: string;
  targetCampaignId: string | null;
  warnings: string[];
  noop?: true;
  /** 승인 뒤 원본 일정을 장부에 넘겨받을지. 캘린더 비노출 상태(PROPOSAL) 대상이면 false. */
  adopt: boolean;
  ledgerKind: "campaign" | "deposit" | "payout" | "supplierPayout";
};

export type ResolveFailure =
  | { ok: false; reason: "no_campaign" | "no_slot" | "no_deal" }
  /** 초안이 계약·화면 스키마 검사를 통과하지 못했다 — 승인할 수 없는 기안은 올리지 않는다. */
  | { ok: false; reason: "invalid_draft"; detail: string };
export type ResolveResult = { ok: true; draft: ProposalDraft } | ResolveFailure;

type Db = Prisma.TransactionClient | PrismaClient;

/** 대상에서 통째로 빼는 상태 — 드랍된 회차는 고치지도, 딜 출처로 쓰지도 않는다. */
const EXCLUDED_TARGET_STATUS = "DROPPED";
/** 캘린더 비노출 상태 — 넘겨받으면 동기화가 원본 일정을 지운다(설계 §8-b). DROPPED 는 이미 제외. */
const NOT_ADOPTABLE_STATUS = "PROPOSAL";
/** 「활성 딜」 이 아닌 상태. */
const INACTIVE_DEAL_STATUSES = new Set(["ARCHIVED", "DROPPED"]);

/** DROPPED 제외 후 가장 최근 순(startDate desc, 같으면 createdAt desc). */
export function pickRecentCampaigns<T extends { status: string; startDate: Date; createdAt: Date }>(rows: T[]): T[] {
  return rows
    .filter((row) => row.status !== EXCLUDED_TARGET_STATUS)
    .sort(
      (a, b) =>
        b.startDate.getTime() - a.startDate.getTime() || b.createdAt.getTime() - a.createdAt.getTime(),
    );
}

/**
 * 채널의 대금 칸 중 이 일정이 가리키는 칸. 입금 → DEPOSIT 칸. 지급 → 공급사 단어가 있으면
 * `supplierPayout`(있을 때만 — 지급 레그가 둘인 자사몰), 아니면 `payout` 칸(없으면 유일한 지급 칸).
 */
export function pickMoneySlot(
  salesChannel: string,
  kind: Exclude<InboundKind, "campaign">,
  supplierHint: boolean,
): CampaignMoneySlot | null {
  const slots = resolveCampaignMoneySlots(salesChannel);
  if (kind === "deposit") return slots.find((slot) => slot.kind === "DEPOSIT") ?? null;
  const payouts = slots.filter((slot) => slot.kind === "PAYOUT");
  if (supplierHint) {
    const supplier = payouts.find((slot) => slot.key === "supplierPayout");
    if (supplier) return supplier;
  }
  const seller = payouts.find((slot) => slot.key === "payout");
  if (seller) return seller;
  return payouts.length === 1 ? payouts[0] : null;
}

type CampaignRow = {
  id: string;
  dealId: string;
  status: string;
  salesChannel: string;
  roundNumber: number | null;
  campaignName: string | null;
  startDate: Date;
  createdAt: Date;
  deal: { dealName: string };
  seller: { name: string; alias: string | null };
};

function campaignLabel(row: CampaignRow): string {
  if (row.campaignName && row.campaignName.trim() !== "") return row.campaignName;
  return generateCampaignName(row.deal.dealName, sellerDisplayName(row.seller), row.roundNumber) ?? row.id;
}

/**
 * 캠페인 한 건의 칸을 바꾸는 `update_record` 초안. 지금 값은 실행기와 같은 스냅샷(화면 모양)에서 읽고,
 * 이미 같은 칸은 싣지 않는다. 전부 같으면 noop. 계약·화면 스키마 검사를 통과 못 하면 null(승인 못 할
 * 기안을 올리지 않는다).
 */
async function buildUpdateDraft(
  db: Db,
  target: CampaignRow,
  wanted: Record<string, string>,
  ledgerKind: ProposalDraft["ledgerKind"],
  warnings: string[],
): Promise<{ ok: true; draft: ProposalDraft } | ResolveFailure> {
  const snapshot: RecordSnapshot | null = await readRecordSnapshot(db as Prisma.TransactionClient, "CAMPAIGN", target.id);
  if (!snapshot) return { ok: false, reason: "no_campaign" };

  const changes: Record<string, string> = {};
  const expected: Record<string, string | number | boolean | null> = {};
  for (const [field, value] of Object.entries(wanted)) {
    const current = currentValueOf("CAMPAIGN", snapshot, field);
    if (sameComparable(current, value)) continue;
    changes[field] = value;
    expected[field] = toComparableValue(current);
  }

  const adopt = target.status !== NOT_ADOPTABLE_STATUS;
  const allWarnings = adopt ? warnings : [...warnings, WARN_PROPOSAL_NOT_ADOPTED];
  const fieldLabels = Object.keys(Object.keys(changes).length > 0 ? changes : wanted)
    .map((field) => recordFieldLabel("CAMPAIGN", field))
    .join("·");
  const base = {
    action: "update_record" as const,
    // 출처(캘린더)는 카드의 출처 배지가 말한다 — 제목은 무엇을 바꾸는지만.
    title: `${fieldLabels} 변경: ${campaignLabel(target)}`,
    targetCampaignId: target.id,
    warnings: allWarnings,
    adopt,
    ledgerKind,
  };

  if (Object.keys(changes).length === 0) {
    return { ok: true, draft: { ...base, args: null, noop: true } };
  }
  const args = { entityType: "CAMPAIGN" as const, entityId: target.id, changes, expected };
  const parsed = updateRecordActionArgsSchema.safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(args)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: "invalid_draft", detail };
  }
  return { ok: true, draft: { ...base, args } };
}

/**
 * 해석된 일정 → 대상 캠페인·칸·기안 초안(설계 §5·§8-b). 읽기만 한다.
 *
 * - 캠페인 회차: 제목의 N 차와 `roundNumber` 가 같은 회차(N=1 이면 null 도) → 기간 수정, 없으면(또는 N 이
 *   없으면) 새 회차 생성. 새 회차의 딜 = 그 셀러×브랜드의 가장 최근 캠페인 딜, 없으면 활성 딜이 유일할 때만.
 * - 입금·지급: 그 칸이 미완료인 가장 최근 회차(전부 완료면 가장 최근), 칸은 채널 슬롯표가 정한다.
 */
export async function resolveInboundTarget(
  intent: ParsedCalendarIntent,
  event: CandidateEvent,
  db: Db,
): Promise<ResolveResult> {
  const rows = (await db.salesCampaign.findMany({
    where: { sellerId: intent.sellerId, dealId: { in: intent.dealIds } },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      dealId: true,
      status: true,
      salesChannel: true,
      roundNumber: true,
      campaignName: true,
      startDate: true,
      createdAt: true,
      deal: { select: { dealName: true } },
      seller: { select: { name: true, alias: true } },
    },
  })) satisfies CampaignRow[];
  const candidates = pickRecentCampaigns(rows);

  if (intent.kind === "campaign") {
    return resolveCampaignKind(intent, event, db, candidates);
  }
  return resolveMoneyKind(intent.kind, intent.supplierHint, event, db, candidates);
}

async function resolveCampaignKind(
  intent: ParsedCalendarIntent,
  event: CandidateEvent,
  db: Db,
  candidates: CampaignRow[],
): Promise<ResolveResult> {
  const round = intent.round;
  if (round !== null) {
    const matches = candidates.filter(
      (row) => row.roundNumber === round || (round === 1 && row.roundNumber === null),
    );
    if (matches.length > 0) {
      const warnings = matches.length > 1 ? [WARN_AUTO_LATEST] : [];
      // 하루짜리 일정은 종료일을 모르고 적었을 수 있다 — 새 회차와 같은 경고(설계 §5).
      if (event.startDate === event.endDate) warnings.push(WARN_CHECK_END_DATE);
      return buildUpdateDraft(
        db,
        matches[0],
        { startDate: event.startDate, endDate: event.endDate },
        "campaign",
        warnings,
      );
    }
  }

  // 새 회차 — 딜 고르기
  let dealId: string | null = candidates[0]?.dealId ?? null;
  const deals = await db.deal.findMany({
    where: { id: { in: intent.dealIds } },
    select: { id: true, dealName: true, status: true },
  });
  if (!dealId) {
    const active = deals.filter((deal) => !INACTIVE_DEAL_STATUSES.has(deal.status));
    if (active.length === 1) dealId = active[0].id;
  }
  if (!dealId) return { ok: false, reason: "no_deal" };
  const deal = deals.find((x) => x.id === dealId);
  const seller = await db.seller.findUnique({ where: { id: intent.sellerId }, select: { name: true, alias: true } });

  const warnings: string[] = [];
  // 후보가 하나면 고를 것이 없었으므로 경고하지 않는다 — 경고가 붙으면 카드가 「여러 회차 중 하나를 골랐다」로 잘못 읽힌다.
  if (round === null && candidates.length > 1) warnings.push(WARN_AUTO_LATEST);
  if (event.startDate === event.endDate) warnings.push(WARN_CHECK_END_DATE);
  if (round !== null) warnings.push(warnRoundNumberMayDiffer(round));

  const args: CreateCampaignRoundDraftArgs = {
    dealId,
    sellerId: intent.sellerId,
    startDate: event.startDate,
    endDate: event.endDate,
  };
  const sellerName = seller ? sellerDisplayName(seller) : intent.sellerId;
  const dealName = deal?.dealName ?? dealId;
  return {
    ok: true,
    draft: {
      action: "create_campaign_round",
      args,
      title: `새 회차 생성: ${sellerName} · ${dealName} (${event.startDate}~${event.endDate})`,
      targetCampaignId: null,
      warnings,
      // 새 회차는 PREPARATION 으로 생성되므로 넘겨받는다(설계 §3-3).
      adopt: true,
      ledgerKind: "campaign",
    },
  };
}

async function resolveMoneyKind(
  kind: Exclude<InboundKind, "campaign">,
  supplierHint: boolean,
  event: CandidateEvent,
  db: Db,
  candidates: CampaignRow[],
): Promise<ResolveResult> {
  if (candidates.length === 0) return { ok: false, reason: "no_campaign" };

  // 그 칸이 있는 회차만 후보 — 칸 유무는 회차마다 채널이 정한다.
  const withSlot = candidates
    .map((row) => ({ row, slot: pickMoneySlot(row.salesChannel, kind, supplierHint) }))
    .filter((x): x is { row: CampaignRow; slot: CampaignMoneySlot } => x.slot !== null);
  if (withSlot.length === 0) return { ok: false, reason: "no_slot" };

  // 미완료 판정은 화면 모양(묶음이면 묶음 행)의 완료 플래그로 — 실행기와 같은 스냅샷에서 읽는다.
  let chosen: { row: CampaignRow; slot: CampaignMoneySlot } | null = null;
  for (const candidate of withSlot) {
    const snapshot = await readRecordSnapshot(db as Prisma.TransactionClient, "CAMPAIGN", candidate.row.id);
    if (!snapshot) continue;
    if (currentValueOf("CAMPAIGN", snapshot, candidate.slot.flagField) !== true) {
      chosen = candidate;
      break;
    }
  }
  const target = chosen ?? withSlot[0];

  const warnings = candidates.length > 1 ? [WARN_AUTO_LATEST] : [];
  // 더 최근 회차가 이 칸이 없어 건너뛰었으면 드러낸다(조용히 이전 회차를 고치지 않는다).
  const slotIds = new Set(withSlot.map((x) => x.row.id));
  const newerRounds = candidates.slice(0, candidates.findIndex((row) => row.id === target.row.id));
  if (newerRounds.some((row) => !slotIds.has(row.id))) {
    warnings.push(WARN_SKIPPED_NEWER_ROUND);
  }
  return buildUpdateDraft(
    db,
    target.row,
    { [target.slot.expectedField]: event.startDate },
    target.slot.key,
    warnings,
  );
}
