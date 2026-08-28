// campaign-content — 캠페인 실적 콘텐츠(R5)의 순수 로직 코어(Prisma·HTTP 비의존).
// "셀러 게시물" 판정 필터와 promote(딜 레퍼런스로 복사) 시 복사 필드 셀렉터,
// 성과 한 줄 요약 포맷을 순수 함수로 분리해 단위테스트한다.
// URL 정규화·중복판정은 R1/R2a(reference-url.ts, reference-inbox.ts)를 그대로 재사용한다.

/** 셀러 게시물 판정에 필요한 최소 Asset 형태. */
export type SellerPostAssetLike = {
  entityType: string;
  provider: string;
  externalUrl?: string | null;
  archivedAt?: string | Date | null;
};

/**
 * 캠페인 자산 중 "셀러 게시물"(셀러가 실제 올린 게시물 링크)인지 판정한다.
 * R5 저장 그릇 규약: entityType=CAMPAIGN + provider=EXTERNAL_LINK + externalUrl 존재.
 * 보관(archivedAt)된 자산은 목록에서 제외한다.
 */
export function isSellerPostAsset(asset: SellerPostAssetLike): boolean {
  return (
    asset.entityType === "CAMPAIGN" &&
    asset.provider === "EXTERNAL_LINK" &&
    typeof asset.externalUrl === "string" &&
    asset.externalUrl.length > 0 &&
    !asset.archivedAt
  );
}

/** promote 복사 필드 셀렉터의 입력(원본 캠페인 Asset의 최소 형태). */
export type PromotableAssetLike = {
  fileName: string;
  externalUrl?: string | null;
  thumbnailUrl?: string | null;
  notes?: string | null;
};

/** promote로 새 DEAL Asset에 복사되는 필드 집합. */
export type PromoteCopyFields = {
  fileName: string;
  externalUrl: string;
  thumbnailUrl: string | null;
  notes: string | null;
};

/**
 * promote(딜 레퍼런스로 복사) 시 원본 캠페인 Asset에서 복사할 필드를 고른다.
 * externalUrl이 없는 자산(파일 업로드 등)은 레퍼런스 링크가 아니므로 null을 반환한다
 * (호출부는 400으로 응답). thumbnailUrl·notes는 R3 보강 결과를 그대로 물려받는다.
 */
export function selectPromoteCopyFields(asset: PromotableAssetLike): PromoteCopyFields | null {
  if (typeof asset.externalUrl !== "string" || asset.externalUrl.length === 0) {
    return null;
  }
  return {
    fileName: asset.fileName,
    externalUrl: asset.externalUrl,
    thumbnailUrl: asset.thumbnailUrl ?? null,
    notes: asset.notes ?? null,
  };
}

/**
 * 캠페인 성과 한 줄 요약을 만든다(셀러 게시물 섹션 헤더용).
 * 기존 캐시 필드(actualSales·itemCount)만 재사용하고 신규 집계는 하지 않는다(R5 제약).
 * 둘 다 없으면 "실적 집계 전"을 반환한다.
 */
export function formatCampaignPerformanceSummary(input: {
  actualSales: number | null | undefined;
  itemCount: number | null | undefined;
}): string {
  const parts: string[] = [];
  if (typeof input.actualSales === "number" && Number.isFinite(input.actualSales)) {
    parts.push(`실매출 ${Math.round(input.actualSales).toLocaleString("ko-KR")}원`);
  }
  if (typeof input.itemCount === "number" && Number.isFinite(input.itemCount)) {
    parts.push(`판매수량 ${input.itemCount.toLocaleString("ko-KR")}개`);
  }
  return parts.length > 0 ? parts.join(" · ") : "실적 집계 전";
}
