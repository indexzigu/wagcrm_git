/**
 * 원천징수 3절차(원천세 신고·지급명세 제출·지방소득세 특별징수)의 완료 기록 계약.
 *
 * `TaxFilingLog` 모델(prisma/schema.prisma)의 완료·미완료 판정과, 진입점 배지가 쓰는
 * 미처리 건수·가장 가까운 기한 계산을 여기 모은다 — API 라우트·UI 양쪽이 같은 계산을
 * 두 번 인코딩하지 않도록.
 *
 * 세 절차의 기한·귀속월 계산은 새로 만들지 않는다 — `withholding-report.ts`의
 * `withholdingDueDate`/`simplifiedStatementDueDate`를 그대로 재사용한다
 * (docs/private/specs/2026-08-03-tax-filing-helper-design.md 「기한 계산」절).
 */

/** 간이지급명세서 업종구분코드 — 기타자영업, 오너 확정(2026-08-04). 전 셀러 공통 상수다.
 *  `Seller.industryCode` 컬럼은 만들지 않는다 — 갈릴 사례가 없고(YAGNI), Seller 는 ISR
 *  프리렌더가 읽는 테이블이라 컬럼 추가가 release-preflight P2022 위험을 만든다(설계
 *  문서 「✅ 업종구분코드」절). 셀러별로 코드가 갈리는 사례가 실제로 생기면 그때 컬럼을
 *  추가한다. */
export const SIMPLIFIED_STATEMENT_INDUSTRY_CODE = "940909";

/** 위 코드의 업종명. 화면에는 **이름과 코드를 함께** 내보낸다(오너 결정, 2026-08-11 — T-030).
 *
 *  ⚠️ 둘 중 하나만 두지 말 것. 홈택스 간이지급명세서 화면이 코드를 직접 받는지 업종명을
 *  검색해 고르게 하는지가 **확인되지 않았다** — 설계 문서(「홈택스 화면 필드」절)는 국세청
 *  안내자료를 근거로 `업종구분코드` 칸이라고 적었고, 별개 세션이 라우팅한 T-030 은 실제
 *  화면이 업종명 검색이라고 주장했으나 그 주장의 원작성자를 특정할 수 없어(익명 미커밋
 *  변경) 실측으로 인정하지 않았다. 어느 쪽이든 오너가 값을 얻게 하는 것이 이 상수 쌍의
 *  목적이다. 한쪽이 실측으로 확정되면 그때 좁힌다. */
export const SIMPLIFIED_STATEMENT_INDUSTRY_NAME = "기타자영업";

export const TAX_FILING_KINDS = [
  "WITHHOLDING_RETURN",
  "SIMPLIFIED_STATEMENT",
  "LOCAL_INCOME_TAX",
] as const;

export type TaxFilingKind = (typeof TAX_FILING_KINDS)[number];

export function isTaxFilingKind(value: unknown): value is TaxFilingKind {
  return typeof value === "string" && (TAX_FILING_KINDS as readonly string[]).includes(value);
}

export type WithholdingFilingSummary = {
  /** 이번 달 대상이 있는데 아직 완료 처리되지 않은 절차 수 (0~3). 대상이 없으면 항상 0. */
  pendingCount: number;
  /** 미완료 절차 중 가장 가까운 기한(YYYY-MM-DD). 대상이 없거나 전부 완료면 null. */
  nextDueDate: string | null;
};

/**
 * 원천징수 3절차 중 미완료·가장 가까운 기한을 계산한다 — 진입점 배지·세금계산서 보드
 * 응답에 얹는 값이다.
 *
 * `hasFilingTarget`(해당 월 개인 셀러 지급 건이 있는지, 즉 `WithholdingReport.rows.length
 * > 0`)이 false 면 세 절차 다 대상이 아니므로 항상 `{ pendingCount: 0, nextDueDate: null
 * }`을 낸다 — 낼 게 없는 달에 "미처리 3건"을 띄우면 오너가 헛수고로 홈택스를 열어보게
 * 된다.
 */
