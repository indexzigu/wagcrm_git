/**
 * "기간 미정" (period not set yet) — SSOT for whether a campaign's sales period is still unset.
 *
 * A campaign created from an outreach task (PATCH /api/outreach/[id], autoCreateCampaign) has no
 * period yet, but `startDate`/`endDate` are NOT NULL columns. The creator stores both dates equal to
 * `periodPlaceholderAt`. The period counts as unset while EITHER date still equals that marker, so
 * the campaign becomes dated once both dates have been written — no writer has to clear the marker
 * (self-clearing). A partial write (only one date, e.g. a store-period sync that sends only an end
 * date) keeps it unset, so it never runs on a half-placeholder period.
 *
 * While unset: the daily schedule transition skips it (campaign-status-sync.ts), it cannot leave
 * PREPARATION except to DROPPED (campaignPatchService.ts · propagateGroupStatus), owner screens show
 * 「미정」 instead of dates, and calendars / period-based grouping / link expiry ignore it.
 * Contract: campaign-period.test.ts.
 */
export type CampaignPeriodFields = {
  startDate: Date | string;
  endDate: Date | string;
  periodPlaceholderAt?: Date | string | null;
};

function toEpochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function isCampaignPeriodUnset(campaign: CampaignPeriodFields): boolean {
  if (campaign.periodPlaceholderAt == null) return false;
  const marker = toEpochMs(campaign.periodPlaceholderAt);
  if (Number.isNaN(marker)) return false;
  return toEpochMs(campaign.startDate) === marker || toEpochMs(campaign.endDate) === marker;
}

/**
 * Statuses an unset campaign may hold. Any other target (ACTIVE, CLOSED, settlement, COMPLETED) needs a
 * period first, whatever the previous status is — kanban moves are any→any, so keying the guard on
 * "leaving PREPARATION" alone let DROPPED/PROPOSAL → ACTIVE through.
 */
export const UNSET_PERIOD_ALLOWED_STATUSES: readonly string[] = ["PROPOSAL", "PREPARATION", "DROPPED"];

/**
 * True when moving to `targetStatus` must be refused (manual change → 409) or held (automatic
 * settlement transition → save flags only) because the period is still unset. Pass the post-write
 * dates when the same request also writes dates.
 */
export function blocksStatusForUnsetPeriod(campaign: CampaignPeriodFields, targetStatus: string): boolean {
  return isCampaignPeriodUnset(campaign) && !UNSET_PERIOD_ALLOWED_STATUSES.includes(targetStatus);
}

/**
 * 409 body `code` for "leave PREPARATION while 기간 미정" (campaignPatchService). The client helper
 * (campaign-patch.ts) shows `CAMPAIGN_PERIOD_REQUIRED_MESSAGE` for it instead of the group-conflict
 * retry text that every code-less 409 gets.
 */
export const CAMPAIGN_PERIOD_REQUIRED_CODE = "CAMPAIGN_PERIOD_REQUIRED";
export const CAMPAIGN_PERIOD_REQUIRED_MESSAGE = "캠페인 일정을 먼저 정해야 상태를 바꿀 수 있습니다";
