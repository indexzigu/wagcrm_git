import type { SettlementItemRow } from "./settlement-items";

export type PartnerType = "BRAND" | "VENDOR" | "AGENCY" | "AGENT" | "SELLER";
export type SnsType = "INSTAGRAM" | "YOUTUBE" | "X";
export type DealStatus =
  | "SOURCING"
  | "NEGOTIATING"
  | "CONFIRMED"
  | "SAMPLE_TESTING"
  | "ARCHIVED"
  | "DROPPED";
export type CampaignStatus =
  | "PROPOSAL"
  | "PREPARATION"
  | "ACTIVE"
  | "CLOSED"
  | "SETTLEMENT_WAIT"
  | "SETTLEMENT_IN_PROGRESS"
  | "COMPLETED"
  | "DROPPED";
export type SalesChannel = "UNSPECIFIED" | "OWN_MALL" | "OWN_MALL_NAVER" | "OWN_MALL_KAKAO" | "SELLER_MALL" | "BRAND_MALL";
export type ApiProvider = "INSTAGRAM" | "YOUTUBE" | "NAVER" | "INTERNAL";
export type AssetProvider =
  | "SUPABASE"
  | "GOOGLE_DRIVE"
  | "EXTERNAL_LINK"
  | "CLOUDFLARE_R2";
export type AssetSection =
  | "PRODUCT_INTRO"
  | "PRICE_TABLE"
  | "GROUP_BUY_PRICE"
  | "DETAIL_PAGE"
  | "SNS_CREATIVE"
  | "CONTRACT_SETTLEMENT"
  | "SAMPLE_REVIEW"
  | "ORDER_TEMPLATE"
  | "ETC";
export type AssetEntityType = "DEAL" | "CAMPAIGN" | "PARTNER" | "SELLER" | "OUTREACH";
export type StorageIntegrationStatus =
  | "CONNECTED"
  | "DISCONNECTED"
  | "ERROR";

export type MarginRate = {
  totalMarginRate: number;
  sellerMarginRate: number;
};

export type SlideRule = {
  minActualSales: number;
  totalMarginAddRate: number;
  sellerMarginAddRate?: number;
};

export type BaseMarginPolicy = {
  byChannel: Partial<Record<SalesChannel, MarginRate>>;
  slides?: SlideRule[];
};

export type PartnerSummary = {
  id: string;
  name: string;
  type: PartnerType;
  status?: string | null;
  contactInfo?: string | null;
  bankAccount?: string | null;
  businessNumber?: string | null;
  companyStatus?: string | null;
  companyRole?: string | null;
  ceoName?: string | null;
  address?: string | null;
  businessType?: string | null;
  businessItem?: string | null;
  representativeEmail?: string | null;
  // F4-② 발주 브랜드 설정
  orderTemplateSlug?: string | null;
  orderDisplayName?: string | null;
  orderEmailDomains?: string | null;
  orderFormatAdapter?: string | null;
  orderToEmail?: string | null;
  orderCcEmail?: string | null;
  // F4 Phase 2: 열 매핑 규칙(OrderExcelRules JSON). UI는 존재 여부·요약만 판단, 검증은 excel-rules zod
  orderExcelRules?: unknown;
  bizSyncedAt?: string | null;
  lastContactAt?: string | null;
  notes?: string | null;
  referredById?: string | null;
  referredByName?: string | null;
  dealCount?: number;
  createdAt?: string;
  contacts?: Array<{
    id: string;
    name: string;
    role?: string | null;
    email?: string | null;
    phoneNumber?: string | null;
    notes?: string | null;
    lastContactAt?: string | null;
  }>;
};

export type DealSummary = {
  id: string;
  dealName: string;
  costPrice: number;
  sellingPrice: number;
  status: DealStatus;
  brandName?: string | null;
  partnerCompanyName?: string | null;
  listPrice?: number | null;
  floorPrice?: number | null;
  discountRate?: number | null;
  totalCommissionRate?: number | null;
  brokerageCommissionRate?: number | null;
  sourcingMemo?: string | null;
  candidateSellers?: string | null;
  shippingFee?: number | null;
  freeShippingThreshold?: number | null;
  createdAt?: string;
  campaignCount?: number;
  partner: PartnerSummary | null;
  baseMarginPolicy: BaseMarginPolicy;
};

