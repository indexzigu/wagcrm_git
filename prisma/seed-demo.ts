/**
 * 데모 배포용 목업 시드 — 외부 시연(비로그인 열람) 전용.
 *
 * 전 데이터가 허구다: 브랜드·셀러·주문·금액 전부 발명된 값이며 실제 인물·업체·
 * 실측치를 포함하지 않는다(P0 공개 레포 데이터 가드). 실DB 오염 방지를 위해
 * sqlite(file:) 대상이 아니면 즉시 중단한다.
 *
 * 실행: npm run demo:seed  (DEMO_MODE=1 + DATABASE_URL=file:./demo.db 전제)
 * 날짜는 실행 시점 상대 오프셋으로 생성한다 — 데모를 재배포(재시드)할 때마다
 * "오늘 기준으로 살아있는" 화면이 된다.
 */
import { createPrismaClient } from "../src/lib/prisma-client";
import { generateCampaignName } from "../src/lib/campaign-name";
import { KNOWN_JOBS } from "../src/lib/cron-jobs";
import { DEMO_USER } from "../src/lib/demo-mode";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (process.env.DEMO_MODE !== "1" || !DATABASE_URL.startsWith("file:")) {
  console.error(
    "[seed-demo] 중단: DEMO_MODE=1 + DATABASE_URL=file:... 조합에서만 실행할 수 있습니다.",
  );
  process.exit(1);
}

const prisma = createPrismaClient();

