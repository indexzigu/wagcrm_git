/**
 * 수취 계산서 **결정**(승인/무관 처리/되돌리기)의 DB 트랜잭션 본체.
 *
 * 설계 정본은 `docs/private/specs/2026-08-12-group-invoice-similarity-approval-design.md`.
 *
 * ## ⛔ 그룹이면 그룹 스칼라만 쓴다 (CG-1)
 *
 * `campaignService.updateCampaign` 이 이미 지키는 규칙과 **같아야 한다**
 * (`campaignService.ts` 의 `...(!isGrouped ? campaignSharedEventUpdates : {})`):
 * 그룹 소속 캠페인의 수취일시는 `CampaignGroup` 스칼라가 SoT 이고 멤버 컬럼은 쓰지 않는다.
 * 양쪽 다 쓰면 그룹 값과 멤버 값이 갈라져, `buildOverdueSettlementItems` 가 밟았던 CG-1
 * 함정(#196 — 멤버 플래그로 그룹을 판정해 이미 처리된 건이 멤버 수만큼 되살아남)이 계산서
 * 축에서 그대로 재현된다.
 *
 * ## 되돌리기는 「우리가 쓴 값」만 지운다
 *
 * 승인 시 실제로 쓴 날짜를 `appliedDate` 에 남기고, 되돌릴 때 현재 저장된 값이 그것과
 * **정확히 같을 때만** 지운다. 승인 이후 오너가 손으로 다른 날짜를 넣었다면 그건 우리 값이
 * 아니므로 건드리지 않는다 — 남의 입력을 조용히 지우는 것은 이 레포가 보드 편집에서 이미
 * 한 번 낸 사고(2026-07-30 타 세션 줄 덮어쓰기)와 같은 부류다.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { ReceivableSlot } from "@/lib/tax-invoice-mail/expected-receivables";

/** 결정 종류. 해제는 행 삭제라 "미결정" 상태를 따로 두지 않는다(`TaxFilingLog` 와 같은 규약). */
export type ReceiptDecisionKind = "APPROVED" | "DISMISSED";

/**
 * 슬롯 → 완료 기록 필드.
 *
 * 2026-08-07 의무표 정정 이후 **전 채널이 「필드명 = 상대」로 균일**하다
 * (`expected-receivables.ts` 헤더) — `SUPPLIER_GOODS` 는 항상 공급사, `SELLER_COMMISSION` 은
 * 항상 셀러다. 그래서 이 대응은 채널과 무관한 전역 함수다.
 *
 * ⛔ 그렇다고 클라이언트가 보낸 필드명을 그대로 믿지 말 것 — 슬롯에서 **서버가 유도**한다.
 * 필드명을 받으면 브랜드몰처럼 그 필드가 「발행」 의무인 조합에 수취 완료를 찍을 수 있다.
 */
const SLOT_TO_FIELD: Record<ReceivableSlot, "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt"> = {
  SUPPLIER_GOODS: "supplierInvoiceIssuedAt",
  SELLER_COMMISSION: "sellerInvoiceIssuedAt",
};

/** `campaignId:slot` 형태의 기대 건 key 를 분해한다. 모양이 다르면 null(조용히 넘기지 않는다). */
export function parseReceivableKey(
  key: string,
): { campaignId: string; slot: ReceivableSlot } | null {
  const separator = key.lastIndexOf(":");
  if (separator <= 0) return null;
  const campaignId = key.slice(0, separator);
  const slot = key.slice(separator + 1);
  if (slot !== "SUPPLIER_GOODS" && slot !== "SELLER_COMMISSION") return null;
  return { campaignId, slot };
}

export interface ApplyReceiptDecisionInput {
  /** 국세청 승인번호 — 계산서 1장의 자연 키 */
  issueId: string;
  decision: ReceiptDecisionKind;
  /** 승인 대상 기대 건 key 목록. 무관 처리면 빈 배열. */
  matchedKeys: readonly string[];
  /** 수취일시에 쓸 값 = 계산서 **작성일자**. 승인인데 없으면 결정만 기록하고 필드는 안 쓴다. */
  appliedDate: Date | null;
  observedTotal: number | null;
  expectedTotal: number | null;
  amountDelta: number | null;
  /** 승인 근거 신호(직렬화해 저장). 수동 결정이면 null. */
  signalSummary: unknown;
}

