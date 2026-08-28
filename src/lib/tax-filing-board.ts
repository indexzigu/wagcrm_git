/**
 * 월별 세금계산서 처리 보드 — "이번 달 세무 마감에 남은 것"의 집계.
 *
 * ⛔ 이 파일은 domain 을 한 번 잘못 이해했다(2026-08-03 이전). 「발행 = 우리→셀러,
 * 수취 = 셀러→우리」로 단정했는데 실제로는 **방향이 채널마다 다르다** — 자세한 표는
 * `docs/private/specs/2026-08-07-settlement-invoice-direction-design.md` §2(최우선
 * 정본)를 볼 것. ✅ 2026-08-07 오너 정정 이후 **상대는 전 채널이 「필드명 = 상대」로
 * 균일하다** — `supplierInvoiceIssuedAt` 은 항상 공급사, `sellerInvoiceIssuedAt` 은
 * 항상 셀러이고, 채널이 바꾸는 것은 방향뿐이다. "필드명이 상대를 뜻하지 않는다"던
 * 종전 서술은 폐기됐다(아래 `TAX_INVOICE_OBLIGATION_TABLE` 헤더 주석 — 그 서술을
 * 되살리지 말 것).
 *
 * 그래서 채널 규칙을 조건문에 흩어놓지 않고 `TAX_INVOICE_OBLIGATION_TABLE` 한 곳에
 * 모았다. 채널 판정(`resolveTaxFilingChannelGroup`)은 `campaign-checklist.ts` 의
 * `ensureCampaignChecklistForStatus` 분기와 **바이트 단위로 동일**해야 한다 — 여기서
 * 다르게 판정하면 보드에 뜬 행에 대응하는 체크리스트 항목이 없어 오너가 「완료」를
 * 영영 못 누르는 행이 생긴다.
 *
 * 금액은 새로 계산하지 않고 `tax-invoice-builder` 와 같은 식(`/1.1`, `×0.1`)을 쓴다 —
 * 보드에 보인 금액과 실제로 내려받는 홈택스 XLSX 의 금액이 갈리면 안 되기 때문이다.
 * 네 가지 금액 기준(셀러 수수료·영업수익·매출-수수료·매출-영업수익)이 전부 오너
 * 확정이다(2026-08-04, 스펙 「우리몰 공급사 물품대금 — 확정됨」절) — 한때 우리몰의
 * 「공급사 수취」만 기준 미확정이라 `TaxInvoiceAmount.status === "NEEDS_CONFIRMATION"`
 * 으로 숫자를 비워 뒀으나, 확정되며 그 장치를 제거했다. 미래에 또 미확정 기준이
 * 생기면 그때 다시 도입한다(YAGNI).
 *
 * 결번(사업자등록번호·상호·대표자명 누락, 금액 0 이하)은 행을 지우지 않고
 * `selectable: false` 로 남긴다. 숨기면 오너가 "이번 달 끝났다"고 오판하고, 섞으면
 * 홈택스가 업로드를 통째로 반려한다 — 보이되 못 고르는 상태가 정답이다.
 *
 * ⛔ 정산 그룹(CampaignGroup) 은 `supplierInvoiceIssuedAt`·`sellerInvoiceIssuedAt`
 * 을 멤버 캠페인 전체가 공유한다(스키마 1개 필드, `campaign-row.ts`가 전 멤버에
 * 동일하게 폴딩) — 실제 세금계산서도 그룹당 1건이다. 그런데 이 파일은 한때 캠페인
 * 단위로 행을 냈다 — 3인 그룹이면 같은 의무가 3행으로 뜨고, 발행/수취 합계가 그만큼
 * 부풀고, 「완료」를 누르면 그룹 필드가 한 번에 바뀌며 3행이 동시에 사라져 오너에게
 * 버그처럼 보였다(2026-08-04 재검토 지적). 그래서 `groupId` 가 있는 캠페인은
 * (groupId, 의무) 단위로 묶어 **한 행**만 낸다 — `emitGroupRows`. 금액은 멤버별
 * VAT 포함 원금(base amount)을 먼저 합산한 뒤 그 합계에 한 번만 `/1.1`·`×0.1`을
 * 적용한다(멤버별로 각각 반올림해 합치면 실제 통합 세금계산서 금액과 몇 원 단위로
 * 갈릴 수 있다 — 한 장의 계산서는 한 번만 반올림된다). 멤버 중 채널
 * (`resolveTaxFilingChannelGroup`)이 갈리면 의무 자체가 그룹 단위로 하나로 정의되지
 * 않는다 — 조용히 하나를 고르지 않고 캠페인 단위 행으로 후퇴시키며 `warnings`에
 * 남긴다(이 순수 함수가 이미 갖고 있는 `salesChannel`만으로 판정 가능해 DB 조회가
 * 필요 없다 — 그룹 지급일 마스킹처럼 route 가 DB 로 채우는 경고와는 별개 계열이다).
 * 멤버끼리 공급사(`partnerName`)가 달라도 같은 이유로 후퇴한다 — `CampaignGroup`의
 * 유일한 앱 불변식은 "같은 셀러"뿐이라 `dealId`(→ 공급사)는 멤버마다 다를 수 있다
 * (2026-08-04 회귀 정정, Finding 1). SELLER 가 상대인 의무는 이 검증이 필요 없다.
 *
 * ⚠️ 위 "한 번만 반올림" 규칙 때문에, 그룹 행의 금액은 `tax-invoice-builder`가 실제
 * 다중 품목 세금계산서를 만들 때(품목별 공급가를 각각 반올림해 합산)와 몇 원 단위로
 * 갈릴 수 있다 — 이 파일 상단에서 "XLSX 와 금액이 갈리면 안 된다"고 적은 원칙은
 * 캠페인 단위 행에는 그대로 적용되고, 그룹 행에서는 의도적으로 깨진다(정합성보다
 * 실제 통합 계산서 금액에 더 가깝게 맞추는 쪽을 택했다). 오너가 이 몇 원 차이를
 * 버그로 오인해 조사하지 않도록 여기 기록한다.
 */
import type { CampaignRow } from "./crm-types";
import { isIndividualSeller } from "./seller-tax-utils";
import {
  GOODS_COST_CONSOLIDATED_LABEL,
  GOODS_COST_CONSOLIDATED_REASON,
  resolveGoodsCost,
  sumGroupManualGoodsCost,
} from "./goods-cost";
import {
  collectSettlementItemsOnInvoice,
  sumSettlementItemsOnInvoice,
  type SettlementItemInput,
  type SettlementItemInvoiceAxis,
} from "./settlement-items";
import { validateTaxInvoiceCampaigns, normalizeBusinessNumber } from "./tax-invoice-builder";
import { splitVatIncluded } from "./vat";

export type TaxInvoiceDirection = "ISSUE" | "RECEIVE";
export type TaxInvoiceCounterpart = "SUPPLIER" | "SELLER";

export type TaxInvoiceBoardSection = "IN_PROGRESS" | "BACKLOG";

/**
 * 이 행이 「지금 할 일」인가 「밀린 정리」인가.
 *
 * ⛔ **전원이 COMPLETED 일 때만 BACKLOG 다.** 그룹 멤버 중 하나라도 진행 중이면 그
 * 계산서 한 장은 아직 살아 있는 작업이므로 IN_PROGRESS 로 올린다 — 접힌 구역에 넣으면
 * 진행 중인 일이 화면에서 사라진다. 틀릴 때 덜 위험한 쪽으로 기울인다.
 *
 * 상태를 모르는 입력(undefined·빈 배열)도 IN_PROGRESS 다. 같은 이유다.
 */
export function resolveBoardSection(
  statuses: readonly (string | undefined)[],
): TaxInvoiceBoardSection {
  if (statuses.length === 0) return "IN_PROGRESS";
  return statuses.every((status) => status === "COMPLETED") ? "BACKLOG" : "IN_PROGRESS";
}

/**
 * 세금계산서 한 행의 공급가액·세액. 한때 "우리몰의 공급사 수취" 금액 기준이 오너
 * 확정 전이라 이 타입이 `CONFIRMED`/`NEEDS_CONFIRMATION` 판별 유니온이었다 — 0 이나
 * 추정치를 내면 그 숫자로 오너가 대사(對査)하게 되는 사고를 막기 위해서였다.
 * 2026-08-04 오너가 마지막 남은 기준(우리몰 공급사 물품대금)을 확정하면서 미확정
 * 인스턴스가 0이 됐다 — YAGNI 로 판별자를 걷어내고 평범한 객체 타입으로 되돌린다.
 * 미래에 또 미확정 기준이 생기면 그때 다시 판별 유니온을 도입한다.
 */
export type TaxInvoiceAmount = { supplyAmount: number; taxAmount: number };

export type TaxInvoiceBoardRow = {
  /**
   * 체크리스트 PATCH 앵커. 그룹 캠페인이 아니면 그 캠페인 자체 id. 그룹 캠페인이면
   * 대표 멤버(id 오름차순 첫 번째) — 체크리스트 항목 조회는 이 id 로 하고, 형제
   * 멤버 항목 동기화는 `setChecklistItemChecked`(campaign-checklist.ts)가 그룹 전체를
   * 다시 조회해 처리한다(이 id 하나만으로는 형제를 못 찾지만, 그건 이 값의 역할이
   * 아니다 — `campaignIds`가 그 역할이다).
   */
  campaignId: string;
  /** 정산 그룹 소속이면 그 id, 아니면 null. */
  groupId: string | null;
  /**
   * 이 행이 대표하는 실제 캠페인 id 전부(그룹 행이면 멤버 전원, 아니면 `[campaignId]`).
   * 체크리스트 항목을 여러 캠페인에 걸쳐 찾아야 할 때(그룹 상황) 이 목록을 쓴다.
   */
  campaignIds: string[];
  /**
   * 이 의무를 만든 원천 필드 — `TAX_INVOICE_OBLIGATION_TABLE`을 순회하며 이미 알고
   * 있는 값을 그대로 싣는다. route 가 `counterpart`·`direction`으로 라벨 판정 조건을
   * 다시 유도하지 않도록 하는 것이 목적(2026-08-04 재검토 지적) — 그 유도는
   * `TAX_INVOICE_OBLIGATION_TABLE`의 두 번째 인코딩이고, `setChecklistItemChecked`의
   * 라벨 문자열 파싱이 세 번째다. 이 필드가 있으면 route 는 `sourceField ===
   * "sellerInvoiceIssuedAt"` 하나만 보고 `isSellerInvoiceLabel`/`isSupplierInvoiceLabel`
   * 을 고르면 된다 — 네 번째 인코딩을 새로 만들지 않는다.
   */
  sourceField: "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt";
  direction: TaxInvoiceDirection;
  counterpart: TaxInvoiceCounterpart;
  /** 거래 상대 표기 — 상대가 셀러면 사업자 상호 우선(없으면 셀러명), 공급사면 파트너명 */
  counterpartName: string;
  /** 자동 조합 캠페인명, 없으면 딜명 폴백. 그룹 행이면 대표 멤버 이름 + "외 N건". */
  campaignLabel: string;
  amount: TaxInvoiceAmount;
  /**
   * ISSUE(발행) 만 우리가 세금계산서를 만들어 내는 방향이다 — RECEIVE(수취)는
   * 상대가 발행하므로 우리는 추적만 한다. 이 필드는 "이 방향이 발행이다"라는
   * 사실 자체를 인코딩한다 — direction 문자열 비교를 호출부마다 다시 하면 그중
   * 하나가 RECEIVE 에 발행 관련 동작을 붙이는 사고가 재발할 수 있다.
   *
   * ⚠️ `tax-invoice-builder.ts`(`buildTaxInvoiceRows`)는 2026-08-04에 이 보드가
   * 낸 ISSUE 행을 그대로 소비하도록 다시 쓰여 counterpart·amount 오류가 고쳐졌다
   * (과거엔 셀러몰 발행이 `actualSales`전액으로 과다청구했고, 브랜드몰 발행은
   * 공급받는자가 셀러로 하드코딩돼 있었다). 그 정정을 리뷰한 뒤 2026-08-05에
   * `tax-filing-dialog.tsx`가 이 필드로 「홈택스 XLSX」 파일 생성(체크박스·전체
   * 선택)의 노출을 게이트한다 — `direction === "ISSUE"`를 다이얼로그가 다시
   * 유도하지 않고 이 필드를 그대로 믿는다. RECEIVE는 상대가 이미 발행하므로 이
   * 값이 항상 false다 — 이 게이트가 깨지면 상대의 계산서를 우리가 중복 발행하는
   * 사고가 난다. 이 필드는 그래서 지우지 않는다.
   */
  xlsxEligible: boolean;
  /**
   * 「진행 중」인가 「밀린 정리」인가. 캠페인 상태에서 파생되며 라우트가 다시 유도하지
   * 않는다 — 그 유도가 이 레포가 반복해서 겪은 「같은 판정의 두 번째 인코딩」이다.
   */
  section: TaxInvoiceBoardSection;
  /**
   * 부가 항목이 이 행에 어떻게 작용했는가(설계 §9). 화면은 이것으로 배지를 만든다 —
   * `amount` 만 보면 「왜 작년과 다른 숫자인가」를 오너가 알 수 없고, 물품대금 행처럼
   * **일부러 안 더한** 경우는 더더욱 근거가 안 보인다.
   */
  settlementItemEffect: SettlementItemEffect;
  /** 비어 있지 않으면 일괄 대상에서 제외된다 */
  blockingReasons: string[];
  selectable: boolean;
};