// 결정론적 의사난수(LCG) — 재시드 간 데이터 분포가 널뛰지 않게 한다.
let rngState = 20260721;
function rand(): number {
  rngState = (rngState * 1103515245 + 12345) % 2147483648;
  return rngState / 2147483648;
}
function randInt(min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

const NOW = new Date();
const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS);
}
function daysAhead(n: number): Date {
  return new Date(NOW.getTime() + n * DAY_MS);
}
/** KST 날짜키(YYYY-MM-DD) — 주문 스냅샷 귀속 규칙과 동일. */
function kstDateKey(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${String(kst.getUTCMonth() + 1).padStart(2, "0")}-${String(kst.getUTCDate()).padStart(2, "0")}`;
}
function kstMonthKey(d: Date): string {
  return kstDateKey(d).slice(0, 7);
}
/** n일 전의 KST hh:mm 시각 — 콘텐츠 발행 시각처럼 **하루 안 위치**가 의미 있는 값에 쓴다. */
function kstDateTime(daysAgoCount: number, kstHour: number, kstMinute = 0): Date {
  const dateKey = kstDateKey(daysAgo(daysAgoCount));
  return new Date(
    `${dateKey}T${String(kstHour).padStart(2, "0")}:${String(kstMinute).padStart(2, "0")}:00+09:00`,
  );
}

// ---------------------------------------------------------------------------
// 픽스처 — 전부 허구의 이름이다.
// ---------------------------------------------------------------------------

const PARTNERS = [
  { id: "demo-partner-aurora", name: "오로라랩", type: "BRAND", contactInfo: "hello@auroralab.example.com", businessNumber: "111-81-00001", ceoName: "김데모", address: "서울 성동구 데모로 12", businessType: "제조업", businessItem: "화장품" },
  { id: "demo-partner-green", name: "그린테이블", type: "VENDOR", contactInfo: "order@greentable.example.com", businessNumber: "222-81-00002", ceoName: "이샘플", address: "경기 성남시 목업대로 34", businessType: "도소매업", businessItem: "건강기능식품" },
  { id: "demo-partner-moa", name: "모아리빙", type: "BRAND", contactInfo: "contact@moaliving.example.com", businessNumber: "333-81-00003", ceoName: "박가상", address: "서울 마포구 시연길 56", businessType: "도소매업", businessItem: "주방용품" },
  { id: "demo-partner-purevime", name: "퓨어바임", type: "VENDOR", contactInfo: "cs@purevime.example.com", businessNumber: "444-81-00004", ceoName: "최허구", address: "서울 강남구 예시로 78", businessType: "제조업", businessItem: "이너뷰티" },
  { id: "demo-partner-dailyfit", name: "데일리핏에이전시", type: "AGENCY", contactInfo: "partner@dailyfit.example.com", businessNumber: "555-81-00005", ceoName: "정목업", address: "서울 송파구 데모타워 9F", businessType: "서비스업", businessItem: "마케팅 대행" },
] as const;

const SELLERS = [
  { id: "demo-seller-haneul", fit: "추천", name: "하늘무드", snsType: "INSTAGRAM", snsHandle: "haneul.mood.demo", followers: 214600, category: "뷰티", bio: "데일리 뷰티와 살림 루틴을 기록해요 ✨ (데모 계정)" },
  { id: "demo-seller-dalbit", fit: "추천", name: "달빛키친", snsType: "INSTAGRAM", snsHandle: "dalbit.kitchen.demo", followers: 168300, category: "푸드", bio: "매일의 집밥과 주방 살림 (데모 계정)" },
  { id: "demo-seller-hanna", fit: "보류", name: "소소한나", snsType: "INSTAGRAM", snsHandle: "soso.hanna.demo", followers: 74300, category: "라이프", bio: "소소한 일상 속 좋은 물건 찾기 (데모 계정)" },
  { id: "demo-seller-liveon", fit: "추천", name: "리브온유", snsType: "YOUTUBE", snsHandle: "liveonyou-demo", followers: 342900, category: "뷰티", bio: "성분 따지는 뷰티 리뷰 채널 (데모 계정)" },
  { id: "demo-seller-morning", fit: "보류", name: "모닝루틴", snsType: "INSTAGRAM", snsHandle: "morning.routine.demo", followers: 58100, category: "헬스", bio: "아침 습관과 건강 루틴 (데모 계정)" },
  { id: "demo-seller-yoon", fit: "추천", name: "집꾸미는윤", snsType: "INSTAGRAM", snsHandle: "home.yoon.demo", followers: 156700, category: "리빙", bio: "집을 아늑하게 만드는 살림템 (데모 계정)" },
  { id: "demo-seller-workingmom", fit: "추천", name: "워킹맘수첩", snsType: "INSTAGRAM", snsHandle: "workingmom.note.demo", followers: 132500, category: "육아", bio: "일과 육아 사이의 기록 (데모 계정)" },
  { id: "demo-seller-bada", fit: "미진행", name: "바다서재", snsType: "YOUTUBE", snsHandle: "badabooks-demo", followers: 42500, category: "라이프", bio: "책과 함께하는 느린 일상 (데모 계정)" },
  { id: "demo-seller-onthefit", fit: "보류", name: "온더핏", snsType: "INSTAGRAM", snsHandle: "onthefit.daily.demo", followers: 87900, category: "패션", bio: "매일의 실착 코디 기록 (데모 계정)" },
  { id: "demo-seller-salim", fit: "추천", name: "그린살림", snsType: "INSTAGRAM", snsHandle: "green.salim.demo", followers: 128200, category: "리빙", bio: "지속가능한 살림을 지향해요 (데모 계정)" },
  { id: "demo-seller-vlog", fit: "추천", name: "제나의하루", snsType: "YOUTUBE", snsHandle: "jenna-daily-demo", followers: 298400, category: "뷰티", bio: "리얼 후기 브이로그 채널 (데모 계정)" },
  { id: "demo-seller-cook", fit: "추천", name: "오늘뭐먹지", snsType: "INSTAGRAM", snsHandle: "what.today.demo", followers: 187600, category: "푸드", bio: "10분 완성 집밥 레시피 (데모 계정)" },
  { id: "demo-seller-trip", fit: "추천", name: "느린여행자", snsType: "INSTAGRAM", snsHandle: "slow.trip.demo", followers: 205300, category: "라이프", bio: "여행과 일상 사이의 물건들 (데모 계정)" },
  { id: "demo-seller-fit", fit: "보류", name: "홈트리나", snsType: "INSTAGRAM", snsHandle: "home.rina.fit.demo", followers: 94800, category: "헬스", bio: "집에서 하는 매일 운동 (데모 계정)" },
] as const;

const MARGIN_POLICY = JSON.stringify({
  byChannel: {
    OWN_MALL: { totalMarginRate: 18, sellerMarginRate: 10 },
    SELLER_MALL: { totalMarginRate: 14, sellerMarginRate: 8 },
    BRAND_MALL: { totalMarginRate: 12, sellerMarginRate: 7 },
  },
  slides: [
    { minActualSales: 30000000, totalMarginAddRate: 5, sellerMarginAddRate: 2 },
  ],
});

type DemoDealOption = { id: string; name: string; unitQuantity: number; unit: string; sellingPrice: number; costPrice: number };
type DemoDeal = {
  id: string;
  dealName: string;
  brandName: string;
  partnerId: string;
  status: string;
  costPrice: number;
  sellingPrice: number;
  options: DemoDealOption[];
};

const DEALS: DemoDeal[] = [
  {
    id: "demo-deal-ampoule",
    dealName: "오로라랩 수분광 앰플 더블세트",
    brandName: "오로라랩",
    partnerId: "demo-partner-aurora",
    status: "CONFIRMED",
    costPrice: 24500,
    sellingPrice: 39900,
    options: [
      { id: "demo-deal-ampoule-1", name: "오로라랩 수분광 앰플 더블세트 - 1세트", unitQuantity: 1, unit: "세트", sellingPrice: 39900, costPrice: 24500 },
      { id: "demo-deal-ampoule-2", name: "오로라랩 수분광 앰플 더블세트 - 2세트", unitQuantity: 2, unit: "세트", sellingPrice: 75800, costPrice: 46600 },
      { id: "demo-deal-ampoule-3", name: "오로라랩 수분광 앰플 더블세트 - 3세트 (미스트 증정)", unitQuantity: 3, unit: "세트", sellingPrice: 109000, costPrice: 66900 },
    ],
  },
  {
    id: "demo-deal-probiotic",
    dealName: "그린테이블 장케어 유산균 3개월분",
    brandName: "그린테이블",
    partnerId: "demo-partner-green",
    status: "CONFIRMED",
    costPrice: 33000,
    sellingPrice: 54900,
    options: [
      { id: "demo-deal-probiotic-3", name: "그린테이블 장케어 유산균 3개월분 - 3개월분", unitQuantity: 3, unit: "개월분", sellingPrice: 54900, costPrice: 33000 },
      { id: "demo-deal-probiotic-6", name: "그린테이블 장케어 유산균 3개월분 - 6개월분", unitQuantity: 6, unit: "개월분", sellingPrice: 99800, costPrice: 61500 },
    ],
  },
  {
    id: "demo-deal-collagen",
    dealName: "퓨어바임 저분자 콜라겐 젤리",
    brandName: "퓨어바임",
    partnerId: "demo-partner-purevime",
    status: "CONFIRMED",
    costPrice: 17500,
    sellingPrice: 29900,
    options: [
      { id: "demo-deal-collagen-1", name: "퓨어바임 저분자 콜라겐 젤리 - 1박스", unitQuantity: 1, unit: "박스", sellingPrice: 29900, costPrice: 17500 },
      { id: "demo-deal-collagen-2", name: "퓨어바임 저분자 콜라겐 젤리 - 2박스", unitQuantity: 2, unit: "박스", sellingPrice: 56800, costPrice: 33400 },
    ],
  },
  {
    id: "demo-deal-pan",
    dealName: "모아리빙 통주물 프라이팬 3종",
    brandName: "모아리빙",
    partnerId: "demo-partner-moa",
    status: "CONFIRMED",
    costPrice: 52000,
    sellingPrice: 89000,
    options: [
      { id: "demo-deal-pan-1", name: "모아리빙 통주물 프라이팬 3종 - 3종 세트", unitQuantity: 1, unit: "세트", sellingPrice: 89000, costPrice: 52000 },
      { id: "demo-deal-pan-2", name: "모아리빙 통주물 프라이팬 3종 - 3종 세트 + 실리콘 집게", unitQuantity: 1, unit: "세트", sellingPrice: 98000, costPrice: 57000 },
    ],
  },
  {
    id: "demo-deal-cica",
    dealName: "오로라랩 시카 진정 크림",
    brandName: "오로라랩",
    partnerId: "demo-partner-aurora",
    status: "SOURCING",
    costPrice: 14200,
    sellingPrice: 26900,
    options: [],
  },
  {
    id: "demo-deal-yogurt",
    dealName: "그린테이블 그릭요거트 메이커",
    brandName: "그린테이블",
    partnerId: "demo-partner-green",
    status: "ARCHIVED",
    costPrice: 41000,
    sellingPrice: 69000,
    options: [],
  },
  {
    id: "demo-deal-serum",
    dealName: "오로라랩 비타 브라이트닝 세럼",
    brandName: "오로라랩",
    partnerId: "demo-partner-aurora",
    status: "CONFIRMED",
    costPrice: 19800,
    sellingPrice: 34900,
    options: [
      { id: "demo-deal-serum-1", name: "오로라랩 비타 브라이트닝 세럼 - 1개", unitQuantity: 1, unit: "개", sellingPrice: 34900, costPrice: 19800 },
      { id: "demo-deal-serum-2", name: "오로라랩 비타 브라이트닝 세럼 - 2개", unitQuantity: 2, unit: "개", sellingPrice: 65800, costPrice: 37600 },
      { id: "demo-deal-serum-3", name: "오로라랩 비타 브라이트닝 세럼 - 3개 (파우치 증정)", unitQuantity: 3, unit: "개", sellingPrice: 94800, costPrice: 55400 },
    ],
  },
  {
    id: "demo-deal-shake",
    dealName: "그린테이블 단백질 쉐이크 30팩",
    brandName: "그린테이블",
    partnerId: "demo-partner-green",
    status: "CONFIRMED",
    costPrice: 28000,
    sellingPrice: 46900,
    options: [
      { id: "demo-deal-shake-1", name: "그린테이블 단백질 쉐이크 30팩 - 30팩", unitQuantity: 1, unit: "박스", sellingPrice: 46900, costPrice: 28000 },
      { id: "demo-deal-shake-2", name: "그린테이블 단백질 쉐이크 30팩 - 60팩", unitQuantity: 2, unit: "박스", sellingPrice: 89800, costPrice: 53200 },
    ],
  },
  {
    id: "demo-deal-diffuser",
    dealName: "모아리빙 우드 디퓨저 기프트세트",
    brandName: "모아리빙",
    partnerId: "demo-partner-moa",
    status: "CONFIRMED",
    costPrice: 21500,
    sellingPrice: 38900,
    options: [
      { id: "demo-deal-diffuser-1", name: "모아리빙 우드 디퓨저 기프트세트 - 1세트", unitQuantity: 1, unit: "세트", sellingPrice: 38900, costPrice: 21500 },
      { id: "demo-deal-diffuser-2", name: "모아리빙 우드 디퓨저 기프트세트 - 2세트", unitQuantity: 2, unit: "세트", sellingPrice: 73800, costPrice: 41000 },
    ],
  },
] as const;

// 주문을 발생시키는 캠페인 3종: 진행중 / 마감 직후(정산대기) / 정산완료.
type OrderCampaignPlan = {
  ocId: string;
  campaignId: string;
  deal: DemoDeal;
  sellerId: string;
  sellerName: string;
  roundNumber: number;
  productId: string;
  startOffset: number; // n일 전 시작
  endOffset: number; // 음수면 미래(마감 전)
  dailyLines: [number, number];
  status: string; // SalesCampaign.status
  isActive: boolean; // OrderCampaign.isActive
  salesChannel: string;
};

const ORDER_PLANS: OrderCampaignPlan[] = [
  // --- 현재 진행중(당월 매출을 만드는 활성 캠페인) ---
  {
    ocId: "demo-oc-ampoule",
    campaignId: "demo-camp-ampoule-haneul-3",
    deal: DEALS[0],
    sellerId: "demo-seller-haneul",
    sellerName: "하늘무드",
    roundNumber: 3,
    productId: "9900000101",
    startOffset: 13,
    endOffset: -3, // 오늘 포함 진행중
    dailyLines: [30, 48],
    status: "ACTIVE",
    isActive: true,
    salesChannel: "OWN_MALL",
  },
  {
    ocId: "demo-oc-serum",
    campaignId: "demo-camp-serum-liveon-2",
    deal: DEALS[6],
    sellerId: "demo-seller-liveon",
    sellerName: "리브온유",
    roundNumber: 2,
    productId: "9900000102",
    startOffset: 10,
    endOffset: -5,
    dailyLines: [28, 46],
    status: "ACTIVE",
    isActive: true,
    salesChannel: "OWN_MALL",
  },
  {
    ocId: "demo-oc-shake",
    campaignId: "demo-camp-shake-dalbit-1",
    deal: DEALS[7],
    sellerId: "demo-seller-dalbit",
    sellerName: "달빛키친",
    roundNumber: 1,
    productId: "9900000103",
    startOffset: 8,
    endOffset: -6,
    dailyLines: [26, 42],
    status: "ACTIVE",
    isActive: true,
    salesChannel: "OWN_MALL",
  },
  {
    ocId: "demo-oc-pan",
    campaignId: "demo-camp-pan-yoon-1",
    deal: DEALS[3],
    sellerId: "demo-seller-yoon",
    sellerName: "집꾸미는윤",
    roundNumber: 1,
    productId: "9900000104",
    startOffset: 16,
    endOffset: -2,
    dailyLines: [20, 34],
    status: "ACTIVE",
    isActive: true,
    salesChannel: "OWN_MALL",
  },
  {
    ocId: "demo-oc-diffuser",
    campaignId: "demo-camp-diffuser-trip-1",
    deal: DEALS[8],
    sellerId: "demo-seller-trip",
    sellerName: "느린여행자",
    roundNumber: 1,
    productId: "9900000105",
    startOffset: 6,
    endOffset: -8,
    dailyLines: [22, 36],
    status: "ACTIVE",
    isActive: true,
    salesChannel: "SELLER_MALL",
  },
  // --- 마감 직후(정산 진행중) ---
  {
    ocId: "demo-oc-probiotic",
    campaignId: "demo-camp-probiotic-cook-1",
    deal: DEALS[1],
    sellerId: "demo-seller-cook",
    sellerName: "오늘뭐먹지",
    roundNumber: 1,
    productId: "9900000202",
    startOffset: 20,
    endOffset: 4,
    dailyLines: [24, 40],
    status: "SETTLEMENT_IN_PROGRESS",
    isActive: true,
    salesChannel: "OWN_MALL",
  },
  // --- 과거 완료 회차(6개월 추이·연 누적·재구매 이력) ---
  {
    ocId: "demo-oc-collagen",
    campaignId: "demo-camp-collagen-vlog-1",
    deal: DEALS[2],
    sellerId: "demo-seller-vlog",
    sellerName: "제나의하루",
    roundNumber: 1,
    productId: "9900000303",
    startOffset: 38,
    endOffset: 31,
    dailyLines: [24, 40],
    status: "COMPLETED",
    isActive: false,
    salesChannel: "OWN_MALL",
  },
  {
    ocId: "demo-oc-ampoule-r2",
    campaignId: "demo-camp-ampoule-haneul-2",
    deal: DEALS[0],
    sellerId: "demo-seller-haneul",
    sellerName: "하늘무드",
    roundNumber: 2,
    productId: "9900000106",
    startOffset: 66,
    endOffset: 59,
    dailyLines: [22, 36],
    status: "COMPLETED",
    isActive: false,
    salesChannel: "OWN_MALL",
  },
  {
    ocId: "demo-oc-serum-r1",
    campaignId: "demo-camp-serum-liveon-1",
    deal: DEALS[6],
    sellerId: "demo-seller-liveon",
    sellerName: "리브온유",
    roundNumber: 1,
    productId: "9900000107",
    startOffset: 96,
    endOffset: 89,
    dailyLines: [20, 34],
    status: "COMPLETED",
    isActive: false,
    salesChannel: "OWN_MALL",
  },
  {
    ocId: "demo-oc-probiotic-r0",
    campaignId: "demo-camp-probiotic-workingmom-1",
    deal: DEALS[1],
    sellerId: "demo-seller-workingmom",
    sellerName: "워킹맘수첩",
    roundNumber: 1,
    productId: "9900000108",
    startOffset: 126,
    endOffset: 119,
    dailyLines: [18, 30],
    // 마감(주문캠페인 비활성)이지만 아직 정산 전 — 보드의 「정산 대기」 열에 남아 **열어볼 수
    // 있는** 상태다. 마감 캠페인은 인트라데이 소스가 없어 타임라인이 **일별 해상도**로
    // 그려지므로, 데모에서 그 경로를 실제로 확인하려면 이렇게 도달 가능한 자리에 하나가 있어야
    // 한다(COMPLETED 로 두면 정산 화면에만 남아 화면 검증이 불가능했다).
    status: "SETTLEMENT_WAIT",
    isActive: false,
    salesChannel: "SELLER_MALL",
  },
];

// 주문이 없는 판매 캠페인(준비중·제안 등 파이프라인 다양성용).
const EXTRA_CAMPAIGNS = [
  // 준비중·제안 — 파이프라인이 살아있음을 보여주는 예정 회차.
  { id: "demo-camp-ampoule-hanna-1", dealIdx: 0, sellerId: "demo-seller-hanna", sellerName: "소소한나", roundNumber: 1, status: "PREPARATION", startOffset: -5, endOffset: -12, salesChannel: "OWN_MALL" },
  { id: "demo-camp-probiotic-morning-2", dealIdx: 1, sellerId: "demo-seller-morning", sellerName: "모닝루틴", roundNumber: 2, status: "PREPARATION", startOffset: -8, endOffset: -15, salesChannel: "SELLER_MALL" },
  { id: "demo-camp-serum-cook-2", dealIdx: 6, sellerId: "demo-seller-cook", sellerName: "오늘뭐먹지", roundNumber: 2, status: "PREPARATION", startOffset: -3, endOffset: -10, salesChannel: "OWN_MALL" },
  { id: "demo-camp-pan-salim-1", dealIdx: 3, sellerId: "demo-seller-salim", sellerName: "그린살림", roundNumber: 1, status: "PREPARATION", startOffset: -6, endOffset: -13, salesChannel: "OWN_MALL" },
  { id: "demo-camp-collagen-workingmom-1", dealIdx: 2, sellerId: "demo-seller-workingmom", sellerName: "워킹맘수첩", roundNumber: 1, status: "PROPOSAL", startOffset: -14, endOffset: -21, salesChannel: "OWN_MALL" },
  { id: "demo-camp-ampoule-salim-1", dealIdx: 0, sellerId: "demo-seller-salim", sellerName: "그린살림", roundNumber: 1, status: "PROPOSAL", startOffset: -20, endOffset: -27, salesChannel: "OWN_MALL" },
  { id: "demo-camp-diffuser-yoon-2", dealIdx: 8, sellerId: "demo-seller-yoon", sellerName: "집꾸미는윤", roundNumber: 2, status: "PROPOSAL", startOffset: -18, endOffset: -25, salesChannel: "BRAND_MALL" },
  // 정산 대기(반품기간 경과 대기) — 판매관리 '정산 대기' 컬럼용.
  { id: "demo-camp-probiotic-workingmom-2", dealIdx: 1, sellerId: "demo-seller-workingmom", sellerName: "워킹맘수첩", roundNumber: 2, status: "SETTLEMENT_WAIT", startOffset: 13, endOffset: 6, salesChannel: "OWN_MALL" },
  { id: "demo-camp-shake-fit-1", dealIdx: 7, sellerId: "demo-seller-fit", sellerName: "홈트리나", roundNumber: 1, status: "SETTLEMENT_WAIT", startOffset: 15, endOffset: 8, salesChannel: "SELLER_MALL" },
  // 과거 완료 회차 — 연간 누적·6개월 추이 차트를 채우는 이력 데이터(우상향).
  { id: "demo-camp-ampoule-haneul-1", dealIdx: 0, sellerId: "demo-seller-haneul", sellerName: "하늘무드", roundNumber: 1, status: "COMPLETED", startOffset: 24, endOffset: 17, salesChannel: "OWN_MALL" },
  { id: "demo-camp-pan-cook-1", dealIdx: 3, sellerId: "demo-seller-cook", sellerName: "오늘뭐먹지", roundNumber: 1, status: "COMPLETED", startOffset: 33, endOffset: 26, salesChannel: "OWN_MALL" },
  { id: "demo-camp-diffuser-yoon-1", dealIdx: 8, sellerId: "demo-seller-yoon", sellerName: "집꾸미는윤", roundNumber: 1, status: "COMPLETED", startOffset: 52, endOffset: 45, salesChannel: "BRAND_MALL" },
  { id: "demo-camp-yogurt-yoon-1", dealIdx: 5, sellerId: "demo-seller-yoon", sellerName: "집꾸미는윤", roundNumber: 1, status: "COMPLETED", startOffset: 74, endOffset: 67, salesChannel: "BRAND_MALL" },
  { id: "demo-camp-shake-vlog-1", dealIdx: 7, sellerId: "demo-seller-vlog", sellerName: "제나의하루", roundNumber: 1, status: "COMPLETED", startOffset: 88, endOffset: 81, salesChannel: "OWN_MALL" },
  { id: "demo-camp-collagen-onthefit-1", dealIdx: 2, sellerId: "demo-seller-onthefit", sellerName: "온더핏", roundNumber: 1, status: "COMPLETED", startOffset: 101, endOffset: 94, salesChannel: "OWN_MALL" },
  { id: "demo-camp-pan-trip-1", dealIdx: 3, sellerId: "demo-seller-trip", sellerName: "느린여행자", roundNumber: 1, status: "COMPLETED", startOffset: 116, endOffset: 109, salesChannel: "OWN_MALL" },
  { id: "demo-camp-probiotic-salim-1", dealIdx: 1, sellerId: "demo-seller-salim", sellerName: "그린살림", roundNumber: 1, status: "COMPLETED", startOffset: 131, endOffset: 124, salesChannel: "SELLER_MALL" },
  { id: "demo-camp-yogurt-dalbit-1", dealIdx: 5, sellerId: "demo-seller-dalbit", sellerName: "달빛키친", roundNumber: 1, status: "COMPLETED", startOffset: 161, endOffset: 154, salesChannel: "BRAND_MALL" },
] as const;

// ---------------------------------------------------------------------------
// 주문 생성 — campaigns-handler·집계 SSOT가 소비하는 평면화 필드만 정확히 채운다.
// ---------------------------------------------------------------------------

const SURNAMES = ["김", "이", "박", "최", "정", "한", "윤", "장", "임", "서"];
function maskedOrdererName(): string {
  return `${pick(SURNAMES)}*${pick(["희", "연", "진", "수", "영", "민", "아", "정"])}`;
}

type DemoOrder = Record<string, unknown>;

let orderSeq = 0;
/** 재구매 시연용 고객 풀 — ordererNo가 겹치면 회차간 재구매로 집계된다. */
const ORDERER_POOL = Array.from({ length: 420 }, (_, i) => `demo-buyer-${1000 + i}`);

function statusForAge(ageDays: number): { productOrderStatus: string; placeOrderStatus: string } {
  const r = rand();
  if (ageDays >= 20) {
    return { productOrderStatus: r < 0.75 ? "PURCHASE_DECIDED" : "DELIVERED", placeOrderStatus: "OK" };
  }
  if (ageDays >= 7) {
    if (r < 0.45) return { productOrderStatus: "DELIVERED", placeOrderStatus: "OK" };
    if (r < 0.8) return { productOrderStatus: "PURCHASE_DECIDED", placeOrderStatus: "OK" };
    return { productOrderStatus: "DELIVERING", placeOrderStatus: "OK" };
  }
  if (ageDays >= 3) {
    if (r < 0.4) return { productOrderStatus: "DELIVERING", placeOrderStatus: "OK" };
    if (r < 0.7) return { productOrderStatus: "DISPATCH_WAIT", placeOrderStatus: "OK" };
    return { productOrderStatus: "PAYED", placeOrderStatus: "OK" };
  }
  if (r < 0.4) return { productOrderStatus: "PAYED", placeOrderStatus: "NOT_YET" };
  if (r < 0.7) return { productOrderStatus: "PAYED", placeOrderStatus: "OK" };
  return { productOrderStatus: "DISPATCH_WAIT", placeOrderStatus: "OK" };
}

function makeOrdersForDay(plan: OrderCampaignPlan, day: Date, ageDays: number): DemoOrder[] {
  const orders: DemoOrder[] = [];
  const lineCount = randInt(plan.dailyLines[0], plan.dailyLines[1]);
  const options = plan.deal.options.length > 0 ? plan.deal.options : [
    { id: plan.deal.id, name: plan.deal.dealName, unitQuantity: 1, unit: "개", sellingPrice: plan.deal.sellingPrice, costPrice: plan.deal.costPrice },
  ];

  let i = 0;
  while (i < lineCount) {
    orderSeq += 1;
    const orderId = `DEMO-ORD-${String(orderSeq).padStart(6, "0")}`;
    // 한 결제가 1~2개 상품주문 라인으로 쪼개진다(P7 주문건수 vs 라인수 구분 시연).
    const linesInOrder = rand() < 0.18 ? 2 : 1;
    const ordererNo = pick(ORDERER_POOL);
    const ordererName = maskedOrdererName();
    const paymentDate = new Date(day.getTime() + randInt(9, 22) * 60 * 60 * 1000 + randInt(0, 59) * 60 * 1000);

    for (let li = 0; li < linesInOrder && i < lineCount; li += 1, i += 1) {
      orderSeq += 1;
      const option = pick(options);
      const quantity = rand() < 0.82 ? 1 : randInt(2, 3);
      const { productOrderStatus, placeOrderStatus } = statusForAge(ageDays);
      const order: DemoOrder = {
        orderId,
        productOrderId: `DEMO-PO-${String(orderSeq).padStart(6, "0")}`,
        productOrderStatus,
        placeOrderStatus,
        productId: plan.productId,
        originalProductId: plan.productId,
        productName: plan.deal.dealName,
        productOption: option.name,
        quantity,
        unitPrice: option.sellingPrice,
        totalPaymentAmount: option.sellingPrice * quantity,
        paymentDate: paymentDate.toISOString(),
        orderDate: paymentDate.toISOString(),
        ordererNo,
        ordererName,
        ordererId: ordererNo,
        receiverName: ordererName,
        shippingMemo: rand() < 0.2 ? "부재 시 문 앞에 놓아주세요" : "",
        deliveryCompany: productOrderStatus === "DELIVERING" || productOrderStatus === "DELIVERED" || productOrderStatus === "PURCHASE_DECIDED" ? "데모택배" : null,
        trackingNumber: productOrderStatus === "DELIVERING" || productOrderStatus === "DELIVERED" || productOrderStatus === "PURCHASE_DECIDED" ? `DEMO${String(orderSeq).padStart(9, "0")}` : null,
      };

      // 소량의 취소·반품 — 클레임 화면과 무효주문 제외 집계(P7)를 시연한다.
      const claimRoll = rand();
      if (claimRoll < 0.035) {
        order.productOrderStatus = "CANCELED";
        order.__claim = {
          cancel: {
            claimType: "CANCEL",
            claimStatus: "CANCEL_DONE",
            claimRequestDate: new Date(paymentDate.getTime() + 6 * 60 * 60 * 1000).toISOString(),
            requestQuantity: quantity,
            cancelReason: pick(["단순 변심", "주문 실수", "배송 지연"]),
          },
          currentClaim: { claimType: "CANCEL", claimStatus: "CANCEL_DONE" },
        };
      } else if (claimRoll < 0.05 && ageDays >= 7) {
        order.productOrderStatus = "RETURNED";
        order.__claim = {
          return: {
            claimType: "RETURN",
            claimStatus: "RETURN_DONE",
            claimRequestDate: new Date(paymentDate.getTime() + 4 * DAY_MS).toISOString(),
            requestQuantity: quantity,
            returnReason: pick(["단순 변심", "상품 불만족"]),
            collectDeliveryCompanyCode: "DEMO",
            collectDeliveryInvoiceNo: `DEMOR${String(orderSeq).padStart(8, "0")}`,
          },
          currentClaim: { claimType: "RETURN", claimStatus: "RETURN_DONE" },
        };
      }

      orders.push(order);
    }
  }
  return orders;
}

/** 스냅샷 배지 카운트 — naver-order-sync.countStatuses와 같은 규칙(모듈 import는 네이버 클라이언트 의존이라 피함). */
function countStatuses(orders: DemoOrder[]) {
  let newOrdersCount = 0;
  let preparingCount = 0;
  let deliveringCount = 0;
  for (const order of orders) {
    const status = order.productOrderStatus;
    if (status === "PAYED" || status === "PRODUCT_ORDERED") newOrdersCount += 1;
    else if (status === "DISPATCH_WAIT") preparingCount += 1;
    else if (status === "DISPATCHED" || status === "DELIVERING") deliveringCount += 1;
  }
  return { newOrdersCount, preparingCount, deliveringCount };
}

// ---------------------------------------------------------------------------
// 시드 본체
// ---------------------------------------------------------------------------

async function resetTables() {
  // FK 제약 역순 삭제 — 데모 DB는 매 시드마다 처음부터 다시 만든다.
  await prisma.trackingAttribution.deleteMany();
  await prisma.campaignActivity.deleteMany();
  await prisma.campaignNote.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.naverSettlementCase.deleteMany();
  await prisma.orderFulfillmentState.deleteMany();
  await prisma.naverOrderSnapshot.deleteMany();
  await prisma.productMapping.deleteMany();
  await prisma.campaignDeal.deleteMany();
  await prisma.salesCampaign.deleteMany();
  await prisma.campaignGroup.deleteMany(); // Seller 를 FK 로 잡고 있어 seller 삭제 전에 비워야 한다.
  await prisma.orderCampaign.deleteMany();
  await prisma.salesTask.deleteMany();
  await prisma.sellerOutreach.deleteMany();
  await prisma.sellerStorySnapshot.deleteMany();
  await prisma.sellerPostClassification.deleteMany();
  await prisma.sellerAiProfile.deleteMany();
  await prisma.sellersHistory.deleteMany();
  await prisma.seller.deleteMany();
  await prisma.deal.deleteMany();
  await prisma.partner.deleteMany();
  await prisma.revenueGoal.deleteMany();
  await prisma.systemTaskStatus.deleteMany();
}

async function seedPartnersSellersDeals() {
  for (const partner of PARTNERS) {
    await prisma.partner.create({
      data: {
        id: partner.id,
        name: partner.name,
        type: partner.type,
        status: "ACTIVE",
        contactInfo: partner.contactInfo,
        bankAccount: "데모은행 000-0000-0000",
        businessNumber: partner.businessNumber,
        ceoName: partner.ceoName,
        address: partner.address,
        businessType: partner.businessType,
        businessItem: partner.businessItem,
        lastContactAt: daysAgo(randInt(1, 12)),
      },
    });
  }

  for (const seller of SELLERS) {
    await prisma.seller.create({
      data: {
        id: seller.id,
        name: seller.name,
        snsType: seller.snsType,
        snsHandle: seller.snsHandle,
        currentFollowers: seller.followers,
        currentPostsCount: randInt(240, 1400),
        profileBio: seller.bio,
        category: seller.category,
        fitLevel: seller.fit,
        isMonitored: true,
        activityFrequency: pick(["HIGH", "MEDIUM"]),
        histories: {
          create: Array.from({ length: 6 }, (_, i) => ({
            snapshotDate: daysAgo((5 - i) * 7),
            followersCount: Math.round(seller.followers * (0.93 + 0.014 * i)),
            source: seller.snsType,
          })),
        },
      },
    });
  }

  for (const deal of DEALS) {
    await prisma.deal.create({
      data: {
        id: deal.id,
        dealName: deal.dealName,
        brandName: deal.brandName,
        partnerId: deal.partnerId,
        status: deal.status,
        costPrice: deal.costPrice,
        sellingPrice: deal.sellingPrice,
        baseMarginPolicy: MARGIN_POLICY,
        dealType: "MAIN",
      },
    });
    for (const [idx, option] of deal.options.entries()) {
      await prisma.deal.create({
        data: {
          id: option.id,
          dealName: option.name,
          brandName: deal.brandName,
          partnerId: deal.partnerId,
          status: deal.status,
          costPrice: option.costPrice,
          sellingPrice: option.sellingPrice,
          baseMarginPolicy: MARGIN_POLICY,
          dealType: "OPTION",
          parentDealId: deal.id,
          unit: option.unit,
          unitQuantity: option.unitQuantity,
          optionSortOrder: idx,
        },
      });
    }
  }
}

type PlanSeedResult = {
  plan: OrderCampaignPlan;
  validRevenue: number;
  validQuantity: number;
  distinctOrders: Set<string>;
  productOrderIds: string[];
  settledPoAmounts: Array<{ productOrderId: string; amount: number; paymentDate: string }>;
  /** 마감 캠페인 캐시(cachedDailyStats)에 넣을 일별 유효 집계 — 일별 해상도 차트의 소스다. */
  dailyStats: Array<{ date: string; orders: number; revenue: number }>;
};

async function seedOrderWorld(): Promise<PlanSeedResult[]> {
  const results: PlanSeedResult[] = [];
  /** snapshotDate(KST키) → 해당일 전체 주문(모든 캠페인 합산) — 스냅샷은 날짜당 1행이다. */
  const snapshotByDate = new Map<string, DemoOrder[]>();

  for (const plan of ORDER_PLANS) {
    const result: PlanSeedResult = {
      plan,
      validRevenue: 0,
      validQuantity: 0,
      distinctOrders: new Set(),
      productOrderIds: [],
      settledPoAmounts: [],
      dailyStats: [],
    };

    for (let offset = plan.startOffset; offset >= plan.endOffset; offset -= 1) {
      if (offset < 0) break; // 미래 날짜의 주문은 없다
      const day = daysAgo(offset);
      const orders = makeOrdersForDay(plan, day, offset);
      const dateKey = kstDateKey(day);
      snapshotByDate.set(dateKey, [...(snapshotByDate.get(dateKey) ?? []), ...orders]);

      const dayOrderKeys = new Set<string>();
      let dayRevenue = 0;
      for (const order of orders) {
        const status = String(order.productOrderStatus);
        result.productOrderIds.push(String(order.productOrderId));
        const isValid = !["PAYMENT_WAITING", "CANCELED", "CANCELED_BY_NOPAYMENT", "RETURNED", "EXCHANGED"].includes(status);
        if (isValid) {
          result.validRevenue += Number(order.totalPaymentAmount);
          result.validQuantity += Number(order.quantity);
          result.distinctOrders.add(String(order.orderId));
          dayOrderKeys.add(String(order.orderId));
          dayRevenue += Number(order.totalPaymentAmount);
          if (status === "PURCHASE_DECIDED") {
            result.settledPoAmounts.push({
              productOrderId: String(order.productOrderId),
              amount: Number(order.totalPaymentAmount),
              paymentDate: String(order.paymentDate),
            });
          }
        }
      }
      // 주문건수는 결제(orderId) 단위 distinct 다(P7 Order-Count Vocabulary — 라인수 아님).
      if (dayOrderKeys.size > 0) {
        result.dailyStats.push({ date: dateKey, orders: dayOrderKeys.size, revenue: dayRevenue });
      }
    }
    results.push(result);
  }

  for (const [dateKey, orders] of [...snapshotByDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const counts = countStatuses(orders);
    await prisma.naverOrderSnapshot.create({
      data: {
        snapshotDate: dateKey,
        orders: JSON.stringify(orders),
        ordersCount: orders.length,
        newOrdersCount: counts.newOrdersCount,
        preparingCount: counts.preparingCount,
        deliveringCount: counts.deliveringCount,
        isDirty: false,
        lastCallTime: NOW,
        syncType: "FULL",
      },
    });
  }

  return results;
}

async function seedCampaigns(orderResults: PlanSeedResult[]) {
  for (const result of orderResults) {
    const { plan } = result;
    const netRevenue = result.validRevenue;
    const sellerExpense = Math.round(netRevenue * 0.1);
    const operatingExpense = Math.round(netRevenue * 0.04);
    const operatingProfit = Math.round(netRevenue * 0.18) - operatingExpense;
    const isSettled = plan.status === "COMPLETED";
    const closed = plan.status !== "ACTIVE";

    await prisma.orderCampaign.create({
      data: {
        id: plan.ocId,
        name: `${plan.deal.brandName} - ${plan.sellerName} ${plan.roundNumber}차`,
        sellerName: plan.sellerName,
        toEmail: "order@demo-brand.example.com",
        category: plan.deal.brandName,
        productId: plan.productId,
        salePeriod: `${kstDateKey(daysAgo(plan.startOffset))} ~ ${kstDateKey(daysAgo(Math.max(plan.endOffset, 0)))}`,
        productStatus: plan.isActive ? "SALE" : "SUSPENDED",
        startDate: daysAgo(plan.startOffset),
        endDate: daysAhead(-plan.endOffset),
        isActive: plan.isActive,
        ...(closed
          ? {
              cachedTotalOrders: result.productOrderIds.length,
              cachedDistinctOrderCount: result.distinctOrders.size,
              cachedTotalQuantity: result.validQuantity,
              cachedTotalRevenue: result.validRevenue,
              cachedCompletedCount: result.settledPoAmounts.length,
              cachedProductOrderIds: JSON.stringify(result.productOrderIds),
              // 마감 캠페인은 인트라데이 소스가 없어 **일별 해상도**로 그려진다 — 이 캐시가
              // 그 차트의 유일한 소스다(sqlite 는 String 컬럼).
              cachedDailyStats: JSON.stringify(result.dailyStats),
              cachedSettledAmount: isSettled ? Math.round(result.validRevenue * 0.94) : 0,
              cachedSettleFeeAmount: isSettled ? Math.round(result.validRevenue * 0.06) : 0,
              cachedUnsettledAmount: isSettled ? 0 : result.validRevenue,
              cachedSettledCount: isSettled ? result.settledPoAmounts.length : 0,
            }
          : {}),
      },
    });

    const options = plan.deal.options.length > 0 ? plan.deal.options : [
      { id: plan.deal.id, name: plan.deal.dealName, unitQuantity: 1, unit: "개", sellingPrice: plan.deal.sellingPrice, costPrice: plan.deal.costPrice },
    ];
    for (const option of options) {
      await prisma.productMapping.create({
        data: {
          campaignId: plan.ocId,
          productName: plan.deal.dealName,
          optionName: option.name,
          brandCode: "DEMO",
          price: option.sellingPrice,
        },
      });
    }

    await prisma.salesCampaign.create({
      data: {
        id: plan.campaignId,
        dealId: plan.deal.id,
        sellerId: plan.sellerId,
        campaignName: generateCampaignName(plan.deal.dealName, plan.sellerName, plan.roundNumber),
        startDate: daysAgo(plan.startOffset),
        endDate: daysAhead(-plan.endOffset),
        salesChannel: plan.salesChannel,
        baseNaverLink: "https://smartstore.example.com/demo-store/products/0000000",
        generatedTrackingLink: `https://smartstore.example.com/demo-store/products/0000000?nt_source=${plan.sellerId}`,
        actualSales: netRevenue,
        sellerExpense,
        operatingExpense,
        operatingProfit,
        quantity: result.validQuantity,
        itemCount: result.distinctOrders.size,
        totalMarginRate: 18,
        sellerMarginRate: 10,
        netMarginRate: 8,
        status: plan.status,
        roundNumber: plan.roundNumber,
        orderCampaignId: plan.ocId,
        isDepositReceived: isSettled,
        isPayoutCompleted: isSettled,
        depositReceivedAt: isSettled ? daysAgo(Math.max(plan.endOffset, 0) - 6) : null,
        payoutCompletedAt: isSettled ? daysAgo(Math.max(plan.endOffset, 0) - 8) : null,
        settlementSales: closed ? netRevenue : null,
        expectedDepositDate: closed && !isSettled ? daysAhead(4) : null,
        expectedPayoutDate: closed && !isSettled ? daysAhead(7) : null,
        campaignDeals: {
          create: options.map((option, idx) => ({
            dealId: option.id,
            quantity: Math.max(1, Math.round(result.validQuantity / options.length) - idx),
            actualSales: Math.round(netRevenue / options.length),
            sellingPrice: option.sellingPrice,
            costPrice: option.costPrice,
          })),
        },
      },
    });

    await prisma.campaignActivity.create({
      data: {
        campaignId: plan.campaignId,
        action: "CREATED",
        label: "캠페인 생성",
        details: `${plan.status} · ${plan.salesChannel}`,
        actor: "SYSTEM",
        createdAt: daysAgo(plan.startOffset + 2),
      },
    });
  }

  for (const extra of EXTRA_CAMPAIGNS) {
    const deal = DEALS[extra.dealIdx];
    const isCompleted = extra.status === "COMPLETED";
    // 마감 이후 상태(정산 대기 포함)는 매출·정산 금액이 있어야 화면이 성립한다.
    const hasRevenue = isCompleted || extra.status === "SETTLEMENT_WAIT";
    const revenue = hasRevenue ? randInt(16, 34) * 1_000_000 : null;
    await prisma.salesCampaign.create({
      data: {
        id: extra.id,
        dealId: deal.id,
        sellerId: extra.sellerId,
        campaignName: generateCampaignName(deal.dealName, extra.sellerName, extra.roundNumber),
        startDate: daysAgo(extra.startOffset),
        endDate: daysAgo(extra.endOffset),
        salesChannel: extra.salesChannel,
        baseNaverLink: "https://smartstore.example.com/demo-store/products/0000000",
        generatedTrackingLink: `https://smartstore.example.com/demo-store/products/0000000?nt_source=${extra.sellerId}`,
        actualSales: revenue,
        quantity: hasRevenue ? Math.round((revenue ?? 0) / deal.sellingPrice) : null,
        totalMarginRate: 16,
        sellerMarginRate: 9,
        netMarginRate: 7,
        status: extra.status,
        roundNumber: extra.roundNumber,
        isDepositReceived: isCompleted,
        isPayoutCompleted: isCompleted,
        settlementSales: revenue,
        returnPeriodEndDate: extra.status === "SETTLEMENT_WAIT" ? daysAhead(3) : null,
        expectedDepositDate: extra.status === "SETTLEMENT_WAIT" ? daysAhead(5) : null,
        expectedPayoutDate: extra.status === "SETTLEMENT_WAIT" ? daysAhead(8) : null,
      },
    });
  }
}

