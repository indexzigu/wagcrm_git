// Feature: outreach API
// Validates the current SalesTask-based outreach workflow.

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  createOutreachSchema,
  isValidOutreachTransition,
  updateOutreachSchema,
  type OutreachStatus,
} from "../lib/validations/outreach";
import {
  getMarginRatesFromPolicy,
  parseMarginPolicy,
} from "../lib/commission";
import type { BaseMarginPolicy, DealStatus } from "../lib/crm-types";

type DealRecord = {
  id: string;
  status: DealStatus;
  baseMarginPolicy: string;
};

type SellerRecord = {
  id: string;
  name: string;
};

type SalesTaskRecord = {
  id: string;
  dealId: string;
  sellerId: string;
  status: OutreachStatus;
  contactChannel: string;
  proposalMessage: string | null;
  negotiationMemo: string | null;
  testingMemo: string | null;
  proposalSentAt: Date;
  respondedAt: Date | null;
  confirmedAt: Date | null;
  droppedAt: Date | null;
  dropReason: string | null;
  lastReminderAt: Date | null;
  nextReminderAt: Date | null;
  linkedCampaignId: string | null;
};

type CampaignRecord = {
  id: string;
  dealId: string;
  sellerId: string;
  status: "PREPARATION";
  salesChannel: "OWN_MALL";
  totalMarginRate: number;
  sellerMarginRate: number;
  netMarginRate: number;
};

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Mirrors POST /api/outreach.
 */
function createSalesTask(
  input: {
    dealId: string;
    sellerId: string;
    contactChannel?: string;
    proposalMessage?: string | null;
  },
  deal: DealRecord | null,
  seller: SellerRecord | null,
  existingTasks: SalesTaskRecord[],
): { success: true; task: SalesTaskRecord } | { success: false; status: number; error: string } {
  const parsed = createOutreachSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, status: 400, error: "validation_error" };
  }

  if (!deal) {
    return { success: false, status: 404, error: "해당 딜을 찾을 수 없습니다" };
  }

  if (!seller) {
    return { success: false, status: 404, error: "해당 셀러를 찾을 수 없습니다" };
  }

  const duplicate = existingTasks.some(
    (task) => task.dealId === input.dealId && task.sellerId === input.sellerId,
  );
  if (duplicate) {
    return {
      success: false,
      status: 409,
      error: "이미 해당 셀러에게 영업 테스크를 생성했습니다",
    };
  }

  const proposalSentAt = new Date();
  return {
    success: true,
    task: {
      id: `task-${Math.random().toString(36).slice(2)}`,
      dealId: deal.id,
      sellerId: seller.id,
      status: "PROPOSED",
      contactChannel: parsed.data.contactChannel,
      proposalMessage: parsed.data.proposalMessage ?? null,
      negotiationMemo: null,
      testingMemo: null,
      proposalSentAt,
      respondedAt: null,
      confirmedAt: null,
      droppedAt: null,
      dropReason: null,
      lastReminderAt: null,
      nextReminderAt: addDays(proposalSentAt, 3),
      linkedCampaignId: null,
    },
  };
}

/**
 * Mirrors PATCH /api/outreach/[id].
 */
