export type EntityType = "PARTNER" | "SELLER";

export type RoomType = "DIRECT" | "GROUP" | "OPEN";

export type CollectorType = "KATOK_AUTO" | "TXT_UPLOAD" | "EXCLUDED";

export type PreviewResult = {
  roomName: string;
  roomKey: string;
  roomType: RoomType;
  messageCount: number;
  chunkCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  mapping: {
    entityType: EntityType | null;
    entityId: string | null;
    campaignId: string | null;
    collectorType: CollectorType;
  } | null;
  warnings: string[];
};

export type CommitResult = {
  upserted: number;
  skipped: number;
  roomKey: string;
  roomName: string;
  errors?: { chunkId?: string; sentAt: string; reason: string }[];
};

export type UploadFileState = {
  id: string;
  file: File;
  status: "pending" | "previewing" | "previewed" | "preview-error" | "committing" | "committed" | "commit-error";
  preview?: PreviewResult;
  commit?: CommitResult;
  error?: string;
  mappingEntityType: EntityType | null;
  mappingEntityId: string | null;
  mappingCampaignId: string | null;
};

export type ManageRoom = {
  id: string | null;
  source: string;
  roomKey: string;
  roomName: string | null;
  roomType: RoomType | null;
  collectorType: CollectorType;
  excluded: boolean;
  entityType: EntityType | null;
  entityId: string | null;
  entityName: string | null;
  campaignId: string | null;
  lastSyncedAt: string | null;
  messageCount: number | null;
  mapped: boolean;
};

export type PartnerOption = { id: string; name: string };
export type SellerOption = { id: string; name: string; alias?: string | null };
export type CampaignOption = {
  id: string;
  campaignName?: string | null;
  dealName: string;
  sellerName: string;
  /** 캠페인 선택 시 entityType=SELLER 귀속에 필요(캠페인은 항상 셀러에 속함). */
  sellerId: string;
};

/**
 * 매핑 드롭다운(업로드 탭 인라인 매핑 + 방 관리 탭 매핑 설정)에서 PARTNER/SELLER/CAMPAIGN을
 * 하나의 검색 가능 목록으로 통합하기 위한 공용 옵션 타입. SearchableDropdown(기존 재사용 컴포넌트,
 * src/components/crm/searchable-dropdown.tsx)의 items 제네릭에 그대로 넣을 수 있다.
 *
 * CAMPAIGN 옵션 선택 시 entityType/entityId는 그 캠페인의 셀러(SELLER)로 설정되고, campaignId가
 * 추가로 태깅된다 — WorkRecord.campaignId는 entityType/entityId와 독립적인 부가 태그이고
 * (kakao-uploads/route.ts의 effectiveCampaignId 처리 참조), SalesCampaign은 항상 특정 셀러에
 * 속하므로 캠페인 매핑은 "그 셀러에게 귀속 + 이 캠페인으로 태깅"을 동시에 의미한다.
 */
export type MappingOption = {
  /** "PARTNER:<id>" | "SELLER:<id>" | "CAMPAIGN:<id>" 형태의 합성 값(SearchableDropdown value) */
  compositeValue: string;
  kind: "PARTNER" | "SELLER" | "CAMPAIGN";
  entityId: string;
  /** CAMPAIGN일 때만 채워짐(그 캠페인이 속한 셀러 id) */
  campaignSellerId?: string;
  label: string;
  searchableText: string;
};
