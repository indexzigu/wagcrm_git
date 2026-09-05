import type { DecimalLike } from "./campaign-row";
import { resolveSettlementCompletionFlags } from "./tax-filing-board";
import { computeAutoStatus } from "./settlement-status";

/**
 * `PATCH /api/campaigns/[id]` 의 순수 파생 로직 추출 — 3계층 이관 2단계.
 *
 * 이 모듈은 DB 접근이 없다(입력 → 출력). 라우트(`src/app/api/campaigns/[id]/route.ts`)가
 * zod 파싱·트랜잭션·응답 조립을 계속 소유하고, 여기서는 그 사이의 "순수 계산" 구간만
 * 분리한다. ⚠️ 이관 자체는 동작 변화 0 이 대전제라 이상해 보이는 산술도 그대로 옮겼고,
 * 그때 발견해 별건으로 보고한 `?? -1` 센티널만 뒤이어 교정했다(`numericFieldChanged`).
 */

// route.ts 의 zod 스키마(`updateCampaignSchema`)에서 이 모듈이 실제로 쓰는 필드만 뽑은
// 구조적 타입. 스키마 자체를 이 모듈로 옮기지 않는다(파싱은 컨트롤러 소관, 3단계 재정리 예정).
export type CampaignUpdateData = {
  status?: string;
  salesChannel?: string;
  actualSales?: number | null;
  operatingExpense?: number | null;
  miscExpense?: number | null;
  quantity?: number | null;
  itemCount?: number | null;
  totalMarginRate?: number;
  sellerMarginRate?: number;
  netMarginRate?: number;
  isManualMargin?: boolean;
  isManualSettlementSales?: boolean;
  isManualSellerExpense?: boolean;
  isManualTaxExpense?: boolean;
  startDate?: string;
  endDate?: string;
  isDepositReceived?: boolean;
  depositReceivedAt?: string | null;
  isPayoutCompleted?: boolean;
  payoutCompletedAt?: string | null;
  isSupplierPayoutCompleted?: boolean;
  supplierPayoutCompletedAt?: string | null;
  returnPeriodEndDate?: string | null;
  settlementSupplyCost?: number | null;
  settlementGoodsCost?: number | null;
  supplierInvoiceIssuedAt?: string | null;
  sellerInvoiceIssuedAt?: string | null;
  expectedDepositDate?: string | null;
  expectedPayoutDate?: string | null;
  expectedSupplierPayoutDate?: string | null;
  accountingCompletedAt?: string | null;
  invoiceInfo?: string | null;
  roundNumber?: number | null;
  campaignName?: string | null;
  dealId?: string;
  sellerId?: string;
  notesFromImport?: string | null;
  salesTask?: unknown;
  campaignDeals?: unknown[];
};

// 라우트가 `previous`로 부르는, PATCH 이전 조회 캠페인 행에서 이 모듈이 읽는 필드만.
export type PreviousCampaignForUpdate = {
  status: string;
  salesChannel: string;
  actualSales: DecimalLike;
  operatingExpense: DecimalLike;
  miscExpense: DecimalLike;
  quantity: number | null;
  itemCount: number | null;
  totalMarginRate: DecimalLike;
  sellerMarginRate: DecimalLike;
  netMarginRate: DecimalLike;
  isManualMargin: boolean;
  isManualSettlementSales: boolean;
  isManualSellerExpense: boolean;
  isManualTaxExpense: boolean;
  startDate: Date;
  endDate: Date;
  returnPeriodEndDate: Date | null;
  roundNumber: number | null;
  campaignName: string | null;
  settlementSupplyCost: DecimalLike;
  settlementGoodsCost: DecimalLike;
  supplierInvoiceIssuedAt: Date | null;
  sellerInvoiceIssuedAt: Date | null;
  expectedDepositDate: Date | null;
  expectedPayoutDate: Date | null;
  expectedSupplierPayoutDate: Date | null;
  accountingCompletedAt: Date | null;
  dealId: string;
  sellerId: string;
  notesFromImport: string | null;
  groupId: string | null;
  group: {
    isDepositReceived: boolean;
    isPayoutCompleted: boolean;
    isSupplierPayoutCompleted: boolean;
    invoiceInfo: string | null;
    // 정산일 6종은 그룹 스칼라가 SoT다(아래 `resolveSharedSettlementDate` 주석) —
    // `diffCampaignChanges` 가 "화면이 보여준 값"과 대조하려면 여기까지 필요하다.
    supplierInvoiceIssuedAt: Date | null;
    sellerInvoiceIssuedAt: Date | null;
    expectedDepositDate: Date | null;
    expectedPayoutDate: Date | null;
    expectedSupplierPayoutDate: Date | null;
    accountingCompletedAt: Date | null;
  } | null;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  isSupplierPayoutCompleted: boolean;
};