function updateSalesTask(
  task: SalesTaskRecord,
  deal: DealRecord,
  input: {
    status: OutreachStatus;
    autoCreateCampaign?: boolean;
    dropReason?: string | null;
    proposalMessage?: string | null;
    negotiationMemo?: string | null;
    testingMemo?: string | null;
    lastReminderAt?: string | null;
    nextReminderAt?: string | null;
  },
): { success: true; task: SalesTaskRecord; campaign: CampaignRecord | null } | {
  success: false;
  status: number;
  error: string;
} {
  const parsed = updateOutreachSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, status: 400, error: "validation_error" };
  }

  const currentStatus = task.status;
  const { status: newStatus = currentStatus, autoCreateCampaign, dropReason } = parsed.data;

  if (!isValidOutreachTransition(currentStatus, newStatus)) {
    return {
      success: false,
      status: 422,
      error: `허용되지 않는 상태 변경입니다: ${currentStatus} → ${newStatus}`,
    };
  }

  const shouldCreateCampaign =
    newStatus === "PENDING_APPROVAL" &&
    autoCreateCampaign === true &&
    !task.linkedCampaignId;
  const hasMetadataUpdate =
    parsed.data.lastReminderAt != null ||
    parsed.data.nextReminderAt != null ||
    dropReason != null ||
    parsed.data.proposalMessage !== undefined ||
    parsed.data.negotiationMemo !== undefined ||
    parsed.data.testingMemo !== undefined;

  if (currentStatus === newStatus && !shouldCreateCampaign && !hasMetadataUpdate) {
    return { success: true, task, campaign: null };
  }

  const updatedTask: SalesTaskRecord = { ...task, status: newStatus };

  if (newStatus === "NEGOTIATION" || newStatus === "TESTING") {
    updatedTask.respondedAt = task.respondedAt ?? new Date();
    updatedTask.nextReminderAt = null;
  }

  if (newStatus === "PENDING_APPROVAL") {
    updatedTask.respondedAt = task.respondedAt ?? new Date();
    updatedTask.confirmedAt = task.confirmedAt ?? new Date();
    updatedTask.nextReminderAt = null;
    updatedTask.dropReason = null;
    updatedTask.droppedAt = null;
  }

  if (newStatus === "DROPPED") {
    updatedTask.droppedAt = new Date();
    updatedTask.dropReason = dropReason ?? task.dropReason ?? "수동 종료";
    updatedTask.nextReminderAt = null;
  }

  if (newStatus === "PROPOSED") {
    updatedTask.nextReminderAt =
      parsed.data.nextReminderAt != null
        ? new Date(parsed.data.nextReminderAt)
        : task.nextReminderAt ?? addDays(new Date(), 3);
  }

  if (parsed.data.lastReminderAt) {
    updatedTask.lastReminderAt = new Date(parsed.data.lastReminderAt);
  }

  if (parsed.data.nextReminderAt) {
    updatedTask.nextReminderAt = new Date(parsed.data.nextReminderAt);
  }

  if (parsed.data.proposalMessage !== undefined) {
    updatedTask.proposalMessage = parsed.data.proposalMessage ?? null;
  }

  if (parsed.data.negotiationMemo !== undefined) {
    updatedTask.negotiationMemo = parsed.data.negotiationMemo ?? null;
  }

  if (parsed.data.testingMemo !== undefined) {
    updatedTask.testingMemo = parsed.data.testingMemo ?? null;
  }

  let campaign: CampaignRecord | null = null;

  if (shouldCreateCampaign) {
    const policy = parseMarginPolicy(deal.baseMarginPolicy);
    if (!policy) {
      return {
        success: false,
        status: 422,
        error: "기본 채널(자사몰)의 수수료 정책이 없습니다",
      };
    }

    const rates = getMarginRatesFromPolicy(policy, "OWN_MALL");
    if (!rates) {
      return {
        success: false,
        status: 422,
        error: "기본 채널(자사몰)의 수수료 정책이 없습니다",
      };
    }

    const campaignId = `camp-${Math.random().toString(36).slice(2)}`;
    campaign = {
      id: campaignId,
      dealId: task.dealId,
      sellerId: task.sellerId,
      status: "PREPARATION",
      salesChannel: "OWN_MALL",
      totalMarginRate: rates.totalMarginRate,
      sellerMarginRate: rates.sellerMarginRate,
      netMarginRate: rates.netMarginRate,
    };
    updatedTask.linkedCampaignId = campaignId;
    // 캠페인 생성(승인) 완료 → CONVERTED 자동 전환
    updatedTask.status = "CONVERTED";
  } else if (newStatus === "PENDING_APPROVAL" && autoCreateCampaign === true && task.linkedCampaignId) {
    // 이미 캠페인이 연결되어 있는 경우에도 CONVERTED 상태로 전환
    updatedTask.status = "CONVERTED";
  }

  return { success: true, task: updatedTask, campaign };
}

const nonEmptyStringArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .filter((value) => value.trim().length > 0);

const trimmedTextArb = fc
  .string({ minLength: 1, maxLength: 160 })
  .filter((value) => value.trim().length > 0);

const nullableMessageArb = fc.option(trimmedTextArb, { nil: null });

const isoDateArb = fc
  .date({
    min: new Date("2000-01-01T00:00:00.000Z"),
    max: new Date("2100-12-31T23:59:59.999Z"),
  })
  .map((value) => value.toISOString());

const dealIdArb = fc.stringMatching(/^[a-z]{6,12}$/).map((value) => `deal-${value}`);
const sellerIdArb = fc.stringMatching(/^[a-z]{6,12}$/).map((value) => `seller-${value}`);

const dealStatusArb = fc.constantFrom<DealStatus>(
  "SOURCING",
  "NEGOTIATING",
  "SAMPLE_TESTING",
  "ARCHIVED",
  "DROPPED",
);

const marginRateArb = fc.float({ min: 0, max: 100, noNaN: true });

const policyWithOwnMallArb: fc.Arbitrary<BaseMarginPolicy> = fc
  .record({
    totalMarginRate: marginRateArb,
    sellerMarginRate: marginRateArb,
  })
  .map((rates) => ({
    byChannel: {
      OWN_MALL: rates,
    },
  }));

const policyWithoutOwnMallArb: fc.Arbitrary<BaseMarginPolicy> = fc
  .record({
    totalMarginRate: marginRateArb,
    sellerMarginRate: marginRateArb,
  })
  .map((rates) => ({
    byChannel: {
      SELLER_MALL: rates,
    },
  }));

const dealArb: fc.Arbitrary<DealRecord> = fc
  .tuple(dealIdArb, dealStatusArb, policyWithOwnMallArb)
  .map(([id, status, policy]) => ({
    id,
    status,
    baseMarginPolicy: JSON.stringify(policy),
  }));

const dealNoOwnMallArb: fc.Arbitrary<DealRecord> = fc
  .tuple(dealIdArb, dealStatusArb, policyWithoutOwnMallArb)
  .map(([id, status, policy]) => ({
    id,
    status,
    baseMarginPolicy: JSON.stringify(policy),
  }));

const sellerArb: fc.Arbitrary<SellerRecord> = fc
  .tuple(sellerIdArb, nonEmptyStringArb)
  .map(([id, name]) => ({ id, name }));

function makeTask(dealId: string, sellerId: string, status: OutreachStatus = "PROPOSED"): SalesTaskRecord {
  const proposalSentAt = new Date(Date.now() - 1_000);
  return {
    id: `task-${Math.random().toString(36).slice(2)}`,
    dealId,
    sellerId,
    status,
    contactChannel: "DM",
    proposalMessage: null,
    negotiationMemo: null,
    testingMemo: null,
    proposalSentAt,
    respondedAt: null,
    confirmedAt: null,
    droppedAt: null,
    dropReason: null,
    lastReminderAt: null,
    nextReminderAt: addDays(proposalSentAt, 3),
    linkedCampaignId: null,
  };
}

