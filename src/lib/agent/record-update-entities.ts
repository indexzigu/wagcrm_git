/**
 * 「기록 수정」(`update_record`)의 엔티티별 연결표 — **화면 저장과 같은 스키마·같은 함수**를 가리킨다.
 *
 * 오너 결정(2026-10-14): 봇이 고칠 수 있는 칸을 따로 정하지 않는다 — 화면에서 오너가 고칠 수 있는
 * 칸이면 기안할 수 있고, 오너가 승인하면 반영된다. 그래서 이 파일에는 칸 목록이 없다:
 *  - 값 검사 = 그 엔티티의 PATCH 요청 스키마(`updateCampaignSchema` 등)를 `.strict()` 로 그대로.
 *  - 반영 = 그 PATCH 라우트가 부르는 본체(`applyCampaignPatch`·`dealService.updateDeal`·
 *    `PartnerService.updatePartner`·`applySellerPatch`)를 승인 트랜잭션 안에서 그대로.
 *    정산 플래그·묶음 정본 행·자동 상태·체크리스트·재무 파생·감사 기록이 전부 화면 저장과 같다.
 *
 * ⛔ 여기서 칸별 규칙을 새로 짜지 말 것. 아래 `EXCLUDED_FIELDS` 는 「화면에선 되지만 이 통로로는
 * 안전하게 못 하는」 칸만, 사유와 함께 둔다.
 */
import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { toKstYmd } from "@/lib/date-utils";
import { CAMPAIGN_INVALIDATION_TAGS, MASTER_DATA_INVALIDATION_TAGS } from "@/lib/cache-tags";
import type { RecordEntityType } from "@/lib/record-update-labels";
import { updateCampaignSchema } from "@/lib/validations/campaign-update";
import { updateDealSchema } from "@/lib/validations/deal";
import { updatePartnerSchema } from "@/lib/validations/partner";
import { updateSellerSchema } from "@/lib/validations/seller";
import { applyCampaignPatch, type CampaignPatchData } from "@/services/campaignPatchService";
import { dealService } from "@/services/dealService";
import { PartnerService } from "@/services/partnerService";
import { applySellerPatch } from "@/services/sellerPatchService";
import type { WriteActionEffectSpec } from "./write-actions/types";

/**
 * 화면에선 고칠 수 있지만 이 통로로는 받지 않는 칸과 그 이유. 기안 단계에서 이 문구로 거절한다.
 * 이유는 셋 중 하나다: ①외부 호출·권한 판정이 걸림 ②민감 정보(기안 내용은 결재함·작업 기록에 평문으로
 * 남는다) ③값이 표·객체라 작업 입력 봉투(깊이 2)에 들어가지 않음 · 승인 트랜잭션에 묶을 수 없음.
 */
export const EXCLUDED_FIELDS: Record<RecordEntityType, Readonly<Record<string, string>>> = {
  CAMPAIGN: {
    assignedTo:
      "담당자 인수인계는 사용자 목록을 외부 인증 서버에서 조회하고 관리자 본인 권한을 확인하는 경로라 화면에서 직접 하세요.",
    handoffMemo: "인수인계 메모는 담당자 인수인계와 함께만 쓰입니다(이 통로로는 인수인계를 하지 않습니다).",
    expectedFinancials: "저장할 칸이 아니라 화면용 동시성 조건입니다. 지금 값은 expected 로 보내세요.",
    settlementItems: "정산 부가 항목은 표라서 이 통로로는 고치지 않습니다. 재무 카드에서 고치세요.",
    campaignDeals: "품목은 표라서 이 통로로는 고치지 않습니다. 재무 카드에서 고치세요.",
    salesTask: "연결된 영업 작업은 묶음 값이라 이 통로로는 고치지 않습니다.",
  },
  DEAL: {
    baseMarginPolicy: "기본 마진 정책은 묶음 값이라 이 통로로는 고치지 않습니다. 딜 화면에서 고치세요.",
  },
  PARTNER: {
    bankAccount: "계좌 정보는 민감 정보라 기안(결재함·작업 기록에 평문으로 남음)으로 받지 않습니다. 화면에서 직접 고치세요.",
  },
  SELLER: {
    residentNumber: "주민등록번호는 기안(결재함·작업 기록에 평문으로 남음)으로 받지 않습니다. 셀러 화면에서 직접 고치세요.",
    accountNumber: "정산 계좌번호는 민감 정보라 기안으로 받지 않습니다. 셀러 화면에서 직접 고치세요.",
    currentFollowers:
      "팔로워 수는 이력 스냅샷 기록이 승인 트랜잭션에 묶이지 않아 이 통로로는 고치지 않습니다(수집기가 갱신합니다).",
  },
};

/**
 * 저장값이 없는 「행동 칸」 — 바꾸는 값이 아니라 함께 보내는 사유다. 지금 값은 언제나 「비어 있음」이다.
 * (캠페인 드랍 사유: 상태를 드랍으로 바꿀 때 메모로 남는다.)
 */