async function seedFulfillmentAndSettlement(orderResults: PlanSeedResult[]) {
  // 배송대기(발주요청됨) 버킷 시연 — 진행중 캠페인의 DISPATCH_WAIT 일부에 poRequestedAt을 찍는다.
  const live = orderResults.find((r) => r.plan.status === "ACTIVE");
  if (live) {
    const poIds = live.productOrderIds.slice(0, 12);
    for (const poId of poIds) {
      await prisma.orderFulfillmentState.create({
        data: {
          productOrderId: poId,
          poRequestedAt: daysAgo(1),
        },
      });
    }
  }

  for (const result of orderResults) {
    if (result.plan.status === "ACTIVE") continue;
    const settled = result.plan.status === "COMPLETED";
    for (const po of result.settledPoAmounts) {
      const fee = Math.round(po.amount * 0.055);
      await prisma.naverSettlementCase.create({
        data: {
          id: `demo-settle-${po.productOrderId}`,
          productOrderId: po.productOrderId,
          orderId: po.productOrderId.replace("PO", "ORD"),
          productId: result.plan.productId,
          productOrderType: "NORMAL",
          settleType: settled ? "NORMAL" : "EXPECT",
          payDate: new Date(po.paymentDate),
          settleExpectDate: settled ? null : daysAhead(randInt(2, 6)),
          settleCompleteDate: settled ? daysAgo(Math.max(result.plan.endOffset, 0) - 4) : null,
          paySettleAmount: po.amount - fee,
          totalPayCommissionAmount: fee,
          settleExpectAmount: settled ? 0 : po.amount - fee,
          settled,
        },
      });
    }
  }
}

