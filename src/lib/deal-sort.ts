import type { CampaignDealRow } from "./crm-types";

const dealNameCollator = new Intl.Collator("ko", {
  numeric: true,
  sensitivity: "base",
});

export function sortDealRowsByName(deals: CampaignDealRow[]): CampaignDealRow[] {
  return [...deals].sort((left, right) => {
    const byName = dealNameCollator.compare(left.dealName ?? "", right.dealName ?? "");
    if (byName !== 0) return byName;
    return String(left.id).localeCompare(String(right.id));
  });
}
