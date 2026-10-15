/**
 * 엔티티 칸 이름 → 화면 이름(감사 기록 `ActivityLog.fieldName` 이 쓰는 표).
 *
 * `activity-log.ts` 에서 옮겨 왔다(내용 그대로, 그 모듈은 여기서 다시 내보낸다). 옮긴 이유는
 * 클라이언트 컴포넌트(결재함 `update_record` 기안 미리보기)도 같은 이름을 써야 하는데
 * `activity-log.ts` 는 Prisma 를 끌고 오는 서버 전용 모듈이라서다. ⚠️ 여기에 서버 import 를 넣지 말 것.
 */
export const FIELD_LABELS: Record<string, string> = {
  // 공통
  name: "이름",
  type: "유형",
  status: "상태",
  notes: "메모",
  
  // 파트너
  contactInfo: "연락처 정보",
  bankAccount: "계좌 정보",
  businessNumber: "사업자 번호",
  ceoName: "대표자명",
  address: "사업장 주소",
  bizSyncedAt: "사업자 정보 동기화",
  referredById: "추천인 ID",
  companyStatus: "납세자 상태",
  companyRole: "과세 유형",
  businessType: "업태",
  businessItem: "종목",
  representativeEmail: "대표이메일",
  lastContactAt: "최근 컨택",
  // 발주 설정(거래처 패널 「발주 설정」) — 입력칸이 없는 것은 스키마 주석의 뜻을 짧은 이름으로 옮겼다.
  orderToEmail: "기본 수신 이메일",
  orderCcEmail: "보조 수신 이메일",
  orderTemplateSlug: "발주 코드",
  orderDisplayName: "발주서 표시명",
  orderEmailDomains: "회신 허용 도메인",
  orderFormatAdapter: "발주 양식",
  
  // 셀러
  snsType: "SNS 유형",
  snsHandle: "SNS 핸들",
  currentFollowers: "팔로워 수",
  category: "카테고리",
  agencyId: "소속 에이전시 ID",
  channelUrl: "채널 URL",
  email: "이메일",
  phoneNumber: "전화번호",
  accountNumber: "정산 계좌번호",
  realName: "실명",
  mailingAddress: "주소",
  acquisitionChannel: "유입 경로",
  acquisitionNote: "유입 메모",
  availabilityNote: "가용 일정",
  availabilityUpdatedAt: "가용 일정 확인일",
  alias: "별칭",
  currentPostsCount: "게시물 수",
  profileBio: "소개글",
  profilePicUrl: "프로필 이미지",
  profileExternalUrls: "외부 링크",
  isMonitored: "수집 관리 대상",
  fitLevel: "적합성",
  collaborationScore: "공구 활성화",
  adResponseScore: "광고 반응",
  commentResponseScore: "댓글 반응",
  activityFrequency: "활동 빈도",
  // 아래는 화면에 입력칸이 없고 수집·가져오기 경로에서만 바뀐다(이름은 칸의 뜻을 옮긴 것).
  reviewer: "검토자",
  personalCategory: "개인 카테고리",
  proposalProduct: "제안 상품",
  proposalWaitlist: "제안 대기 목록",
  lastReviewedAt: "마지막 검토일",

  // 딜
  dealName: "딜 이름",
  brandName: "브랜드명",
  partnerCompanyName: "파트너 회사명",
  costPrice: "공급가",
  sellingPrice: "판매가",
  listPrice: "정가",
  floorPrice: "최저가",
  // 딜 화면 「공급가」는 판매가×총수수료율로 계산되는 칸이다 — 원가 칸(costPrice)도 「공급가」로 불려 이력에서 구분한다.
  supplyPrice: "공급가(계산값)",
  discountRate: "할인율",
  totalCommissionRate: "총수수료율",
  unit: "판매 단위",
  unitQuantity: "기본 수량",
  supplementaryInfo: "보조 정보",
  // 아래는 화면에 입력칸이 없다(가격표·옵션 구성 경로에서만 바뀐다).
  brokerageCommissionRate: "중개수수료율",
  parentDealId: "상위 딜",
  dealType: "딜 구분",
  optionSortOrder: "옵션 순서",
  baseMarginPolicy: "기본 마진 정책",
  sourcingMemo: "소싱 메모",
  candidateSellers: "후보 셀러",
  partnerId: "파트너 ID",
  isDepositReceived: "정산 입금 여부",
  isPayoutCompleted: "정산 지급 여부",
  depositReceivedAt: "정산 입금 처리 일시",
  payoutCompletedAt: "정산 지급 처리 일시",
};