export function computeWithholdingFilingSummary(
  hasFilingTarget: boolean,
  completedKinds: ReadonlySet<TaxFilingKind>,
  dueDateByKind: Record<TaxFilingKind, string>,
): WithholdingFilingSummary {
  if (!hasFilingTarget) return { pendingCount: 0, nextDueDate: null };

  const pendingKinds = TAX_FILING_KINDS.filter((kind) => !completedKinds.has(kind));
  if (pendingKinds.length === 0) return { pendingCount: 0, nextDueDate: null };

  const nextDueDate = [...pendingKinds].map((kind) => dueDateByKind[kind]).sort()[0];
  return { pendingCount: pendingKinds.length, nextDueDate };
}

// ---------------------------------------------------------------------------
// 캠페인 단위 원천징수 신고 상태 — 정산 상세 카드가 읽는 파생값
// ---------------------------------------------------------------------------

/**
 * 정산 상세 「정산 및 회계 일정」의 개인 셀러 칸이 표시할 상태.
 *
 * ⛔ **이 값을 캠페인 컬럼에 쓰지 말 것.** 원천징수 신고는 캠페인에 붙는 사실이 아니라
 * **월에 붙는 사실**이라 SoT 는 `TaxFilingLog(month, kind)` 하나다(그래서 애초에 별도
 * 모델이다). 월 단위 사실을 캠페인 행마다 복사하면 한 캠페인의 지급월이 정정되는 순간
 * 두 값이 조용히 갈린다. 특히 `sellerInvoiceIssuedAt` 에 신고일을 찍지 말 것 — 그 필드는
 * 「셀러 계산서 수취일」이고 세금계산서 보드·수취 대조 엔진·정산 명세서가 전부 그 의미로
 * 읽어서, 넣는 순간 그 소비처들이 「계산서를 수취했다」로 오독한다.
 *
 * 설계 정본: docs/private/specs/2026-08-12-withholding-status-on-settlement-card-design.md
 */
export type CampaignWithholdingState =
  /** 지급 미완료 — 귀속월 자체가 없으므로 아직 신고 대상이 아니다. */
  | "AWAITING_PAYOUT"
  /** 지급월은 확정됐고 3절차 중 완료가 0건. */
  | "NOT_FILED"
  /** 3절차 중 일부만 완료. */
  | "PARTIALLY_FILED"
  /** 3절차 전부 완료 — 정산 카드가 체크로 표시하는 유일한 상태. */
  | "FILED";

export type CampaignWithholdingStatus = {
  state: CampaignWithholdingState;
  /** 귀속월(= 지급월, `YYYY-MM`). 지급 미완료면 null. */
  month: string | null;
  /**
   * 원천세 신고(`WITHHOLDING_RETURN`) 완료일(`YYYY-MM-DD`, KST). 그 절차가 아직이면 null.
   * 오너가 지정한 표시 일자 축이 「신고일자」라 3절차 전부가 아니라 1번 기준이다 —
   * 부분 완료 상태에서도 "언제 원천세를 냈는지"는 사실로 남는다.
   */
  filedAt: string | null;
  /**
   * 아직 완료되지 않은 절차 수(0~3). **`AWAITING_PAYOUT`이면 `null`이다** — 아직 대상이
   * 아닌 것을 「3건 남음」으로 세면 오너가 밀린 일로 읽는다. `computeWithholdingFilingSummary`
   * 가 `hasFilingTarget=false`일 때 0을 내는 것과 같은 규율(미입력을 낙제로 읽지 않는다).
   */
  pendingCount: number | null;
};

/** ISO datetime 을 **KST 기준** 날짜(`YYYY-MM-DD`)로 자른다.
 *
 *  🪤 `slice(0, 10)` 으로 바꾸지 말 것 — `completedAt` 은 UTC ISO 라, KST 22:00 이후에
 *  완료 체크한 건이 **전날**로 표시된다. 이 파일의 `computeDueDiffDays` 와 같은 관용구다. */