/**
 * 방향별 합계 — 발행(우리가 낼 세금계산서)과 수취(상대가 낼 세금계산서)는 반대
 * 현금흐름이라 하나로 합치면 뜻이 없다. 이전 버전은 방향 구분 없이 한 캠페인의
 * ISSUE·RECEIVE 두 행을 같은 `sellerExpense` 기준 금액으로 계산해 하나의 합계에
 * 더했다 — 사실상 같은 성격의 숫자를 두 번 센 것이다(회귀 테스트가 이를
 * "c1 의 ISSUE+RECEIVE 만"으로 정상 동작처럼 고정하고 있었다). 방향별로 쪼개면
 * 각 숫자가 "이번 달 우리가 발행할 총액" / "이번 달 우리가 받을 총액"이라는 실제
 * 의미를 갖는다 — 정직한 합계는 이거다.
 */
export type TaxInvoiceDirectionTotals = {
  supplyAmount: number;
  taxAmount: number;
};

export type TaxInvoiceBoard = {
  month: string;
  rows: TaxInvoiceBoardRow[];
  /** 진행 중(IN_PROGRESS) 미처리 행 수 — 진입점 배지의 소스다.
   *  ⛔ BACKLOG 를 더하지 말 것: 배지가 영구히 고정돼 신호가 죽는다. */
  pendingCount: number;
  /** 밀린 정리(BACKLOG) 행 수 — 배지에 반영하지 않는다. */
  backlogCount: number;
  /** 그중 결번(또는 금액 확인 필요)으로 막힌 행 수 */
  blockedCount: number;
  totalsByDirection: {
    ISSUE: TaxInvoiceDirectionTotals;
    RECEIVE: TaxInvoiceDirectionTotals;
  };
  /**
   * 이 순수 함수는 DB 접근이 없다 — 그래서 DB 조회가 필요한 경고(그룹 지급일
   * 마스킹 등)는 여기서 만들지 않고 `WithholdingReport.warnings` 와 같은 이유로
   * 필드만 열어 둬서 route 가 채워 넣는다. 다만 **입력으로 받은 `campaigns` 안에서
   * 계산 가능한 경고**(그룹 멤버 채널 불일치 등)는 이 함수가 스스로 채운다 — 그 판정
   * 에 필요한 정보(`salesChannel`·`groupId`)가 이미 인자로 들어와 있어 DB 를 새로
   * 조회할 이유가 없다. route 는 이 배열에 자신의 DB 파생 경고를 추가로 push 한다
   * (덮어쓰지 않는다).
   */
  warnings: string[];
};

/** 스펙 표의 3행 — `campaign-checklist.ts` 의 커스텀 체크리스트 분기와 1:1 대응한다. */
type TaxFilingChannelGroup = "OWN_MALL" | "BRAND_MALL" | "SELLER_MALL";

/**
 * `campaign-checklist.ts`(`ensureCampaignChecklistForStatus`)의 `isOwnMall`/
 * `isBrandMall` 분기와 **완전히 동일**해야 한다. 여기서 갈리면 보드 행과 체크리스트
 * 항목이 서로 다른 채널로 나뉘어 대응하는 항목이 없는 행이 생긴다.
 *
 * `UNSPECIFIED`가 셀러몰로 떨어지는 것은 기존 동작 그대로다(의도된 동작 — 스펙
 * 「채널 판정의 경계값」절).
 */
export function resolveTaxFilingChannelGroup(salesChannel: string): TaxFilingChannelGroup {
  if (salesChannel.startsWith("OWN_MALL")) return "OWN_MALL";
  if (salesChannel === "BRAND_MALL") return "BRAND_MALL";
  return "SELLER_MALL";
}

export type AmountBasis =
  | "SELLER_COMMISSION" // sellerExpense — 셀러 → 우리 수취 (전 채널 공통)
  | "SETTLEMENT_SALES" // settlementSales(영업수익) — 브랜드몰 발행 → 공급사
  | "SALES_MINUS_COMMISSION" // actualSales − sellerExpense — 셀러몰 발행 → 셀러몰
  | "SALES_MINUS_SETTLEMENT"; // actualSales − settlementSales(= 상품 공급가) — 우리몰 공급사 물품대금, 채널 무관 확정 기준(오너 2026-08-04)

type ChannelObligation = {
  direction: TaxInvoiceDirection;
  counterpart: TaxInvoiceCounterpart;
  amountBasis: AmountBasis;
} | null; // null = 이 채널엔 이 절차 자체가 없다 → 행을 만들지 않는다

/**
 * 부가 항목이 이 금액 기준에 어떻게 작용하는가.
 *
 * - `ADD` — 그 축의 항목을 **원금에 가산**한다. 실물 계산서가 그 금액을 담고 오기 때문.
 * - `NOTE_ONLY` — 관련은 있지만 **가산하지 않고 배지로만** 알린다. 지금은 물품대금
 *   하나뿐이고 사유는 아래 표에 적혀 있다.
 *
 * ⛔ 한쪽을 `null` 로 두지 않고 둘 다 축을 갖게 한 것은 의도다 — 「이 기준은 부가
 * 항목과 무관하다」와 「관련 있는데 일부러 안 더한다」는 전혀 다른 사실이고, `null`
 * 로 뭉개면 배지를 붙일 근거가 사라져 **오너에게 차액의 원인이 안 보인다.**
 */
type ItemAxisRule =
  | { mode: "ADD"; axis: SettlementItemInvoiceAxis }
  | { mode: "NOTE_ONLY"; axis: SettlementItemInvoiceAxis; reason: string };

/**
 * ⛔ **금액 기준 → 부가 항목 축의 SSOT** (설계 §9-2, 오너 승인 2026-08-08).
 *
 * 의무 축(`direction × counterpart`)과 부가 항목 축(`invoiceMode × counterparty`)은
 * **같은 사실의 같은 표현**이라 대응이 유도가 아니라 **동형사상**이다 —
 * `SALES_ISSUE`=ISSUE · `PURCHASE_RECEIVE`=RECEIVE · `BRAND`=SUPPLIER · `SELLER`=SELLER.
 * 그래서 이 표에는 방향을 다시 계산하는 조건문이 하나도 없다. 1단계가 저장 축을
 * 「브랜드/셀러 반영 토글」이 아니라 「계산서 방식 × 대상」으로 고른 결정(설계 §2-2
 * 근거 ①)이 여기서 이자를 낸다.
 *
 * `Record<AmountBasis, …>` 인 것이 핵심이다 — 금액 기준이 늘면 **컴파일이 막는다.**
 * 이 레포는 같은 판정을 두 번 인코딩해 갈린 사고를 여섯 번 겪었고, 표를 못 빠뜨리게
 * 하는 것은 주석이 아니라 타입이다.
 *
 * ⚠️ `NO_INVOICE` 와 `INTERNAL` 은 이 표에 **등장할 수 없다**(타입이 막는다). 계산서
 * 없는 돈을 계산서 금액에 더하는 것은 모순이다. 설계 §2-3 반영 매트릭스가
 * 「(매입계산서 수취 | 계산서 없음) × 셀러 → 기대액 가산」으로 적어 `NO_INVOICE` 도
 * 가산하는 것처럼 읽히지만, 그 괄호는 **개인 셀러 지급 경로를 같은 줄에 묶어 적은
 * 것**이다 — 개인 셀러는 애초에 셀러 상대 의무가 생기지 않으므로(아래
 * `isIndividualSeller` 가드) 가산 대상이 될 수 없다. 이 표가 정본이다(설계 §9-2).
 */
export const AMOUNT_BASIS_ITEM_RULE: Record<AmountBasis, ItemAxisRule> = {
  // 셀러가 우리에게 끊는 수수료 계산서에 「우리가 셀러에게 지급하는 부가 항목」이
  // 품목 행으로 함께 실린다(오너 확정, 설계 §3-3 — 별도 계산서 2건이 아니다).
  SELLER_COMMISSION: { mode: "ADD", axis: { invoiceMode: "PURCHASE_RECEIVE", counterparty: "SELLER" } },
  // 브랜드몰 공급사 발행 — 통과 광고비의 **수취 다리**가 여기 실린다.
  SETTLEMENT_SALES: { mode: "ADD", axis: { invoiceMode: "SALES_ISSUE", counterparty: "BRAND" } },
  // 셀러몰 셀러 발행 — 우리가 셀러에게 청구하는 실비(드묾).
  SALES_MINUS_COMMISSION: { mode: "ADD", axis: { invoiceMode: "SALES_ISSUE", counterparty: "SELLER" } },
  // ⛔ **가산하면 이중 계상이다**(설계 §3-2·§9-3). 매입 부대비용은 브랜드사가 물품대금
  //    계산서에 **붙여서** 청구하므로, 수기 물품대금이 이미 부대비용을 포함한 실물
  //    총액이다. 여기에 또 더하면 같은 돈을 두 번 센다.
  //    ⚠️ 수기값이 **미입력**(공식 폴백)일 때도 더하지 않는다 — 공식은 부대비용을
  //    모르지만, 모르는 것을 부분적으로 메우면 「일부만 반영된 합계」가 실물 총액처럼
  //    보이는 그럴듯한 오답이 된다. 공식+모델링으로 실물을 재현하려는 시도는 이미
  //    실측 기각됐다(`expected-receivables.ts` 의 `manualGoodsCost` 주석) — **세 번째
  //    추정 경로를 만들지 않는다.**
  SALES_MINUS_SETTLEMENT: {
    mode: "NOTE_ONLY",
    axis: { invoiceMode: "PURCHASE_RECEIVE", counterparty: "BRAND" },
    reason: "매입 부대비용은 물품대금 계산서에 합산돼 청구되므로 가산하지 않습니다(수기 물품대금이 총액 정본).",
  },
};

/**
 * 가산 대상 축(가산하지 않는 기준이면 null) — 호출부가 `mode` 를 다시 분기하지 않게.
 *
 * `computeBaseAmountForBasis` 를 못 쓰는 호출부가 하나 있다: 수취 엔진의 셀러 수수료
 * 슬롯은 기대액이 `null`(모름)일 수 있어야 하는데 그 함수는 결번을 0 + 사유로 표현한다
 * (두 어휘가 다르다). 그쪽이 축만 빌려 쓰도록 export 한다 — 축을 손으로 다시 적으면
 * 그게 두 번째 인코딩이다.
 */
export function resolveAddableItemAxis(basis: AmountBasis): SettlementItemInvoiceAxis | null {
  const rule = AMOUNT_BASIS_ITEM_RULE[basis];
  return rule.mode === "ADD" ? rule.axis : null;
}

/**
 * 이 행 금액에 부가 항목이 어떻게 작용했는지.
 *
 * 두 소비처가 있다: 화면의 배지(「왜 숫자가 달라졌나」)와 **세금계산서 품목 행**
 * (`tax-invoice-builder`). 후자 때문에 `applied` 는 합계가 아니라 **행 목록**이다 —
 * 빌더가 캠페인에서 항목을 다시 골라 오면 그게 두 번째 인코딩이고, 보드가 더한 것과
 * 빌더가 늘어놓은 것이 갈리면 「품목 합 ≠ 총계」로 홈택스가 반려한다.
 */
export type SettlementItemEffect = {
  /** 원금에 **가산된** 항목 — 품목 행의 원천이다. VAT 포함 금액(부호 있음). */
  applied: Array<{ note: string | null; amount: number }>;
  /**
   * 관련 있으나 **가산하지 않은** 항목의 요약(현재는 물품대금 행의 매입 부대비용뿐).
   * 품목 행이 되지 않으므로 목록이 아니라 요약으로 충분하다 — 화면 배지 전용.
   */
  unapplied: { count: number; total: number; reason: string | null };
};

/** 가산분 합계 — 배지 문구·검증이 쓴다(`applied` 를 두 번 순회하지 않게). */
export function sumAppliedItemEffect(effect: SettlementItemEffect): number {
  return effect.applied.reduce((sum, item) => sum + item.amount, 0);
}

const NO_UNAPPLIED = { count: 0, total: 0, reason: null } as const;

function summarizeItemEffect(
  basis: AmountBasis,
  itemLists: ReadonlyArray<readonly SettlementItemInput[] | undefined>,
): SettlementItemEffect {
  const rule = AMOUNT_BASIS_ITEM_RULE[basis];
  const matched = itemLists.flatMap((items) => collectSettlementItemsOnInvoice(items, rule.axis));

  if (rule.mode === "ADD") {
    return {
      applied: matched.map((item) => ({
        // `note` 는 `SettlementItemInput` 에 없다(판정에 안 쓰이므로) — 있는 경우에만
        // 싣는다. 없으면 빌더가 「부가 항목」 폴백 이름을 쓴다.
        note: "note" in item ? ((item as { note?: string | null }).note ?? null) : null,
        amount: Number(item.amount) || 0,
      })),
      unapplied: NO_UNAPPLIED,
    };
  }

  return {
    applied: [],
    unapplied: {
      count: matched.length,
      total: matched.reduce((sum, item) => sum + (Number(item.amount) || 0), 0),
      reason: rule.reason,
    },
  };
}