export type SellerSummary = {
  id: string;
  name: string;
  alias?: string | null;
  snsType: SnsType;
  snsHandle: string;
  currentFollowers: number;
  currentPostsCount?: number | null;
  profileBio?: string | null;
  profilePicUrl?: string | null;
  profileExternalUrls?: string | null;
  /** 유효 캠페인 수 — 그룹(CampaignGroup)은 1건으로 센다(campaign-group-count.ts SSOT). */
  campaignCount?: number;
  /** 딜 단위 행 수(SalesCampaign raw count) — 유효 수와 다를 때 "(N딜)" 보조 표기용. */
  campaignRowCount?: number;
  category?: string | null;
  agencyId?: string | null;
  agencyName?: string | null;
  channelUrl?: string | null;
  reviewer?: string | null;
  personalCategory?: string | null;
  proposalProduct?: string | null;
  proposalWaitlist?: string | null;
  fitLevel?: string | null;
  collaborationScore?: string | null;
  adResponseScore?: string | null;
  commentResponseScore?: string | null;
  activityFrequency?: string | null;
  /** AI 분석 종합점수 캐시 (SellerAiProfile.compositeScore, §12-3) */
  aiComposite?: number | null;
  /** AI 분석 신뢰도 캐시 ('high'|'medium'|'low') */
  aiConfidence?: string | null;
  /** AI 분석 시각 캐시 (SellerAiProfile.analyzedAt) — 목록의 분석 경과 표시용 */
  aiAnalyzedAt?: string | null;
  accountNumber?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  mailingAddress?: string | null;
  notes?: string | null;
  lastReviewedAt?: string | null;
  /**
   * 셀러 프로필/팔로워 데이터가 마지막으로 실제 수집된 시각 = max(SellersHistory.snapshotDate).
   * Seller.updatedAt(수기 메모 편집에도 움직임)과 달리 재수집 경로에서만 갱신되므로,
   * "어느 셀러 정보를 다시 긁을지"(API 쿼터 선별) 판단의 정확한 신선도 신호다. null=미수집.
   */
  lastSyncedAt?: string | null;
  isMonitored?: boolean;
  /** 셀러 전용 리포트 포털 토큰 (Seller.portalToken). 미발급이면 null. */
  portalToken?: string | null;
  /** 셀러 전용 주소 슬러그 (crm.ygrd.kr/<slug>). 미설정이면 null. */
  portalSlug?: string | null;
  /** 포털 열람 비밀번호 설정 여부 — 해시는 절대 클라이언트로 내리지 않는다. */
  hasPortalPassword?: boolean;
  createdAt?: string;
  /**
   * 누적 캠페인 최근성 신호 — campaigns 캡(take:12)과 무관한 서버 집계(non-DROPPED 기준,
   * seller-summary.ts). campaignRecency(partner-seller-display.ts)가 캡 배열보다 우선 소비한다.
   * undefined = 집계 실패/구 페이로드(캡 배열 폴백). lastCampaignEndAt null = 종료 이력 없음.
   */
  hasActiveCampaign?: boolean;
  hasUpcomingCampaign?: boolean;
  lastCampaignEndAt?: string | null;
  /**
   * 휴면 티어 판정 근거 — **과거에 실제로 진행된** 캠페인만 센 신호(seller-dormancy.ts SSOT).
   * `campaignCount`(전 상태 누적)와 **다른 값이다**: 여기는 RUN_STATUSES + 시작일 도래분만
   * 세고 그룹은 1회로 접는다. undefined = 집계 실패/구 페이로드(티어 열을 비운다),
   * lastRunStartAt null = 과거 진행 0건 → '판정 불가'(0일로 취급하지 않는다).
   */
  runCount?: number;
  lastRunStartAt?: string | null;
  campaigns?: Array<{
    id: string;
    dealName: string;
    brandName: string | null;
    partnerName: string | null;
    startDate: string;
    endDate: string;
    status: CampaignStatus;
    actualSales: number | null;
  }>;
  histories?: Array<{
    snapshotDate: string;
    followersCount: number;
    postsCount?: number | null;
  }>;
  /** F6 outcome 적립: 유입 경로 (REFERRAL|NETWORK|INBOUND|COLD|DISCOVERY) */
  acquisitionChannel?: string | null;
  /** F6: 소개자 셀러 ID (acquisitionChannel=REFERRAL일 때) */
  referredById?: string | null;
  /** F6: 소개자 표시명 (alias 우선) — 서버 매핑 산출 */
  referredByName?: string | null;
  acquisitionNote?: string | null;
  /** F6: 셀러에게 직접 확인한 가용 일정 (추정 금지) */
  availabilityNote?: string | null;
  availabilityUpdatedAt?: string | null;
};

