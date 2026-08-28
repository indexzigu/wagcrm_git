/**
 * 물품대금(공급사 → 우리 상품 매입 대금)의 **3-상태 판정 SSOT** — 순수 함수.
 *
 * 설계 정본: `docs/private/specs/2026-08-07-settlement-money-separation-design.md` §3-1.
 *
 * ## 왜 이 모듈이 생겼나 — 이중 기준이 이미 코드에 있었다
 *
 * 수기 물품대금(`SalesCampaign.settlementGoodsCost`)을 **수취 대조 엔진**
 * (`tax-invoice-mail/expected-receivables.ts`)은 공식보다 우선 적용하는데,
 * **세무 처리 보드**(`tax-filing-board.ts`)는 그 필드를 아예 읽지 않고 항상 공식을
 * 썼다. 프로덕션 전건이 null 이라 결과가 우연히 같았을 뿐, **누군가 입력을 시작하는
 * 순간 두 화면이 같은 의무에 다른 금액을 말한다.** 오너가 그 두 숫자를 손으로
 * 홈택스에 넣는 도메인이라 어느 쪽이 맞는지 모른 채 신고하게 된다.
 *
 * 그래서 판정을 여기 한 곳으로 모으고 두 소비처가 이 함수를 공유한다.
 *
 * ## 3-상태 (셋이 전부 다른 뜻이다 — 하나로 접지 말 것)
 *
 * | 수기값 | 뜻 | 판정 |
 * | --- | --- | --- |
 * | `null` | **미입력** | 공식(`actualSales − settlementSales`)으로 추정한다 |
 * | `0` | **다른 캠페인 계산서에 합산됨** | 받을 계산서가 없다 — 기대 건·금액을 만들지 않는다 |
 * | 양수 | 실물 매입 계산서 총액(관측값) | 그 금액이 정본이다(공식보다 우선) |
 *
 * ⛔ `0` 을 "금액 0원"으로 접으면 유령 기대건이 생기고, `null` 을 0 으로 접으면
 * 존재하지 않는 합산 이관 마커가 박힌다. 두 실수 모두 이 도메인에서 실제로 났다.
 *
 * ⛔ **손익·원가에 쓰지 말 것.** 이 값은 캠페인 경계와 어긋난다(자체 판매분 포함,
 * 한 장이 여러 캠페인을 묶음 — `expected-receivables.ts` 의 `manualGoodsCost` 주석).
 * `expected-receivables-scope.contract.test.ts` 가 소스 스캔으로 막는다.
 *
 * ⛔ 종전 서술 「**세무 대조 전용**」은 **SUPERSEDED**(T-057, 오너 승인 2026-08-27) —
 * 공급사 **지급 칸**(이체 일정)과 그 확정 게이트도 이 값을 읽는다. 그 표면이 묻는 것은
 * "이 건으로 실제로 얼마가 나가나"이고, 계산서가 여러 캠페인을 묶는 문제는 아래 3-상태의
 * `0`(합산 이관)이 이미 닫는다. **금지선은 여전히 「손익」이다** — `operatingProfit`·
 * 「조정 후 손익」에는 들어가지 않는다.
 */

export type GoodsCostResolution =
  /** 수기 관측값이 정본이다. */
  | { kind: "MANUAL"; amount: number }
  /** `0` 마커 — 이 캠페인 몫은 다른 캠페인의 계산서에 합산됐다(받을 계산서 없음). */
  | { kind: "CONSOLIDATED" }
  /** 미입력 — 공식 추정. `amount` 가 null 이면 피연산자가 없어 계산조차 못 한 것이다. */
  | { kind: "FORMULA"; amount: number | null };

export const GOODS_COST_FORMULA_BASIS =
  "물품비 = 총매출 − 영업수익(actualSales − settlementSales) · VAT 포함(채널 무관 확정, 오너 2026-08-04)";

/** ⛔ 「공식」이라고 적지 말 것 — 근거가 뒤바뀐다. */
export const GOODS_COST_MANUAL_BASIS =
  "물품비 = 수기 입력값(정산내역서 최종정산금) · VAT 포함, 공식보다 우선(오너 확정 2026-08-06)";

/** 보드 행이 「합산 이관」으로 막힐 때의 사유 — 행을 지우지 않고 선택 불가로 남긴다. */
export const GOODS_COST_CONSOLIDATED_REASON = "타 캠페인 계산서에 합산됨(수기 물품대금 0)";