/**
 * ⛔ 채널별 세금계산서 거래 구조 — 스펙의 표를 그대로 코드로 옮긴 판정표.
 * 이 상수 하나가 SSOT다. 채널 규칙을 바꿀 일이 생기면 여기만 고친다(조건문에
 * 다시 흩어놓지 말 것 — 그게 이 파일이 한 번 domain 을 잘못 이해한 원인이었다).
 *
 * | 채널 | supplierInvoiceIssuedAt | sellerInvoiceIssuedAt |
 * | --- | --- | --- |
 * | 우리몰 | 수취 ← 공급사 (물품 대금 = actualSales−settlementSales, 상품 공급가) | 수취 ← 셀러 (수수료) |
 * | 브랜드몰 | 발행 → 공급사 (총 RS) | 수취 ← 셀러 (수수료) |
 * | 셀러몰 | 수취 ← 공급사 (물품 대금, 위와 같은 식) | 발행 → 셀러 (셀러수수료 제외 전체) |
 *
 * ✅ **2026-08-07 오너 정정 이후 전 채널이 「필드명 = 상대」로 균일하다** — 채널이
 * 바꾸는 것은 방향뿐이다. 종전 표는 셀러몰의 셀러 발행을 `supplierInvoiceIssuedAt`
 * 슬롯에 넣고 셀러 슬롯을 미사용으로 두어, "필드명은 supplier지만 상대는 셀러다"라는
 * 함정을 만들었다. 그 서술을 되살리지 말 것.
 *
 * 근거 3종: ①금액 기준표가 이미 「공급사 → 우리 물품비 수취」를 **전 채널** 공통으로
 * 확정했다 ②수취 메일 대조 엔진은 셀러몰에도 SUPPLIER_GOODS 기대 건을 이미 만들고
 * 있었다(추적 칸이 없어 버렸을 뿐) ③프로덕션 실데이터가 두 필드를 각각 공급사
 * 수취·셀러 발행으로 쓰고 있었다(2026-08-07 읽기 전용 조회).
 */
export const TAX_INVOICE_OBLIGATION_TABLE: Record<
  TaxFilingChannelGroup,
  { supplierInvoiceIssuedAt: ChannelObligation; sellerInvoiceIssuedAt: ChannelObligation }
> = {
  OWN_MALL: {
    supplierInvoiceIssuedAt: {
      direction: "RECEIVE",
      counterpart: "SUPPLIER",
      amountBasis: "SALES_MINUS_SETTLEMENT",
    },
    sellerInvoiceIssuedAt: {
      direction: "RECEIVE",
      counterpart: "SELLER",
      amountBasis: "SELLER_COMMISSION",
    },
  },
  BRAND_MALL: {
    supplierInvoiceIssuedAt: {
      direction: "ISSUE",
      counterpart: "SUPPLIER",
      amountBasis: "SETTLEMENT_SALES",
    },
    sellerInvoiceIssuedAt: {
      direction: "RECEIVE",
      counterpart: "SELLER",
      amountBasis: "SELLER_COMMISSION",
    },
  },
  SELLER_MALL: {
    supplierInvoiceIssuedAt: {
      direction: "RECEIVE",
      counterpart: "SUPPLIER",
      amountBasis: "SALES_MINUS_SETTLEMENT",
    },
    sellerInvoiceIssuedAt: {
      direction: "ISSUE",
      counterpart: "SELLER",
      amountBasis: "SALES_MINUS_COMMISSION",
    },
  },
};

/**
 * `tax-invoice-builder`가 행 금액을 그대로 쓸 때 적용하는 변환과 동일한 식이다
 * (2026-08-04부터 `buildTaxInvoiceRows`는 이 보드가 낸 행의 `amount`를 재계산 없이
 * 그대로 소비하므로, 사실상 이 함수가 유일한 변환 지점이다 — 갈라지면 보드 화면과
 * XLSX 금액이 어긋난다).
 */
function toSupplyAndTax(vatIncludedAmount: number): { supplyAmount: number; taxAmount: number } {
  // 식은 `vat.ts` 한 곳에 있다 — 빌더가 품목 행을 나누며 같은 변환을 해야 하는데
  // 두 파일은 순환 때문에 서로 import 할 수 없어서다(그 모듈 헤더 참조).
  return splitVatIncluded(vatIncludedAmount);
}

/**
 * `computeBaseAmountForBasis`가 실제로 읽는 필드만 남긴 타입 — `CampaignRow` 전체가
 * 아니라 이 세 스칼라만 있으면 원금을 계산할 수 있다. 그룹 합산(`resolveGroupSellerIssueInvoiceAmount`)
 * 이 멤버 전원의 `CampaignRow`를 들고 있지 않은 호출부(캠페인 사이드패널의 신고자료출력
 * 도우미는 그룹 형제의 매출·수수료만 필요하고 나머지 캠페인 필드는 필요 없다)에서도
 * 이 함수를 그대로 재사용하기 위한 최소 계약이다.
 */
export type InvoiceBaseAmountInput = Pick<
  CampaignRow,
  "actualSales" | "sellerExpense" | "settlementSales"
> &
  // 수기 물품대금 — 있으면 `SALES_MINUS_SETTLEMENT` 공식보다 **우선**한다(설계 §3-1).
  // optional 인 이유: 이 타입을 쓰는 호출부 중 물품대금과 무관한 기준(셀러 수수료 등)만
  // 계산하는 곳이 있고, 그쪽에 필드를 강제하면 의미 없는 값을 실어 나르게 된다.
  Partial<Pick<CampaignRow, "settlementGoodsCost">> & {
    /**
     * 부가 항목 — `AMOUNT_BASIS_ITEM_RULE` 이 `ADD` 로 지정한 축의 항목이 원금에 가산된다.
     *
     * ⚠️ **미입력(undefined)과 0건([])은 같은 뜻이다** — 부가 항목은 「평소 0행이 정상」
     * 이므로 없음이 곧 0원이고, 물품대금처럼 「모름 → 폴백」으로 해석하지 않는다.
     *
     * 타입이 `CampaignRow["settlementItems"]`(= `SettlementItemRow[]`)가 아니라 판정에
     * 필요한 3필드(`SettlementItemInput`)인 것은 의도다 — 대조 엔진은 `id`·`note`·
     * `sortOrder` 를 조회하지 않으므로, 그것들을 요구하면 의미 없는 값을 실어 나르거나
     * select 를 넓히게 된다(egress 규율).
     */
    settlementItems?: readonly SettlementItemInput[];
  };

/**
 * VAT 포함 원금(base amount) — **부가 항목 가산 후**의 값. `/1.1`·`×0.1` 변환은
 * 호출부가 한다. 단일 캠페인 행은 `computeAmountForBasis`(아래)가 곧바로 변환해서
 * 쓰고, 그룹 행은 `emitGroupRows`가 멤버별 원금을 **먼저 합산한 뒤** 그 합계에 변환을
 * 한 번만 적용한다 — 멤버마다 따로 반올림해서 합치면 실제 통합 세금계산서 금액과
 * 몇 원 단위로 갈릴 수 있어서다(한 장의 계산서는 한 번만 반올림된다). 부가 항목이
 * **원금 단계**에서 더해지는 것도 같은 이유다(설계 §9-5).
 *
 * ## 가산 규칙 (설계 §9-2)
 *
 * 축은 `AMOUNT_BASIS_ITEM_RULE` 이 정한다. 여기서 다시 방향을 유도하지 않는다.
 *
 * ⛔ **원금이 결번이면 가산하지 않는다.** 결번일 때 `baseAmount` 는 0인데 그건
 * 「0원」이 아니라 **모름**이다 — 거기에 부가 항목을 얹으면 부가 항목 금액이 곧 계산서
 * 총액인 것처럼 보이는 그럴듯한 오답이 된다(이 파일이 `?? 0` 으로 두 번 밟은 함정과
 * 같은 부류). 모르는 것은 모르는 채로 둔다.
 */
export function computeBaseAmountForBasis(
  basis: AmountBasis,
  campaign: InvoiceBaseAmountInput,
): { baseAmount: number; blockingReasons: string[] } {
  const raw = computeRawBaseAmountForBasis(basis, campaign);
  // 결번이면 그대로 — 위 ⛔ 참조.
  if (raw.blockingReasons.length > 0) return raw;

  const axis = resolveAddableItemAxis(basis);
  if (axis === null) return raw;

  const itemsTotal = sumSettlementItemsOnInvoice(campaign.settlementItems, axis);
  if (itemsTotal === 0) return raw;

  const baseAmount = raw.baseAmount + itemsTotal;
  // 역방향 정정(음수 항목)이 원금을 다 깎아 낸 경우 — 0원짜리 계산서는 실무상 없다.
  // 조용히 0을 내지 않고 결번으로 표면화한다.
  return {
    baseAmount,
    blockingReasons: baseAmount <= 0 ? ["부가 항목 반영 후 금액이 0 이하"] : [],
  };
}

/** 부가 항목을 모르는 순수 원금 계산 — 위 래퍼만 호출한다(직접 부르지 말 것). */
function computeRawBaseAmountForBasis(
  basis: AmountBasis,
  campaign: InvoiceBaseAmountInput,
): { baseAmount: number; blockingReasons: string[] } {
  const blockingReasons: string[] = [];
  let baseAmount: number;

  if (basis === "SELLER_COMMISSION") {
    baseAmount = Number(campaign.sellerExpense ?? 0);
    if (baseAmount <= 0) blockingReasons.push("정산금(sellerExpense)이 0 이하");
  } else if (basis === "SETTLEMENT_SALES") {
    baseAmount = Number(campaign.settlementSales ?? 0);
    if (baseAmount <= 0) blockingReasons.push("영업수익(settlementSales)이 0 이하");
  } else if (basis === "SALES_MINUS_COMMISSION") {
    // ⚠️ 이 분기와 아래 SALES_MINUS_SETTLEMENT 분기는 **의도적으로 대칭**을 맞춘다 —
    // 둘 다 "매출에서 무언가를 빼는" 뺄셈 기준이라, 빼는 값이 null 일 때 `?? 0`으로
    // 대체하면 결과가 `actualSales` 전액(수수료를 뺀 값보다 훨씬 큰 양수)이 되어
    // 버젓한 숫자로 보인다. 이 케이스는 counterpart === "SELLER" 라
    // `counterpartBlockingReasons`(→ `validateTaxInvoiceCampaigns`)가 sellerExpense
    // 0 이하일 때 이미 별도로 결번 처리한다(belt) — 하지만 그 안전망이 있다는 이유로
    // 여기서 다시 `?? 0`을 써서 "결번인데 금액 칸엔 매출 전액이 찍히는" 상태를
    // 만들면 안 된다(suspenders). 두 분기를 나란히 명시적으로 써 두는 건, 한쪽만
    // 보고 "다른 쪽도 똑같이 안전하겠지"라고 넘겨짚다가 이 버그가 퍼진 이력이 있어서다
    // — 나중에 "간단하게" `?? 0`으로 되돌리지 말 것.
    if (campaign.actualSales == null) {
      blockingReasons.push("실매출(actualSales) 없음");
      baseAmount = 0;
    } else if (campaign.sellerExpense == null) {
      blockingReasons.push("정산금(sellerExpense) 없음: 셀러몰 매출 계산 불가");
      baseAmount = 0;
    } else {
      baseAmount = campaign.actualSales - campaign.sellerExpense;
      if (baseAmount <= 0) blockingReasons.push("정산금(actualSales-sellerExpense)이 0 이하");
    }
  } else {
    // SALES_MINUS_SETTLEMENT — 공급사 물품대금(= 상품 공급가), 채널 무관 확정 기준.
    //
    // ⛔ **수기 물품대금이 있으면 그것이 정본이다**(설계 §3-1, 2026-08-08). 종전에는 이
    // 보드가 `settlementGoodsCost` 를 **아예 읽지 않아**, 수취 대조 엔진(그 필드를 우선
    // 적용한다)과 같은 의무에 다른 금액을 말할 수 있었다 — 전건 null 이라 결과가 우연히
    // 같았을 뿐인 **이중 기준**이었다. 판정은 공유 SSOT(`goods-cost.ts`)에 위임한다.
    const goods = resolveGoodsCost({
      manualGoodsCost: campaign.settlementGoodsCost,
      actualSales: campaign.actualSales,
      settlementSales: campaign.settlementSales,
    });

    if (goods.kind === "CONSOLIDATED") {
      // 0 = 「다른 캠페인 계산서에 합산됨」. 행을 **지우지 않고** 선택 불가로 남긴다 —
      // 숨기면 오너가 "이번 달 끝났다"고 오판한다(기존 결번 원칙과 같은 처분).
      blockingReasons.push(GOODS_COST_CONSOLIDATED_REASON);
      return { baseAmount: 0, blockingReasons };
    }
    if (goods.kind === "MANUAL") {
      if (goods.amount <= 0) blockingReasons.push("수기 물품대금이 0 이하");
      return { baseAmount: goods.amount, blockingReasons };
    }
    //
    // ⚠️ settlementSales 를 `?? 0` 으로 대체하면 안 된다 — 이 식은 뺄셈이라 null 을
    // 0 으로 치는 방향이 SETTLEMENT_SALES(더하기식 기준)와 정반대로 뒤집힌다.
    // SETTLEMENT_SALES 는 null→0 이 그대로 "0 이하" 가드에 걸려 안전하게 결번
    // 처리되지만(크게 실패), 여기서 null→0 을 빼면 `actualSales` 전액(물품대금의
    // 몇 배에 달하는 큰 양수)이 그대로 통과해 버젓한 숫자로 보인다(조용하게 오답) —
    // 오너가 그 숫자로 공급사 세금계산서를 대사하게 되는, 이 재작성이 막으려 했던
    // 바로 그 사고 유형이다. 그래서 settlementSales 도 actualSales 와 똑같이
    // "없으면 계산하지 않고 결번으로 남긴다"로 명시 분기한다(위 SALES_MINUS_COMMISSION
    // 분기와 대칭 — 뺄셈 기준은 전부 이 패턴을 따른다).
    if (campaign.actualSales == null) {
      blockingReasons.push("실매출(actualSales) 없음");
      baseAmount = 0;
    } else if (campaign.settlementSales == null) {
      blockingReasons.push("영업수익(settlementSales) 없음: 물품대금 계산 불가");
      baseAmount = 0;
    } else {
      baseAmount = campaign.actualSales - campaign.settlementSales;
      if (baseAmount <= 0) blockingReasons.push("물품대금(actualSales-settlementSales)이 0 이하");
    }
  }

  return { baseAmount, blockingReasons };
}