/** 그룹 스칼라 SoT + 읽기 오버레이가 걸린 정산일 필드(= `campaign-row.ts` 오버레이 목록). */
type SharedSettlementDateField =
  | "supplierInvoiceIssuedAt"
  | "sellerInvoiceIssuedAt"
  | "expectedDepositDate"
  | "expectedPayoutDate"
  | "expectedSupplierPayoutDate"
  | "accountingCompletedAt";

/**
 * 정산일 6종의 **유효 이전값** — 그룹이면 그룹 스칼라, 아니면 멤버 컬럼.
 *
 * ⚠️ 멤버 컬럼과 그냥 대조하면 안 된다. 그룹 캠페인일 때 이 5종은 `campaignService` 가
 * **멤버에 쓰지 않고**(`!isGrouped ? campaignSharedEventUpdates : {}`) 그룹 행에만 쓰므로,
 * 멤버 컬럼은 낡은 채 남는다 — 낡은 값과 대조하면 같은 값을 재전송해도 "바뀌었다"가 되어
 * 좁힌 의미가 없어진다(대시보드 정산 판정이 밟았던 CG-1 함정과 동형).
 *
 * ⛔ `=== undefined` 를 `?? ` 나 `!= null` 로 바꾸지 말 것 — **그룹 값이 null 이어도 그룹이
 * 이긴다**. 판정식은 `toCampaignRow`(`src/lib/campaign-row.ts`)의 오버레이와 **한 글자도
 * 다르면 안 된다**: 사용자가 화면에서 본 값이 곧 "이전값"이어야 "바뀌었다"가 사람의 감각과
 * 일치한다.
 */
function resolveSharedSettlementDate(
  previous: PreviousCampaignForUpdate,
  field: SharedSettlementDateField,
): Date | null {
  const groupValue = previous.group?.[field];
  return groupValue === undefined ? previous[field] : groupValue;
}

/**
 * 날짜 필드의 **실변경** 판정 — 미전송(`undefined`)은 무변경, null↔값은 변경,
 * 값↔값은 `start date`·`end date` 와 **같은 식**(ISO 인스턴트 대조)으로 본다.
 *
 * 🪤 Date 객체를 `!==` 로 비교하면 참조 비교라 항상 참이다(요청값은 zod `z.string().date()`
 * 인 날짜 문자열이고 이전값은 Date 다).
 *
 * ℹ️ 이전값의 `undefined` 는 null 과 같게(= 비어 있음) 본다. 프로덕션의 `previous` 는
 * `CAMPAIGN_DETAIL_INCLUDE`(`group` 을 `include` 로 통째로 싣는다)로 조회한 **전체 행**이라
 * 컬럼이 빠질 일이 없지만,
 * 부분 객체가 들어와도 판정이 터지지 않고 **거짓 양성(변경으로 봄) 쪽으로만** 기울게 한다 —
 * 거짓 음성(실제 변경을 무변경으로 봄)은 이력 유실이라 반대 방향보다 나쁘다.
 */
