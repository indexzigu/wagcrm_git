/**
 * 수기 물품대금(`manualGoodsCost`)의 **소비처 경계**를 소스 스캔으로 고정한다.
 *
 * ## 왜 필요한가
 *
 * 이 값은 「캠페인의 원가」가 아니라 **그 캠페인 앞으로 온 매입 계산서의 총액**이다.
 * 실측·오너 확인(2026-08-06)으로 두 형태가 확인됐다 — ①우리가 자체 판매한 수량이 그
 * 캠페인 건에 포함돼 계산서가 끊긴다 ②계산서 한 장이 서로 다른 두 그룹·두 셀러를 묶는다
 * (실측·오너 확인 — 좌표는 모드 L 워크시트 부록2, public 레포라 여기 싣지 않는다).
 *
 * 그래서 이 숫자를 손익·원가·리포트로 흘리면 **남의 매출에 붙은 원가가 그 캠페인 손익에
 * 잡힌다.** 세무 대조는 "실물 계산서와 금액이 맞나"만 물으므로 그 오염이 문제가 되지
 * 않지만, 손익은 물음 자체가 다르다.
 *
 * ⚠️ **이 게이트가 막는 것은 「손익 소비」이지 「세무 대조 밖 전부」가 아니다**(T-057 정정,
 * 오너 승인 2026-08-27). 대금 칸(이체 일정)과 그 확정 게이트가 이 값을 읽는 것은 허용된다 —
 * 그 표면의 물음은 "이 건으로 실제로 얼마가 나가나"이고, 계산서가 여러 캠페인을 묶는 문제는
 * 아래 3-상태의 `0`(합산 이관) 마커가 이미 닫는다. 종전 서술이 이 둘을 한 덩어리로 읽어
 * 「세무 대조 전용」으로 좁게 적혀 있었다.
 *
 * ⚠️ 이 테스트는 **금지가 아니라 게이트**다 — 소비처를 넓히는 것은 오너 승인 사안이고,
 * 승인되면 아래 허용 목록에 **사유와 함께** 추가한다. 목록을 지우는 방향으로 "고치지" 말 것.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(process.cwd(), "src");

/**
 * 이 심볼을 참조해도 되는 파일. 값은 **왜 허용되는가**다.
 * 새 항목은 오너 승인 근거를 적는다 — 이유 없이 늘어나면 게이트가 무의미해진다.
 */