/**
 * 합산 이관을 **금액 칸에 적을 때**의 문구. 위 `…_REASON`(게이트가 거부 사유로 말하는
 * 긴 문장)과 짝이지만 자리가 다르다 — 이쪽은 숫자가 들어갈 자리에 들어간다.
 *
 * ⛔ **`₩0` 으로 렌더하지 말 것.** 합산 이관은 **금액이 아니라 상태**다(재무 카드가 먼저
 * 세운 규약). 0 원으로 적으면 「확인된 0원」으로 읽혀 오너가 입력 실수를 의심하게 되고,
 * 같은 사실을 재무 카드는 문구로·대금 칸은 숫자로 말하는 표면 갈림이 된다.
 * ⚠️ 산술(합계·그룹 접기)에서는 여전히 **0 이 맞는 기여값**이다 — 문구는 표시 계층에만.
 */
export const GOODS_COST_CONSOLIDATED_LABEL = "합산 이관 (계산서 없음)";

/**
 * 뺄셈 — 피연산자가 하나라도 없으면 **0 으로 치지 않고** null(모름)을 돌려준다.
 *
 * 이 방향이 중요하다: `settlementSales` 가 null 일 때 0 으로 치면 결과가
 * `actualSales` 전액(물품대금의 몇 배)이 되어 **버젓한 숫자로 보이는 오답**이 된다.
 * 오너가 그 값으로 공급사 계산서를 대사하게 되는, 이 도메인이 실제로 낸 사고다.
 */
function subtract(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || b == null) return null;
  return a - b;
}

/**
 * 물품대금 상태를 판정한다 — 수기값이 있으면 그것이 정본이고, 없을 때만 공식으로 간다.
 *
 * ⛔ 둘을 평균내거나 가까운 쪽을 고르지 말 것. 수기값은 실물 정산내역서에서 옮긴
 * **관측**이고 공식은 **추정**이다 — 관측이 있으면 추정은 쓰지 않는다.
 */
export function resolveGoodsCost(input: {
  manualGoodsCost?: number | null;
  actualSales?: number | null;
  settlementSales?: number | null;
}): GoodsCostResolution {
  const manual = input.manualGoodsCost ?? null;
  if (manual === 0) return { kind: "CONSOLIDATED" };
  if (manual !== null) return { kind: "MANUAL", amount: manual };
  return { kind: "FORMULA", amount: subtract(input.actualSales, input.settlementSales) };
}

/**
 * 정산 그룹의 수기 물품대금 합 — **부분 합산 금지**.
 *
 * 멤버 하나라도 미입력이면 그룹 전체가 공식 폴백으로 간다(null 반환). 입력된 멤버만
 * 더하면 "일부만 반영된 합계"가 실물 계산서 총액인 것처럼 보이는 그럴듯한 오답이
 * 되는데, 그룹은 계산서 **한 장**이라 그 오답이 곧 영구 금액 불일치이거나 — 더
 * 나쁘게는 — 우연히 근사해 오확정이 된다.
 *
 * 전원이 `0`(합산 이관)이면 합도 0 이라 자연히 CONSOLIDATED 로 판정된다.
 */
export function sumGroupManualGoodsCost(
  members: readonly { settlementGoodsCost?: number | null }[],
): number | null {
  let total = 0;
  for (const member of members) {
    const value = member.settlementGoodsCost ?? null;
    if (value === null) return null;
    total += value;
  }
  return total;
}

/**
 * 총액 산술에 쓰는 **기여값** — 3-상태를 숫자 하나로 접는다.
 *
 * ⚠️ 이 접기는 **산술 전용**이다. 표시 계층은 3-상태를 그대로 유지해야 한다
 * (`CONSOLIDATED` 를 `₩0` 으로 렌더하지 말 것 — 위 `GOODS_COST_CONSOLIDATED_LABEL`).
 * 두 소비처(재무 카드의 물품대금 행 · `settlement-brand-total`)가 각자 접으면
 * 같은 3-상태가 두 자리에서 다른 숫자가 된다.
 *
 * 음수 클램프는 공식 폴백에만 걸린다 — 공식(`actualSales − settlementSales`)은
 * 영업수익이 총매출을 넘는 입력에서 음수가 될 수 있고, 그건 "브랜드사가 우리에게
 * 물품대금을 준다"는 뜻이 아니라 입력이 아직 덜 채워졌다는 뜻이다. 관측값(`MANUAL`)은
 * 클램프하지 않는다 — 오너가 실제로 적은 값을 화면이 고쳐 쓰면 안 된다.
 */
export function resolveGoodsCostContribution(resolution: GoodsCostResolution): number {
  if (resolution.kind === "MANUAL") return resolution.amount;
  // 합산 이관이면 이 캠페인 몫으로 낼 물품대금이 없다 — 0 이 맞는 기여값이다.
  if (resolution.kind === "CONSOLIDATED") return 0;
  return Math.max(resolution.amount ?? 0, 0);
}