function hasDateFieldChanged(
  next: string | null | undefined,
  previousValue: Date | null | undefined,
): boolean {
  if (next === undefined) return false;
  if (next === null) return previousValue != null;
  if (previousValue == null) return true;
  return new Date(next).toISOString() !== previousValue.toISOString();
}

export type SettlementStates = {
  isGrouped: boolean;
  previousDepositState: boolean;
  previousPayoutState: boolean;
  previousSupplierPayoutState: boolean;
  newDepositState: boolean;
  newPayoutState: boolean;
  newSupplierPayoutState: boolean;
  invoiceInfo: string | null | undefined;
  previousInvoiceInfo: string | null;
};

/**
 * 그룹/멤버 분기를 포함한 입금·지급 상태 해석 — PATCH 앞부분의
 * `isGrouped`·`previousDepositState`·`previousPayoutState`·`newDepositState`·
 * `newPayoutState`·`invoiceInfo`·`previousInvoiceInfo` 계산을 그대로 옮긴 것이다.
 */
export function resolveSettlementStates(
  data: CampaignUpdateData,
  previous: PreviousCampaignForUpdate,
): SettlementStates {
  const isGrouped = previous.groupId !== null;
  const previousDepositState = isGrouped && previous.group
    ? previous.group.isDepositReceived
    : previous.isDepositReceived;
  const previousPayoutState = isGrouped && previous.group
    ? previous.group.isPayoutCompleted
    : previous.isPayoutCompleted;
  const previousSupplierPayoutState = isGrouped && previous.group
    ? previous.group.isSupplierPayoutCompleted
    : previous.isSupplierPayoutCompleted;
  const newDepositState = data.depositReceivedAt !== undefined
    ? data.depositReceivedAt !== null
    : data.isDepositReceived !== undefined
      ? data.isDepositReceived
      : previousDepositState;
  const newPayoutState = data.payoutCompletedAt !== undefined
    ? data.payoutCompletedAt !== null
    : data.isPayoutCompleted !== undefined
      ? data.isPayoutCompleted
      : previousPayoutState;
  const newSupplierPayoutState = data.supplierPayoutCompletedAt !== undefined
    ? data.supplierPayoutCompletedAt !== null
    : data.isSupplierPayoutCompleted !== undefined
      ? data.isSupplierPayoutCompleted
      : previousSupplierPayoutState;
  const invoiceInfo = data.invoiceInfo !== undefined
    ? data.invoiceInfo
    : data.notesFromImport;
  const previousInvoiceInfo = isGrouped && previous.group
    ? previous.group.invoiceInfo
    : previous.notesFromImport;

  return {
    isGrouped,
    previousDepositState,
    previousPayoutState,
    previousSupplierPayoutState,
    newDepositState,
    newPayoutState,
    newSupplierPayoutState,
    invoiceInfo,
    previousInvoiceInfo,
  };
}

/**
 * 숫자 필드의 변경 판정 — **미입력(null/undefined)은 값이 아니라 상태**로 다룬다.
 *
 * ⛔ `?? -1` 센티널로 되돌리지 말 것: "미입력"을 도메인 값 -1 로 사영하면 실제 -1 과
 * 구분이 사라진다. 그러면 미입력 → -1 저장이 무변경으로 삼켜지고(이력 누락), 반대로
 * -1 → 미입력 삭제도 잡히지 않는다. 정산 조정분처럼 음수가 실제로 들어오는 필드라
 * 가정으로 막을 수 없다. 규약은 3분기 — 양쪽 미입력=무변경, 한쪽만 미입력=변경,
 * 둘 다 값=수치 비교 — 이고, 미입력을 `null` 로 정규화하면 세 갈래가 한 비교로 접힌다
 * (`null !== null` 이 거짓, `null !== 0` 이 참이므로 분기를 따로 쓸 필요가 없다).
 */
function numericFieldChanged(next: DecimalLike, previous: DecimalLike): boolean {
  const toNumber = (value: DecimalLike): number | null =>
    value === null || value === undefined ? null : Number(value.toString());
  return toNumber(next) !== toNumber(previous);
}