export interface ApplyReceiptDecisionResult {
  /** 실제로 수취일시를 기록한 대상 */
  applied: Array<{ campaignId: string; groupId: string | null; field: string }>;
}

/**
 * 승인이 **성립하지 않는** 입력. 트랜잭션을 되돌리고 호출부가 오너에게 알린다.
 *
 * ⛔ 이 오류를 「결정만 기록하고 넘어가기」로 되돌리지 말 것 — 교차 검증에서 잡힌 실제
 * 결함이다(2026-08-12). 그 관대한 분기가 있으면 ①작성일자를 못 읽은 계산서를 승인했을 때
 * 결정 행만 쓰이고 수취일시는 비어 있는데 ②다음 스캔은 「결정된 건」이라 제안을 더 이상
 * 띄우지 않아 ③화면은 영구히 「승인됨」인데 정산 SoT 는 미수취로 남는다. HTTP 는 200
 * 이므로 호출부의 `res.ok` 가드도 발동하지 않는다 — **아무것도 안 한 것보다 나쁜**,
 * 이 기능이 애초에 막으려던 바로 그 상태다.
 */
export class ReceiptDecisionRejected extends Error {
  constructor(
    readonly code: "MISSING_WRITTEN_DATE" | "TARGET_NOT_FOUND",
    readonly detail: string[] = [],
  ) {
    super(
      code === "MISSING_WRITTEN_DATE"
        ? "계산서 작성일자를 읽지 못해 수취일시를 기록할 수 없습니다."
        : "승인 대상 캠페인을 찾지 못했습니다.",
    );
    this.name = "ReceiptDecisionRejected";
  }
}

/**
 * 결정을 기록하고, 승인이면 수취일시를 기록한다.
 *
 * 멱등이다 — 같은 승인번호로 다시 부르면 결정 행을 갱신하고 같은 날짜를 다시 쓴다(같은 값
 * 재기록이라 관측 가능한 변화가 없다).
 */
export async function applyReceiptDecision(
  prisma: PrismaClient,
  input: ApplyReceiptDecisionInput,
): Promise<ApplyReceiptDecisionResult> {
  const applied: ApplyReceiptDecisionResult["applied"] = [];

  // ⛔ 검증은 **쓰기 전에** 끝낸다 — 결정 행이 먼저 남으면 그 자체가 「승인됨」 표시가 되어
  //    위 `ReceiptDecisionRejected` 주석의 상태를 만든다.
  if (input.decision === "APPROVED") {
    if (input.appliedDate === null) throw new ReceiptDecisionRejected("MISSING_WRITTEN_DATE");
    const unparsable = input.matchedKeys.filter((key) => parseReceivableKey(key) === null);
    if (unparsable.length > 0) throw new ReceiptDecisionRejected("TARGET_NOT_FOUND", unparsable);
  }

  const parsedTargets =
    input.decision === "APPROVED"
      ? input.matchedKeys.map((key) => ({ key, parsed: parseReceivableKey(key) }))
      : [];

  await prisma.$transaction(async (tx) => {
    const payload = {
      decision: input.decision,
      matchedKeys: JSON.stringify(input.matchedKeys),
      observedTotal: input.observedTotal,
      expectedTotal: input.expectedTotal,
      amountDelta: input.amountDelta,
      signalSummary: input.signalSummary === null ? null : JSON.stringify(input.signalSummary),
      appliedDate: input.decision === "APPROVED" ? input.appliedDate : null,
      decidedAt: new Date(),
    };

    await tx.taxInvoiceReceiptDecision.upsert({
      where: { issueId: input.issueId },
      create: { issueId: input.issueId, ...payload },
      update: payload,
    });

    if (input.decision !== "APPROVED" || input.appliedDate === null) return;

    for (const target of parsedTargets) {
      if (!target.parsed) continue;
      const { campaignId, slot } = target.parsed;
      const field = SLOT_TO_FIELD[slot];

      const campaign = await tx.salesCampaign.findUnique({
        where: { id: campaignId },
        select: { id: true, groupId: true },
      });
      // ⛔ 하나라도 못 찾으면 **전부 되돌린다.** 찾은 것만 쓰고 넘어가면 「일부만 기록된
      //    승인」이 완료로 보인다(부분 일치를 전체 확인으로 둔갑시키지 않는다는, 이 엔진이
      //    그룹 후퇴 가드에서 이미 세운 원칙과 같다).
      if (!campaign) throw new ReceiptDecisionRejected("TARGET_NOT_FOUND", [target.key]);

      // ⛔ CG-1 — 그룹이면 그룹 스칼라만, 미그룹이면 캠페인 컬럼만. 둘 다 쓰지 않는다(헤더).
      if (campaign.groupId) {
        await tx.campaignGroup.update({
          where: { id: campaign.groupId },
          data: { [field]: input.appliedDate },
        });
      } else {
        await tx.salesCampaign.update({
          where: { id: campaignId },
          data: { [field]: input.appliedDate },
        });
      }

      applied.push({ campaignId, groupId: campaign.groupId, field });
    }
  });

  return { applied };
}

