/**
 * 채널별 **발행(우리가 끊는)** 세금계산서 기대 건 생성 — 순수 함수.
 *
 * 짝 모듈 `expected-receivables.ts` 는 **수취**만 만든다. 이 파일은 그 반대 방향이다.
 *
 * ## 판정표를 다시 쓰지 않는다
 *
 * 채널×필드 → (방향·상대·금액기준)의 SSOT 는 `tax-filing-board.ts` 의
 * `TAX_INVOICE_OBLIGATION_TABLE` 하나다. 그 파일 자신이 "채널 규칙을 조건문에 흩어놓지
 * 말 것 — 그게 이 파일이 한 번 domain 을 잘못 이해한 원인이었다"고 적어 뒀다. 그래서
 * 여기서는 표를 **순회해서** `direction === "ISSUE"` 인 칸만 뽑는다 — 어느 채널이 발행
 * 의무를 갖는지를 이 파일이 다시 인코딩하지 않는다(그러면 세 번째 인코딩이 된다).
 *
 * 금액도 마찬가지로 `computeBaseAmountForBasis`(같은 파일)를 그대로 쓴다. 보드 화면·홈택스
 * XLSX·이 대조 엔진이 서로 다른 금액을 말하면 오너는 셋 다 안 믿게 된다.
 *
 * ## ⛔ 그룹에서 캠페인별로 후퇴하면 자동 확정 대상이 아니다
 *
 * `CampaignGroup` 은 `supplierInvoiceIssuedAt` 을 **멤버 전원이 공유하는 스칼라 1개**로
 * 갖고 있고(`prisma/schema.prisma`), `PATCH /api/campaigns/[id]` 도 그룹 소속이면 **그룹
 * 행에만** 쓴다. 즉 이 트랙에서 "멤버 한 건만 확정"이라는 것은 물리적으로 불가능하다 —
 * 멤버 하나를 찍으면 그룹 전체가 찍힌다.
 *
 * 그래서 기대 건마다 `writeTarget` 을 싣는다:
 *
 * | 상황 | `writeTarget` |
 * | --- | --- |
 * | 미그룹 캠페인 | `{ kind: "campaign" }` |
 * | 그룹 · 의무 전체를 합산한 1건 | `{ kind: "group" }` |
 * | 그룹 · 상대/채널이 갈려 캠페인별로 후퇴 | **`null` = 자동 확정 불가** |
 *
 * 마지막 행이 이 파일의 핵심 안전장치다. 후퇴한 그룹의 멤버 1건이 계산서와 맞아떨어져도
 * 그것을 근거로 그룹 필드를 찍으면 **나머지 멤버의 의무까지 조용히 완료로 굳는다.** 그건
 * 이 트랙이 반복해 고쳐 온 「부분 일치를 전체 확인으로 둔갑」의 가장 비싼 형태다 — 그래서
 * 후퇴 케이스는 판정은 하되 **쓰기 대상에서 뺀다**(오너의 수동 「완료」 버튼이 그대로 폴백).
 */

import {
  TAX_INVOICE_OBLIGATION_TABLE,
  computeBaseAmountForBasis,
  resolveTaxFilingChannelGroup,
  type TaxInvoiceCounterpart,
} from "../tax-filing-board";
import type { CampaignSettlementFacts, SalesChannelKind } from "./expected-receivables";

/** 발행 의무를 기록하는 필드. 현재 표에서 ISSUE 인 칸은 이 필드뿐이지만 표를 순회해 뽑는다. */
export type IssuanceTrackingField = "supplierInvoiceIssuedAt" | "sellerInvoiceIssuedAt";

/**
 * 자동 확정이 쓰기를 걸 대상. `null` 은 "판정은 했지만 자동으로 찍으면 안 된다"이다 —
 * 위 헤더 주석의 표 참조.
 */
export type IssuanceWriteTarget =
  | { kind: "campaign"; campaignId: string }
  | { kind: "group"; groupId: string }
  | null;