/**
 * `changedFields` 배열 리터럴(35개 항목 비교). ⚠️ 반환되는 영문 라벨 문자열은 한 글자도
 * 바꾸지 않는다 — 뒤의 `CALENDAR_SYNC_FIELDS` 매칭과 `describeChangedFields`가 이 리터럴에
 * 의존한다.
 *
 * **판정 기준은 "요청에 실려 왔는가"가 아니라 "실제로 바뀌었는가"다**(T-020). 3계층 이관
 * (#317)이 그대로 옮긴 원본에는 두 기준이 섞여 있었다 — 대부분은 `previous` 와 대조하는데
 * 11개 항목만 `data.X !== undefined` 였고, 그래서 인라인 날짜 입력에서 **같은 날짜를 다시
 * 골라 blur 하기만 해도** "expected deposit date 변경"이 활동 로그에 남고 캘린더 동기화가
 * 발화했다. T-019(`resolveReturnPeriodEndDate`)가 같은 부류를 이미 한 건 좁혔고, 여기서
 * 나머지를 정리한다.
 *
 * ℹ️ 이 배열은 **쓰기를 유발하지 않는다** — `campaignService.updateCampaign` 은
 * `plan.changedFields` 를 읽지 않고 각 필드를 `data.X !== undefined` 로 직접 쓴다. 소비처는
 * ①`periodChanged`(start/end 전용, 이 변경과 무관) ②`CALENDAR_SYNC_FIELDS` ③활동 로그
 * `describeChangedFields` ④"로그를 남길지" 게이트뿐이라, 좁혀도 저장 결과는 동일하고
 * **무변경 저장이 이력·캘린더를 오염시키지 않는 것**만 달라진다.
 *
 * ⛔ **`salesTask`·`campaignDeals` 두 항목은 의도적으로 `!== undefined` 로 남긴다** —
 * `previous` 에 대응 값이 없고(salesTask 는 별도 테이블이라 라우트의 previous 조회에 아예
 * 없다), campaignDeals 는 행 N개 × 숫자 7종을 Decimal↔number 로 심층 비교해야 해서
 * **거짓 무변경**(실제로 바뀐 저장이 이력에 안 남음)의 위험이 좁혀서 얻는 이득보다 크다.
 * 게다가 두 필드의 쓰기 자체가 `data.X !== undefined` 조건이므로, 지금 형태가 오히려
 * "이 요청이 무엇을 썼는가"의 정확한 기록이다.
 */
