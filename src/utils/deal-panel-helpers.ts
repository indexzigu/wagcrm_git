import type { BaseMarginPolicy, DealStatus } from "@/lib/crm-types";

export type DealPanelData = {
  id: string;
  dealName: string;
  brandName?: string | null;
  partnerName: string;
  partnerId: string;
  partner?: {
    id: string;
    name: string;
    type: string;
    businessNumber?: string | null;
    companyStatus?: string | null;
    companyRole?: string | null;
    ceoName?: string | null;
    address?: string | null;
    contactInfo?: string | null;
    representativeEmail?: string | null;
  } | null;
  costPrice: number;
  sellingPrice: number;
  listPrice?: number | null;
  floorPrice?: number | null;
  supplyPrice?: number | null;
  discountRate?: number | null;
  totalCommissionRate?: number | null;
  brokerageCommissionRate?: number | null;
  sourcingMemo?: string | null;
  candidateSellers?: string | null;
  status: DealStatus;
  baseMarginPolicy: BaseMarginPolicy;
  createdAt: string;
  dealType?: string;
  parentDealId?: string | null;
  unit?: string | null;
  unitQuantity?: number | null;
  supplementaryInfo?: string | null;
  options?: Array<{
    id: string;
    dealName: string;
    costPrice: number;
    sellingPrice: number;
    totalCommissionRate?: number | null;
    dealType: string;
    optionSortOrder?: number;
    parentDealId?: string | null;
    unit?: string | null;
    unitQuantity?: number | null;
    supplementaryInfo?: string | null;
  }>;
  campaigns?: Array<{
    id: string;
    sellerName: string;
    salesChannel: string;
    status: string;
    startDate: string;
    endDate: string;
  }>;
};

export function formatCurrency(value: number): string {
  return value.toLocaleString("ko-KR") + "원";
}

export function formatBusinessNumber(value?: string | null) {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 10) return value;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

export function parseNullableNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizePolicy(
  value: unknown,
  fallback: BaseMarginPolicy,
): BaseMarginPolicy {
  if (!value) {
    return fallback;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as BaseMarginPolicy;
    } catch {
      return fallback;
    }
  }

  if (typeof value === "object") {
    return value as BaseMarginPolicy;
  }

  return fallback;
}