export interface CampaignIssuanceFacts extends CampaignSettlementFacts {
  /** 정산 그룹 소속이면 그 id. 쓰기 대상 판정에 반드시 필요하다. */
  groupId: string | null;
}

export interface ExpectedIssuance {
  /** `${campaignId}:ISSUE:${trackingField}` — 판정 결과를 캠페인으로 되돌리는 키 */
  key: string;
  /** 이 기대 건이 덮는 캠페인 전부(그룹 합산이면 멤버 전원, 아니면 1건) */
  campaignIds: string[];
  /** 대표 캠페인 id(id 오름차순 첫 멤버) — 보드의 anchor 규칙과 같다 */
  campaignId: string;
  campaignLabel: string;
  channel: SalesChannelKind;
  /** 계산서를 **받는 쪽**(= 공급받는자)의 사업자등록번호. null 이면 대조 자체가 불가능하다. */
  counterpartBusinessNumber: string | null;
  counterpartLabel: string;
  counterpart: TaxInvoiceCounterpart;
  /** 기대 금액(**VAT 포함 합계**). 근거가 없으면 null — 0 으로 메우지 않는다. */
  expectedTotalAmount: number | null;
  amountBasis: string;
  /** 금액 근거가 결번이라 대조가 성립하지 않는 사유(보드의 `blockingReasons` 와 같은 값) */
  amountBlockingReasons: string[];
  trackingField: IssuanceTrackingField;
  /** 이미 발행 완료로 기록된 시각(ISO) */
  alreadyMarkedAt: string | null;
  /** 자동 확정 쓰기 대상. `null` 이면 수동 전용이다. */
  writeTarget: IssuanceWriteTarget;
  validWrittenDateFrom: string | null;
  validWrittenDateTo: string | null;
}

const TRACKING_FIELDS: readonly IssuanceTrackingField[] = [
  "supplierInvoiceIssuedAt",
  "sellerInvoiceIssuedAt",
];

/** `id.localeCompare` 오름차순 — 보드(`emitGroupRows`)·수취 엔진과 **같은** 대표 선택 규칙. */
function sortByCampaignId(
  members: readonly CampaignIssuanceFacts[],
): CampaignIssuanceFacts[] {
  return [...members].sort((a, b) => a.campaignId.localeCompare(b.campaignId));
}

function isUniform(values: readonly (string | null)[]): boolean {
  return new Set(values).size <= 1;
}

/** null 이 하나라도 있으면 전체를 모름으로 되돌린다 — 누락을 0 으로 치지 않는다. */
function sum(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return total;
}

/** "YYYY-MM-DD" 는 고정 자릿수라 사전식 비교가 날짜 비교와 일치한다. */
function extremeDateKey(
  values: readonly (string | null | undefined)[],
  pick: (a: string, b: string) => string,
): string | null {
  const known = values.filter((v): v is string => v != null);
  return known.length === 0 ? null : known.reduce(pick);
}

function counterpartOf(
  which: TaxInvoiceCounterpart,
  facts: CampaignIssuanceFacts,
): { businessNumber: string | null; label: string } {
  return which === "SELLER"
    ? { businessNumber: facts.sellerBusinessNumber, label: facts.sellerLabel }
    : { businessNumber: facts.partnerBusinessNumber, label: facts.partnerLabel };
}

function markedAt(facts: CampaignIssuanceFacts, field: IssuanceTrackingField): string | null {
  return field === "supplierInvoiceIssuedAt"
    ? facts.supplierInvoiceIssuedAt
    : facts.sellerInvoiceIssuedAt;
}

/**
 * 캠페인 1건(또는 이미 합산된 가상 캠페인)에서 발행 기대 건을 만든다.
 *
 * `campaignIds`·`writeTarget` 은 호출부가 정한다 — 같은 금액 계산이라도 "그룹 1장을
 * 대표하는가"와 "캠페인 한 건인가"는 쓰기 대상이 달라지기 때문이다.
 */