export function diffCampaignChanges(
  data: CampaignUpdateData,
  previous: PreviousCampaignForUpdate,
  states: SettlementStates,
): string[] {
  const {
    newDepositState,
    previousDepositState,
    newPayoutState,
    previousPayoutState,
    newSupplierPayoutState,
    previousSupplierPayoutState,
    invoiceInfo,
    previousInvoiceInfo,
  } = states;

  return [
    data.status !== undefined && data.status !== previous.status ? "status" : null,
    data.salesChannel !== undefined && data.salesChannel !== previous.salesChannel ? "channel" : null,
    data.actualSales !== undefined && numericFieldChanged(data.actualSales, previous.actualSales) ? "actual sales" : null,
    data.operatingExpense !== undefined && numericFieldChanged(data.operatingExpense, previous.operatingExpense) ? "operating expense" : null,
    data.miscExpense !== undefined && numericFieldChanged(data.miscExpense, previous.miscExpense) ? "misc expense" : null,
    data.quantity !== undefined && numericFieldChanged(data.quantity, previous.quantity) ? "order count" : null,
    data.itemCount !== undefined && numericFieldChanged(data.itemCount, previous.itemCount) ? "item count" : null,
    data.totalMarginRate !== undefined && Number(data.totalMarginRate) !== Number(previous.totalMarginRate?.toString() ?? 0) ? "total margin" : null,
    data.sellerMarginRate !== undefined && Number(data.sellerMarginRate) !== Number(previous.sellerMarginRate?.toString() ?? 0) ? "seller margin" : null,
    data.netMarginRate !== undefined && Number(data.netMarginRate) !== Number(previous.netMarginRate?.toString() ?? 0) ? "net margin" : null,
    data.isManualMargin !== undefined && data.isManualMargin !== previous.isManualMargin ? "manual margin" : null,
    data.isManualSettlementSales !== undefined && data.isManualSettlementSales !== previous.isManualSettlementSales ? "manual settlement sales" : null,
    data.isManualSellerExpense !== undefined && data.isManualSellerExpense !== previous.isManualSellerExpense ? "manual seller expense" : null,
    data.isManualTaxExpense !== undefined && data.isManualTaxExpense !== previous.isManualTaxExpense ? "manual tax expense" : null,
    data.startDate !== undefined && new Date(data.startDate).toISOString() !== previous.startDate.toISOString() ? "start date" : null,
    data.endDate !== undefined && new Date(data.endDate).toISOString() !== previous.endDate.toISOString() ? "end date" : null,
    newDepositState !== previousDepositState ? "deposit date" : null,
    newPayoutState !== previousPayoutState ? "payout date" : null,
    newSupplierPayoutState !== previousSupplierPayoutState ? "supplier payout date" : null,
    // 반품기간 종료일은 그룹 오버레이 대상이 **아니다** — 멤버 컬럼이 SoT이고 형제에는
    // `fanOutMemberSchedule` 이 복사한다(`docs/agents/codebase-map.md`).
    hasDateFieldChanged(data.returnPeriodEndDate, previous.returnPeriodEndDate) ? "return period end date" : null,
    // 금액 2종은 위 금액 항목들과 **같은 판정기**(`numericFieldChanged`)를 쓴다 — 미입력을
    // 센티널로 사영하지 않으므로 `settlementGoodsCost` 의 0(「타 캠페인 계산서에 합산됨」
    // 마커라 유효값)과 미입력(null)이 그대로 구분된다.
    data.settlementSupplyCost !== undefined && numericFieldChanged(data.settlementSupplyCost, previous.settlementSupplyCost) ? "settlement supply cost" : null,
    data.settlementGoodsCost !== undefined && numericFieldChanged(data.settlementGoodsCost, previous.settlementGoodsCost) ? "settlement goods cost" : null,
    hasDateFieldChanged(data.supplierInvoiceIssuedAt, resolveSharedSettlementDate(previous, "supplierInvoiceIssuedAt")) ? "supplier invoice date" : null,
    hasDateFieldChanged(data.sellerInvoiceIssuedAt, resolveSharedSettlementDate(previous, "sellerInvoiceIssuedAt")) ? "seller invoice date" : null,
    hasDateFieldChanged(data.expectedDepositDate, resolveSharedSettlementDate(previous, "expectedDepositDate")) ? "expected deposit date" : null,
    hasDateFieldChanged(data.expectedPayoutDate, resolveSharedSettlementDate(previous, "expectedPayoutDate")) ? "expected payout date" : null,
    hasDateFieldChanged(data.expectedSupplierPayoutDate, resolveSharedSettlementDate(previous, "expectedSupplierPayoutDate")) ? "expected supplier payout date" : null,
    hasDateFieldChanged(data.accountingCompletedAt, resolveSharedSettlementDate(previous, "accountingCompletedAt")) ? "accounting completed at" : null,
    data.roundNumber !== undefined && numericFieldChanged(data.roundNumber, previous.roundNumber) ? "round number" : null,
    data.campaignName !== undefined && data.campaignName !== previous.campaignName ? "campaign name" : null,
    data.dealId !== undefined && data.dealId !== previous.dealId ? "deal" : null,
    data.sellerId !== undefined && data.sellerId !== previous.sellerId ? "seller" : null,
    invoiceInfo !== undefined && invoiceInfo !== previousInvoiceInfo ? "invoice info" : null,
    // ⛔ 아래 2건만 `!== undefined` 로 남는다 — 위 함수 주석의 「의도적으로 남긴다」 참조.
    // 좁히려면 `previous` 확장(salesTask 별도 조회)과 심층 비교가 선행돼야 한다.
    data.salesTask !== undefined ? "connected task details" : null,
    data.campaignDeals !== undefined ? "revenue items" : null,
  ].filter((value): value is string => value !== null);
}

