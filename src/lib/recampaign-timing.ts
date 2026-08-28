// 재캠페인 적기 감지 (F1 읽기 전용 알림) — GROWTH_FLYWHEEL_PLAN.md §F1
//
// 셀러별로 "실행된" 캠페인(시작일이 도래한 ACTIVE 이후 상태)의 시작일 간격 중앙값을
// 그 셀러의 재캠페인 케이던스로 보고, 마지막 시작일 + 중앙값이 지났거나(적기 도래)
// 임박(14일 이내)한 셀러를 알린다. 기안(쓰기) 연결은 Phase B — 여기는 계산만.
//
// 설계 근거:
// - PROPOSAL/PREPARATION은 아직 실행 전이라 케이던스 표본에서 제외.
// - 진행·예정 캠페인이 있는 셀러는 이미 인게이지 상태라 알림 제외.
// - 간격 0일(같은 날 여러 행 — 임포트 산출물)은 표본에서 제외, 중앙값은 최소 7일로
//   클램프해 데이터 결함이 상시 알림으로 번지는 것을 막는다.

const DAY_MS = 86_400_000;

export const RECAMPAIGN_UPCOMING_DAYS = 14;
/** 케이던스 계산에 필요한 최소 실행 캠페인 수 (간격 표본 1개) */
export const RECAMPAIGN_MIN_RUN = 2;
/** 중앙값 하한 — 이보다 짧은 케이던스는 데이터 결함으로 간주 */
export const RECAMPAIGN_MIN_INTERVAL_DAYS = 7;

/**
 * "실제로 실행된" 캠페인 상태 — 시작일이 도래해 시장 반응이 있었던 것.
 * C2 오퍼 진단의 앵콜 이력 행도 같은 어휘를 써야 "실행"의 정의가 갈리지 않는다.
 */
export const RUN_STATUSES = new Set([
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
]);
const ENGAGED_STATUSES = new Set(["PROPOSAL", "PREPARATION", "ACTIVE"]);

export type RecampaignCampaignInput = {
  sellerId: string;
  startDate: Date | string;
  endDate: Date | string;
  status: string;
  sellerName: string;
  sellerAlias?: string | null;
  availabilityNote?: string | null;
};

export type RecampaignAlert = {
  sellerId: string;
  /** alias 우선 표기 (P2 Seller Alias Priority) */
  sellerName: string;
  runCount: number;
  medianIntervalDays: number;
  lastStartDate: string;
  dueDate: string;
  /** 음수 = 적기 경과 일수 */
  daysUntilDue: number;
  state: "DUE" | "UPCOMING";
  availabilityNote: string | null;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computeRecampaignAlerts(
  campaigns: RecampaignCampaignInput[],
  referenceDate: Date = new Date()
): RecampaignAlert[] {
  const ref = referenceDate.getTime();
  const bySeller = new Map<string, RecampaignCampaignInput[]>();
  for (const c of campaigns) {
    const list = bySeller.get(c.sellerId);
    if (list) list.push(c);
    else bySeller.set(c.sellerId, [c]);
  }

  const alerts: RecampaignAlert[] = [];

  for (const [sellerId, list] of bySeller) {
    // 진행·예정 캠페인이 있으면 이미 인게이지 — 알림 불필요
    const engaged = list.some(
      (c) => ENGAGED_STATUSES.has(c.status) || toDate(c.endDate).getTime() >= ref
    );
    if (engaged) continue;

    const runs = list
      .filter((c) => RUN_STATUSES.has(c.status) && toDate(c.startDate).getTime() <= ref)
      .sort((a, b) => toDate(a.startDate).getTime() - toDate(b.startDate).getTime());
    if (runs.length < RECAMPAIGN_MIN_RUN) continue;

    const intervals: number[] = [];
    for (let i = 1; i < runs.length; i++) {
      const days =
        (toDate(runs[i].startDate).getTime() - toDate(runs[i - 1].startDate).getTime()) / DAY_MS;
      if (days > 0) intervals.push(days);
    }
    if (intervals.length === 0) continue;

    intervals.sort((a, b) => a - b);
    const cadenceDays = Math.max(RECAMPAIGN_MIN_INTERVAL_DAYS, Math.round(median(intervals)));

    const last = runs[runs.length - 1];
    const lastStart = toDate(last.startDate);
    const due = new Date(lastStart.getTime() + cadenceDays * DAY_MS);
    const daysUntilDue = Math.ceil((due.getTime() - ref) / DAY_MS);

    let state: RecampaignAlert["state"];
    if (daysUntilDue <= 0) state = "DUE";
    else if (daysUntilDue <= RECAMPAIGN_UPCOMING_DAYS) state = "UPCOMING";
    else continue;

    alerts.push({
      sellerId,
      sellerName:
        last.sellerAlias && last.sellerAlias.trim() !== "" ? last.sellerAlias : last.sellerName,
      runCount: runs.length,
      medianIntervalDays: cadenceDays,
      lastStartDate: lastStart.toISOString(),
      dueDate: due.toISOString(),
      daysUntilDue,
      state,
      availabilityNote: last.availabilityNote ?? null,
    });
  }

  // 적기 경과(가장 오래 지난 순) → 임박(가까운 순)
  return alerts.sort((a, b) => {
    if (a.state !== b.state) return a.state === "DUE" ? -1 : 1;
    return a.daysUntilDue - b.daysUntilDue;
  });
}
