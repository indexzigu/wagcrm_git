import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { updateRecordArgsSchema, updateSettlementAmountArgsSchema } from "@/lib/agent-worker/contracts";
import { settlementTargetFlag } from "@/lib/settlement-status";
import { resolveSettlementCompletionFlags } from "@/lib/tax-filing-board";
import { resolveSettlementFlagSnapshot } from "@/lib/settlement-flag-write";
import {
  currentValueOf,
  isActionOnlyField,
  readRecordSnapshot,
  sameComparable,
} from "./record-update-entities";
import { matchesExpected } from "./write-actions/update-settlement-amount";

/**
 * 실패(FAILED)한 기안이 **다른 경로로 이미 반영됐는가** — 결재함 실패 탭이 「반영완료」 배지와 종결 버튼을 띄우는 근거.
 *
 * 실패 기안은 재시도 말고는 빠져나갈 길이 없어서, 오너가 화면에서 직접 처리한 일도 실패 탭에 계속 남았다.
 * 이 판정은 기안이 바꾸려던 값과 지금 DB 값을 비교해 「이미 그렇게 돼 있다」를 알려 줄 뿐이고 아무것도 쓰지 않는다
 * (종결은 오너가 버튼으로 한다 — `POST /api/action-proposals/[id]/close`).
 *
 * 규칙:
 *  - 비교는 **실행기와 같은 읽기·비교 함수**로 한다(묶음 캠페인은 묶음 행이 정본 — CG-1, 날짜는 KST 달력 날짜,
 *    금액은 Decimal). ⛔ 여기서 플래그 대응이나 날짜 정규화를 다시 쓰지 말 것 — 실행기와 갈리면 배지가 거짓말한다.
 *  - 바꿀 값이 **전부** 같을 때만 true. 판정하지 않는 액션·대상 없음·인자 불량·조회 오류는 false(배지 없음)다 —
 *    「모름」을 「반영완료」으로 읽게 하지 않는다.
 *  - 조회 오류는 목록 전체를 깨지 않도록 여기서 삼키되 로그를 남긴다.
 */
export type AlreadyAppliedDb = Pick<Prisma.TransactionClient, "salesCampaign" | "deal" | "partner" | "seller">;

const confirmSettlementArgsSchema = z.object({
  campaignId: z.string().min(1),
  target: z.enum(["deposit", "payout"]),
});

const payloadSchema = z.object({ action: z.string(), args: z.unknown() });

async function confirmSettlementApplied(args: unknown, db: AlreadyAppliedDb): Promise<boolean> {
  const parsed = confirmSettlementArgsSchema.safeParse(args);
  if (!parsed.success) return false;
  const campaign = await db.salesCampaign.findUnique({
    where: { id: parsed.data.campaignId },
    include: { group: true },
  });
  if (!campaign) return false;
  const flag = settlementTargetFlag(parsed.data.target);
  // 그 판매채널에 이 절차가 없으면(예: 입금 레그 없는 채널의 입금 확정) 애초에 적용할 수 없는 기안이다 —
  // 낡은 플래그가 켜져 있어도 「반영완료」이 아니다(실행기 `isValidSettlementAction` 과 같은 레그 목록).
  if (!resolveSettlementCompletionFlags(campaign.salesChannel).includes(flag)) return false;
  const flags = resolveSettlementFlagSnapshot(campaign, campaign.groupId ? campaign.group : null);
  return flags[flag] === true;
}

async function updateRecordApplied(args: unknown, db: AlreadyAppliedDb): Promise<boolean> {
  const parsed = updateRecordArgsSchema.safeParse(args);
  if (!parsed.success) return false;
  const { entityType, entityId, changes } = parsed.data;
  const fields = Object.keys(changes);
  if (fields.length === 0) return false;
  if (fields.some((field) => isActionOnlyField(entityType, field))) return false;
  const snapshot = await readRecordSnapshot(db as Prisma.TransactionClient, entityType, entityId);
  if (!snapshot) return false;
  return fields.every((field) => sameComparable(currentValueOf(entityType, snapshot, field), changes[field]));
}

async function updateSettlementAmountApplied(args: unknown, db: AlreadyAppliedDb): Promise<boolean> {
  const parsed = updateSettlementAmountArgsSchema.safeParse(args);
  if (!parsed.success) return false;
  const campaign = await db.salesCampaign.findUnique({ where: { id: parsed.data.campaignId } });
  if (!campaign) return false;
  return matchesExpected(campaign[parsed.data.field], parsed.data.newAmountKrw);
}

const DETECTORS: Record<string, (args: unknown, db: AlreadyAppliedDb) => Promise<boolean>> = {
  confirm_settlement: confirmSettlementApplied,
  update_record: updateRecordApplied,
  update_settlement_amount: updateSettlementAmountApplied,
};

export async function detectAlreadyApplied(payload: unknown, db: AlreadyAppliedDb): Promise<boolean> {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return false;
  const detector = DETECTORS[parsed.data.action];
  if (!detector) return false;
  try {
    return await detector(parsed.data.args, db);
  } catch (error) {
    console.error(`[detectAlreadyApplied] ${parsed.data.action} 판정 실패 — 배지 없이 둔다:`, error);
    return false;
  }
}