const ALLOWED: Record<string, string> = {
  "lib/tax-invoice-mail/expected-receivables.ts": "판정 본체 — 이 값의 정의와 우선순위를 소유",
  "lib/tax-invoice-mail/expected-receivables.test.ts": "위 판정의 계약",
  "lib/tax-invoice-mail/expected-receivables-scope.contract.test.ts": "이 게이트 자신",
  "lib/tax-invoice-mail/campaign-facts.ts": "DB → 판정 계층 배선(세무 대조 경로 전용)",
  // 2026-08-08 이중 기준 해소(오너 승인). 3-상태 판정이 이 엔진과 세무 처리 보드에
  // 따로 있어 같은 의무에 다른 금액을 말할 수 있었다 — 판정을 goods-cost.ts 하나로
  // 모으고 보드가 그것을 소비한다. **여전히 세무 대조 전용**이며 손익·리포트 확산이
  // 아니다(손익 소비 금지는 그대로).
  "lib/goods-cost.ts": "3-상태 판정 SSOT — 이 엔진과 세무 보드가 공유(이중 기준 해소, 오너 승인 2026-08-08)",
  "lib/__tests__/goods-cost.test.ts": "위 SSOT 의 계약",
  "lib/tax-filing-board.ts": "세무 처리 보드 — 위 SSOT 로 물품대금 기준 금액 판정(세무 대조 경로)",
  "lib/__tests__/tax-filing-board.test.ts": "위 보드 판정의 계약",
  // 2026-08-08 2-A(설계 §9-6-2). 발행 기대건 빌더가 `computeBaseAmountForBasis` 에
  // **3필드만 골라 넘기던 것**을 고치면서 이 값이 통과 인자로 들어왔다. 현행 표에서
  // ISSUE 기준에 물품대금이 없어 실제로는 쓰이지 않지만, 골라 넘기는 형태 자체가
  // 「표가 바뀌면 조용히 틀리는」 함정이라 통째로 넘기는 쪽으로 바꿨다.
  // ⚠️ **값 통과만이다** — 이 파일은 물품대금으로 산술하지 않는다(발행 방향 판정은
  // 영업수익·매출−수수료 기준뿐).
  "lib/tax-invoice-mail/expected-issuances.ts":
    "발행 기대건 빌더 — 금액 기준 계산에 값 통과만(세무 대조 경로, 산술 없음, 2026-08-08 2-A)",
  // 2026-08-08. 재무 카드가 「브랜드사와 주고받을 총액」을 그리려면 물품대금 3-상태를
  // 알아야 한다(합산 이관이면 낼 금액이 0, 미입력이면 추정). 종전엔 그 판정을 **손으로
  // 다시 구현**했다가 0 을 null 과 같이 취급해 행과 총액이 갈렸다(교차 검증에서 적발) —
  // 그래서 SSOT 소비를 강제한 것이고, 그 대가로 이 게이트에 등재한다.
  // ⚠️ **표시 전용이다** — 이 값은 `operatingProfit`·「조정 후 손익」 어디에도 들어가지
  // 않는다(손익 소비 금지는 그대로). 그 불변식은 `settlement-items.contract.test.ts` 가 본다.
  "components/crm/campaign-side-panel.tsx": "재무 카드 브랜드사 구간의 물품대금 표시·총액(세무 대조 맥락) — 손익 파생에는 불반영",
  "components/crm/__tests__/campaign-side-panel-settlement-zones.test.tsx":
    "위 표시의 3-상태 계약(0=합산 이관 / null=추정) — 행과 총액이 갈리지 않음을 고정",
  // 2026-08-08 2-B(설계 §9-10). 「기대액이 공식 추정인가」(`amountIsEstimate`)가 수기
  // 입력 여부에서 나오므로, 그 파생이 살아 있는지 확인하려면 픽스처가 이 필드를 넣어
  // **양쪽 상태**(미입력=추정 / 입력=확정)를 만들어야 한다. 여전히 세무 대조 경로다.
  "lib/tax-invoice-mail/receipt-match.contract.test.ts":
    "추정 기대액 판정 계약(2-B) — 수기 입력 유무로 amountIsEstimate 가 갈리는지 확인하는 픽스처. 값 통과만",
  // 2026-08-28 (오너 승인 — 정산 목록 선택 바에 거래처 지급·입금 금액 표시).
  // **새 소비가 아니라 기존 소비의 이사다**: 바로 위 `campaign-side-panel.tsx` 항목이
  // 허용한 「브랜드사에 지급할/에서 받을 총액」계산을 컴포넌트 밖 lib 으로 옮겼다.
  // 옮긴 이유가 이 게이트의 취지와 같다 — 소비처가 둘이 되는 순간(재무 카드 + 선택 바)
  // 화면이 각자 계산하면 같은 캠페인이 두 자리에서 다른 금액을 말한다.
  // ⚠️ **표시·이체 금액 전용이다**(T-057 이 연 「이 건으로 실제로 얼마가 나가나」 경로).
  // `operatingProfit`·「조정 후 손익」 어디에도 들어가지 않는다 — 손익 소비 금지는 그대로다.
  "lib/settlement-brand-total.ts":
    "거래처 정산 총액 판정 SSOT — 재무 카드에 박혀 있던 계산의 이관(소비처: 재무 카드 + 정산 선택 바). 표시·이체 전용, 손익 불반영(오너 승인 2026-08-28)",
  "lib/__tests__/settlement-brand-total.test.ts": "위 SSOT 의 계약 — 3-상태가 접히지 않는지 단언하는 픽스처",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "generated") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * raw DB 필드명(`settlementGoodsCost`)은 UI 배선(입력·표시·PATCH)이 정당하게 들고
 * 다니므로 위 `ALLOWED` 와 별도의 허용 목록을 쓴다. 이 목록의 파일은 값을 **그대로
 * 통과**시킬 뿐 산술에 쓰지 않는다는 것이 계약이다 — 새 참조 파일이 생기면 여기서
 * 걸리고, 추가하려면 "통과인가 연산인가"를 판단해 사유를 적는다.
 */