export type CampaignDealRow = {
  id: string;
  campaignId: string;
  dealId: string;
  dealName: string;
  quantity: number;
  actualSales: number;
  feeRate?: number | null;
  sellerMarginRate?: number | null;
  costPrice?: number | null;
  sellingPrice?: number | null;
};

export type SalesTaskSummary = {
  id: string;
  status: string;
  contactChannel: string | null;
  proposalMessage: string | null;
  negotiationMemo: string | null;
  testingMemo: string | null;
};

export type CampaignRow = {
  id: string;
  dealId: string;
  sellerId: string;
  /** CG-1: 조합 캠페인 묶음(CampaignGroup) 소속 id. null=미그룹. */
  groupId?: string | null;
  /** CG-1: 소속 그룹의 멤버 수(카드 배지용). 목록 읽기 경로에서만 채워짐 — 미제공 시 배지는 아이콘만. */
  groupMemberCount?: number;
  /**
   * 이번 PATCH 가 **같은 그룹의 형제 멤버 몇 건에 일정을 함께 반영했는가**(원본 제외).
   *
   * 영속 필드가 아니라 `PATCH /api/campaigns/[id]` 응답에만 실리는 **일회성 신호**다 —
   * 클라이언트가 "같은 그룹 N건도 함께 변경되었습니다" 고지를 띄우는 근거. 그룹이 아니거나
   * 팬아웃 대상 필드(기간·반품기간)를 안 건드렸으면 미제공(undefined)이다.
   * ⛔ 그룹 크기로 읽지 말 것 — 원본을 제외한 **이번에 갱신된 수**다.
   */
  groupScheduleSyncedCount?: number;
  campaignName: string | null;
  salesCode?: string | null;
  dealName: string;
  partnerName: string;
  /**
   * 공급사(거래처) 사업자 필드 — 세금계산서 공급받는자가 공급사인 행(브랜드몰
   * 발행·우리몰 수취)에 필요하다. `PartnerSummary`에는 이미 있던 필드를 캠페인
   * DTO 로도 노출한 것뿐이다(2026-08-04, `tax-invoice-builder` 공급사 상대 지원).
   * 전부 optional·nullable — 대부분의 화면은 안 쓰고, 파트너 데이터가 비어 있는
   * 레거시 캠페인도 있다.
   */
  partnerBusinessNumber?: string | null;
  /**
   * 공급사(거래처) id — 정산 정보 공급사 탭이 계좌번호를 그 자리에서 수정할 때
   * `PATCH /api/partners/[id]` 의 대상이 된다(2026-08-27). 거래처 미연결 캠페인은 null.
   */
  partnerId?: string | null;
  /**
   * 공급사 계좌번호(`Partner.bankAccount`) — 거래처에 저장되는 값이라 같은 공급사의
   * 다른 캠페인·구글 캘린더 대금 이벤트(`google-calendar-sync`)와 출처가 하나다.
   */
  partnerBankAccount?: string | null;
  partnerCeoName?: string | null;
  partnerAddress?: string | null;
  partnerBusinessType?: string | null;
  partnerBusinessItem?: string | null;
  partnerEmail?: string | null;
  sellerName: string;
  /**
   * 법적 실명(`Seller.realName`) — 원천징수 신고 등 법적 서류 표기용.
   * 화면 일반 표기는 `sellerName`(별칭 우선)이고, 이 필드는 **미입력이면 null 이다** —
   * `sellerName` 으로 폴백하지 말 것(활동명이 실명으로 신고되는 사고를 막는 계약).
   */
  sellerRealName?: string | null;
  sellerCompanyName?: string | null;
  sellerCompanyType?: PartnerType | string | null;
  sellerCompanyBusinessNumber?: string | null;
  sellerCompanyStatus?: string | null;
  sellerCompanyRole?: string | null;
  sellerCompanyCeoName?: string | null;
  sellerCompanyAddress?: string | null;
  sellerCompanyBankAccount?: string | null;
  sellerCompanyBusinessType?: string | null;
  sellerCompanyBusinessItem?: string | null;
  sellerCompanyEmail?: string | null;
  sellerResidentNumber?: string | null;
  sellerPersonalBankAccount?: string | null;
  snsType: SnsType;
  snsHandle: string;
  fitLevel?: string | null;
  currentFollowers?: number | null;
  campaignCount?: number;
  category?: string | null;
  startDate: string;
  endDate: string;
  salesChannel: SalesChannel;
  /**
   * 주문관리(`OrderCampaign`)에 등록됐는가 — 자사 네이버 캠페인의 "세팅 완료" 신호.
   * `orderCampaignId != null` 을 boolean 으로 좁혀 싣는다(cuid 원문은 화면이 쓰지
   * 않고, 이 payload 는 Supabase egress 의 주 소비처다). 판정 SSOT 는
   * `src/lib/campaign-setup.ts` — 그 파일의 doc 에 실측 근거가 있다.
   *
   * optional 인 이유: 이 DTO 는 표면이 넓고 부분 구성 사이트(주로 테스트 픽스처)가
   * 많다. 운영 경로의 유일한 생산자는 `toCampaignRow` 이고 거기서 항상 채워진다.
   * 미지정은 `needsOrderRegistration` 에서 "미등록"으로 읽히지만, 그 판정은
   * `salesChannel === "OWN_MALL_NAVER"` 를 먼저 통과해야 해서 부분 픽스처가 배지를
   * 잘못 켜지 않는다.
   */
  isOrderRegistered?: boolean;
  baseNaverLink: string;
  generatedTrackingLink: string;
  actualSales: number | null;
  sellerExpense?: number | null;
  operatingExpense?: number | null;
  operatingProfit?: number | null;
  settlementSales?: number | null;
  quantity?: number | null;
  itemCount?: number | null;
  totalMarginRate: number;
  sellerMarginRate: number;
  netMarginRate: number;
  status: CampaignStatus;
  isManualMargin: boolean;
  isManualSettlementSales?: boolean;
  isManualSellerExpense?: boolean;
  isManualTaxExpense?: boolean;
  sellerTaxType?: string | null;
  commissionBasis?: string | null;
  isDepositReceived?: boolean;
  isPayoutCompleted?: boolean;
  depositReceivedAt?: string | null;
  payoutCompletedAt?: string | null;
  returnPeriodEndDate?: string | null;
  settlementSupplyCost?: number | null;
  /** 수기 물품대금(세무 대조 전용) — 0 = 타 캠페인 계산서에 합산됨 */
  settlementGoodsCost?: number | null;
  /**
   * 정산 부가 항목 — 「매출 × 요율」 파생 밖의 돈(부대비용·통과·잡이익).
   * 평소 빈 배열이 정상이다. 판정·합계 SSOT 는 `src/lib/settlement-items.ts`.
   * ⛔ 셀러 정산 기준·저장 손익 파생에 반영하지 않는다(불변식).
   */
  settlementItems?: SettlementItemRow[];
  supplierInvoiceIssuedAt?: string | null;
  sellerInvoiceIssuedAt?: string | null;
  shippingFee?: number | null;
  freeShippingThreshold?: number | null;
  expectedDepositDate?: string | null;
  expectedPayoutDate?: string | null;
  /** 자사몰 공급사 지급 레그(2번째 지급 일정) — 슬롯 SSOT: resolveCampaignMoneySlots */
  expectedSupplierPayoutDate?: string | null;
  supplierPayoutCompletedAt?: string | null;
  isSupplierPayoutCompleted?: boolean;
  accountingCompletedAt?: string | null;
  actualPayoutAmount?: number | null;
  taxExpense?: number | null;
  miscExpense?: number | null;
  roundNumber?: number | null;
  assignedTo: string | null;
  teamId?: string | null;
  nextAction?: string | null;
  checklistSummary?: {
    status: CampaignStatus;
    checkedCount: number;
    totalCount: number;
    requiredCheckedCount: number;
    requiredTotalCount: number;
    nextItemLabel: string | null;
    isComplete: boolean;
  };
  rawSchedule?: string | null;
  sourceCreatedAt?: string | null;
  notesFromImport?: string | null;
  updatedAt: string;
  deal?: {
    costPrice: number;
    sellingPrice: number;
    brandName: string | null;
    status?: DealStatus | string | null;
  };
  followerHistory: Array<{
    date: string;
    followers: number;
  }>;
  activityHistory: Array<{
    id: string;
    action: string;
    label: string;
    details?: string | null;
    actor: string;
    createdAt: string;
  }>;
  notes: Array<{
    id: string;
    content: string;
    actor: string;
    actorName: string | null;
    createdAt: string;
  }>;
  campaignDeals?: CampaignDealRow[];
  salesTask?: SalesTaskSummary | null;
  /** UX1-C: 캠페인 딜(메인+하위) 중 최신 최저가 모니터링 스냅샷이 VIOLATED인 것이 1건 이상 존재하는지 여부. */
  hasPriceViolation?: boolean;
  /** UX1-C: 최신 스냅샷 기준 verdict=VIOLATED인 딜 개수 (hover/title 표시용). */
  violatedDealCount?: number;
};

