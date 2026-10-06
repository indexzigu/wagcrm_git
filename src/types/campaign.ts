import type { InvoiceReplyStatus } from '@/lib/order-converter/invoice-reply-status';

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
  /**
   * 거래처 양식(공급사 템플릿) 슬러그. DB(`OrderCampaign.template String?`)와 생성 핸들러
   * (`data.template || null`)가 비울 수 있으므로 null 이 실제로 내려온다 — `string` 으로 선언하면
   * 가드 없이 서버로 보내 400 을 만든다(T-235). 양식이 필요한 동작(송장 회신 조회 등)은 호출 전에 확인한다.
   */
  template: string | null;
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
  /**
   * 스토어(네이버)에서 판매기간이 바뀌었는데 화면 기간(=판매관리 일정)이 그대로인 상태.
   * 정본을 자동으로 뒤집지 않고 어긋남만 드러낸 뒤, 운영자가 한 번 눌러 판매관리 일정을 맞춘다
   * (오너 결정 2026-09-17). 맞출 대상이 없으면 서버가 null 을 준다.
   */
  storePeriodDrift?: {
    /**
     * `full` 스토어가 판매중 — 시작일·종료일 둘 다 맞춘다.
     * `end-only` 판매가 끝난 상태 — 네이버가 시작일을 종료일 기준으로 다시 쓰므로 **종료일만** 맞춘다
     * (오너 결정 2026-09-17, 실측 근거는 `sale-window.ts` 의 `STORE_PERIOD_TRUSTED_STATUS`).
     */
    scope: 'full' | 'end-only';
    /**
     * `end-only` 인 이유(`full` 이면 null) — 팝오버가 왜 종료일만 맞추는지 설명하는 데 쓴다.
     * `store-closed` 판매 종료 상태 · `sales-before-store-start` 스토어 시작일 전에 이미 매출이 있음
     * (오너 결정 2026-09-24).
     */
    startKeptReason: 'store-closed' | 'sales-before-store-start' | null;
    /** 화면에 보여줄 스토어 값. `full` 이면 기간, `end-only` 면 종료일 하나. */
    storeLabel: string;
    /** 비교 대상인 지금 화면 값 — `storeLabel` 과 같은 해상도(서버가 만든다). */
    windowLabel: string;
    /** `end-only` 면 null — 시작일은 보내지 않는다. */
    storeStartYmd: string | null;
    /** 종료 미정('계속')이면 null — 판매관리 종료일을 맞출 근거가 없어 액션을 막는다. */
    storeEndYmd: string | null;
    /** 맞출 대상 판매캠페인(정산 확정된 회차는 제외됨). */
    salesCampaignIds: string[];
  } | null;
  productId?: string | null; // 네이버 상품번호 (스토어 옵션 자동 로드 시 상품 식별에 사용)
  insights?: CampaignInsights | null;
  /**
   * 아직 처리 안 된 송장 회신(크론 `scan-invoice-replies` 감지) — 없으면 null. 카드의
   * 「송장 회신 도착 · 주문 N건 · HH:MM」 줄. 판정 SSOT 는 `invoice-reply-status.ts`.
   */
  invoiceReply?: InvoiceReplyStatus | null;
  /** 발주서 자동 준비 스위치(발주 자동화 2단계, 기본 꺼짐). */
  autoPrepEnabled?: boolean;
  /** 발주요청 창이 준비본을 허락하는 상태면 그 기준 시각(변경피드 커서), 아니면 null — prepared-po SSOT. */
  preparedPo?: { asOfIso: string } | null;
  // 활성이지만 라이브 집계가 비어(조회창 만료) 마감 시점 스냅샷으로 폴백 중임을 알리는 표식.
  // 마감취소된 캠페인의 기록이 화면에서 사라지지 않게 하는 폴백 경로에서만 true(campaigns-handler).
  isFrozenFallback?: boolean;
};
