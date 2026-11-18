import { describe, expect, it } from "vitest";
import { isCampaignPeriodUnset } from "./campaign-period";

// T-313: a campaign created from outreach has no period yet. It is stored with both dates equal to
// a placeholder timestamp; the period counts as unset while either date still equals it (both must be written to leave 미정).
const placeholder = new Date("2026-11-17T03:00:00.000Z");

describe("isCampaignPeriodUnset", () => {
  it("is unset while both dates equal the placeholder", () => {
    expect(
      isCampaignPeriodUnset({ startDate: placeholder, endDate: placeholder, periodPlaceholderAt: placeholder }),
    ).toBe(true);
  });

  it("accepts ISO strings (DTO / JSON shapes)", () => {
    const iso = placeholder.toISOString();
    expect(isCampaignPeriodUnset({ startDate: iso, endDate: iso, periodPlaceholderAt: iso })).toBe(true);
  });

  it("is dated when there is no placeholder", () => {
    expect(isCampaignPeriodUnset({ startDate: placeholder, endDate: placeholder, periodPlaceholderAt: null })).toBe(false);
    expect(isCampaignPeriodUnset({ startDate: placeholder, endDate: placeholder })).toBe(false);
  });

  it("stays unset until both dates are written (a one-date write keeps it unset)", () => {
    const other = new Date("2026-12-01T00:00:00.000Z");
    expect(isCampaignPeriodUnset({ startDate: other, endDate: placeholder, periodPlaceholderAt: placeholder })).toBe(true);
    expect(isCampaignPeriodUnset({ startDate: placeholder, endDate: other, periodPlaceholderAt: placeholder })).toBe(true);
  });

  it("becomes dated once both dates are written (self-clearing)", () => {
    const start = new Date("2026-12-01T00:00:00.000Z");
    const end = new Date("2026-12-10T00:00:00.000Z");
    expect(isCampaignPeriodUnset({ startDate: start, endDate: end, periodPlaceholderAt: placeholder })).toBe(false);
  });

  it("treats unparseable dates as dated (never hides a real period)", () => {
    expect(isCampaignPeriodUnset({ startDate: "garbage", endDate: "garbage", periodPlaceholderAt: "garbage" })).toBe(false);
  });
});
