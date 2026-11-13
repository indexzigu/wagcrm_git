/**
 * 주문캠페인 등록·수정 창의 「거래처 양식」 드롭다운 공용 판정 — 순수 함수만(client-safe).
 *
 * 두 창이 각자 손으로 들고 있다가 수정 창만 메일 상속을 빠뜨렸다: 양식을 바꿔도 수신·참조 메일이 안 채워지고,
 * 수신 메일이 필수 칸이라 저장까지 막혔다(봇이 양식 없이 만든 캠페인에 양식을 붙이려다 실사용에서 드러남).
 */

export type OrderBrandOption = {
  slug: string;
  displayName: string;
  toEmail: string | null;
  ccEmail: string | null;
};

/** `GET /order-converter/api/brands` 응답의 `brands` 를 드롭다운 항목으로. 배열이 아니면 빈 목록. */
export function toOrderBrandOptions(brands: unknown): OrderBrandOption[] {
  if (!Array.isArray(brands)) return [];
  return brands.flatMap((b) => {
    if (!b || typeof b !== "object") return [];
    const r = b as Record<string, unknown>;
    if (typeof r.slug !== "string" || !r.slug) return [];
    return [{
      slug: r.slug,
      displayName: typeof r.displayName === "string" && r.displayName ? r.displayName : r.slug,
      toEmail: typeof r.toEmail === "string" && r.toEmail ? r.toEmail : null,
      ccEmail: typeof r.ccEmail === "string" && r.ccEmail ? r.ccEmail : null,
    }];
  });
}

/**
 * 양식을 고르면 캠페인에 물려줄 메일 — 그 거래처에 설정된 칸만 돌려준다(없는 칸은 지금 값을 그대로 둔다).
 * 등록 창의 기존 동작(설정된 메일이 있으면 덮어씀)과 같다.
 */
export function brandEmailsFor(
  options: ReadonlyArray<OrderBrandOption>,
  slug: string,
): { toEmail?: string; ccEmail?: string } {
  const brand = options.find((o) => o.slug === slug);
  return {
    ...(brand?.toEmail ? { toEmail: brand.toEmail } : {}),
    ...(brand?.ccEmail ? { ccEmail: brand.ccEmail } : {}),
  };
}