export interface RevertReceiptDecisionResult {
  /** 결정 행이 있었는가 */
  found: boolean;
  /** 수취일시를 실제로 지운 대상 */
  cleared: Array<{ campaignId: string; groupId: string | null; field: string }>;
  /**
   * 승인이 쓴 값과 현재 값이 달라 **건드리지 않은** 대상.
   *
   * 조용히 넘기지 않고 돌려준다 — 오너에게 "되돌렸지만 이 건은 그대로 뒀다(그 사이 직접
   * 수정하신 값이라)"고 말할 수 있어야 한다(P0 No Silent Failure).
   */
  skipped: Array<{ campaignId: string; field: string }>;
}

/**
 * 결정을 취소한다. 승인이었다면 **우리가 쓴 값과 정확히 같은** 수취일시만 지운다(헤더).
 */
export async function revertReceiptDecision(
  prisma: PrismaClient,
  issueId: string,
): Promise<RevertReceiptDecisionResult> {
  const cleared: RevertReceiptDecisionResult["cleared"] = [];
  const skipped: RevertReceiptDecisionResult["skipped"] = [];

  const found = await prisma.$transaction(async (tx) => {
    const existing = await tx.taxInvoiceReceiptDecision.findUnique({ where: { issueId } });
    if (!existing) return false;

    if (existing.decision === "APPROVED" && existing.appliedDate) {
      const keys = parseStoredKeys(existing.matchedKeys);
      for (const key of keys) {
        const parsed = parseReceivableKey(key);
        if (!parsed) continue;
        const field = SLOT_TO_FIELD[parsed.slot];

        const campaign = await tx.salesCampaign.findUnique({
          where: { id: parsed.campaignId },
          select: { id: true, groupId: true, [field]: true } as Prisma.SalesCampaignSelect,
        });
        if (!campaign) continue;

        if (campaign.groupId) {
          const group = await tx.campaignGroup.findUnique({
            where: { id: campaign.groupId },
            select: { id: true, [field]: true } as Prisma.CampaignGroupSelect,
          });
          if (!sameInstant(group?.[field], existing.appliedDate)) {
            skipped.push({ campaignId: parsed.campaignId, field });
            continue;
          }
          await tx.campaignGroup.update({
            where: { id: campaign.groupId },
            data: { [field]: null },
          });
        } else {
          if (!sameInstant(campaign[field], existing.appliedDate)) {
            skipped.push({ campaignId: parsed.campaignId, field });
            continue;
          }
          await tx.salesCampaign.update({
            where: { id: parsed.campaignId },
            data: { [field]: null },
          });
        }

        cleared.push({ campaignId: parsed.campaignId, groupId: campaign.groupId, field });
      }
    }

    await tx.taxInvoiceReceiptDecision.delete({ where: { issueId } });
    return true;
  });

  return { found, cleared, skipped };
}

/** 저장된 key 목록을 읽는다. 깨진 값은 빈 배열 — 되돌리기가 엉뚱한 캠페인을 건드리지 않는다. */
function parseStoredKeys(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** 같은 시각인가. Prisma 가 돌려주는 Date 와 저장된 Date 를 밀리초로 비교한다. */
function sameInstant(value: unknown, expected: Date): boolean {
  return value instanceof Date && value.getTime() === expected.getTime();
}