function computeAmountForBasis(
  basis: AmountBasis,
  campaign: CampaignRow,
): { amount: TaxInvoiceAmount; blockingReasons: string[] } {
  const { baseAmount, blockingReasons } = computeBaseAmountForBasis(basis, campaign);
  return { amount: toSupplyAndTax(baseAmount), blockingReasons };
}

/**
 * 상대 쪽 결번(사업자등록번호·상호·대표자명 누락) 검증.
 *
 * `validateTaxInvoiceCampaigns`(세금계산서 빌더의 검증)에 상대를 그대로 넘긴다 —
 * 그 함수가 counterpart 인자로 셀러/공급사 중 어느 쪽 필드를 볼지 가른다(2026-08-04,
 * 「따라오는 결론」#2·「검증도 상대를 봐야 한다」절 — 이전에는 SUPPLIER 상대일 때
 * 빈 배열만 반환해 공급사 쪽 결번을 놓쳤다). `CampaignRow`가 이제 파트너 사업자
 * 필드(`partnerBusinessNumber` 등)를 노출하므로 두 상대 모두 같은 함수로 검증할 수
 * 있다.
 */
function counterpartBlockingReasons(
  counterpart: TaxInvoiceCounterpart,
  campaign: CampaignRow,
): string[] {
  const validation = validateTaxInvoiceCampaigns([campaign], counterpart);
  return validation.ok ? [] : validation.errors.flatMap((e) => e.missingFields);
}

function counterpartName(counterpart: TaxInvoiceCounterpart, campaign: CampaignRow): string {
  if (counterpart === "SUPPLIER") return campaign.partnerName;
  return campaign.sellerCompanyName || campaign.sellerName;
}

/**
 * 캠페인 사이드패널 「신고자료출력」(`tax-invoice-helper-dialog.tsx`)이 쓰는 금액
 * SSOT — 이 도우미는 "우리가 셀러에게 발행하는 세금계산서"의 금액만 다룬다.
 *
 * ⛔ 이 함수가 생긴 이유(2026-08-04 실사고): 그 다이얼로그는 원래 `mapLineItems`
 * (딜별 `actualSales` 합산 → 결과적으로 `actualSales/1.1`)를 썼다. 스펙 「⛔ 채널별
 * 세금계산서 거래 구조」표의 셀러몰 발행 기준은 `actualSales − sellerExpense`
 * (셀러 수수료를 뺀 금액)다 — 옛 코드는 셀러 수수료 전액만큼을 매번 과다표시했다.
 * 오너가 홈택스에 그 숫자를 그대로 손으로 입력하는 경로라 되돌릴 수 없는 오신고로
 * 이어진다. 같은 도메인을 이 레포에서 세 번째로 잘못 짚은 사고라 SSOT를 하나로
 * 강제한다 — 여기서 다시 별도 계산식을 만들지 말 것.
 *
 * `TAX_INVOICE_OBLIGATION_TABLE`에서 "이 캠페인 채널이 셀러를 상대로 ISSUE(발행)
 * 하는 의무"만 골라 `computeAmountForBasis`(보드가 쓰는 그 함수)로 계산한다 — 표를
 * 다시 보면 이 조건(ISSUE·SELLER)을 만족하는 채널은 셀러몰뿐이다. 우리몰·브랜드몰은
 * 셀러를 상대로 발행하는 계산서가 없으므로 `null`을 반환한다 — 호출부(사이드패널의
 * 「신고자료출력」 트리거)는 채널이 셀러몰일 때만 버튼을 보여줘야 하고, 혹시 다른
 * 채널에서 다이얼로그가 열리는 경로가 생겨도 이 함수는 금액을 추정해 채우지 않는다
 * (null → 다이얼로그가 「입력 필요」로 표시).
 *
 * ⛔ Finding 2(2026-08-04 재검토 지적) — 이 함수는 원래 캠페인 1건만 봤는데, 보드
 * (`emitGroupRows`)는 정산 그룹이면 세금계산서를 그룹당 1건(멤버 전원의 합산 금액)
 * 으로 취급하도록 이미 고쳐졌다(`groupId` 있는 캠페인끼리). 두 표면이 다른 계산을
 * 하면 오너가 사이드패널 「신고자료출력」에서 본 금액과 정산 페이지 「세무 처리」
 * 보드에서 본 같은 의무의 금액이 달라, 둘 다 손으로 홈택스에 입력하는 이 도메인에서
 * 어느 쪽이 맞는지 알 수 없는 채로 신고하게 된다. `groupMembers`(그룹이면 자기
 * 자신을 포함한 멤버 전원, 아니면 생략)를 받아 `emitGroupRows`와 같은 규칙(채널
 * 일치 시에만 원금을 먼저 합산 후 한 번만 변환)으로 합친다 — 채널이 갈리면 보드도
 * 그룹 합산을 포기하고 캠페인 단위로 후퇴하므로 여기서도 똑같이 후퇴해 `campaign`
 * 단독 금액을 반환한다(호출부가 `isGroupAmount: false`로 이를 구분한다). SUPPLIER
 * 상대 공급사 불일치 검증(Finding 1)은 이 함수에는 적용하지 않는다 — 이 함수가 다루는
 * 의무는 항상 counterpart === "SELLER"(위 가드)이고, 같은 셀러라는 그룹 불변식이
 * 이미 상대 동일성을 보장한다.
 */
export type SellerIssueInvoiceObligation = {
  amount: TaxInvoiceAmount;
  blockingReasons: string[];
  /** true면 정산 그룹 멤버 전원(`memberCount`건)의 합산 금액이다 — 캠페인 1건 금액이 아니다. */
  isGroupAmount: boolean;
  /** 합산에 포함된 멤버 수. 그룹이 아니거나 채널 불일치로 후퇴했으면 1. */
  memberCount: number;
  /**
   * 이 금액에 부가 항목이 어떻게 작용했는가 — 보드 행의 같은 필드와 **같은 규칙**이다.
   *
   * 도우미 다이얼로그가 품목 행을 보드·XLSX 와 똑같이 나눌 수 있게 싣는다. 이걸 안
   * 주면 다이얼로그가 캠페인에서 항목을 다시 골라 오게 되고, 그 순간 이 함수가 존재하는
   * 이유(같은 도메인을 세 번째로 잘못 짚어 만든 SSOT)가 무의미해진다.
   */
  settlementItemEffect: SettlementItemEffect;
};

/** `resolveSellerIssueInvoiceObligation`의 그룹 합산 입력 — 채널 일치 판정에 필요한
 *  `salesChannel`과 원금 계산에 필요한 매출·수수료만 요구한다(캠페인 전체를 들고
 *  있을 필요가 없다). 현재 캠페인 자기 자신도 이 배열에 포함해서 넘긴다(호출부 계약). */
export type SellerIssueInvoiceGroupMember = InvoiceBaseAmountInput & { salesChannel: string };

export function resolveSellerIssueInvoiceObligation(
  campaign: CampaignRow,
  groupMembers?: SellerIssueInvoiceGroupMember[],
): SellerIssueInvoiceObligation | null {
  const group = resolveTaxFilingChannelGroup(campaign.salesChannel);
  // ⛔ 슬롯을 이름으로 집지 말 것 — 「우리 → 셀러 발행」이 어느 필드에 사는지는 채널이
  // 정한다(2026-08-07 정정으로 셀러몰이 supplier → seller 슬롯으로 옮겨갔다). 종전처럼
  // `table.supplierInvoiceIssuedAt` 을 직접 읽으면 표를 고치는 순간 이 함수가 조용히
  // null 을 내고, 사이드패널의 「신고자료출력」 버튼이 아무 오류 없이 사라진다.
  const table = TAX_INVOICE_OBLIGATION_TABLE[group];
  const obligation =
    (["supplierInvoiceIssuedAt", "sellerInvoiceIssuedAt"] as const)
      .map((field) => table[field])
      .find(
        (candidate): candidate is NonNullable<ChannelObligation> =>
          candidate != null && candidate.direction === "ISSUE" && candidate.counterpart === "SELLER",
      ) ?? null;
  if (!obligation) {
    return null;
  }

  // 채널이 갈리면 `emitGroupRows`도 그룹 합산을 포기하고 캠페인 단위로 후퇴한다 —
  // 여기서도 똑같이 후퇴해 단독 금액을 낸다(조용히 그중 하나를 대표로 고르지 않는다).
  const allSameChannel =
    groupMembers && groupMembers.every((m) => resolveTaxFilingChannelGroup(m.salesChannel) === group);

  if (groupMembers && groupMembers.length > 1 && allSameChannel) {
    let baseAmountSum = 0;
    const blockingReasons = new Set<string>();
    for (const member of groupMembers) {
      const { baseAmount, blockingReasons: reasons } = computeBaseAmountForBasis(
        obligation.amountBasis,
        member,
      );
      baseAmountSum += baseAmount;
      reasons.forEach((r) => blockingReasons.add(r));
    }
    return {
      amount: toSupplyAndTax(baseAmountSum),
      blockingReasons: [...blockingReasons],
      isGroupAmount: true,
      memberCount: groupMembers.length,
      settlementItemEffect: summarizeItemEffect(
        obligation.amountBasis,
        groupMembers.map((m) => m.settlementItems),
      ),
    };
  }

  const { amount, blockingReasons } = computeAmountForBasis(obligation.amountBasis, campaign);
  return {
    amount,
    blockingReasons,
    isGroupAmount: false,
    memberCount: 1,
    settlementItemEffect: summarizeItemEffect(obligation.amountBasis, [campaign.settlementItems]),
  };
}

/** 그룹 행의 표시 이름 — 대표 멤버 이름 + 나머지 인원. 개별 멤버 이름을 다 늘어놓지
 * 않는다(표 셀이 좁고, 오너에게 필요한 건 "몇 건이 합쳐졌는지"다). */
function groupCampaignLabel(sortedMembers: CampaignRow[]): string {
  const primary = sortedMembers[0].campaignName ?? sortedMembers[0].dealName;
  return sortedMembers.length > 1 ? `${primary} 외 ${sortedMembers.length - 1}건` : primary;
}

/** 캠페인 단위로 의무 행을 만든다 — 그룹에 속하지 않은 캠페인, 그리고 그룹 멤버끼리
 * 채널이 갈려 그룹 단위로 합칠 수 없는 캠페인이 이 경로를 탄다(둘 다 "이 캠페인
 * 하나의 의무"라는 뜻은 같다). */
function emitCampaignRows(campaign: CampaignRow, rows: TaxInvoiceBoardRow[]): void {
  const group = resolveTaxFilingChannelGroup(campaign.salesChannel);
  const table = TAX_INVOICE_OBLIGATION_TABLE[group];

  for (const field of ["supplierInvoiceIssuedAt", "sellerInvoiceIssuedAt"] as const) {
    const obligation = table[field];
    if (!obligation) continue; // 이 채널엔 이 절차가 없다(예: 셀러몰의 sellerInvoiceIssuedAt)
    // 개인 셀러는 원천징수 대상이라 "셀러가 상대인" 세금계산서 의무가 없다 — 그 행만
    // 건너뛴다. 공급사가 상대인 의무(브랜드몰의 공급사 발행, 우리몰의 공급사 수취)는
    // 셀러의 세무 유형과 무관하게 그대로 남는다. ⛔ 이 조건을 캠페인 단위(루프 최상단)
    // 에 두면 개인 셀러 캠페인의 공급사 쪽 의무까지 통째로 사라진다 — 체크리스트에는
    // 「공급사 총 수수료 매출 세금계산서 발행」 항목이 생기는데 보드에는 대응 행이
    // 없어 오너가 그 의무 자체를 인지하지 못하는 사고가 났다(2026-08-04 실사고).
    if (obligation.counterpart === "SELLER" && isIndividualSeller(campaign)) continue;
    if (campaign[field]) continue; // 이미 처리됨 — 행을 만들지 않는다

    const { amount, blockingReasons: amountReasons } = computeAmountForBasis(
      obligation.amountBasis,
      campaign,
    );
    const identityReasons = counterpartBlockingReasons(obligation.counterpart, campaign);
    const blockingReasons = [...new Set([...identityReasons, ...amountReasons])];

    rows.push({
      campaignId: campaign.id,
      groupId: campaign.groupId ?? null,
      campaignIds: [campaign.id],
      sourceField: field,
      direction: obligation.direction,
      counterpart: obligation.counterpart,
      counterpartName: counterpartName(obligation.counterpart, campaign),
      campaignLabel: campaign.campaignName ?? campaign.dealName,
      amount,
      xlsxEligible: obligation.direction === "ISSUE",
      section: resolveBoardSection([campaign.status]),
      settlementItemEffect: summarizeItemEffect(obligation.amountBasis, [campaign.settlementItems]),
      blockingReasons,
      selectable: blockingReasons.length === 0,
    });
  }
}

/** `emitGroupRows`가 합치기를 포기한 이유 — 호출부가 사유별로 다른 경고 문구를 낸다. */
type GroupCollapseMismatch = "CHANNEL_MISMATCH" | "SUPPLIER_MISMATCH";