function buildFor(
  facts: CampaignIssuanceFacts,
  options: {
    campaignIds: string[];
    writeTarget: IssuanceWriteTarget;
    amountBasisSuffix?: string;
  },
): ExpectedIssuance[] {
  const channel = resolveTaxFilingChannelGroup(facts.salesChannel ?? "");
  const obligations = TAX_INVOICE_OBLIGATION_TABLE[channel];

  return TRACKING_FIELDS.flatMap((field) => {
    const obligation = obligations[field];
    if (!obligation || obligation.direction !== "ISSUE") return [];

    const { businessNumber, label } = counterpartOf(obligation.counterpart, facts);
    // ⛔ 필드를 **골라 넘기지 말 것**(설계 §9-6-2). 종전에는 3필드만 뽑아 넘겨
    //    `settlementGoodsCost` 가 흘렀다 — 현행 표에서 ISSUE 기준에 물품대금이 없어
    //    오늘은 무해했지만, 표가 바뀌면 **오류 없이 조용히** 다른 금액을 낸다(이 트랙이
    //    「이름으로 슬롯을 집다」 밟은 함정의 사촌). 2-A 가 `settlementItems` 를 더하면서
    //    같은 실수가 곧바로 실화가 되는 자리라 통째로 넘기는 형태로 고쳤다.
    const { baseAmount, blockingReasons } = computeBaseAmountForBasis(obligation.amountBasis, {
      actualSales: facts.actualSales,
      sellerExpense: facts.sellerExpense,
      settlementSales: facts.settlementSales,
      settlementGoodsCost: facts.manualGoodsCost ?? null,
      settlementItems: facts.settlementItems,
    });

    return [
      {
        key: `${facts.campaignId}:ISSUE:${field}`,
        campaignIds: options.campaignIds,
        campaignId: facts.campaignId,
        campaignLabel: facts.campaignLabel,
        // 채널 어휘는 두 모듈이 같은 3분류를 쓴다(`resolveChannelKind` ↔
        // `resolveTaxFilingChannelGroup`) — 문자열이 같으므로 그대로 싣는다.
        channel: channel as SalesChannelKind,
        counterpartBusinessNumber: businessNumber,
        counterpartLabel: label,
        counterpart: obligation.counterpart,
        // 결번이면 baseAmount 가 0 인데, 그 0 은 "0원"이 아니라 **모름**이다 —
        // 그대로 실으면 0원짜리 계산서와 맞아떨어지는 그럴듯한 오답이 된다.
        expectedTotalAmount: blockingReasons.length > 0 ? null : baseAmount,
        amountBasis: `${obligation.amountBasis}${options.amountBasisSuffix ?? ""}`,
        amountBlockingReasons: blockingReasons,
        trackingField: field,
        alreadyMarkedAt: markedAt(facts, field),
        writeTarget: options.writeTarget,
        validWrittenDateFrom: facts.validWrittenDateFrom ?? null,
        validWrittenDateTo: facts.validWrittenDateTo ?? null,
      },
    ];
  });
}

/**
 * 정산 그룹(또는 미그룹 캠페인 1건)의 발행 기대 건 — 그룹 인지형 진입점.
 *
 * | 상황 | 기대 건 | 쓰기 |
 * | --- | --- | --- |
 * | 미그룹 | 캠페인 1건 | 캠페인 행 |
 * | 그룹 · 채널 동일 · 상대 동일 | 그룹 1건(멤버 합산) | 그룹 행 |
 * | 그룹 · 채널이 갈림 | 캠페인별 | **불가**(수동) |
 * | 그룹 · 상대(공급사)가 갈림 | 캠페인별 | **불가**(수동) |
 *
 * 후퇴 케이스에서 `writeTarget` 이 `null` 인 이유는 헤더 주석 참조 — 그룹 필드는 멤버가
 * 공유하므로 멤버 1건을 근거로 찍으면 나머지 멤버 의무까지 함께 완료로 굳는다.
 *
 * ⚠️ 상대가 `SELLER` 인 의무(셀러몰 발행)는 `CampaignGroup.sellerId` 가 앱 레벨
 * 불변식이라 그룹 안에서 갈릴 수 없다 — 그래서 상대 불일치 가드는 `SUPPLIER` 상대에만
 * 필요하다(수취 엔진과 같은 판단). 단 여기서는 채널이 같으면 상대 종류도 같으므로,
 * 실제로 상대가 갈릴 수 있는 조합은 「브랜드몰 그룹 · 공급사 다중」 하나다.
 */
