export type LinkedDealSortItem = {
  id: string;
  createdAt?: string | null;
};

export type LinkedCampaignSortItem = {
  id: string;
  startDate?: string | null;
};

function timeOrMin(value?: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

export function sortLinkedDealsByCreatedAt<T extends LinkedDealSortItem>(items: T[]): T[] {
  return [...items].sort((a, b) => timeOrMin(b.createdAt) - timeOrMin(a.createdAt));
}

export function sortLinkedCampaignsByStartDate<T extends LinkedCampaignSortItem>(items: T[]): T[] {
  return [...items].sort((a, b) => timeOrMin(b.startDate) - timeOrMin(a.startDate));
}