type EmitGroupRowsResult =
  | { collapsed: true }
  | { collapsed: false; reason: GroupCollapseMismatch; campaignLabel: string };

/**
 * 정산 그룹 멤버를 (groupId, 의무) 단위로 묶어 **한 행**만 만든다. 그룹 멤버끼리
 * 채널 또는 공급사가 달라 의무 자체가 하나로 정의되지 않으면 `collapsed: false`를
 * 돌려줘 호출부가 `emitCampaignRows`로 캠페인별 행에 후퇴하게 한다 — 여기서 하나를
 * 조용히 고르지 않는다.
 */
function emitGroupRows(members: CampaignRow[], groupId: string, rows: TaxInvoiceBoardRow[]): EmitGroupRowsResult {
  // id 오름차순으로 대표(anchor)를 고정한다 — 입력 배열 순서(쿼리 결과 순서)에 기대지
  // 않고 항상 같은 멤버가 대표가 되어야 체크리스트 매칭(route.ts)과 테스트가 안정된다.
  // 채널·공급사 불일치 판정보다 먼저 정렬해 두는 이유는, 두 판정 중 어느 쪽이 실패해도
  // 호출부가 경고에 쓸 `campaignLabel`(대표 멤버 이름 + 외 N건)이 이미 필요하기
  // 때문이다.
  const sortedMembers = [...members].sort((a, b) => a.id.localeCompare(b.id));
  const anchor = sortedMembers[0];
  const campaignLabel = groupCampaignLabel(sortedMembers);

  const channelGroups = new Set(members.map((m) => resolveTaxFilingChannelGroup(m.salesChannel)));
  if (channelGroups.size > 1) return { collapsed: false, reason: "CHANNEL_MISMATCH", campaignLabel };

  const channelGroup = resolveTaxFilingChannelGroup(anchor.salesChannel);
  const table = TAX_INVOICE_OBLIGATION_TABLE[channelGroup];

  // ⛔ Finding 1(2026-08-04 회귀) — 채널 가드만으로는 부족하다. `CampaignGroup`의
  // 유일한 앱 레벨 불변식은 "같은 셀러"뿐이다(prisma/schema.prisma의 sellerId 주석,
  // `campaignGroupService`의 HETERO_SELLER 검증) — `dealId`는 멤버마다 자유롭게
  // 다를 수 있고, 그러면 `deal.partner`(공급사)도 갈린다. SUPPLIER 가 상대인 의무
  // (우리몰·브랜드몰의 `supplierInvoiceIssuedAt`)를 채널만 같다고 한 행으로 합치면
  // "상대가 다른 두 거래를 한 상대에게 몰아서 발행/추적"하는 사고가 난다 — 바로 위
  // 채널 불일치 가드가 막으려던 것과 같은 종류의 사고를, 이번엔 상대 축에서
  // 재현한다. SELLER 가 상대인 의무는 이 검증이 필요 없다 — 같은 셀러라는 불변식이
  // 이미 상대 동일성을 보장한다.
  //
  // ⛔ 2026-08-04 whole-branch 리뷰 정정 — 이 주석은 한때 "`CampaignRow`가 파트너
  // 사업자등록번호 등 식별자를 노출하지 않고 partnerName 하나만 준다"고 적혀
  // 있었다. 그 전제는 이 브랜치가 `CampaignRow.partnerBusinessNumber`를 추가하며
  // 이미 깨졌다 — 그런데도 이 함수는 여전히 이름만으로 동일성을 판정하고 있어서,
  // **이름이 같지만 사업자등록번호가 다른 두 거래처**(오탐의 실제 사례 — 상호를
  // 똑같이 쓰는 별개 사업자는 실재한다)가 한 행으로 합쳐지면 한쪽 금액 전체가 다른
  // 쪽의 등록번호로 신고되는 사고가 난다. 그래서 지금은 **전 멤버가 사업자등록번호를
  // 갖고 있으면 정규화된 번호로 판정**하고, 한 명이라도 없으면(레거시 데이터 결손)
  // 이름으로 후퇴한다 — 번호가 없는 멤버를 "번호 다름"으로 단정해 불필요하게
  // 캠페인별 행으로 후퇴시키는 것보다, 기존처럼 이름 비교로 판정하는 쪽이 더
  // 관용적이다.
  const supplierObligation = table.supplierInvoiceIssuedAt;
  if (supplierObligation?.counterpart === "SUPPLIER") {
    const allHaveBusinessNumber = sortedMembers.every((m) => !!m.partnerBusinessNumber);
    const partnerIdentityKey = (m: CampaignRow) =>
      allHaveBusinessNumber ? normalizeBusinessNumber(m.partnerBusinessNumber ?? "") : m.partnerName;
    const partnerIdentities = new Set(sortedMembers.map(partnerIdentityKey));
    if (partnerIdentities.size > 1) return { collapsed: false, reason: "SUPPLIER_MISMATCH", campaignLabel };
  }

  for (const field of ["supplierInvoiceIssuedAt", "sellerInvoiceIssuedAt"] as const) {
    const obligation = table[field];
    if (!obligation) continue;
    // 그룹 공유 필드다 — `campaign-row.ts`가 그룹 값을 전 멤버에 동일하게 폴딩하므로
    // 대표 하나만 확인하면 전 멤버를 대표한다.
    if (anchor[field]) continue;
    // 그룹 멤버는 앱 불변식상 셀러가 전원 동일하다(`CampaignGroup.sellerId`) — 개인/
    // 사업자 판정도 대표로 충분하고, 멤버마다 다시 물을 이유가 없다.
    if (obligation.counterpart === "SELLER" && isIndividualSeller(anchor)) continue;

    // 금액은 멤버별 VAT 포함 원금을 먼저 합산한 뒤, 그 합계에 변환을 한 번만 적용한다
    // (파일 상단 주석 참조 — 멤버별로 각각 반올림해 합치면 실제 통합 계산서 금액과
    // 갈릴 수 있다). 결번 사유는 멤버 각자의 원금 계산 기준으로 모은다 — 그룹 총액이
    // 양수로 보여도 그중 한 멤버의 데이터가 없으면 "합쳐진 숫자가 사실 일부만 반영된
    // 것"이라 못 미더우므로, 한 멤버라도 결번이면 행 전체를 선택 불가로 막는다(기존
    // 캠페인 단위 결번 정책과 동일 — 확신 없는 숫자를 확정치처럼 보여주지 않는다).
    let baseAmountSum = 0;
    const identityReasons = new Set<string>();
    const amountReasons = new Set<string>();

    // 물품대금은 **그룹 단위로 먼저 판정**한다 — 멤버별로 각자 수기/공식을 고르면
    // 「일부만 반영된 합계」가 실물 계산서 총액인 것처럼 보이는 그럴듯한 오답이 된다
    // (그룹은 계산서 한 장이라 그 오답이 곧 영구 금액 불일치이거나, 더 나쁘게는 우연히
    // 근사해 오확정이 된다). 수취 대조 엔진의 `buildGroupExpectedReceivables` 가 이미
    // 같은 규칙(부분 합산 금지)을 쓰므로 두 모듈이 같은 답을 내야 한다.
    const groupGoodsCost =
      obligation.amountBasis === "SALES_MINUS_SETTLEMENT"
        ? sumGroupManualGoodsCost(sortedMembers)
        : null;

    if (groupGoodsCost !== null) {
      if (groupGoodsCost === 0) {
        amountReasons.add(GOODS_COST_CONSOLIDATED_REASON);
      } else if (groupGoodsCost < 0) {
        amountReasons.add("수기 물품대금이 0 이하");
      }
      baseAmountSum = Math.max(groupGoodsCost, 0);
      for (const member of sortedMembers) {
        counterpartBlockingReasons(obligation.counterpart, member).forEach((r) => identityReasons.add(r));
      }
    } else {
      for (const member of sortedMembers) {
        // ⚠️ 물품대금 기준인데 여기 왔다는 것은 **멤버 하나 이상이 수기값 미입력**이라는
        // 뜻이다 — 그러면 그룹 전체가 공식으로 간다. 입력된 멤버의 수기값만 섞어 더하면
        // 그게 바로 위에서 막으려던 부분 합산이므로, 그 필드를 벗겨 공식을 강제한다.
        const input =
          obligation.amountBasis === "SALES_MINUS_SETTLEMENT"
            ? { ...member, settlementGoodsCost: null }
            : member;
        const { baseAmount, blockingReasons } = computeBaseAmountForBasis(obligation.amountBasis, input);
        baseAmountSum += baseAmount;
        blockingReasons.forEach((r) => amountReasons.add(r));
        counterpartBlockingReasons(obligation.counterpart, member).forEach((r) => identityReasons.add(r));
      }
    }
    const blockingReasons = [...identityReasons, ...amountReasons];

    rows.push({
      campaignId: anchor.id,
      groupId,
      campaignIds: sortedMembers.map((m) => m.id),
      sourceField: field,
      direction: obligation.direction,
      counterpart: obligation.counterpart,
      counterpartName: counterpartName(obligation.counterpart, anchor),
      campaignLabel: groupCampaignLabel(sortedMembers),
      amount: toSupplyAndTax(baseAmountSum),
      xlsxEligible: obligation.direction === "ISSUE",
      section: resolveBoardSection(sortedMembers.map((m) => m.status)),
      // ⚠️ 부가 항목은 **그룹 폴딩 대상이 아니다**(멤버 각자의 비용 — `campaign-row.ts`
      //    의 `settlementItems` 주석). 그래서 멤버 전원의 목록을 이어 붙여 센다.
      settlementItemEffect: summarizeItemEffect(
        obligation.amountBasis,
        sortedMembers.map((m) => m.settlementItems),
      ),
      blockingReasons,
      selectable: blockingReasons.length === 0,
    });
  }

  return { collapsed: true };
}

/**
 * 캠페인 배열을 그대로 세금계산서 의무 행으로 변환한다 — 월 필터가 없다.
 *
 * `buildTaxInvoiceWorkBoard`(아래)가 캠페인 상태 축(월 무관) 집합에 이 함수를 쓰는
 * 게 원래 유일한 용도였으나, `tax-invoice-builder.buildTaxInvoiceRows`(XLSX 생성)도
 * 이제 이 함수의 출력을 그대로 소비한다(2026-08-04, 빌더 정정) — 호출부가 이미 특정
 * campaignIds 로 캠페인을 골라 왔으므로 월 필터를 다시 적용하면 사용자가 고른
 * 행이 조용히 사라질 수 있다. 그래서 월 필터는 애초에 이 함수에 두지 않고,
 * 실제 행 변환 로직은 여기 한 곳에 둔다 — 빌더가 이 로직을 다시 유도하면 화면과
 * 파일이 갈리는 이 파일이 여섯 번 정정된 그 사고가 재발한다.
 */
/**
 * 이 캠페인의 채널에 **대응하는 의무가 없는** 부가 항목을 찾는다 — 조용히 사라지는 것을
 * 막는 안전망(설계 §9-8).
 *
 * 예: 「매출 발행 × 브랜드」 항목을 우리몰·셀러몰 캠페인에 등록하면, 그 채널의 공급사
 * 방향은 **수취**라 대응하는 발행 의무가 없다. 설계 §3-3 이 *"공급사 방향이 수취인
 * 채널에서 매출 부대비용이 생기는 경우"* 를 **미확정**으로 남겨 둔 바로 그 조합이다 —
 * 지어내서 아무 의무에나 붙이지 않고, 경고로 오너에게 넘긴다.
 *
 * ⛔ 항목의 `note`(비고)는 경고 문구에 넣지 않는다 — 오너가 자유롭게 쓰는 칸이라 셀러·
 * 캠페인 실명이 들어올 수 있다(P0, 레포 public). 개수와 캠페인 라벨까지만 말한다.
 */
function findOrphanItems(campaign: CampaignRow): SettlementItemInput[] {
  const items = campaign.settlementItems;
  if (!items || items.length === 0) return [];

  const table = TAX_INVOICE_OBLIGATION_TABLE[resolveTaxFilingChannelGroup(campaign.salesChannel)];
  const coveredAxes = (["supplierInvoiceIssuedAt", "sellerInvoiceIssuedAt"] as const)
    .map((field) => table[field])
    .filter((obligation): obligation is NonNullable<ChannelObligation> => obligation != null)
    // ⛔ **표에 의무가 있다고 계산서가 존재하는 것은 아니다**(교차 검증 적발 2026-08-08).
    //    개인 셀러는 원천징수 대상이라 셀러 상대 계산서를 **주고받지 않으며**,
    //    `emitCampaignRows`·`emitGroupRows` 도 같은 규칙으로 그 행을 만들지 않는다.
    //    그러면 「매입 수취 × 셀러」 항목은 실릴 계산서가 영영 없는데 경고도 안 떠서
    //    **이 안전망이 막으려던 바로 그 형태로 조용히 사라진다**(초판의 구멍).
    //    개인 셀러 지급의 올바른 인코딩은 「계산서 없음 × 셀러」다(설계 §2-2 조합표) —
    //    즉 이 경우는 오너의 입력 오류이고, 그래서 더더욱 표면화해야 한다.
    .filter(
      (obligation) => !(obligation.counterpart === "SELLER" && isIndividualSeller(campaign)),
    )
    .map((obligation) => AMOUNT_BASIS_ITEM_RULE[obligation.amountBasis].axis);

  // ⚠️ **이미 발행·수취 완료로 찍힌 의무는 「커버됨」으로 본다** — 행이 안 나오는 것은
  //    같지만 뜻이 다르다. 그 계산서는 **실재하고**, 다만 이 항목이 거기 실렸는지는
  //    보드가 아니라 대조 엔진이 물을 질문이다(`AMOUNT_MISMATCH`). 여기서 경고하면
  //    정산이 끝난 캠페인마다 매달 같은 경고가 떠서 신호가 습관화로 죽는다.

  return items.filter((item) => {
    // 계산서가 없는 항목은 애초에 어떤 의무에도 붙지 않는다 — 고아가 아니라 정상이다.
    if (item.invoiceMode === "NO_INVOICE" || item.counterparty === "INTERNAL") return false;
    return !coveredAxes.some(
      (axis) => axis.invoiceMode === item.invoiceMode && axis.counterparty === item.counterparty,
    );
  });
}

