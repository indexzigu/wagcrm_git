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

  // 딜
  dealName: "딜 이름",
  brandName: "브랜드명",
  partnerCompanyName: "파트너 회사명",
  costPrice: "공급가",
  sellingPrice: "판매가",
  listPrice: "정가",
  floorPrice: "최저가",
  baseMarginPolicy: "기본 마진 정책",
  sourcingMemo: "소싱 메모",
  candidateSellers: "후보 셀러",
  partnerId: "파트너 ID",
  isDepositReceived: "정산 입금 여부",
  isPayoutCompleted: "정산 지급 여부",
  depositReceivedAt: "정산 입금 처리 일시",
  payoutCompletedAt: "정산 지급 처리 일시",
};