export type SettlementSync = Record<string, boolean | Date | null>;

/**
 * 정산일↔불린 동기화 객체(`settlementSync`) 생성. ⚠️ `new Date()`(현재 시각)는 순수성을
 * 위해 `now` 인자로 주입받는다 — 호출부는 `new Date()`를 넘겨 동작을 그대로 유지한다.
 */
export function resolveSettlementSync(
  data: CampaignUpdateData,
  states: Pick<SettlementStates, "previousDepositState" | "previousPayoutState" | "previousSupplierPayoutState">,
  now: Date,
): SettlementSync {
  const settlementSync: SettlementSync = {};
  if (data.depositReceivedAt !== undefined) {
    if (data.depositReceivedAt !== null) {
      settlementSync.depositReceivedAt = new Date(data.depositReceivedAt);
      settlementSync.isDepositReceived = true;
    } else {
      settlementSync.depositReceivedAt = null;
      settlementSync.isDepositReceived = false;
    }
  } else if (data.isDepositReceived !== undefined && data.isDepositReceived !== states.previousDepositState) {
    settlementSync.isDepositReceived = data.isDepositReceived;
    settlementSync.depositReceivedAt = data.isDepositReceived ? now : null;
  }
  if (data.payoutCompletedAt !== undefined) {
    if (data.payoutCompletedAt !== null) {
      settlementSync.payoutCompletedAt = new Date(data.payoutCompletedAt);
      settlementSync.isPayoutCompleted = true;
    } else {
      settlementSync.payoutCompletedAt = null;
      settlementSync.isPayoutCompleted = false;
    }
  } else if (data.isPayoutCompleted !== undefined && data.isPayoutCompleted !== states.previousPayoutState) {
    settlementSync.isPayoutCompleted = data.isPayoutCompleted;
    settlementSync.payoutCompletedAt = data.isPayoutCompleted ? now : null;
  }
  if (data.supplierPayoutCompletedAt !== undefined) {
    if (data.supplierPayoutCompletedAt !== null) {
      settlementSync.supplierPayoutCompletedAt = new Date(data.supplierPayoutCompletedAt);
      settlementSync.isSupplierPayoutCompleted = true;
    } else {
      settlementSync.supplierPayoutCompletedAt = null;
      settlementSync.isSupplierPayoutCompleted = false;
    }
  } else if (
    data.isSupplierPayoutCompleted !== undefined &&
    data.isSupplierPayoutCompleted !== states.previousSupplierPayoutState
  ) {
    settlementSync.isSupplierPayoutCompleted = data.isSupplierPayoutCompleted;
    settlementSync.supplierPayoutCompletedAt = data.isSupplierPayoutCompleted ? now : null;
  }
  return settlementSync;
}