export function buildTaxInvoiceObligationRows(campaigns: CampaignRow[]): {
  rows: TaxInvoiceBoardRow[];
  warnings: string[];
} {
  const rows: TaxInvoiceBoardRow[] = [];
  const warnings: string[] = [];

  for (const campaign of campaigns) {
    const orphans = findOrphanItems(campaign);
    if (orphans.length === 0) continue;
    warnings.push(
      `「${campaign.campaignName ?? campaign.dealName}」의 부가 항목 ${orphans.length}건은 ` +
        `이 판매채널에 대응하는 세금계산서 의무가 없어 어느 금액에도 반영되지 않았습니다. ` +
        `계산서 방식·대상을 다시 확인하거나, 이 조합의 처리 방침을 정해 주세요.`,
    );
  }

  // 그룹 소속 캠페인은 groupId 로 모아 두고, 그룹 없는 캠페인은 바로 캠페인 단위로
  // 처리한다 — 그룹 묶음은 전원이 모인 뒤에야 채널 일치 여부를 판정할 수 있어서
  // 별도 패스가 필요하다.
  const byGroup = new Map<string, CampaignRow[]>();
  for (const campaign of campaigns) {
    if (!campaign.groupId) {
      emitCampaignRows(campaign, rows);
      continue;
    }
    const members = byGroup.get(campaign.groupId);
    if (members) {
      members.push(campaign);
    } else {
      byGroup.set(campaign.groupId, [campaign]);
    }
  }

  for (const [groupId, members] of byGroup) {
    const result = emitGroupRows(members, groupId, rows);
    if (!result.collapsed) {
      // ⚠️ raw groupId(cuid)는 오너가 조치할 수 없는 내부 식별자다(작은 수정
      // 사항, 2026-08-04 재검토 지적) — 오너가 알아볼 수 있는 `campaignLabel`
      // (대표 멤버 이름 + 외 N건)을 앞세우고, groupId는 추적용으로만 괄호에 남긴다.
      const message =
        result.reason === "CHANNEL_MISMATCH"
          ? `정산 그룹(${result.campaignLabel}, id: ${groupId}) 멤버끼리 판매채널이 달라 세금계산서 의무를 한 행으로 합치지 못했습니다. ` +
            `캠페인별로 표시합니다. 그룹의 판매채널을 통일하거나 그룹에서 분리해 주세요.`
          : `정산 그룹(${result.campaignLabel}, id: ${groupId}) 멤버끼리 공급사가 달라 세금계산서 발행 의무를 한 행으로 합치지 못했습니다. ` +
            `캠페인별로 표시합니다. 그룹의 공급사를 통일하거나 그룹에서 분리해 주세요.`;
      warnings.push(message);
      for (const member of members) emitCampaignRows(member, rows);
    }
  }

  return { rows, warnings };
}

/**
 * 월 필터 없는 **작업 보드** — 세금계산서 탭 전용 진입점.
 *
 * ⛔ 여기에 월 필터를 다시 넣지 말 것. 3채널 모두 계산서가 지급보다 **먼저** 일어나므로
 * (설계 2026-08-09 §1), 지급월로 자르면 지금 발행·수취해야 할 캠페인이 구조적으로 전부
 * 탈락한다. 그것이 이 함수가 생긴 이유다.
 *
 * `month` 필드는 응답 호환을 위해 남기되 **필터로 쓰지 않는다** — 원천징수 탭이 같은
 * 응답을 공유하므로 그쪽이 어느 월을 보고 있는지는 여전히 실려야 한다.
 */