const RAW_FIELD_ALLOWED: Record<string, string> = {
  "lib/tax-invoice-mail/campaign-facts.ts": "DB → manualGoodsCost 매핑(세무 대조 경로)",
  "lib/campaign-row.ts": "Decimal → number 통과 변환만(산술 없음)",
  "lib/crm-types.ts": "타입 선언만",
  "components/crm/campaign-side-panel.tsx": "오너 입력 칸·읽기 표시(값 통과만)",
  // 3계층 이관 3단계(2026-08-07)로 저장 경로가 둘로 나뉘었다 — 라우트는 zod 스키마에
  // 필드를 선언(파싱)만 하고, 실제 update 스프레드는 서비스가 소유한다. 둘 다 값 통과만이다.
  "app/api/campaigns/[id]/route.ts": "PATCH 입력 스키마 선언(값 통과만 — update 스프레드는 services/campaignService.ts 로 이관)",
  "services/campaignService.ts": "PATCH 트랜잭션 본체의 update 스프레드(값 통과만, 산술 없음 — 3계층 이관 3단계)",
  "app/api/campaigns/[id]/route.test.ts": "위 저장 경로의 계약",
  "lib/campaign-update-plan.ts": "PATCH 변경 감지 diff — settlementGoodsCost 는 값 비교(변경 여부 판정)만, 산술 없음(3계층 이관 2단계)",
  "lib/__tests__/campaign-update-plan.test.ts": "위 diff 함수의 단위 테스트 — 값 비교 픽스처만",
  "components/crm/__tests__/campaign-side-panel-settlement-zones.test.tsx":
    "재무 카드 3구간 렌더 계약의 픽스처 — 물품대금 표시값을 넣을 뿐 산술 없음(2026-08-08)",
  "lib/__tests__/settlement-invoice-amounts.contract.test.ts":
    "부가 항목 금액 반영 계약(2-A) — 「수기 물품대금이 있어도 매입 부대비용을 안 더한다」(§9-3)를 단언하는 픽스처. 값 통과만",

  // ── T-057 (오너 승인 2026-08-27): 대금 칸 배선 ─────────────────────────────
  // 공급사 지급 칸이 **구조적으로 영영 「미정」**이었다(`MONEY_SLOT_DISPLAY_AMOUNT` 가
  // 그 기준에 `() => null` 을 박아 뒀다). 그래서 같은 기준을 쓰는 AI 어시스턴트 확정
  // 게이트도 어떤 값을 넣어도 열리지 않았다(#479 가 문구만 정직하게 고친 임시 봉합).
  //
  // 조사 결론: **캠페인 단위 물품대금을 데이터에서 끌어낼 대안 경로는 없다.** ①공식은
  // 2026-08-06 실물 대조에서 기각(위 §왜 공식을 못 믿나) ②`CampaignDeal.costPrice` 는
  // 그 공식과 같은 수수료율 파생이다(프로덕션 141행 중 137행이 `sellingPrice × (1−feeRate)`
  // 와 원 단위 일치 — 독립 근거가 아니다) ③발주·정산 기록에는 매입 금액 컬럼 자체가 없다.
  // 그래서 **새 추정을 만들지 않고 수기 3-상태를 그대로 쓴다** — 계산서가 여러 캠페인을
  // 묶는 문제는 이 게이트가 지키는 그 3-상태(`0` = 합산 이관)가 이미 닫고 있고, 세무 보드가
  // 쓰던 규약을 대금 칸이 물려받는 것이라 오너가 배울 규칙이 없다.
  //
  // ⚠️ **손익 소비 금지는 그대로다.** 아래는 전부 「이체 일정 표시 + 확정 게이트」 경로이며
  // `operatingProfit`·「조정 후 손익」에는 여전히 들어가지 않는다.
  "lib/calendar-entities.ts":
    "대금 칸 금액 타입·위임(값 통과만 — 판정은 tax-filing-board SSOT, 그룹 접기 규약도 SSOT 조회)",
  "lib/agent/write-executor.ts":
    "AI 확정 게이트의 금액 근거 조립(Decimal → number 통과만, 산술 없음)",
  "lib/agent/__tests__/write-executor.test.ts": "위 게이트의 3-상태 계약 픽스처",
  "lib/mobile-calendar-data.ts": "DB → 캘린더 페이로드 매핑(Decimal → number 통과만)",
  "lib/mobile-settlement-data.ts": "DB → 모바일 정산 페이로드 매핑(Decimal → number 통과만)",
  "lib/mobile-settlement-data.test.ts": "위 매핑의 계약 픽스처",
  "lib/google-calendar-sync.ts": "구글 캘린더 대금 이벤트의 금액 근거 통과(산술 없음)",
  "app/calendar/calendar-page-client.tsx": "캘린더 응답 zod 스키마 선언(값 통과만)",
  "app/calendar/__tests__/calendar-page-client.test.tsx": "위 스키마의 픽스처",
  "app/calendar/calendar-page-client.test.tsx": "위 스키마의 병렬 픽스처(동명 co-located 파일)",
  "components/mobile/__tests__/mobile-settlement-pending-sheet.test.tsx":
    "정산 대기 금액 계약의 픽스처(SSOT 위임 후 3-상태 단언)",
  // ⚠️ 아래 둘만 **연산**이다 — 그룹(조합) 접기. 단, 규칙을 손으로 쓰지 않고
  //    `sumGroupManualGoodsCost` 에 위임한다(부분 합산 금지 = 그룹은 계산서 한 장).
  "components/mobile/mobile-campaign-detail-sheet.tsx":
    "상세 시트 대금 줄 — 그룹 접기를 SSOT(sumGroupManualGoodsCost)에 위임, 그 외 값 통과",
  "components/mobile/mobile-calendar-home.tsx":
    "캘린더 → 상세 시트 조립 — 그룹 접기를 SSOT 에 위임, 그 외 값 통과",
  "components/mobile/mobile-settlement-pending-sheet.tsx":
    "정산 대기 금액 — 손수 삼항 사본을 걷고 moneySlotAmount(SSOT)에 위임(값 통과만)",
  "components/mobile/__tests__/mobile-campaign-detail-sheet.test.tsx": "위 상세 시트의 픽스처",
  "components/mobile/__tests__/mobile-schedule-calendar.test.tsx": "일정 캘린더 렌더 픽스처",
  "lib/__tests__/calendar-entities.test.ts": "대금 칸 금액·그룹 접기 계약의 픽스처",
  "lib/__tests__/mobile-calendar-groups.test.ts": "모바일 그룹 병합 픽스처",

  // ── 2026-08-28: 정산 선택 바의 거래처 지급·입금 표시(오너 승인) ─────────────
  // 판정 본체는 위 `ALLOWED` 의 `lib/settlement-brand-total.ts` 다. 아래 둘은 그 판정이
  // 3-상태를 접지 않는지 확인하는 **픽스처**로, 값을 넣을 뿐 산술하지 않는다.
  "lib/__tests__/settlement-partner-breakdown.test.ts":
    "거래처별 상계 계약의 픽스처 — 합산 이관(0)이 줄을 만들지 않는지 단언. 값 통과만",
  "components/crm/__tests__/settlement-selection-bar.test.tsx":
    "선택 바 렌더 계약의 픽스처 — 지급·입금 칸이 도달하는지 단언. 값 통과만",
};

