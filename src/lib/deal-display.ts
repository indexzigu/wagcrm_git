export function formatOptionDealName(parentDealName: string, optionDealName: string) {
  const trimmedParent = parentDealName.trim();
  const trimmedOption = optionDealName.trim();

  if (!trimmedParent) return trimmedOption;
  if (!trimmedOption) return trimmedParent;
  if (trimmedOption === trimmedParent || trimmedOption.startsWith(`${trimmedParent} - `)) {
    return trimmedOption;
  }

  return `${trimmedParent} - ${trimmedOption}`;
}

export function extractOptionLabel(parentDealName: string, optionDealName: string) {
  const normalizedName = formatOptionDealName(parentDealName, optionDealName);
  const prefix = `${parentDealName.trim()} - `;

  if (!prefix.trim() || !normalizedName.startsWith(prefix)) {
    return optionDealName.trim();
  }

  return normalizedName.slice(prefix.length);
}

export type DealNameInput = {
  dealName: string;
  unit?: string | null;
  unitQuantity?: number | null;
  supplementaryInfo?: string | null;
  parentDealId?: string | null;
};

export function getDisplayDealName(deal: DealNameInput): string {
  // 하위 딜(옵션)은 이미 dealName 필드에 완전한 조합 문자열이 저장되어 있으므로 그대로 사용
  if (deal.parentDealId) {
    return deal.dealName;
  }

  let pureSupplementaryInfo = deal.supplementaryInfo;
  if (pureSupplementaryInfo && pureSupplementaryInfo.startsWith("{")) {
    try {
      const parsed = JSON.parse(pureSupplementaryInfo);
      pureSupplementaryInfo = parsed.supplementaryInfo;
    } catch {
      // JSON 파싱 실패 시 원본 문자열 유지
    }
  }

  if (deal.unit && deal.unitQuantity != null) {
    let name = `${deal.dealName} - ${deal.unitQuantity}${deal.unit}`;
    if (pureSupplementaryInfo) {
      name += ` (${pureSupplementaryInfo})`;
    }
    return name;
  }
  
  if (pureSupplementaryInfo) {
    return `${deal.dealName} (${pureSupplementaryInfo})`;
  }

  return deal.dealName;
}

/**
 * 새 하위품목이 저장될 이름(T-271 봇 기안 · 결재 미리보기 공용 — 클라이언트 안전한 이 파일에 둔다) — 판매 조건 화면의 「하위품목 추가」(`useDealOptions` `handleAddOption`)와 같은 규칙:
 *  - 판매 조건에 단위(`unit`)가 있으면 이름은 단위 수량(+ 보충 정보 괄호)으로 만든다(`getDisplayDealName` =
 *    「판매 조건 이름 - 6통 (6개월분 + 케일 1박스)」) —
 *    화면은 이때 수량을 필수로 받는다. 수량이 없으면 null(기안 시점·승인 시점 모두 거절한다).
 *  - 없으면 「판매 조건 이름 - 옵션 이름」(`formatOptionDealName`).
 */
export function plannedOptionDealName(
  main: { dealName: string; unit: string | null },
  row: { dealName?: string; unitQuantity?: number; supplementaryInfo?: string },
): string | null {
  if (main.unit) {
    if (row.unitQuantity === undefined) return null;
    return getDisplayDealName({
      dealName: main.dealName,
      unit: main.unit,
      unitQuantity: row.unitQuantity,
      supplementaryInfo: row.supplementaryInfo?.trim() || null,
    });
  }
  return formatOptionDealName(main.dealName, row.dealName ?? "");
}

type DealBrandPartner = {
  name?: string | null;
  type?: string | null;
} | null | undefined;

export type DealContextInput = {
  brandName?: string | null;
  partnerName?: string | null;
};

export type DealIdentityInput = DealContextInput & {
  dealName?: string | null;
};

export type DealContextPart = {
  label: "판매 조건" | "브랜드" | "거래처";
  value: string;
};

export function normalizeDealBrandName(
  brandName: string | null | undefined,
  partner: DealBrandPartner,
) {
  if (brandName) return brandName;
  if (partner?.type !== "BRAND") return null;
  return partner.name ?? null;
}

export function getDealContextParts(input: DealContextInput): DealContextPart[] {
  const brandName =
    typeof input.brandName === "string" && input.brandName.trim().length > 0
      ? input.brandName.trim()
      : null;
  const partnerName =
    typeof input.partnerName === "string" && input.partnerName.trim().length > 0
      ? input.partnerName.trim()
      : null;

  if (brandName && partnerName && brandName !== partnerName) {
    return [
      { label: "브랜드", value: brandName },
      { label: "거래처", value: partnerName },
    ];
  }
  if (brandName) {
    return [{ label: "브랜드", value: brandName }];
  }
  if (partnerName) {
    return [{ label: "거래처", value: partnerName }];
  }
  return [];
}

export function formatDealContextLabel(input: DealContextInput) {
  const parts = getDealContextParts(input);
  return parts.length > 0 ? parts.map((part) => part.value).join(" - ") : undefined;
}

export function getDealIdentityParts(input: DealIdentityInput): DealContextPart[] {
  const dealName =
    typeof input.dealName === "string" && input.dealName.trim().length > 0
      ? input.dealName.trim()
      : null;

  return [
    ...(dealName ? [{ label: "판매 조건", value: dealName } satisfies DealContextPart] : []),
    ...getDealContextParts(input),
  ];
}
