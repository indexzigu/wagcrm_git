export type DailyTask = {
  id: string;
  date: string;
  status: string;
};

// 캠페인 인사이트(비식별 집계) — campaigns route가 활성 캠페인에 한해 라이브 산출.
// 마감 캠페인은 캐시 미지원으로 null.
export type CampaignInsights = {
  inflow: { path: string; orders: number; quantity: number; revenue: number; orderRatio: number }[];
  hourly: { hour: number; orders: number; revenue: number }[];
  device: { mobile: number; pc: number; unknown: number };
  paymentMeans: { means: string; orders: number }[];
  membership: { orders: number; ratio: number };
  buyers: { unique: number; repeat: number; repeatRatio: number };
  claims: { canceled: number; returned: number; exchanged: number; total: number; ratio: number };
};

export type Campaign = {
  id: string;
  name: string;
  template: string;
  sellerName: string;
  toEmail?: string;
  ccEmail?: string;
  tasks: DailyTask[];
  mappings?: any[];
  salesCampaigns?: any[];
  thumbnailUrl?: string;
  newOrderBeforeCount?: number;
  newOrderAfterCount?: number;
  pendingCount?: number;
  shippingCount?: number;
  completedCount?: number;
  totalOrders?: number;
  distinctOrderCount?: number;
  totalRevenue?: number;
  lastOrderAt?: number | null;
  pendingDelayDays?: Record<string, number>;
  shippingDelayDays?: Record<string, number>;
  isActive?: boolean;
  category?: string;
  productStatus?: string;
  /**
   * 스토어(네이버)가 관측한 판매기간 문자열. **화면 표시에 쓰지 말 것** — 집계 창의 정본은 판매관리
   * 일정이라(오너 2026-07-15) '종료 후 임시 오픈' 같은 운영에서 이 값과 창이 갈라진다. 표시는 periodLabel.
   * 판매캠페인이 연결되지 않은 캠페인에서만 창의 폴백 근거로 쓰인다.
   */
  salePeriod?: string;
  /** 화면에 띄우는 판매기간 = 집계 창 그대로(서버가 컷오프와 같은 값에서 파생). 표시는 항상 이걸 쓴다. */
  periodLabel?: string | null;
  /** 연결된 판매캠페인들의 기간이 서로 달라 min~max 합성 창이 어느 딜에도 정확하지 않음(경고 배지). */
  periodMismatch?: boolean;
  /**
   * 정산 확정으로 창이 얼었는데 판매관리 일정이 그와 다름 = 판매관리에서 기간을 고쳐도 반영되지 않는 상태.
   * 조용한 무응답을 드러내는 신호(운영자가 "종료일을 늘리세요" 안내를 따랐는데 안 먹는 경우).
   */
  periodFrozenDrift?: boolean;
  productId?: string | null; // 네이버 상품번호 (스토어 옵션 자동 로드 시 상품 식별에 사용)
  insights?: CampaignInsights | null;
  // 활성이지만 라이브 집계가 비어(조회창 만료) 마감 시점 스냅샷으로 폴백 중임을 알리는 표식.
  // 마감취소된 캠페인의 기록이 화면에서 사라지지 않게 하는 폴백 경로에서만 true(campaigns-handler).
  isFrozenFallback?: boolean;
};