export function normalizeDealPanelData(
  payload: Record<string, unknown>,
  current: DealPanelData,
): DealPanelData {
  const partner =
    payload.partner && typeof payload.partner === "object"
      ? (payload.partner as Record<string, unknown>)
      : null;

  return {
    ...current,
    ...payload,
    partnerName:
      (typeof payload.partnerName === "string" && payload.partnerName) ||
      (typeof partner?.name === "string" && partner.name) ||
      current.partnerName,
    partnerId:
      typeof payload.partnerId === "string"
        ? payload.partnerId
        : current.partnerId,
    costPrice: Number(payload.costPrice ?? current.costPrice ?? 0),
    sellingPrice: Number(payload.sellingPrice ?? current.sellingPrice ?? 0),
    listPrice:
      payload.listPrice === undefined
        ? current.listPrice
        : (parseNullableNumber(payload.listPrice) ?? null),
    floorPrice:
      payload.floorPrice === undefined
        ? current.floorPrice
        : (parseNullableNumber(payload.floorPrice) ?? null),
    supplyPrice:
      payload.supplyPrice === undefined
        ? current.supplyPrice
        : (parseNullableNumber(payload.supplyPrice) ?? null),
    discountRate:
      payload.discountRate === undefined
        ? current.discountRate
        : (parseNullableNumber(payload.discountRate) ?? null),
    totalCommissionRate:
      payload.totalCommissionRate === undefined
        ? current.totalCommissionRate
        : (parseNullableNumber(payload.totalCommissionRate) ?? null),
    brokerageCommissionRate:
      payload.brokerageCommissionRate === undefined
        ? current.brokerageCommissionRate
        : (parseNullableNumber(payload.brokerageCommissionRate) ?? null),
    baseMarginPolicy: normalizePolicy(
      payload.baseMarginPolicy,
      current.baseMarginPolicy,
    ),
    dealType:
      typeof payload.dealType === "string"
        ? payload.dealType
        : current.dealType,
    parentDealId:
      payload.parentDealId === undefined
        ? current.parentDealId
        : payload.parentDealId == null
          ? null
          : String(payload.parentDealId),
    unit: typeof payload.unit === "string" ? payload.unit : current.unit,
    unitQuantity:
      typeof payload.unitQuantity === "number"
        ? payload.unitQuantity
        : current.unitQuantity,
    supplementaryInfo:
      typeof payload.supplementaryInfo === "string"
        ? payload.supplementaryInfo
        : current.supplementaryInfo,
    campaigns: Array.isArray(payload.campaigns)
      ? payload.campaigns.map((campaign) => {
          const record = campaign as Record<string, unknown>;
          return {
            id: String(record.id ?? ""),
            sellerName: String(record.sellerName ?? ""),
            salesChannel: String(record.salesChannel ?? "공동구매"),
            status: String(record.status ?? ""),
            startDate: String(record.startDate ?? ""),
            endDate: String(record.endDate ?? ""),
          };
        })
      : current.campaigns,
    options: Array.isArray(payload.options)
      ? payload.options.map((option) => {
          const record = option as Record<string, unknown>;
          return {
            id: String(record.id ?? ""),
            dealName: String(record.dealName ?? ""),
            costPrice: Number(record.costPrice ?? 0),
            sellingPrice: Number(record.sellingPrice ?? 0),
            totalCommissionRate:
              record.totalCommissionRate === undefined
                ? null
                : (parseNullableNumber(record.totalCommissionRate) ?? null),
            dealType: String(record.dealType ?? "OPTION"),
            optionSortOrder: Number(record.optionSortOrder ?? 0),
            parentDealId:
              record.parentDealId == null ? null : String(record.parentDealId),
            unit: typeof record.unit === "string" ? record.unit : null,
            unitQuantity:
              typeof record.unitQuantity === "number"
                ? record.unitQuantity
                : null,
            supplementaryInfo:
              typeof record.supplementaryInfo === "string"
                ? record.supplementaryInfo
                : null,
          };
        })
      : current.options,
  };
}

export function computeOptionCostFromSelling(
  sellingValue: string,
  commissionValue: string,
): string {
  const selling = Number(sellingValue);
  const commission = Number(commissionValue);

  if (!Number.isFinite(selling) || sellingValue === "") return "";
  if (!Number.isFinite(commission) || commissionValue === "") return "";
  if (commission < 0 || commission >= 100) return "";

  return String(Math.round(selling * (1 - commission / 100)));
}

export function computeSupplyPrice(
  sellingPrice: number | null | undefined,
  commissionRate: number | null | undefined,
) {
  if (sellingPrice == null || commissionRate == null) return null;
  if (!Number.isFinite(sellingPrice) || !Number.isFinite(commissionRate))
    return null;
  if (sellingPrice < 0 || commissionRate < 0 || commissionRate >= 100)
    return null;
  return Math.round(sellingPrice * (1 - commissionRate / 100));
}

export function buildOptionSupplementaryInfo(
  freeText: string,
  modelName: string,
): string | null {
  const trimmedModelName = modelName.trim();
  const trimmedFreeText = freeText.trim();
  if (!trimmedModelName) {
    return trimmedFreeText || null;
  }
  return JSON.stringify({
    supplementaryInfo: trimmedFreeText,
    modelName: trimmedModelName,
  });
}

export function parseOptionSupplementaryInfo(raw: string | null | undefined): {
  supplementaryInfo: string;
  modelName: string;
} {
  if (!raw) return { supplementaryInfo: "", modelName: "" };
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.modelName === "string"
    ) {
      return {
        supplementaryInfo:
          typeof parsed.supplementaryInfo === "string"
            ? parsed.supplementaryInfo
            : "",
        modelName: parsed.modelName,
      };
    }
  } catch {
    // 레거시 경로
  }
  return { supplementaryInfo: raw, modelName: "" };
}
