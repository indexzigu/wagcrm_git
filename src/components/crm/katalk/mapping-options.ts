import type { CampaignOption, MappingOption, PartnerOption, SellerOption } from "./types";

/**
 * PARTNER/SELLER/CAMPAIGN 목록을 SearchableDropdown(src/components/crm/searchable-dropdown.tsx,
 * 기존 재사용 패턴 — cmdk 기반 검색 가능 드롭다운)에 넣을 수 있는 단일 옵션 배열로 합친다.
 * 방/파일이 많아 목록이 길어질 때 이름으로 필터링할 수 있도록 하기 위한 용도.
 */
export function buildMappingOptions(
  partners: PartnerOption[],
  sellers: SellerOption[],
  campaigns: CampaignOption[]
): MappingOption[] {
  const partnerOptions: MappingOption[] = partners.map((p) => ({
    compositeValue: `PARTNER:${p.id}`,
    kind: "PARTNER",
    entityId: p.id,
    label: `[거래처] ${p.name}`,
    searchableText: p.name,
  }));

  const sellerOptions: MappingOption[] = sellers.map((s) => ({
    compositeValue: `SELLER:${s.id}`,
    kind: "SELLER",
    entityId: s.id,
    label: `[셀러] ${s.alias || s.name}`,
    searchableText: `${s.alias ?? ""} ${s.name}`,
  }));

  const campaignOptions: MappingOption[] = campaigns.map((c) => {
    const displayName = c.campaignName || `${c.dealName} · ${c.sellerName}`;
    return {
      compositeValue: `CAMPAIGN:${c.id}`,
      kind: "CAMPAIGN",
      entityId: c.id,
      campaignSellerId: c.sellerId,
      label: `[캠페인] ${displayName}`,
      searchableText: `${displayName} ${c.dealName} ${c.sellerName}`,
    };
  });

  return [...partnerOptions, ...sellerOptions, ...campaignOptions];
}