describe("Outreach creation invariants", () => {
  it("creates a PROPOSED sales task for any existing deal and seller", () => {
    fc.assert(
      fc.property(dealArb, sellerArb, nullableMessageArb, trimmedTextArb, (deal, seller, proposalMessage, contactChannel) => {
        const result = createSalesTask(
          { dealId: deal.id, sellerId: seller.id, contactChannel, proposalMessage },
          deal,
          seller,
          [],
        );

        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.task.status).toBe("PROPOSED");
        expect(result.task.contactChannel).toBe(contactChannel.trim());
        expect(result.task.proposalMessage).toBe(proposalMessage?.trim() ?? null);
        expect(result.task.proposalSentAt).toBeInstanceOf(Date);
        expect(result.task.nextReminderAt).toBeInstanceOf(Date);
        expect(result.task.respondedAt).toBeNull();
        expect(result.task.confirmedAt).toBeNull();
        expect(result.task.linkedCampaignId).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("rejects duplicate deal-seller pairs with 409", () => {
    fc.assert(
      fc.property(dealArb, sellerArb, (deal, seller) => {
        const existing = makeTask(deal.id, seller.id);
        const result = createSalesTask(
          { dealId: deal.id, sellerId: seller.id, contactChannel: "DM" },
          deal,
          seller,
          [existing],
        );

        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.status).toBe(409);
      }),
      { numRuns: 100 },
    );
  });

  it("returns 404 when deal or seller is missing", () => {
    fc.assert(
      fc.property(dealIdArb, sellerIdArb, sellerArb, dealArb, (dealId, sellerId, seller, deal) => {
        const missingDeal = createSalesTask({ dealId, sellerId: seller.id }, null, seller, []);
        const missingSeller = createSalesTask({ dealId: deal.id, sellerId }, deal, null, []);

        expect(missingDeal.success).toBe(false);
        expect(missingSeller.success).toBe(false);
        if (!missingDeal.success) expect(missingDeal.status).toBe(404);
        if (!missingSeller.success) expect(missingSeller.status).toBe(404);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Outreach status update invariants", () => {
  it("sets respondedAt and clears nextReminderAt when moving from PROPOSED to NEGOTIATION or TESTING", () => {
    fc.assert(
      fc.property(dealArb, sellerArb, fc.constantFrom<OutreachStatus>("NEGOTIATION", "TESTING"), (deal, seller, nextStatus) => {
        const task = makeTask(deal.id, seller.id, "PROPOSED");
        const result = updateSalesTask(task, deal, { status: nextStatus });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.task.status).toBe(nextStatus);
        expect(result.task.respondedAt).toBeInstanceOf(Date);
        expect(result.task.nextReminderAt).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("승인대기(PENDING_APPROVAL) + autoCreateCampaign=true 시 PREPARATION 첨페인 생성 후 CONVERTED 자동 전환", () => {
    fc.assert(
      fc.property(dealArb, sellerArb, fc.constantFrom<OutreachStatus>("NEGOTIATION", "TESTING"), (deal, seller, currentStatus) => {
        const task = makeTask(deal.id, seller.id, currentStatus);
        const result = updateSalesTask(task, deal, {
          status: "PENDING_APPROVAL",
          autoCreateCampaign: true,
        });

        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.task.confirmedAt).toBeInstanceOf(Date);
        // 쳪페인 생성 후 자동으로 CONVERTED 상태
        expect(result.task.status).toBe("CONVERTED");
        expect(result.campaign).not.toBeNull();
        expect(result.campaign?.status).toBe("PREPARATION");
        expect(result.task.linkedCampaignId).toBe(result.campaign?.id ?? null);
      }),
      { numRuns: 100 },
    );
  });

  it("autoCreateCampaign=false시 쳪페인 생성 안함", () => {
    fc.assert(
      fc.property(dealArb, sellerArb, fc.constantFrom<OutreachStatus>("NEGOTIATION", "TESTING"), (deal, seller, currentStatus) => {
        const task = makeTask(deal.id, seller.id, currentStatus);
        const result = updateSalesTask(task, deal, {
          status: "PENDING_APPROVAL",
          autoCreateCampaign: false,
        });

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.campaign).toBeNull();
        expect(result.task.linkedCampaignId).toBeNull();
        expect(result.task.status).toBe("PENDING_APPROVAL");
      }),
      { numRuns: 100 },
    );
  });

  it("OWN_MALL 정책 없는 딥의 쳪페인 생성 거부 (422)", () => {
    fc.assert(
      fc.property(dealNoOwnMallArb, sellerArb, fc.constantFrom<OutreachStatus>("NEGOTIATION", "TESTING"), (deal, seller, currentStatus) => {
        const task = makeTask(deal.id, seller.id, currentStatus);
        const result = updateSalesTask(task, deal, {
          status: "PENDING_APPROVAL",
          autoCreateCampaign: true,
        });

        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.status).toBe(422);
      }),
      { numRuns: 100 },
    );
  });

  it("allows metadata-only updates without changing status", () => {
    fc.assert(
      fc.property(dealArb, sellerArb, isoDateArb, isoDateArb, nullableMessageArb, nullableMessageArb, nullableMessageArb, (deal, seller, lastReminderAt, nextReminderAt, proposalMessage, negotiationMemo, testingMemo) => {
        const task = makeTask(deal.id, seller.id, "PROPOSED");
        const result = updateSalesTask(task, deal, {
          status: "PROPOSED",
          lastReminderAt,
          nextReminderAt,
          proposalMessage,
          negotiationMemo,
          testingMemo,
        });

        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.task.status).toBe("PROPOSED");
        expect(result.task.lastReminderAt?.toISOString()).toBe(lastReminderAt);
        expect(result.task.nextReminderAt?.toISOString()).toBe(nextReminderAt);
        expect(result.task.proposalMessage).toBe(proposalMessage?.trim() ?? null);
        expect(result.task.negotiationMemo).toBe(negotiationMemo?.trim() ?? null);
        expect(result.task.testingMemo).toBe(testingMemo?.trim() ?? null);
      }),
      { numRuns: 100 },
    );
  });

  it("persists a drop reason and droppedAt on DROPPED", () => {
    fc.assert(
      fc.property(dealArb, sellerArb, fc.constantFrom<OutreachStatus>("PROPOSED", "NEGOTIATION", "TESTING"), trimmedTextArb, (deal, seller, currentStatus, dropReason) => {
        const task = makeTask(deal.id, seller.id, currentStatus);
        const result = updateSalesTask(task, deal, {
          status: "DROPPED",
          dropReason,
        });

        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(result.task.status).toBe("DROPPED");
        expect(result.task.dropReason).toBe(dropReason.trim());
        expect(result.task.droppedAt).toBeInstanceOf(Date);
        expect(result.task.nextReminderAt).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it("CONVERTED 상태에서 DROPPED 이외 상태로의 전환 거부 (422)", () => {
    fc.assert(
      fc.property(dealArb, sellerArb, fc.constantFrom<OutreachStatus>("PROPOSED", "NEGOTIATION", "TESTING", "PENDING_APPROVAL"), (deal, seller, nextStatus) => {
        const task = makeTask(deal.id, seller.id, "CONVERTED");
        const result = updateSalesTask(task, deal, { status: nextStatus });

        expect(result.success).toBe(false);
        if (result.success) return;
        expect(result.status).toBe(422);
      }),
      { numRuns: 100 },
    );
  });

  it("쳪페인 마진율이 OWN_MALL 정책과 일치함", () => {
    fc.assert(
      fc.property(dealArb, sellerArb, fc.constantFrom<OutreachStatus>("NEGOTIATION", "TESTING"), (deal, seller, currentStatus) => {
        const task = makeTask(deal.id, seller.id, currentStatus);
        const result = updateSalesTask(task, deal, {
          status: "PENDING_APPROVAL",
          autoCreateCampaign: true,
        });

        expect(result.success).toBe(true);
        if (!result.success) return;

        const policy = parseMarginPolicy(deal.baseMarginPolicy);
        const rates = policy ? getMarginRatesFromPolicy(policy, "OWN_MALL") : null;

        expect(rates).not.toBeNull();
        expect(result.campaign?.totalMarginRate).toBe(rates?.totalMarginRate);
        expect(result.campaign?.sellerMarginRate).toBe(rates?.sellerMarginRate);
        expect(result.campaign?.netMarginRate).toBe(rates?.netMarginRate);
      }),
      { numRuns: 100 },
    );
  });
});