function toKstDateString(isoTimestamp: string): string | null {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * 캠페인 하나의 원천징수 신고 상태를 그 캠페인의 **지급월** 신고 기록에서 파생한다.
 *
 * 축 연결: `payoutCompletedAt`(KST `YYYY-MM-DD`, `toCampaignRow` 가 그룹 지급일을 이미
 * 접어 넣는다) → 앞 7자 = 귀속월 → 그 달의 `TaxFilingLog`. `buildWithholdingReport` 가
 * 신고 대상을 모으는 축과 **정확히 같다**(귀속월 = 지급월, 오너 확정 2026-08-04).
 *
 * `completedLogs` 는 `GET /api/settlement/tax-filing-log?month=` 의 `completed` 배열이다 —
 * 호출부가 이미 월로 좁혀 받으므로 여기서 월을 다시 거르지 않는다.
 */
export function resolveCampaignWithholdingStatus(
  payoutCompletedAt: string | null | undefined,
  completedLogs: ReadonlyArray<{ kind: string; completedAt: string }>,
): CampaignWithholdingStatus {
  const month = payoutCompletedAt?.slice(0, 7) ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return { state: "AWAITING_PAYOUT", month: null, filedAt: null, pendingCount: null };
  }

  const completedKinds = new Set(completedLogs.map((log) => log.kind).filter(isTaxFilingKind));
  const pendingCount = TAX_FILING_KINDS.filter((kind) => !completedKinds.has(kind)).length;

  const withholdingReturn = completedLogs.find((log) => log.kind === "WITHHOLDING_RETURN");
  const filedAt = withholdingReturn ? toKstDateString(withholdingReturn.completedAt) : null;

  const state: CampaignWithholdingState =
    pendingCount === 0 ? "FILED" : pendingCount === TAX_FILING_KINDS.length ? "NOT_FILED" : "PARTIALLY_FILED";

  return { state, month, filedAt, pendingCount };
}

/** KST 기준 오늘부터 `dueDate`(YYYY-MM-DD)까지 남은 일수. 음수면 기한이 지났다는 뜻.
 *  `formatDDay`·`getDDayLevel`이 같은 계산을 두 번 인코딩하지 않도록 여기 하나로 모은다. */
function computeDueDiffDays(dueDate: string, now: Date = new Date()): number {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const todayStr = kst.toISOString().slice(0, 10);
  return Math.round(
    (new Date(`${dueDate}T00:00:00Z`).getTime() - new Date(`${todayStr}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

/** `YYYY-MM-DD` 기한까지 남은 일수를 "D-n"(오늘 포함 남은 일)·"D-day"·"기한 초과"로
 *  표기한다. KST 기준 — 이 레포의 다른 날짜 계산(`withholding-report.ts`)과 같은 관용구. */
export function formatDDay(dueDate: string, now: Date = new Date()): string {
  const diffDays = computeDueDiffDays(dueDate, now);
  if (diffDays > 0) return `D-${diffDays}`;
  if (diffDays === 0) return "D-day";
  return "기한 초과";
}

export type DDayLevel = "urgent" | "caution" | "normal";

/**
 * 기한 근접도의 심각도 레벨 — 절차 카드의 D-day 배지 톤을 정하는 유일한 축이다
 * (design-system.md §1 「축을 섞지 말 것」·§4 「범주는 색을 받지 않는다」: 제출처
 * (홈택스/위택스)는 범주라 색을 받지 않고, 대신 기한 근접도가 그 색을 받는다).
 *
 * 임계값(직접 고른 값이라 근거를 남긴다):
 * - `diffDays <= 0`(기한이 지났거나 오늘이 기한) → `urgent`. 더 미룰 시간이 없는
 *   상태라 색 없이 지나칠 수 없다.
 * - `diffDays <= 3` → `caution`. 3일은 "오늘 안에 처리 안 해도 되지만 이번 순번에서
 *   밀리면 위험한" 여유값으로 임의 선택했다 — 더 넉넉하게(예: 7일) 당기고 싶으면 이
 *   상수만 바꾸면 된다. 1~2일로 좁히면 카드 3개가 동시에 caution 으로 몰리는 달이
 *   잦아 배지 색의 변별력이 떨어진다고 판단해 3을 택했다.
 * - 그 외(4일 이상 남음) → `normal`(무채색). 아직 이번 주 우선순위가 아니다.
 */
export function getDDayLevel(dueDate: string, now: Date = new Date()): DDayLevel {
  const diffDays = computeDueDiffDays(dueDate, now);
  if (diffDays <= 0) return "urgent";
  if (diffDays <= 3) return "caution";
  return "normal";
}