export function buildGroupExpectedIssuances(
  members: readonly CampaignIssuanceFacts[],
): ExpectedIssuance[] {
  if (members.length === 0) return [];

  const sorted = sortByCampaignId(members);
  const anchor = sorted[0];

  if (sorted.length === 1) {
    return buildFor(anchor, {
      campaignIds: [anchor.campaignId],
      writeTarget: anchor.groupId
        ? // 멤버가 1건뿐인 그룹 — 그룹 행이 SoT 이므로 그쪽에 쓴다(캠페인 행에 쓰면
          //  `campaign-row.ts` 의 폴딩이 그룹 값(null)으로 덮어 화면이 안 바뀐다).
          { kind: "group", groupId: anchor.groupId }
        : { kind: "campaign", campaignId: anchor.campaignId },
    });
  }

  const groupId = anchor.groupId;
  const memberIds = sorted.map((m) => m.campaignId);

  /** 캠페인별 후퇴 — 판정은 하되 자동 확정은 막는다. */
  const fallback = (): ExpectedIssuance[] =>
    sorted.flatMap((member) =>
      buildFor(member, {
        campaignIds: [member.campaignId],
        writeTarget: null,
        amountBasisSuffix: " · ⚠️ 그룹 안에서 채널·상대가 갈려 캠페인별로 후퇴: 자동 확정 대상 아님",
      }),
    );

  // groupId 가 없는 멤버가 섞여 들어왔다면 호출부의 묶기가 잘못된 것이다 — 그룹 필드에
  // 쓸 근거가 없으므로 후퇴한다(조용히 하나를 고르지 않는다).
  if (!groupId || sorted.some((m) => m.groupId !== groupId)) return fallback();

  const channels = new Set(sorted.map((m) => resolveTaxFilingChannelGroup(m.salesChannel ?? "")));
  if (channels.size > 1) return fallback();

  // 브랜드몰 발행의 상대는 공급사다 — `dealId` 에 그룹 불변식이 없어 갈릴 수 있다.
  if (!isUniform(sorted.map((m) => m.partnerBusinessNumber))) return fallback();

  const summed: CampaignIssuanceFacts = {
    ...anchor,
    actualSales: sum(sorted.map((m) => m.actualSales)),
    settlementSales: sum(sorted.map((m) => m.settlementSales)),
    sellerExpense: sum(sorted.map((m) => m.sellerExpense)),
    // ⚠️ anchor 스프레드가 **대표 멤버의 항목만** 실어 오므로 반드시 덮어쓴다.
    //    부가 항목은 미입력이 곧 0건이라 부분 합산 금지가 적용되지 않는다(설계 §9-5).
    settlementItems: sorted.flatMap((m) => m.settlementItems ?? []),
    // 그룹 1장이 어느 멤버의 캠페인 기간을 근거로 끊겼는지는 알 수 없으므로 창을 넓게
    // 잡는다 — 좁히면 정상 건이 「확인 필요」로 떨어진다(수취 엔진과 같은 원칙).
    validWrittenDateFrom: extremeDateKey(
      sorted.map((m) => m.validWrittenDateFrom),
      (a, b) => (a < b ? a : b),
    ),
    validWrittenDateTo: extremeDateKey(
      sorted.map((m) => m.validWrittenDateTo),
      (a, b) => (a > b ? a : b),
    ),
  };

  return buildFor(summed, {
    campaignIds: memberIds,
    writeTarget: { kind: "group", groupId },
    amountBasisSuffix: ` · 정산 그룹 ${sorted.length}건 합산(그룹당 계산서 1장, 오너 확정 2026-08-04)`,
  });
}