const ACTION_ONLY_FIELDS: Record<RecordEntityType, ReadonlySet<string>> = {
  CAMPAIGN: new Set(["dropReason"]),
  DEAL: new Set(),
  PARTNER: new Set(),
  SELLER: new Set(),
};

/**
 * 묶음(조합) 캠페인이면 묶음 행이 정본인 칸 — 화면 행(`toCampaignRow`)의 오버레이 목록과 같다.
 * 기안자가 본 값은 화면 값이므로 대조도 같은 행에서 읽는다.
 */
const CAMPAIGN_GROUP_OVERLAY_FIELDS = new Set([
  "isDepositReceived",
  "isPayoutCompleted",
  "isSupplierPayoutCompleted",
  "depositReceivedAt",
  "payoutCompletedAt",
  "supplierPayoutCompletedAt",
  "supplierInvoiceIssuedAt",
  "sellerInvoiceIssuedAt",
  "expectedDepositDate",
  "expectedPayoutDate",
  "expectedSupplierPayoutDate",
  "accountingCompletedAt",
]);

const PATCH_SCHEMAS: Record<RecordEntityType, z.ZodObject> = {
  CAMPAIGN: updateCampaignSchema,
  DEAL: updateDealSchema,
  PARTNER: updatePartnerSchema,
  SELLER: updateSellerSchema,
};

export type RecordChangeValidation =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * `changes` 를 그 엔티티의 **화면 PATCH 스키마**로 거른다. 모르는 칸은 거절한다(`.strict()` — 화면
 * 스키마는 모르는 칸을 조용히 버리지만, 기안에서 칸이 사라지면 승인자가 본 것과 반영이 갈린다).
 */
export function validateRecordChanges(
  entityType: RecordEntityType,
  changes: Record<string, unknown>,
): RecordChangeValidation {
  const excluded = Object.keys(changes).filter((field) => Object.hasOwn(EXCLUDED_FIELDS[entityType], field));
  if (excluded.length > 0) {
    return {
      ok: false,
      message: excluded.map((field) => `${field}: ${EXCLUDED_FIELDS[entityType][field]}`).join(" / "),
    };
  }
  const parsed = PATCH_SCHEMAS[entityType].strict().safeParse(changes);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(칸)"}: ${issue.message}`).join("; "),
    };
  }
  return { ok: true, data: parsed.data as Record<string, unknown> };
}

/**
 * 대조용 값 정규화 — 화면이 보여 주는 모양으로 맞춘다. 날짜는 KST 달력 날짜(`YYYY-MM-DD`, PATCH 가
 * 받는 글자와 같다), Decimal 은 숫자, 없음은 null.
 */
export function toComparableValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return toKstYmd(value);
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "object" && "toString" in value) {
    const asNumber = Number(String(value));
    return Number.isFinite(asNumber) ? asNumber : String(value);
  }
  return String(value);
}

/** 기안자가 본 값과 지금 값이 같은가. 숫자는 값으로(Decimal 의 "1000.00" 과 1000 이 같다). */
export function sameComparable(current: unknown, expected: unknown): boolean {
  return toComparableValue(current) === toComparableValue(expected);
}

/** 대조와 잠금에 쓰는 지금 상태 — 칸 값(화면 모양)과 잠글 행의 `updatedAt`. */
export type RecordSnapshot = {
  values: Record<string, unknown>;
  updatedAt: Date;
  /** 묶음 캠페인이면 묶음 행도 잠근다(정본 칸이 거기 산다). */
  group: { id: string; updatedAt: Date } | null;
};

export async function readRecordSnapshot(
  tx: Prisma.TransactionClient,
  entityType: RecordEntityType,
  entityId: string,
): Promise<RecordSnapshot | null> {
  switch (entityType) {
    case "CAMPAIGN": {
      const row = await tx.salesCampaign.findUnique({ where: { id: entityId }, include: { group: true } });
      if (!row) return null;
      const group = row.groupId ? row.group : null;
      const values: Record<string, unknown> = { ...row };
      if (group) {
        for (const field of CAMPAIGN_GROUP_OVERLAY_FIELDS) {
          values[field] = (group as Record<string, unknown>)[field];
        }
      }
      // 계산서 정보는 묶음이면 묶음 행(`invoiceInfo`), 아니면 멤버 행(`notesFromImport`)이 정본이다
      // (`toCampaignRow` 와 같은 오버레이). PATCH 는 두 이름을 같은 칸으로 받는다.
      const invoiceInfo = group ? group.invoiceInfo : row.notesFromImport;
      values.invoiceInfo = invoiceInfo;
      values.notesFromImport = invoiceInfo;
      return { values, updatedAt: row.updatedAt, group: group ? { id: group.id, updatedAt: group.updatedAt } : null };
    }
    case "DEAL": {
      const row = await tx.deal.findUnique({ where: { id: entityId } });
      return row ? { values: { ...row }, updatedAt: row.updatedAt, group: null } : null;
    }
    case "PARTNER": {
      const row = await tx.partner.findUnique({ where: { id: entityId } });
      return row ? { values: { ...row }, updatedAt: row.updatedAt, group: null } : null;
    }
    case "SELLER": {
      const row = await tx.seller.findUnique({ where: { id: entityId } });
      return row ? { values: { ...row }, updatedAt: row.updatedAt, group: null } : null;
    }
  }
}