/**
 * 반품기간 종료일(+14일 자동 규칙) — 명시값이 있으면 그것, 없고 **종료일이 실제로 바뀌었으며**
 * 기존값이 비어 있으면 +14일 자동.
 *
 * ⚠️ 이 함수만 모듈 헤더의 "동작 변화 0" 대전제에서 **의도적으로 벗어난다**(T-019). 3계층 이관
 * (#317)이 그대로 옮긴 종전 조건은 `data.endDate !== undefined`, 즉 **요청에 실려 오기만 하면**
 * 참이었다. 그래서 종료일을 같은 값으로 재저장하는 것만으로 비어 있던(= 반품기간 미정이라는
 * 오너의 의도) 필드에 날짜가 저절로 생겼다. 판정은 `diffCampaignChanges` 의 `"end date"` 와
 * **같은 식**(ISO 문자열 대조)을 쓴다 — ⛔ 호출부의 `periodChanged` 를 인자로 받는 형태로
 * 바꾸지 말 것: 그 신호는 `start date` 변경까지 포함하므로 시작일만 바꿔도 자동 계산이 튄다.
 * 🪤 Date 객체를 `!==` 로 비교하면 참조 비교라 항상 참이다(`data.endDate` 는 zod
 * `z.string().date()` 인 날짜 문자열이고 `previous.endDate` 는 Date 다).
 *
 * ℹ️ 그룹 팬아웃(`fanOutMemberSchedule`)이 이 값을 형제 멤버에 복사하므로, 여기서 `undefined`
 * 를 반환하면 형제 멤버의 반품기간도 건드리지 않는다(무쓰기).
 */
export function resolveReturnPeriodEndDate(
  data: Pick<CampaignUpdateData, "returnPeriodEndDate" | "endDate">,
  previous: Pick<PreviousCampaignForUpdate, "returnPeriodEndDate" | "endDate">,
): Date | null | undefined {
  let resolvedReturnPeriodEndDate: Date | null | undefined;
  if (data.returnPeriodEndDate !== undefined) {
    resolvedReturnPeriodEndDate = data.returnPeriodEndDate
      ? new Date(data.returnPeriodEndDate)
      : null;
  } else if (
    data.endDate !== undefined &&
    new Date(data.endDate).toISOString() !== previous.endDate.toISOString() &&
    !previous.returnPeriodEndDate
  ) {
    const d = new Date(data.endDate);
    d.setDate(d.getDate() + 14); // 14 calendar days ~ 10 working days
    resolvedReturnPeriodEndDate = d;
  }
  return resolvedReturnPeriodEndDate;
}

/**
 * `autoStatus` 결정 — **채널이 요구하는 완료 플래그가 전부** 참이면 COMPLETED, 일부만
 * 참이고 이전 상태가 COMPLETED면 SETTLEMENT_WAIT, 그 외는 undefined.
 *
 * 요구 플래그 목록은 `resolveSettlementCompletionFlags`(슬롯 SSOT)가 정한다 — 자사몰은
 * [공급사 지급, 셀러 지급], 그 외 채널은 [입금, 지급](현행 유지, 오너 확정 2026-08-25).
 * ⛔ `입금 && 지급` 을 여기서 다시 손으로 쓰지 말 것 — 자사몰엔 입금 칸이 없어 그 판정이
 * 영구 미완료가 된다.
 */
export function resolveAutoStatus(
  states: Pick<
    SettlementStates,
    | "newDepositState"
    | "previousDepositState"
    | "newPayoutState"
    | "previousPayoutState"
    | "newSupplierPayoutState"
    | "previousSupplierPayoutState"
  >,
  previousStatus: string,
  salesChannel: string,
): string | undefined {
  const legStates = {
    isDepositReceived: { next: states.newDepositState, prev: states.previousDepositState },
    isPayoutCompleted: { next: states.newPayoutState, prev: states.previousPayoutState },
    isSupplierPayoutCompleted: {
      next: states.newSupplierPayoutState,
      prev: states.previousSupplierPayoutState,
    },
  } as const;
  // 변경 게이트도 요구 플래그 집합으로 좁힌다 — 판정에 안 들어가는 플래그의 토글이
  // status 를 흔들면 안 된다.
  const settlementStateChanged = resolveSettlementCompletionFlags(salesChannel).some(
    (flag) => legStates[flag].next !== legStates[flag].prev,
  );
  if (!settlementStateChanged) return undefined;

  return computeAutoStatus(previousStatus, salesChannel, {
    isDepositReceived: states.newDepositState,
    isPayoutCompleted: states.newPayoutState,
    isSupplierPayoutCompleted: states.newSupplierPayoutState,
  });
}