describe("manualGoodsCost 소비처 경계 — 세무 대조 전용", () => {
  const sources = walk(SRC).map((file) => ({
    path: relative(SRC, file).split("\\").join("/"),
    text: readFileSync(file, "utf8"),
  }));
  const referencing = sources.filter((s) => s.text.includes("manualGoodsCost")).map((s) => s.path);
  const rawReferencing = sources
    .filter((s) => s.text.includes("settlementGoodsCost"))
    .map((s) => s.path);

  it("허용 목록 밖의 파일은 이 심볼을 참조하지 않는다", () => {
    const unexpected = referencing.filter((file) => !(file in ALLOWED));
    expect(unexpected, `손익·리포트로 새면 남의 매출에 붙은 원가가 섞인다: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("raw DB 필드(settlementGoodsCost)도 배선 목록 밖에서는 참조하지 않는다", () => {
    // 게이트가 별칭(manualGoodsCost)만 보면, 손익 코드가 raw 필드를 직접 읽는 우회가
    // 조용히 통과한다(code-reviewer 지적 2026-08-06). 새 소비처는 여기서 표면화된다.
    const allowed = { ...ALLOWED, ...RAW_FIELD_ALLOWED };
    const unexpected = rawReferencing.filter((file) => !(file in allowed));
    expect(unexpected, `raw 필드의 새 소비처 — 통과인지 연산인지 판정 후 등재하라: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("스캐너가 살아 있다 — 판정 본체는 반드시 잡힌다(양성 프로브)", () => {
    // 이 단언이 없으면 walk() 나 확장자 필터가 고장 났을 때도 위 테스트가 초록이다.
    expect(referencing).toContain("lib/tax-invoice-mail/expected-receivables.ts");
    expect(rawReferencing).toContain("lib/tax-invoice-mail/campaign-facts.ts");
  });

  it("손익 경로가 별칭 심볼을 알지 못한다(음성 대조군)", () => {
    for (const path of ["lib/campaign-row.ts", "lib/crm-types.ts"]) {
      expect(referencing).not.toContain(path);
    }
  });
});