/**
 * CG-1: 조합 캠페인 묶음(CampaignGroup) 표시용 행.
 * 정산/캘린더 이벤트 필드는 CG-2/3 배선 전 미사용(생성 시 null 시작).
 * startDate/endDate는 멤버 min/max 롤업(표시용, SoT 아님).
 */
export type CampaignGroupRow = {
  id: string;
  sellerId: string;
  /** 셀러 별칭 우선(alias || name) — 매핑 시점에 해결. */
  sellerName: string;
  name: string | null;
  startDate: string | null;
  endDate: string | null;
  memberCount: number;
  memberCampaignIds: string[];
  expectedDepositDate?: string | null;
  depositReceivedAt?: string | null;
  isDepositReceived: boolean;
  expectedPayoutDate?: string | null;
  payoutCompletedAt?: string | null;
  isPayoutCompleted: boolean;
  expectedSupplierPayoutDate?: string | null;
  supplierPayoutCompletedAt?: string | null;
  isSupplierPayoutCompleted: boolean;
  supplierInvoiceIssuedAt?: string | null;
  sellerInvoiceIssuedAt?: string | null;
  accountingCompletedAt?: string | null;
  returnPeriodEndDate?: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * CG-1: 그룹 상세 뷰의 멤버 행(사이드패널 그룹 섹션용).
 * 날짜는 KST YYYY-MM-DD(캠페인 행과 동일 관행), roundNumber는 서버 소유값.
 *
 * `salesChannel`·`actualSales`·`sellerExpense` 3필드는 Finding 2(2026-08-04
 * 재검토)를 위해 추가됐다 — 캠페인 사이드패널 「신고자료출력」 도우미가 정산
 * 그룹 소속 캠페인의 세금계산서 발행 금액을 세무 처리 보드와 똑같이(멤버 전원
 * 합산) 계산하려면 형제 멤버의 매출·수수료·채널이 필요하다
 * (`resolveSellerIssueInvoiceObligation`, tax-filing-board.ts). 저장소가 이미
 * `include`로 멤버 전체 스칼라 컬럼을 불러오므로(`campaignGroupRepository`의
 * `memberInclude`) 새 쿼리 없이 매퍼(`campaign-group-row.ts`)만 이 필드를
 * 추가로 옮기면 된다.
 */
export type CampaignGroupMemberRow = {
  campaignId: string;
  dealName: string;
  campaignName: string | null;
  /**
   * 딜의 브랜드·거래처. **optional 로 두지 않는 것이 의도다** — 아래
   * `settlementItems` 와 같은 규율이고, 멤버 행을 만드는 새 자리가 생기면 컴파일이
   * 막아 이 필드를 빠뜨릴 수 없게 한다. 빠뜨리면 멤버 목록은 「이게 같은 묶음인가」를
   * 판단할 축을 잃는다 — 그 정보 부재가 곧 "같은 셀러·같은 일정인데 브랜드가
   * 달라서 안 묶이는 것 같다"는 오진이 나온 자리다.
   * 표기 조립은 화면이 직접 하지 말고 `formatDealContextLabel`(`lib/deal-display`)에
   * 위임한다(브랜드=거래처면 하나만 보여주는 규칙을 그 함수가 소유한다).
   * ⚠️ 두 값은 **딜의 원본**이다 — 브랜드사 거래처를 브랜드로 승격하는
   * `normalizeDealBrandName` 을 거치지 않는다. `formatDealContextLabel` 은 값만
   * 이어붙이고 라벨을 버리므로 지금 화면 출력은 같지만, 라벨("브랜드"/"거래처")을
   * 보여주는 `getDealIdentityParts` 로 이 행을 소비하면 다른 화면이 "브랜드"라
   * 부르는 값을 "거래처"로 읽게 된다. 그때는 승격을 함께 태울 것.
   */
  brandName: string | null;
  partnerName: string | null;
  status: CampaignStatus;
  startDate: string;
  endDate: string;
  roundNumber: number | null;
  salesChannel: SalesChannel;
  actualSales: number | null;
  sellerExpense: number | null;
  /**
   * 멤버 각자의 부가 항목(설계 §9-2). **optional 로 두지 않는 것이 의도다** — 그룹
   * 멤버 행을 만드는 새 자리가 생기면 컴파일이 막아 이 필드를 빠뜨릴 수 없게 한다.
   * 빠뜨리면 사이드패널 「신고자료출력」이 보드보다 작은 금액을 **조용히** 보여주고,
   * 오너는 그 숫자를 홈택스에 그대로 입력한다.
   */
  settlementItems: SettlementItemRow[];
};

/** CG-1: 그룹 상세 응답(GET/POST/PATCH campaign-groups) — 요약 행 + 멤버 목록. */
export type CampaignGroupDetailRow = CampaignGroupRow & {
  members: CampaignGroupMemberRow[];
};

/**
 * CG-1: 「그룹으로 묶기」 후보 캠페인 1건 — 같은 셀러이면서 아직 어느 그룹에도
 * 속하지 않은 캠페인. 그룹 멤버 행(`CampaignGroupMemberRow`)과 **다른 타입인 것이
 * 의도다** — 후보는 아직 멤버가 아니라 정산 항목을 싣지 않고, 대신 오너가 "이게 같은
 * 묶음인가"를 판단하는 데 필요한 브랜드·거래처를 싣는다.
 */
export type CampaignCombineCandidateRow = {
  campaignId: string;
  /**
   * 줄 제목. **캠페인명이 아니라 딜 이름인 것이 의도다** — 캠페인명은
   * `generateCampaignName` 이 `{딜} - {셀러} {N}차` 로 만들어서, 차수 배지와 나란히
   * 두면 차수가 두 번 나오고(P2 「Campaign Round Badge」), 같은 셀러만 나열되는
   * 이 목록에서 셀러명이 매 줄 반복돼 브랜드·거래처를 밀어낸다. 그룹 멤버 목록도
   * 같은 이유로 `dealName` 을 쓴다.
   */
  dealName: string;
  brandName: string | null;
  partnerName: string | null;
  status: CampaignStatus;
  roundNumber: number | null;
  startDate: string;
  endDate: string;
};

/**
 * 후보 조회 응답. `alreadyGroupedCount` 는 **빈 상태 문구를 정직하게 가르기 위한
 * 필드다** — 같은 기간 창에 캠페인이 아예 없는 것과, 있는데 전부 다른 그룹에 속해
 * 후보에서 빠진 것은 오너가 취할 다음 행동이 다르다. 이 구분이 없으면 화면은 다시
 * "없습니다" 한마디로 두 상황을 뭉갠다(이 기능이 고치려던 결함이 그것이다).
 */
export type CampaignCombineCandidatesResponse = {
  candidates: CampaignCombineCandidateRow[];
  alreadyGroupedCount: number;
};

export type CampaignNoteRow = {
  id: string;
  campaignId: string;
  content: string;
  actor: string;
  actorName: string | null;
  createdAt: string;
};


export type ApiCallLogRow = {
  id: string;
  provider: ApiProvider;
  permissionScope?: string | null;
  endpoint: string;
  statusCode: number;
  success: boolean;
  calledAt: string;
  errorMessage?: string | null;
};

export type AssetRow = {
  id: string;
  provider: AssetProvider;
  section: AssetSection;
  entityType: AssetEntityType;
  entityId: string;
  campaignId?: string | null;
  fileName: string;
  mimeType?: string | null;
  sizeBytes: number;
  storagePath?: string | null;
  externalFileId?: string | null;
  externalUrl?: string | null;
  thumbnailUrl?: string | null;
  notes?: string | null;
  // 게시물 반응 지표(캠페인 셀러 게시물 전용) — 3-state: null=미집계 · 숫자=집계 · likesHidden=숨김
  likeCount?: number | null;
  commentCount?: number | null;
  likesHidden?: boolean | null;
  engagementSyncedAt?: string | null;
  // 표현 자산 — 유형 배지·롤오버 재생(videoUrl은 만료성 fbcdn, 활성 창 동안 크론이 매일 갱신)
  mediaType?: string | null;
  videoUrl?: string | null;
  postedAt?: string | null;
  archivedAt?: string | null;
  createdAt: string;
};

export type StorageSummary = {
  supabaseLimitBytes: number;
  supabaseWarningBytes: number;
  supabaseEstimatedBytes: number;
  googleDriveConnected: boolean;
  googleDriveAccount?: string | null;
  googleDriveRootFolderId?: string | null;
  recentAssets: AssetRow[];
};

export type Team = {
  id: string;
  name: string;
};

export type DashboardData = {
  deals: DealSummary[];
  sellers: SellerSummary[];
  campaigns: CampaignRow[];
  apiCallLogs: ApiCallLogRow[];
  assets: AssetRow[];
  storage: StorageSummary;
  teams?: Team[];
  dataSource?: "database" | "mock";
  dataSourceMessage?: string;
  actionRequiredCounts?: {
    overdueReminders: number;
    overdueSettlements: number;
  };
  salesTasks?: Array<{ id: string; dealId?: string; dealName: string; sellerName: string }>;
  partners?: PartnerSummary[];
};

export const campaignStatusLabels: Record<CampaignStatus, string> = {
  PROPOSAL: "셀러 제안 중",
  PREPARATION: "세팅 대기",
  ACTIVE: "판매 진행 중",
  CLOSED: "판매 마감",
  SETTLEMENT_WAIT: "정산 대기",
  SETTLEMENT_IN_PROGRESS: "정산 진행",
  COMPLETED: "정산 완료",
  DROPPED: "드랍",
};

export const dealStatusLabels: Record<DealStatus, string> = {
  SOURCING: "발굴",
  NEGOTIATING: "협의",
  CONFIRMED: "확정",
  SAMPLE_TESTING: "샘플 테스트",
  ARCHIVED: "완료",
  DROPPED: "보류",
};

export const salesChannelLabels: Record<SalesChannel, string> = {
  UNSPECIFIED: "미지정",
  OWN_MALL: "자사몰(기타)",
  OWN_MALL_NAVER: "자사몰(네이버)",
  OWN_MALL_KAKAO: "자사몰(카카오)",
  SELLER_MALL: "셀러몰",
  BRAND_MALL: "브랜드몰",
};

// 판매채널 배지의 채널별 색 맵(`salesChannelBadgeStyles`)은 제거했다 — P8 색 원칙 4
// "범주는 색을 받지 않는다". 채널은 좋고 나쁨이 없는 순수한 이름표라서 네이버=초록 ·
// 카카오=주황 · 브랜드몰=인디고 · 셀러몰=보라가 아무 판단도 나르지 않았고, 같은 카드의
// 판단색(지연·정체·최저가 위반 등)과 자리를 다퉜다. 이 맵은 존재 이유가 그 hue 뿐이라
// 균일하게 만드는 대신 지운다 — 정렬 기준은 맨 `<Badge variant="outline">` 이었다.
// 채널 배지의 소비처는 이제 `campaign-card.tsx` 한 곳뿐이다: #183 이 죽은
// `PipelineMonthlyView` 를 지워 2곳→1곳이 됐고, 종전 이 주석이 정렬 선례로 지목했던
// 손익 리포트 표(`pnl-report-client.tsx`)는 배지 자체를 걷어냈다(그 표의 판단은
// "얼마 남겼나"라서 범주가 참여하지 않는다 — 채널은 상세 시트가 보유한다).
// 라벨(`salesChannelLabels`)은 그대로 — 구분은 색이 아니라 라벨이 한다. 손익 리포트가
// 갖고 있던 4개짜리 라벨 사본도 이 맵으로 흡수했다(사본은 `OWN_MALL` 을 몰라 화면에
// 원문 코드를 뱉었다).

export const partnerTypeLabels: Record<PartnerType, string> = {
  BRAND: "브랜드",
  VENDOR: "벤더",
  AGENCY: "대행사",
  AGENT: "에이전시",
  SELLER: "셀러",
};

export const snsTypeLabels: Record<SnsType, string> = {
  INSTAGRAM: "Instagram",
  YOUTUBE: "YouTube",
  X: "X(Twitter)",
};

// F6 outcome 적립: 유입 경로 라벨 (값 정의는 validations/seller.ts ACQUISITION_CHANNELS)
export const acquisitionChannelLabels: Record<string, string> = {
  REFERRAL: "소개",
  NETWORK: "네트워크·지인",
  INBOUND: "인바운드",
  COLD: "콜드",
  DISCOVERY: "발굴",
};

export const assetSectionLabels: Record<AssetSection, string> = {
  PRODUCT_INTRO: "상품소개",
  PRICE_TABLE: "단가표",
  GROUP_BUY_PRICE: "공구단가",
  DETAIL_PAGE: "상세페이지",
  SNS_CREATIVE: "SNS 소재",
  CONTRACT_SETTLEMENT: "계약/정산",
  SAMPLE_REVIEW: "샘플리뷰",
  ORDER_TEMPLATE: "발주서 양식",
  ETC: "기타",
};

export const assetProviderLabels: Record<AssetProvider, string> = {
  SUPABASE: "Supabase",
  GOOGLE_DRIVE: "Drive",
  EXTERNAL_LINK: "Link",
  CLOUDFLARE_R2: "R2",
};

/** 캠페인 상세에서 검토하는 셀러 스토리 스냅샷(SellerStorySnapshot 표시용 부분집합).
 *  GET /api/campaigns/[id]/stories 응답 항목. 스토리는 좋아요/댓글이 없다(휘발성 24h) —
 *  게시시각·수집시각·영상 여부·분류만 다룬다. 공유 타입 파일에 둬서 client(asset-manager)가
 *  서버 route 모듈을 참조하지 않게 한다. */
export type CampaignStory = {
  id: string;
  storyPk: string;
  takenAt: string; // ISO — 게시시각
  capturedAt: string; // ISO — 수집시각
  mediaType: number; // 1=사진 2=영상
  thumbnailUrl: string | null;
  sourceImageUrl: string | null;
  caption: string | null;
  classification: string; // UNREVIEWED | CAMPAIGN | OTHER
};