export function buildTaxInvoiceWorkBoard(campaigns: CampaignRow[], month: string = ""): TaxInvoiceBoard {
  const { rows, warnings } = buildTaxInvoiceObligationRows(campaigns);

  const totalsByDirection = {
    ISSUE: { supplyAmount: 0, taxAmount: 0 },
    RECEIVE: { supplyAmount: 0, taxAmount: 0 },
  };
  for (const row of rows) {
    // 결번은 확정치가 아니라 합계에 넣지 않는다(기존 규칙 유지).
    if (!row.selectable) continue;
    // ⛔ BACKLOG 금액은 「이번에 발행할 총액」이 아니다 — 섞으면 오너가 그 숫자로 대사한다.
    if (row.section !== "IN_PROGRESS") continue;
    totalsByDirection[row.direction].supplyAmount += row.amount.supplyAmount;
    totalsByDirection[row.direction].taxAmount += row.amount.taxAmount;
  }

  return {
    month,
    rows,
    pendingCount: rows.filter((row) => row.section === "IN_PROGRESS").length,
    backlogCount: rows.filter((row) => row.section === "BACKLOG").length,
    blockedCount: rows.filter((row) => !row.selectable).length,
    totalsByDirection,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 카드용 슬롯 뷰 — 정산 상세 「정산 및 회계 일정」이 칸을 파생한다
// ---------------------------------------------------------------------------

/**
 * 정산 카드가 두 칸(공급사 필드 · 셀러 필드)에 무엇을 쓸지 판정표에서 파생한다.
 *
 * ⛔ 카드가 채널 분기를 다시 쓰지 않게 하는 것이 이 함수의 존재 이유다 — 카드는
 * 오랫동안 두 칸을 **양쪽 다 「발행」으로 하드코딩**하고 있었고, 그래서 우리몰
 * (실제로는 둘 다 수취)에서 라벨이 거짓말을 했다.
 *
 * 순수 함수이고 Prisma 에 의존하지 않는다 — 클라이언트 컴포넌트가 그대로 부른다.
 */
export type CampaignInvoiceSlotView = {
  field: "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt";
  counterpart: TaxInvoiceCounterpart;
  direction: TaxInvoiceDirection;
  title: string;
  /** 배지·좁은 열용 축약 라벨("공급사 수취"). `title` 은 "공급사 계산서 수취"라
   *  정산 목록의 열에 넣으면 잘린다. ⛔ 호출부가 한글 매핑을 다시 만들지 않게 하는
   *  것이 이 필드의 존재 이유다 — `COUNTERPART_LABEL` 은 이 모듈 밖으로 나가지 않는다. */
  shortTitle: string;
  directionLabel: string;
  applicable: boolean;
  /** 화면에 그대로 찍는 **표시 문구**. 분기 판정에 쓰지 말 것 — 아래 `inapplicableCause` 가 그 몫이다. */
  inapplicableReason: string | null;
  /**
   * 비적용 **사유 코드**. 적용되는 칸이면 null.
   *
   * ⛔ 호출부가 `inapplicableReason` **한국어 문구**를 비교해 분기하지 않게 하려고 있다 —
   * 문구를 다듬는 순간 그런 분기는 조용히 깨진다(P0 계열 침묵형 회귀). 정산 카드가
   * 개인 셀러 칸을 원천징수 신고 표시로 갈아끼울 때 이 코드를 본다.
   */
  inapplicableCause: "INDIVIDUAL_SELLER" | "NO_OBLIGATION" | null;
};

/** 이 함수가 실제로 읽는 필드만 — 카드 외의 호출부가 `CampaignRow` 전체를 들고 있을
 *  필요가 없다. */
export type CampaignInvoiceSlotInput = Pick<CampaignRow, "salesChannel"> &
  Partial<Pick<CampaignRow, "sellerTaxType" | "sellerCompanyBusinessNumber">>;

const COUNTERPART_LABEL: Record<TaxInvoiceCounterpart, string> = {
  SUPPLIER: "공급사",
  SELLER: "셀러",
};

const DIRECTION_LABEL: Record<TaxInvoiceDirection, string> = {
  ISSUE: "발행",
  RECEIVE: "수취",
};

export function resolveCampaignInvoiceSlots(
  campaign: CampaignInvoiceSlotInput,
): CampaignInvoiceSlotView[] {
  const group = resolveTaxFilingChannelGroup(campaign.salesChannel);
  const table = TAX_INVOICE_OBLIGATION_TABLE[group];
  const individualSeller = isIndividualSeller({
    sellerTaxType: campaign.sellerTaxType ?? null,
    sellerCompanyBusinessNumber: campaign.sellerCompanyBusinessNumber ?? null,
  });

  return (["supplierInvoiceIssuedAt", "sellerInvoiceIssuedAt"] as const).map((field) => {
    const obligation = table[field];

    // 채널에 이 절차 자체가 없다. 2026-08-07 정정 이후 그런 조합은 없지만, 표가 다시
    // 넓어질 때 카드가 조용히 빈 칸을 그리지 않도록 분기를 남긴다.
    if (!obligation) {
      const counterpart: TaxInvoiceCounterpart =
        field === "supplierInvoiceIssuedAt" ? "SUPPLIER" : "SELLER";
      return {
        field,
        counterpart,
        direction: "RECEIVE" as const,
        title: `${COUNTERPART_LABEL[counterpart]} 계산서`,
        shortTitle: COUNTERPART_LABEL[counterpart],
        directionLabel: "",
        applicable: false,
        inapplicableReason: "이 채널에는 해당 절차가 없습니다",
        inapplicableCause: "NO_OBLIGATION",
      };
    }

    // 개인 셀러는 계산서를 주고받지 않는다 — 수수료에서 3.3% 를 원천징수해 지급한다.
    // 보드(`emitCampaignRows`)가 `counterpart === "SELLER" && isIndividualSeller` 행을
    // 만들지 않는 것과 **같은 규칙**이다. ⛔ 캠페인 단위로 판정하지 말 것 — 공급사가
    // 상대인 의무는 셀러의 세무 유형과 무관하다(2026-08-04 실사고).
    const applicable = !(obligation.counterpart === "SELLER" && individualSeller);

    return {
      field,
      counterpart: obligation.counterpart,
      direction: obligation.direction,
      title: `${COUNTERPART_LABEL[obligation.counterpart]} 계산서 ${DIRECTION_LABEL[obligation.direction]}`,
      shortTitle: `${COUNTERPART_LABEL[obligation.counterpart]} ${DIRECTION_LABEL[obligation.direction]}`,
      directionLabel: DIRECTION_LABEL[obligation.direction],
      applicable,
      inapplicableReason: applicable ? null : "개인 셀러(원천징수 대상)",
      inapplicableCause: applicable ? null : "INDIVIDUAL_SELLER",
    };
  });
}

/**
 * 대금 결제 일정의 **한 칸** — 어느 방향·어느 상대의 돈이고, 그 기록이 어느 필드에
 * 사는지까지 이 슬롯이 소유한다. 회계 일정의 `CampaignInvoiceSlotView` 와 같은 부류다.
 */
export type CampaignMoneySlot = {
  /** DEPOSIT = 돈이 들어온다(입금) · PAYOUT = 돈이 나간다(지급). */
  kind: "DEPOSIT" | "PAYOUT";
  /**
   * `kind` 의 한글 동사. ⛔ 소비처가 `kind === "DEPOSIT" ? "입금" : "지급"` 을 다시 쓰지
   * 말 것 — 2단계에서 소비 표면이 9곳으로 늘면서 그 삼항이 아홉 벌이 된다(이 레포가
   * 반복해서 겪은 「같은 판정의 두 번째 인코딩」의 가장 값싼 형태다).
   */
  verb: "입금" | "지급";
  /** 거래 상대. null 은 상대가 아니라 몰 정산금(현재 판정표에서는 나오지 않는 조합). */
  counterpart: TaxInvoiceCounterpart | null;
  /** 칸 제목 괄호에 들어가는 상대 라벨("공급사"/"셀러"/"몰 정산금"). */
  counterpartLabel: string;
  /**
   * 슬롯의 **안정 식별자**. 구글 캘린더 장부(`calendarEventIds`)의 이벤트 kind 키가
   * 이 값이므로 ⛔ **문자열을 바꾸지 말 것** — 바꾸는 순간 기존 장부가 가리키던
   * 이벤트가 전부 고아가 된다(장부에서만 사라지고 구글에는 남는다). `deposit`·
   * `payout` 두 값은 2026-08-25 이전 장부가 이미 쓰고 있던 키를 그대로 승계한 것이다.
   */
  key: "deposit" | "payout" | "supplierPayout";
  /** 예정일이 사는 필드. */
  expectedField: "expectedDepositDate" | "expectedPayoutDate" | "expectedSupplierPayoutDate";
  /** 완료일이 사는 필드. */
  completedAtField: "depositReceivedAt" | "payoutCompletedAt" | "supplierPayoutCompletedAt";
  /** 완료 플래그가 사는 필드 — `resolveSettlementCompletionFlags` 가 이 축으로 완료를 판정한다. */
  flagField: "isDepositReceived" | "isPayoutCompleted" | "isSupplierPayoutCompleted";
  /**
   * 이 칸에 오갈 **금액의 기준** — 의무표에서 그대로 온다(방향과 같은 출처).
   *
   * 계산서와 이체는 같은 거래의 같은 숫자다("계산서는 항상 지급보다 먼저", 2026-08-09
   * 설계). 그래서 대금 칸 금액은 전용 컬럼이 아니라 이 기준에서 파생한다 —
   * `resolveMoneySlotDisplayAmount`. ⛔ 소비처가 채널·상대로 금액을 다시 유도하지 말 것.
   */
  amountBasis: AmountBasis;
};

/**
 * 채널별 대금 결제 **슬롯**을 판정표에서 파생한다(2026-08-25, 종전 `resolveCampaignMoneyFlow`
 * 를 대체 — 자사몰의 "두 상대 지급을 한 칸에 뭉개기"와 실효 없는 몰 정산금 입금 칸을 걷어냈다).
 *
 * 규칙 하나로 3채널이 전부 설명된다 — 우리가 청구서를 **발행**하면(ISSUE) 돈이
 * 들어오고(입금), 상대가 청구하면(RECEIVE) 돈이 나간다(지급).
 *
 * - 브랜드몰: 입금(공급사) + 지급(셀러) · 셀러몰: 입금(셀러) + 지급(공급사)
 * - **자사몰: 지급(공급사) + 지급(셀러) — 입금 칸이 없다.** 몰 정산금은 캠페인 기간 동안
 *   일별로 정산 입금되므로 단일 입금 예정일이 실효가 없다(오너 확정 2026-08-25). 과거
 *   입금 기록이 있는 행은 카드가 읽기 전용으로 남긴다(레거시 값을 숨기지 않는다 —
 *   `WithholdingSlotBox` 선례).
 *
 * **필드 매핑 규약:** 지급 레그가 하나뿐인 채널은 상대가 누구든 기존 payout 3종을 쓴다
 * (셀러몰의 공급사 지급이 이미 그 필드에 실데이터로 쌓여 있다 — 옮기지 않는다). 지급
 * 레그가 둘인 자사몰만 공급사 레그가 전용 supplierPayout 3종을 쓰고, 셀러 레그가 기존
 * payout 3종을 잇는다(자사몰 정산의 본류 — 명세서·원천징수가 셀러 지급 기준 — 가 기존
 * 필드에 남아야 소비처가 안 갈라진다).
 *
 * ⛔ **채널→상대 표를 새로 만들지 말 것.** 판정표를 훑으면 방향표를 고치는 순간 슬롯이
 * 자동으로 따라온다(2026-08-07 셀러몰 정정 같은 일이 또 있어도 갈라지지 않는다).
 * ⚠️ **개인 셀러 가드를 여기 태우지 말 것** — 개인 셀러는 *계산서*가 없을 뿐 *지급*은
 * 받는다(원천징수 후 차인지급). `resolveCampaignInvoiceSlots` 의 분기를 복사하면 개인
 * 셀러 캠페인의 지급 칸이 사라진다. 그래서 이 함수는 인자가 채널 하나뿐이다.
 * ⚠️ `money-direction.ts` 와 혼동 금지 — 그쪽은 방향의 **색**이고 여기는 **상대**다.
 */
export function resolveCampaignMoneySlots(salesChannel: string): CampaignMoneySlot[] {
  const table = TAX_INVOICE_OBLIGATION_TABLE[resolveTaxFilingChannelGroup(salesChannel)];
  const obligations = (["supplierInvoiceIssuedAt", "sellerInvoiceIssuedAt"] as const)
    .map((field) => table[field])
    .filter((o): o is NonNullable<ChannelObligation> => o != null);

  const depositObligation = obligations.find((o) => o.direction === "ISSUE") ?? null;
  const payoutObligations = obligations.filter((o) => o.direction === "RECEIVE");
  const hasTwoPayoutLegs = payoutObligations.length > 1;

  const slots: CampaignMoneySlot[] = [];
  if (depositObligation) {
    const { counterpart } = depositObligation;
    slots.push({
      kind: "DEPOSIT",
      verb: "입금",
      counterpart,
      counterpartLabel: COUNTERPART_LABEL[counterpart],
      key: "deposit",
      expectedField: "expectedDepositDate",
      completedAtField: "depositReceivedAt",
      flagField: "isDepositReceived",
      amountBasis: depositObligation.amountBasis,
    });
  }
  for (const { counterpart, amountBasis } of payoutObligations) {
    // 두 레그일 때만 공급사가 전용 필드로 간다 — 단일 레그 채널(셀러몰)의 공급사 지급은
    // 기존 payout 필드의 실데이터를 잇는다(위 필드 매핑 규약).
    const usesSupplierFields = hasTwoPayoutLegs && counterpart === "SUPPLIER";
    slots.push({
      kind: "PAYOUT",
      verb: "지급",
      counterpart,
      counterpartLabel: COUNTERPART_LABEL[counterpart],
      key: usesSupplierFields ? "supplierPayout" : "payout",
      expectedField: usesSupplierFields ? "expectedSupplierPayoutDate" : "expectedPayoutDate",
      completedAtField: usesSupplierFields ? "supplierPayoutCompletedAt" : "payoutCompletedAt",
      flagField: usesSupplierFields ? "isSupplierPayoutCompleted" : "isPayoutCompleted",
      amountBasis,
    });
  }
  return slots;
}

/**
 * 대금 칸이 **표시**할 금액의 근거 필드. `CampaignRow` 전체가 아니라 이 셋뿐이다 —
 * 캘린더는 월 단위 대량 조회라 select 를 넓히는 대가가 크다.
 */
export type MoneySlotAmountInput = {
  actualSales?: number | null;
  sellerExpense?: number | null;
  settlementSales?: number | null;
  /**
   * 셀러에게 **실제로 나간** 금액(원천징수·조정 반영). 있으면 예정액보다 우선한다 —
   * 대금 칸은 이체 일정이라 지급이 끝난 뒤엔 실제 금액이 답이다(오너 확정 2026-08-26).
   *
   * ⛔ **세금계산서 원금(`computeBaseAmountForBasis`)에는 넣지 말 것** — 계산서는 약정
   * 금액(판매대행비)으로 발행되고 이 값은 이체 결과다. 두 축이 갈리는 유일한 지점이라
   * 합치면 홈택스에 옮기는 숫자가 틀어진다.
   */
  actualPayoutAmount?: number | null;
  /**
   * 수기 물품대금 = **그 캠페인 앞으로 온 매입 계산서의 총액**(VAT 포함, 3-상태).
   * 공급사 지급 칸의 유일한 근거다 — 판정은 `goods-cost.ts` 가 소유한다.
   *
   * ⛔ **공식(`actualSales − settlementSales`)으로 대체하지 말 것**(오너 승인 2026-08-27,
   * T-057). 그 공식은 2026-08-06 실물 매입계산서 원 단위 대조에서 **기각됐다** —
   * 정확히 맞은 표본이 소수였고 나머지는 양쪽 부호로 어긋났으며, 근본 원인이
   * *「`totalMarginRate` 는 공급률의 거울이 아니라 운영 레버」* 라 구조적으로 재현이
   * 안 된다(`expected-receivables.ts` §왜 공식을 못 믿나). 이 칸은 **실제로 나갈 이체액**
   * 이라 추정이 들어가면 오너가 그 숫자로 공급사에 송금한다.
   */
  settlementGoodsCost?: number | null;
};

/**
 * 금액 기준 → 대금 칸에 표시할 금액. `Record` 라 **기준이 늘면 컴파일이 막는다**.
 *
 * ⚠️ `computeBaseAmountForBasis`(세무 보드)와 **일부러 다르다** — 저쪽은 계산서 **총액**
 * 이라 부가 항목을 가산하고 수기 물품대금을 우선하며, **약정 금액**(판매대행비)을 쓴다.
 * 이쪽은 이체 일정이라 셀러 지급에 **실지급액이 우선**한다. 대금 칸은 "이 건으로 대략 얼마가
 * 오가나"를 보여주는 **일정 표면**이라 원금만 쓴다(부가 항목까지 실으면 캘린더 쿼리가
 * 무거워지고, 정확한 계산서 총액은 세무 보드·정산 카드가 이미 담당한다).
 *
 * ⛔ **뺄셈 기준에서 `?? 0` 을 쓰지 말 것** — 빼는 값이 null 인데 0 으로 대체하면 결과가
 * 매출 전액이 되어 **버젓한 숫자로 보인다**(`computeRawBaseAmountForBasis` 가 같은 함정을
 * 두 번 밟았다). 모르는 것은 모르는 채로 둔다.
 */
const MONEY_SLOT_DISPLAY_AMOUNT: Record<
  AmountBasis,
  (campaign: MoneySlotAmountInput) => number | null
> = {
  // 실지급액 우선 — `??` 라 **0 은 폴백하지 않는다**(「확인된 0원」과 「미입력」은 다르다).
  SELLER_COMMISSION: (c) => c.actualPayoutAmount ?? c.sellerExpense ?? null,
  SETTLEMENT_SALES: (c) => c.settlementSales ?? null,
  SALES_MINUS_COMMISSION: (c) =>
    c.actualSales == null || c.sellerExpense == null ? null : c.actualSales - c.sellerExpense,
  // 공급사 물품대금 — **수기 입력값만** 읽는다(오너 승인 2026-08-27, T-057).
  //
  // ⛔ 종전 `() => null`(항상 「미정」)은 **SUPERSEDED**다. 그 판정의 근거는 "계산서 한 장이
  //    여러 캠페인·여러 셀러를 묶어 남의 금액이 이 칸에 뜬다" 였는데, 그 묶임은 수기값의
  //    **3-상태**가 이미 닫는다: 총액은 주 캠페인에 넣고 합산된 쪽에는 `0` 을 넣는다
  //    (`goods-cost.ts` · `expected-receivables.ts` §`0` = 「다른 캠페인의 계산서에 합산됨」).
  //    세무 보드가 쓰던 그 규약을 이 칸이 그대로 물려받으므로 오너가 배울 규칙이 없다.
  //
  // ⛔ **공식 폴백을 켜지 말 것** — 그래서 `resolveGoodsCost` 에 뺄셈 피연산자
  //    (`actualSales`·`settlementSales`)를 **일부러 넘기지 않는다.** 넘기면 미입력 캠페인이
  //    추정값을 실제 이체액처럼 표시하는데, 그 공식은 2026-08-06 실물 대조에서 기각됐다
  //    (`MoneySlotAmountInput.settlementGoodsCost` 주석). 모르는 것은 모르는 채로 둔다.
  //
  // ⚠️ `0` 을 `null` 로 접지 말 것 — 「합산 이관(이 캠페인에서 나갈 돈이 없다)」과
  //    「미입력(모른다)」은 다른 사실이고, 게이트가 그 둘에 다른 문구를 말해야 한다
  //    (`MONEY_SLOT_AMOUNT_BLOCK`).
  SALES_MINUS_SETTLEMENT: (c) => {
    const goods = resolveGoodsCost({ manualGoodsCost: c.settlementGoodsCost });
    if (goods.kind === "MANUAL") return goods.amount;
    if (goods.kind === "CONSOLIDATED") return 0;
    return null;
  },
};

/**
 * 대금 칸이 **화면에 적을 것**. 금액 채널(`resolveMoneySlotDisplayAmount`)과 일부러 나눠 둔다 —
 * 산술(합계·그룹 접기)은 숫자가 필요하지만, 표시에는 **숫자가 아닌 상태**가 하나 있다.
 *
 * - `AMOUNT` — 그 금액을 적는다.
 * - `STATE`  — 금액이 아니라 상태다. 합산 이관이 유일한 경우이고, `₩0` 으로 적으면
 *   「확인된 0원」으로 읽혀 오너가 입력 실수를 의심한다(재무 카드가 먼저 세운 규약).
 * - `UNKNOWN` — 근거가 없다(「미정」). 표면마다 처분이 다르므로(데스크톱 팝오버는 줄을
 *   감추고 모바일은 「금액 미정」으로 적는다) 문자열이 아니라 **판정**을 돌려준다.
 *
 * ⚠️ **그룹 합계에는 쓰지 않는다** — 합산 이관은 캠페인 단위 마커라 접힌 값에는 대응이
 * 없다(전원 합산 이관인 조합의 합계 0 은 「이 조합에서 나갈 물품대금 없음」이 맞다).
 */
export type MoneySlotAmountDisplay =
  | { kind: "AMOUNT"; amount: number }
  | { kind: "STATE"; text: string }
  | { kind: "UNKNOWN" };

export function resolveMoneySlotAmountDisplay(
  slot: CampaignMoneySlot,
  campaign: MoneySlotAmountInput,
): MoneySlotAmountDisplay {
  if (
    slot.amountBasis === "SALES_MINUS_SETTLEMENT" &&
    resolveGoodsCost({ manualGoodsCost: campaign.settlementGoodsCost }).kind === "CONSOLIDATED"
  ) {
    return { kind: "STATE", text: GOODS_COST_CONSOLIDATED_LABEL };
  }
  const amount = resolveMoneySlotDisplayAmount(slot, campaign);
  return amount == null ? { kind: "UNKNOWN" } : { kind: "AMOUNT", amount };
}

/**
 * 조합(그룹)의 대금 칸을 만들 때 멤버 금액을 **어떻게 접는가**. 기준마다 다르다.
 *
 * - `SKIP_UNKNOWN` — 아는 멤버만 더한다. 금액이 멤버마다 독립인 기준(셀러 수수료·영업수익
 *   ·매출−수수료)은 한 멤버를 몰라도 나머지 합이 그 자체로 사실이다.
 * - `ALL_OR_NOTHING` — 한 멤버라도 모르면 **그룹 전체가 모름**이다. 물품대금은 그룹이
 *   **계산서 한 장**이라(`sumGroupManualGoodsCost` 의 판단과 같은 근거) 입력된 멤버만
 *   더하면 「일부만 반영된 합계」가 실물 총액인 것처럼 보인다. 그 오답은 곧 영구 금액
 *   불일치이거나 — 더 나쁘게는 — 우연히 근사해 오확정이 된다.
 *
 * ⚠️ 합산 이관 멤버(`0`)는 **모름이 아니다** — 위 표시 규칙이 `0` 을 돌려주므로 이
 * 판정에서 자연히 통과한다(총액 멤버 1 + 0 멤버 N = 실물 1장 금액).
 */
export type MoneySlotGroupFold = "SKIP_UNKNOWN" | "ALL_OR_NOTHING";

const MONEY_SLOT_GROUP_FOLD: Record<AmountBasis, MoneySlotGroupFold> = {
  SELLER_COMMISSION: "SKIP_UNKNOWN",
  SETTLEMENT_SALES: "SKIP_UNKNOWN",
  SALES_MINUS_COMMISSION: "SKIP_UNKNOWN",
  SALES_MINUS_SETTLEMENT: "ALL_OR_NOTHING",
};

/** 위 표의 조회기 — ⛔ 소비처가 기준별 접기 규칙을 다시 삼항으로 쓰지 말 것. */
export function resolveMoneySlotGroupFold(slot: CampaignMoneySlot): MoneySlotGroupFold {
  return MONEY_SLOT_GROUP_FOLD[slot.amountBasis];
}

/**
 * 금액이 미확정일 때 **운영자가 채워야 할 컬럼**. 위 근거식 바로 옆에 두는 것이 요점이다.
 *
 * ⛔ 소비처가 「이 칸은 어느 컬럼이더라」를 다시 삼항으로 쓰지 말 것. 종전 `write-executor`
 * 의 하드 게이트가 채널과 무관하게 `입금액(settlementSales)` 으로 문구를 박고 있어서,
 * 셀러몰 운영자에게 **근거가 아닌 컬럼**을 채우라고 안내했다 — 그 컬럼을 아무리 채워도
 * 게이트는 계속 닫힌다(#479). 근거식을 바꾸면 이 표도 함께 바뀌어야 하므로 짝으로 둔다.
 *
 * `null` = **채워서 열 수 있는 컬럼이 없다**(안내할 대상이 존재하지 않는다). 「입력하세요」로
 * 안내하면 영영 닫히는 칸 앞에서 운영자가 컬럼만 뒤지게 된다.
 */
const MONEY_SLOT_AMOUNT_BLOCK: Record<
  AmountBasis,
  (campaign: MoneySlotAmountInput) => MoneySlotAmountBlock
> = {
  SELLER_COMMISSION: () => ({
    kind: "FILLABLE",
    needs: "실지급액(actualPayoutAmount) 또는 판매대행비(sellerExpense)",
  }),
  SETTLEMENT_SALES: () => ({ kind: "FILLABLE", needs: "영업수익(settlementSales)" }),
  SALES_MINUS_COMMISSION: () => ({
    kind: "FILLABLE",
    needs: "총거래액(actualSales)과 판매대행비(sellerExpense)",
  }),
  // 물품대금은 이제 **채워서 열 수 있다**(오너 승인 2026-08-27, T-057) — 입력 칸은
  // 캠페인 사이드패널 재무 카드의 「물품대금 (계산서 대조)」다.
  // ⛔ 종전 `null`(= 안내할 컬럼이 없다)은 **SUPERSEDED**. 다만 **합산 이관(`0`)은 그대로
  //    「채울 것이 없다」**로 남는다 — 그 캠페인 몫은 다른 캠페인의 계산서에 실려 있어
  //    여기서 확정할 실체가 없고, 「입력하세요」로 안내하면 오너가 이미 올바르게 넣은 `0`
  //    을 지우고 남의 금액을 옮겨 적게 된다.
  SALES_MINUS_SETTLEMENT: (campaign) =>
    resolveGoodsCost({ manualGoodsCost: campaign.settlementGoodsCost }).kind === "CONSOLIDATED"
      ? { kind: "NOT_APPLICABLE", reason: GOODS_COST_CONSOLIDATED_REASON }
      : { kind: "FILLABLE", needs: "수기 물품대금(settlementGoodsCost)" },
};

/**
 * 대금 칸이 금액 미확정으로 막혔을 때 게이트가 말할 것.
 *
 * - `FILLABLE` — 그 컬럼을 채우면 열린다. 소비처는 「입력 후 다시 시도」로 안내한다.
 * - `NOT_APPLICABLE` — 채울 대상이 없다. 「입력하세요」로 안내하면 **영영 닫히는 칸 앞에서
 *   운영자가 컬럼만 뒤지게** 된다(#479 가 고친 실패 형태).
 */
export type MoneySlotAmountBlock =
  | { kind: "FILLABLE"; needs: string }
  | { kind: "NOT_APPLICABLE"; reason: string };

/**
 * 위 표의 조회기. **캠페인을 인자로 받는 것이 요점이다** — 같은 기준이라도 캠페인의 값에
 * 따라 「채우면 열린다」와 「채울 것이 없다」가 갈린다(물품대금의 합산 이관 `0`).
 *
 * ⛔ 소비처가 「이 칸은 어느 컬럼이더라」를 다시 삼항으로 쓰지 말 것. 종전 `write-executor`
 * 의 하드 게이트가 채널과 무관하게 `입금액(settlementSales)` 으로 문구를 박고 있어서,
 * 셀러몰 운영자에게 **근거가 아닌 컬럼**을 채우라고 안내했다 — 그 컬럼을 아무리 채워도
 * 게이트는 계속 닫힌다(#479). 근거식을 바꾸면 이 표도 함께 바뀌어야 하므로 짝으로 둔다.
 */
export function describeMoneySlotAmountBlock(
  slot: CampaignMoneySlot,
  campaign: MoneySlotAmountInput,
): MoneySlotAmountBlock {
  return MONEY_SLOT_AMOUNT_BLOCK[slot.amountBasis](campaign);
}

/**
 * 대금 칸 하나가 표시할 금액. 근거 값이 없으면 **0 이 아니라 `null`(= 「금액 미정」)** —
 * 금전 대조 화면에서 「₩0」은 확인된 0으로 읽힌다.
 *
 * 도입 배경(T-055, 오너 확정 2026-08-25): 종전에는 슬롯 키를 `settlementDeposit`·
 * `settlementPayout` 두 컬럼에 직접 매핑했는데, 그 컬럼은 프로덕션 108건 중 **0건**으로
 * 쓰기 경로 자체가 없어 전 표면이 「미정」이었다. 게다가 컬럼 2개로는 **채널마다 다른
 * 상대·금액**을 표현할 수 없다(브랜드몰 입금은 영업수익, 셀러몰 입금은 매출−수수료).
 */
export function resolveMoneySlotDisplayAmount(
  slot: CampaignMoneySlot,
  campaign: MoneySlotAmountInput,
): number | null {
  return MONEY_SLOT_DISPLAY_AMOUNT[slot.amountBasis](campaign);
}

/**
 * 대금 칸 하나의 **날짜 근거** — 예정일·완료일·완료 플래그. 날짜 타입은 호출부가 정한다
 * (서버 경로는 `Date`, 페이로드 경로는 ISO 문자열) — 변환은 이 함수의 일이 아니다.
 */
export type MoneySlotDateSource<T extends string | Date = string | Date> = Partial<
  Record<CampaignMoneySlot["expectedField"] | CampaignMoneySlot["completedAtField"], T | null>
> &
  Partial<Record<CampaignMoneySlot["flagField"], boolean>>;

/**
 * 대금 칸이 **일정 표면에 서는 날짜** — 완료됐으면 실제로 오간 날, 아니면 예정일.
 *
 * 오너 지적(2026-07-15): *"20일이 지급예정인데 15일에 지급되었으면 예정일정은 캘린더에서
 * 없어지고 지급일정으로 변경돼야 하는 거 아니야?"* 돈이 실제로 오간 사건은 예정일이 아니라
 * 그날 일어난 것이므로, 완료된 칸을 예정일에 남겨 두면 캘린더가 **일어나지 않은 날의 사건**을
 * 그리게 된다.
 *
 * ⚠️ **이 규칙은 구글 캘린더가 먼저 갖고 있었다** — `syncMoneyEvents` 가 `완료일 ?? 예정일`
 * 로 이벤트를 옮기고 메모에 `(실제 지급 완료)` 를 달아 왔다(#459). 앱 안 표면(데스크톱
 * 캘린더 도트·모바일 일정탭 링·날짜 목록·홈 다가올 일정)만 예정일에 고정돼 있어서 **같은
 * 캠페인이 두 캘린더에서 다른 날에 떴다.** 그 사본을 여기로 모은다.
 *
 * ⛔ **소비처가 `slot.expectedField` 를 직접 읽지 말 것** — 그 순간 이 판정의 두 번째
 * 인코딩이 생기고, 표면마다 하나씩 빠뜨리면서 원래 상태로 되돌아간다(이 레포가 금액
 * 컬럼에서 이미 겪은 형태다). `money-slot-effective-date.contract.test.ts` 가 일정 표면을
 * 소스 스캔으로 막는다.
 *
 * **완료의 정본은 플래그다**(`resolveSettlementCompletionFlags` 와 같은 축). 쓰기 경로
 * (`resolveSettlementSync`)가 완료 취소 시 완료일을 함께 지우므로 둘이 어긋난 행은 생기지
 * 않지만, 판정 기준을 하나로 못 박아 둔다.
 *
 * ⛔ **완료인데 완료일이 비어 있다고 날짜를 `null` 로 만들지 말 것** — 완료일 컬럼이 없던
 * 시절의 행과 그룹 스칼라가 비어 있는 행이 실재한다. 그것들이 캘린더에서 통째로 사라지면
 * 크래시 없는 침묵형 소실이라 아무도 모른다. 예정일에 그대로 남긴다.
 */
export function resolveMoneySlotEffectiveDate<T extends string | Date>(
  slot: CampaignMoneySlot,
  source: MoneySlotDateSource<T>,
): { date: T | null; isActual: boolean } {
  const completed = source[slot.flagField] ? source[slot.completedAtField] ?? null : null;
  if (completed) return { date: completed, isActual: true };
  return { date: source[slot.expectedField] ?? null, isActual: false };
}

/**
 * **여러 채널이 섞인 묶음**의 대금 슬롯 — 멤버 슬롯의 합집합(키 기준 dedup, 입력 순서 유지).
 *
 * 조합 캠페인(`CampaignGroup`)에는 `salesChannel` 컬럼이 **없다** — 채널은 멤버 행이
 * 소유하므로 그룹 표면은 멤버들의 채널을 합쳐야 한다.
 *
 * ⛔ **한 멤버의 채널을 골라 대표로 삼지 말 것.** 자사몰 멤버를 골랐는데 형제가
 * 브랜드몰이면 그룹의 입금 예정일이 어느 슬롯에도 안 걸려 **화면에서 조용히 사라지고**,
 * 반대로 고르면 공급사 지급 레그를 잃는다. 둘 다 크래시가 아니라 오표시라 눈으로만 잡힌다.
 * (2026-08-25 교차검증 — 구글 동기화는 합집합, 모바일 그룹 집계는 `first.salesChannel`
 * 로 **한 판정을 두 규칙으로** 들고 있었다. 이 함수는 그 통일이 본체다.
 * ⚠️ **채널 혼재 그룹은 운영에 없다**(오너 확정 2026-08-25 — 조합은 딜만 여러 개이고
 * 판매채널은 하나다). 그러니 위 실패 모드는 관측된 증상이 아니라 **코드상 가능한**
 * 것이고, 판정을 한 곳에 모으는 값어치는 그 존재 여부와 무관하다.)
 *
 * 균일 채널 묶음에서는 결과가 `resolveCampaignMoneySlots(그 채널)` 과 **정확히 같다** —
 * 즉 자사몰만 모인 그룹에는 입금 슬롯이 없다.
 *
 * ⚠️ 섞인 묶음에서 같은 키의 상대 라벨이 멤버마다 다를 수 있다(브랜드몰 payout=셀러 ·
 * 셀러몰 payout=공급사). 그때는 **먼저 온 채널**의 라벨을 쓴다 — 호출부가 안정된 순서
 * (예: id 오름차순)로 넘겨야 표시가 흔들리지 않는다. 채널 혼재 자체가 이미 세무 보드가
 * 이상 상태로 신고하는 조합이라 여기서 더 판단하지 않는다.
 */
export function resolveMoneySlotsForChannels(salesChannels: string[]): CampaignMoneySlot[] {
  const byKey = new Map<CampaignMoneySlot["key"], CampaignMoneySlot>();
  for (const channel of salesChannels) {
    for (const slot of resolveCampaignMoneySlots(channel)) {
      if (!byKey.has(slot.key)) byKey.set(slot.key, slot);
    }
  }
  return [...byKey.values()];
}

/**
 * 정산 완료(COMPLETED 자동 전환)를 구성하는 완료 플래그 목록 — **슬롯에서 파생**한다.
 * 자사몰 = [공급사 지급, 셀러 지급], 그 외 = [입금, 지급](현행 유지). 오너 확정 2026-08-25.
 *
 * ⛔ 호출부(PATCH 본 라우트·settlement-status 라우트)가 `입금 && 지급` 을 손으로 다시
 * 쓰지 말 것 — 판정이 두 벌이 되는 순간 자사몰 완료가 표면마다 갈라진다.
 */
export function resolveSettlementCompletionFlags(
  salesChannel: string,
): CampaignMoneySlot["flagField"][] {
  return resolveCampaignMoneySlots(salesChannel).map((slot) => slot.flagField);
}