async function seedOutreachAndOps() {
  const outreachRows = [
    { dealIdx: 3, sellerId: "demo-seller-yoon", status: "PROPOSED", note: "프라이팬 3종 공구 제안 DM 발송" },
    { dealIdx: 3, sellerId: "demo-seller-salim", status: "NEGOTIATING", note: "수수료 조건 조율 중 — 회신 대기" },
    { dealIdx: 4, sellerId: "demo-seller-haneul", status: "TESTING", note: "시카 크림 샘플 발송 완료, 사용 후기 대기" },
    { dealIdx: 4, sellerId: "demo-seller-onthefit", status: "PROPOSED", note: "진정 크림 공구 가능 여부 문의" },
    { dealIdx: 1, sellerId: "demo-seller-workingmom", status: "CONVERTED", note: "유산균 2차 회차 확정" },
    { dealIdx: 2, sellerId: "demo-seller-bada", status: "DROPPED", note: "카테고리 부적합으로 종료" },
  ] as const;

  for (const [idx, row] of outreachRows.entries()) {
    const deal = DEALS[row.dealIdx];
    await prisma.salesTask.create({
      data: {
        id: `demo-task-${idx + 1}`,
        dealId: deal.id,
        sellerId: row.sellerId,
        status: row.status,
        contactChannel: pick(["DM", "EMAIL"]),
        proposalMessage: row.note,
        proposalSentAt: daysAgo(randInt(2, 14)),
        nextReminderAt: row.status === "PROPOSED" ? daysAhead(randInt(1, 3)) : null,
        droppedAt: row.status === "DROPPED" ? daysAgo(2) : null,
        dropReason: row.status === "DROPPED" ? "카테고리 부적합" : null,
        totalMarginRate: 16,
        sellerMarginRate: 9,
      },
    });
    await prisma.sellerOutreach.create({
      data: {
        dealId: deal.id,
        sellerId: row.sellerId,
        status: row.status === "NEGOTIATING" ? "PROPOSED" : row.status,
        proposedAt: daysAgo(randInt(2, 14)),
      },
    });
  }

  // 매출 목표 — 데스크톱 히어로/추이 차트는 UTC 월키(desktop-dashboard.monthKey)로 목표를
  // 매칭한다. 당월은 활성 캠페인이 항상 "오늘의 달"과 겹쳐 실매출이 재배포 시점과 무관하게
  // 안정적으로 높으므로(≈2.9억), 목표를 그보다 낮게 잡아 재배포해도 '달성(≥100%)'으로 보인다.
  // 과거 월 목표는 실적보다 넉넉히 낮게 둬 월별 달성 서사를 유지한다(실적 우상향 라인은 그대로).
  const utcMonthKey = (backMonths: number) => {
    const d = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - backMonths, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const MONTH_TARGETS = [250_000_000, 60_000_000, 60_000_000, 55_000_000, 40_000_000, 20_000_000];
  const yearKey = String(NOW.getUTCFullYear());
  await prisma.revenueGoal.createMany({
    data: [
      ...MONTH_TARGETS.map((revenueTarget, back) => ({
        periodType: "MONTH",
        periodKey: utcMonthKey(back),
        revenueTarget,
      })),
      { periodType: "YEAR", periodKey: yearKey, revenueTarget: 750_000_000 },
    ],
  });

// 알림 시드는 알림센터 해체(2026-07-24)와 함께 제거 — 대체 표면은 홈 카드가 라이브 계산
  await prisma.systemTaskStatus.createMany({
    data: KNOWN_JOBS.map((job, idx) => ({
      jobKey: job.key,
      status: "SUCCESS",
      lastRunAt: daysAgo(0.2 + (idx % 4) * 0.1),
      nextExpectedRunAt: daysAhead(1),
    })),
  });
}

// ---------------------------------------------------------------------------
// 콘텐츠 × 주문 타임라인 검증 데이터
//
// 이 기능은 **타입·테스트를 전부 통과한 상태에서 화면 결함이 반복 실측된** 이력이 있어
// 데모 실렌더가 유일하게 믿을 수 있는 검증 수단이다. 그런데 종전 데모에는 콘텐츠 자산이
// 0건이라 마커·클러스터링을 눈으로 확인할 수 없었다(설계 스펙의 "미검증으로 남은 것").
// 그래서 세 상태를 전부 재현한다:
//   ① 인트라데이(10분) + 콘텐츠 마커 + 중간 「기록 없음」 하루
//   ② 인트라데이 없는 캠페인(일별 해상도) — 마감 캠페인이 이 경로다
//   ③ 발주 미연결 + 미검토 후보만 있는 캠페인(빈 상태 문구)
// ---------------------------------------------------------------------------

/** 마커 검증용 콘텐츠가 붙는 진행중 캠페인(인트라데이 경로). */
const TIMELINE_ASSET_CAMPAIGN = "demo-camp-ampoule-haneul-3";
const TIMELINE_ASSET_SELLER = "demo-seller-haneul";
/**
 * 발주 미연결 + 미검토 후보만 있는 캠페인(빈 상태 경로).
 * **창이 과거인 캠페인이어야 한다** — 후보 창(시작−7일~마감+1일)이 미래면 방금 심은 후보가
 * 통째로 창 밖이라 안내에 0건으로 뜬다(첫 시도에서 실제로 그랬다).
 */
const TIMELINE_EMPTY_CAMPAIGN = "demo-camp-probiotic-workingmom-2";
const TIMELINE_EMPTY_SELLER = "demo-seller-workingmom";

async function seedTimelineContent() {
  /** 창(13일 전~오늘) 안의 발행 시각 — 하루 저녁에 3건을 몰아 **클러스터 해체**를 검증한다. */
  const postedOffsets: Array<{ offset: number; hour: number; minute: number; mediaType: string }> = [
    { offset: 11, hour: 20, minute: 10, mediaType: "reel" },
    { offset: 8, hour: 12, minute: 30, mediaType: "image" },
    // 같은 저녁 3건 — 축소하면 +2 로 묶이고 확대하면 개별로 풀려야 한다.
    { offset: 5, hour: 21, minute: 5, mediaType: "carousel" },
    { offset: 5, hour: 21, minute: 20, mediaType: "reel" },
    { offset: 5, hour: 21, minute: 35, mediaType: "video" },
  ];
  for (const [idx, p] of postedOffsets.entries()) {
    const postedAt = kstDateTime(p.offset, p.hour, p.minute);
    await prisma.asset.create({
      data: {
        provider: "EXTERNAL_LINK",
        section: "SELLER_POST",
        entityType: "CAMPAIGN",
        entityId: TIMELINE_ASSET_CAMPAIGN,
        campaignId: TIMELINE_ASSET_CAMPAIGN,
        fileName: `demo-post-${idx + 1}`,
        externalUrl: `https://instagram.example.com/p/demo-${idx + 1}/`,
        mediaType: p.mediaType,
        postedAt,
        likeCount: randInt(120, 980),
        commentCount: randInt(3, 44),
        likesHidden: false,
        engagementSyncedAt: NOW,
      },
    });
  }

  // 분류된 스토리 2건 — 마커의 다른 갈래(반응 지표가 구조적으로 없는 유형).
  for (const [idx, offset] of [9, 4].entries()) {
    await prisma.sellerStorySnapshot.create({
      data: {
        sellerId: TIMELINE_ASSET_SELLER,
        storyPk: `demo-story-${idx + 1}`,
        takenAt: kstDateTime(offset, 19, 40),
        classification: "CAMPAIGN",
        classifiedAt: NOW,
        salesCampaignId: TIMELINE_ASSET_CAMPAIGN,
      },
    });
  }

  // ③ 빈 상태 — 미검토 스토리 2건 + 미등록 게시물 후보 3건(발주 미연결 캠페인의 셀러).
  for (let i = 0; i < 2; i += 1) {
    await prisma.sellerStorySnapshot.create({
      data: {
        sellerId: TIMELINE_EMPTY_SELLER,
        storyPk: `demo-story-unreviewed-${i + 1}`,
        takenAt: kstDateTime(11 - i, 18, 0),
        classification: "UNREVIEWED",
      },
    });
  }
  await prisma.sellerAiProfile.create({
    data: {
      sellerId: TIMELINE_EMPTY_SELLER,
      analyzedAt: daysAgo(1),
      sourceTier: "Tier0",
      aiTags: {
        postsCollectedAt: daysAgo(1).toISOString(),
        postsPreview: [1, 2, 3].map((n) => ({
          permalink: `https://instagram.example.com/p/demo-candidate-${n}/`,
          taken_at: kstDateTime(12 - n, 11, 0).toISOString(),
          likes: 100 * n,
          likes_hidden: false,
          comments: n,
          thumb: null,
          media_type: n === 1 ? "reel" : "image",
          is_gongu: n === 1,
        })),
      },
    },
  });
}

/**
 * ① 의 「기록 없음」 하루를 만든다 — 주문은 있는데 10분 버킷이 없는 날(프로덕션에서 백필
 * 퇴행 가드가 건너뛴 마감 구간과 같은 상태). 집계를 **정상 형태로 계산한 뒤 버킷만 뗀다** —
 * 손으로 형태를 지어내면 계약과 어긋나 폴백을 타버려 구멍이 재현되지 않는다.
 *
 * 이 하루가 있어야 "누적선이 그 구간을 건너뛰고도 서버 일계에 다시 붙는가"(이번 회차의
 * 핵심 수리)를 눈으로 확인할 수 있다.
 */
async function seedIntradayGapDay() {
  const { computeSnapshotDailyAggregate, loadAggregationCampaignSources } = await import(
    "../src/lib/order-converter/daily-aggregate"
  );
  const gapDateKey = kstDateKey(daysAgo(6));
  const row = await prisma.naverOrderSnapshot.findFirst({ where: { snapshotDate: gapDateKey } });
  if (!row) {
    console.warn(`[seed-demo] 인트라데이 구멍 대상 스냅샷(${gapDateKey})이 없어 건너뜁니다.`);
    return;
  }
  const universe = await loadAggregationCampaignSources(prisma);
  const orders = JSON.parse(String(row.orders)) as Parameters<typeof computeSnapshotDailyAggregate>[1];
  const aggregate = computeSnapshotDailyAggregate(universe, orders);
  // 버킷만 제거 — 나머지(일 합계·주문키)는 그대로라 일별 수치는 정확히 남는다.
  // ⚠️ 대상은 **이 행의 리프 전부**다. `snapshotDate` 로 좁히려 했다가 구멍이 사라진 적이
  // 있다(실측): 집계 리프의 날짜 키는 결제시각 귀속(`orderToDateKey`)이라 행의 `snapshotDate`
  // 와 다를 수 있다. 어차피 한 행 = 하루치이므로 전부 지워도 구멍은 하루뿐이다.
  for (const byCampaign of Object.values(aggregate.days)) {
    for (const leaf of Object.values(byCampaign)) delete (leaf as { buckets?: unknown }).buckets;
  }
  delete (aggregate as { bv?: unknown }).bv;
  await prisma.naverOrderSnapshot.update({
    where: { id: row.id },
    // 데모는 sqlite 라 이 컬럼이 String 이다(postgres 는 Json) — 읽기 경로가 두 형태를 다
    // 받으므로(safeJsonParse) 직렬화해 넣는다.
    data: { dailyAggregate: JSON.stringify(aggregate) },
  });
  console.log(
    `[seed-demo] 인트라데이 구멍 재현: 스냅샷 ${gapDateKey} → 집계 날짜 ${Object.keys(aggregate.days).join(",")}`,
  );
}

async function main() {
  console.log("[seed-demo] 데모 목업 시드 시작");
  await resetTables();
  await seedPartnersSellersDeals();
  const orderResults = await seedOrderWorld();
  await seedCampaigns(orderResults);
  await seedFulfillmentAndSettlement(orderResults);
  await seedOutreachAndOps();
  await seedTimelineContent();
  await seedIntradayGapDay();

  const [partners, sellers, deals, campaigns, snapshots] = await Promise.all([
    prisma.partner.count(),
    prisma.seller.count(),
    prisma.deal.count(),
    prisma.salesCampaign.count(),
    prisma.naverOrderSnapshot.count(),
  ]);
  console.log("[seed-demo] 완료:", { partners, sellers, deals, campaigns, snapshots });
  if (partners === 0 || sellers === 0 || campaigns === 0 || snapshots === 0) {
    throw new Error("[seed-demo] 시드 결과가 비어 있습니다 — 데모 빌드를 중단합니다.");
  }
}

main()
  .catch((error) => {
    console.error("[seed-demo] 실패:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