/** 지금 값 — 행동 칸은 저장값이 없어 언제나 null 이다. */
export function currentValueOf(entityType: RecordEntityType, snapshot: RecordSnapshot, field: string): unknown {
  if (ACTION_ONLY_FIELDS[entityType].has(field)) return null;
  return snapshot.values[field] ?? null;
}

/**
 * 읽은 뒤 쓰기 전에 남이 먼저 고쳤으면 실패시키고, 우리 커밋까지 다른 쓰기를 기다리게 하는 잠금 쓰기.
 * 데이터는 `updatedAt` 하나뿐이다(어차피 저장이 다시 찍는다). 묶음 캠페인은 묶음 행 → 멤버 행 순서로
 * 잠근다 — 확정 경로·캠페인 PATCH 와 같은 순서(교착 방지, `update-settlement-amount.ts` 와 같은 규약).
 * `count !== 1` 이면 false.
 */
export async function lockRecordRows(
  tx: Prisma.TransactionClient,
  entityType: RecordEntityType,
  entityId: string,
  snapshot: RecordSnapshot,
): Promise<boolean> {
  const now = new Date();
  const where = { id: entityId, updatedAt: snapshot.updatedAt };
  switch (entityType) {
    case "CAMPAIGN": {
      if (snapshot.group) {
        const groupGuard = await tx.campaignGroup.updateMany({
          where: { id: snapshot.group.id, updatedAt: snapshot.group.updatedAt, members: { some: { id: entityId } } },
          data: { updatedAt: now },
        });
        if (groupGuard.count !== 1) return false;
      }
      return (await tx.salesCampaign.updateMany({ where, data: { updatedAt: now } })).count === 1;
    }
    case "DEAL":
      return (await tx.deal.updateMany({ where, data: { updatedAt: now } })).count === 1;
    case "PARTNER":
      return (await tx.partner.updateMany({ where, data: { updatedAt: now } })).count === 1;
    case "SELLER":
      return (await tx.seller.updateMany({ where, data: { updatedAt: now } })).count === 1;
  }
}

/**
 * 화면 저장과 **같은 본체**로 반영한다. 실패는 던진다(승인 실행이 기안을 실패로 기록하고 전부 롤백한다).
 * `approver` 는 승인자 id 다 — 감사 기록의 주체가 된다.
 */
export async function applyRecordChanges(
  tx: Prisma.TransactionClient,
  entityType: RecordEntityType,
  entityId: string,
  data: Record<string, unknown>,
  approver: string,
): Promise<void> {
  switch (entityType) {
    case "CAMPAIGN": {
      const outcome = await applyCampaignPatch({
        id: entityId,
        data: data as CampaignPatchData,
        // 인수인계(관리자 판정)는 제외 칸이라 역할은 쓰이지 않는다 — 관리자 권한을 지어내지 않는다.
        auth: { userId: approver, email: approver, role: "approver" },
        tx,
      });
      if (outcome.kind === "error") {
        const reason = typeof outcome.body.error === "string" ? outcome.body.error : JSON.stringify(outcome.body.error);
        throw new Error(`캠페인 저장이 거절되었습니다(${outcome.status}): ${reason}`);
      }
      return;
    }
    case "DEAL":
      await dealService.updateDeal(entityId, data as Parameters<typeof dealService.updateDeal>[1], approver, tx);
      return;
    case "PARTNER":
      await PartnerService.updatePartner(entityId, data as Prisma.PartnerUpdateInput, approver, tx);
      return;
    case "SELLER": {
      const outcome = await applySellerPatch({
        id: entityId,
        data: data as Parameters<typeof applySellerPatch>[0]["data"],
        actor: approver,
        tx,
      });
      if (outcome.kind === "error") {
        throw new Error(`셀러 저장이 거절되었습니다(${outcome.status}): ${outcome.error}`);
      }
      return;
    }
  }
}

/**
 * 커밋 뒤 후속 처리 — 각 화면 PATCH 가 하는 무효화와 같은 태그 묶음. 캠페인은 캘린더도 다시 맞춘다
 * (멱등이고 실패해도 쓰기를 되돌리지 않는다). ⚠️ 화면 PATCH 는 캘린더 칸이 바뀐 경우에만 맞추지만,
 * 실행 결과(`WriteActionResult`)에 그 판정을 실을 칸이 없어 캠페인 기안은 언제나 맞춘다.
 */
export function recordUpdateEffects(entityType: string, refId: string): WriteActionEffectSpec {
  if (entityType === "CAMPAIGN") {
    return { revalidate: CAMPAIGN_INVALIDATION_TAGS, calendarCampaignId: refId };
  }
  return { revalidate: MASTER_DATA_INVALIDATION_TAGS, calendarCampaignId: null };
}
