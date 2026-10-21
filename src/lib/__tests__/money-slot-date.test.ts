import { describe, expect, it } from "vitest";

import { PAYOUT_SLOT_DATE_FIELDS } from "@/lib/money-slot-date";
import { resolveCampaignMoneySlots } from "@/lib/tax-filing-board";
import type { SalesChannel } from "@/lib/crm-types";

const CHANNELS: SalesChannel[] = ["UNSPECIFIED", "OWN_MALL", "OWN_MALL_NAVER", "OWN_MALL_KAKAO", "SELLER_MALL", "BRAND_MALL"];

describe("PAYOUT_SLOT_DATE_FIELDS — 판정표의 payout 칸과 같은 필드", () => {
  it.each(CHANNELS)("%s 의 payout 칸 필드가 상수와 같다", (channel) => {
    const slot = resolveCampaignMoneySlots(channel).find((s) => s.key === "payout");
    expect(slot).toBeDefined();
    expect({
      expectedField: slot!.expectedField,
      completedAtField: slot!.completedAtField,
      flagField: slot!.flagField,
    }).toEqual(PAYOUT_SLOT_DATE_FIELDS);
  });
});
