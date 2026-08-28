import { getPrisma } from "@/lib/prisma";

// ── 기본 상수 (운영 설정에서 오버라이드 가능) ──────────────────
export const DEFAULT_SCHEDULE_THRESHOLDS = {
  idealDays: 60,
  minDays: 30,
  deadlineDays: 21,
};

export type ScheduleThresholds = typeof DEFAULT_SCHEDULE_THRESHOLDS;

// ── 타입 ──────────────────────────────────────────────────────
export type BucketUrgency = "DANGER" | "URGENT" | "CAUTION" | "PREPARE" | "OK";

export type BucketCampaign = {
  id: string;
  /** 툴팁 표기 라벨 — 미그룹 "딜명 - 셀러명(별칭 우선)", 그룹은 그룹명 1건으로 접힘 */
  label: string;
  status: string;
};

export type ScheduleBucket = {
  label: string;          // "6/3 ~ 6/16"
  startDate: string;      // ISO
  endDate: string;        // ISO
  daysFromNow: number;
  urgency: BucketUrgency;
  confirmedCount: number;
  campaigns: BucketCampaign[];
  actionLabel: string | null;
};

/**
 * 확정 캠페인이 하루도 없는 "연속 빈 날짜 구간"(item 10, 소유자 결정 2026-07-09).
 * 주간 버킷(ScheduleBucket)은 데스크톱 커버리지 타임라인 유지용이고, 실제 "확보 필요"
 * 판정은 이 일 단위 갭으로 한다 — 주 일부만 빈 구간(예: 7/18~7/20)도 정확히 잡힌다.
 */
export type ScheduleGap = {
  label: string;          // "7/18" 또는 "7/18~7/20"
  startDate: string;      // ISO (구간 시작일 00:00 UTC)
  endDate: string;        // ISO (구간 종료일 00:00 UTC)
  daysFromNow: number;    // 오늘→구간 시작일
  dayCount: number;       // 구간 길이(일)
  urgency: BucketUrgency;
  actionLabel: string | null;
};

export type PipelineFunnel = {
  readyDeals: number;       // 확정 딜 중 캠페인 미생성
  proposedTasks: number;    // 제안 중
  negotiatingTasks: number; // 협의 + 테스트
  stagnantTasks: number;    // 협의 + 테스트 단계에서 7일 이상 멈춘 건
  pendingApproval: number;  // 승인 대기
  totalActive: number;
};

export type ScheduleGapBriefing = {
  thresholds: ScheduleThresholds;
  buckets: ScheduleBucket[];
  /** 일 단위 빈 날짜 구간(확보 필요 판정의 실제 소스) — daysFromNow 오름차순 */
  gaps: ScheduleGap[];
  funnel: PipelineFunnel;
  summary: {
    totalBuckets: number;
    emptyBuckets: number;
    dangerBuckets: number;
    urgentBuckets: number;
    /** 빈 날짜 구간 총 개수 */
    gapCount: number;
    /** 위험(DANGER)+긴급(URGENT) 빈 구간 개수 — 상단 경고 대상 */
    riskyGapCount: number;
  };
};

// ── 헬퍼 ──────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_DAYS = 7;

function getWeekOfMonthLabel(date: Date): string {
  // ISO 8601 style week calculation
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 3 - (date.getUTCDay() || 7) + 1));
  const month = d.getUTCMonth() + 1;
  const year = d.getUTCFullYear();
  
  let firstThursday = 1;
  while (new Date(Date.UTC(year, month - 1, firstThursday)).getUTCDay() !== 4) {
    firstThursday++;
  }
  
  const weekNumber = Math.floor((d.getUTCDate() - firstThursday) / 7) + 1;
  return `${month}월 ${weekNumber}주차`;
}

function formatBucketLabel(start: Date): string {
  return getWeekOfMonthLabel(start);
}

function classifyUrgency(
  daysFromNow: number,
  confirmedCount: number,
  thresholds: ScheduleThresholds,
): BucketUrgency {
  if (confirmedCount > 0) return "OK";
  if (daysFromNow <= thresholds.deadlineDays) return "DANGER";
  if (daysFromNow <= thresholds.minDays) return "URGENT";
  if (daysFromNow <= thresholds.idealDays) return "CAUTION";
  return "PREPARE";
}

function actionForUrgency(urgency: BucketUrgency): string | null {
  switch (urgency) {
    case "DANGER":
      return "즉시 일정 확보 필요";
    case "URGENT":
      return "이번 주 내 일정 확정";
    case "CAUTION":
      return "셀러 제안 및 협의 가속";
    case "PREPARE":
      return "딜 소싱 · 제안 준비";
    case "OK":
      return null;
  }
}

// ── 버킷 캠페인 그룹 접기 ─────────────────────────────────────
export type FoldableBucketCampaign = {
  id: string;
  status: string;
  groupId: string | null;
  group: { name: string | null } | null;
  deal: { dealName: string };
  seller: { name: string; alias: string | null };
};

function sellerLabel(c: FoldableBucketCampaign): string {
  return c.seller.alias && c.seller.alias.trim() !== "" ? c.seller.alias : c.seller.name;
}

/**
 * 버킷에 걸린 캠페인 목록을 그룹당 1건으로 접는다(입력 순서 보존).
 * 그룹 라벨은 그룹명(D4 자동명 저장분) 우선, 없으면 "딜명 - 셀러명 외 N-1건" 합성.
 * status 는 첫 멤버 값(툴팁 미표시 — 형태 유지용).
 */
export function foldBucketCampaigns(campaigns: FoldableBucketCampaign[]): BucketCampaign[] {
  const result: BucketCampaign[] = [];
  const groupEntry = new Map<string, { row: BucketCampaign; members: FoldableBucketCampaign[] }>();
  for (const c of campaigns) {
    if (c.groupId == null) {
      result.push({ id: c.id, label: `${c.deal.dealName} - ${sellerLabel(c)}`, status: c.status });
      continue;
    }
    const entry = groupEntry.get(c.groupId);
    if (entry) {
      entry.members.push(c);
      continue;
    }
    const row: BucketCampaign = { id: c.id, label: "", status: c.status };
    groupEntry.set(c.groupId, { row, members: [c] });
    result.push(row);
  }
  for (const { row, members } of groupEntry.values()) {
    const first = members[0];
    const storedName = first.group?.name;
    row.label =
      storedName && storedName.trim() !== ""
        ? storedName
        : members.length > 1
          ? `${first.deal.dealName} - ${sellerLabel(first)} 외 ${members.length - 1}건`
          : `${first.deal.dealName} - ${sellerLabel(first)}`;
  }
  return result;
}

// ── 일 단위 빈 구간(갭) 감지 ──────────────────────────────────
type GapCampaignRange = { start: string; end: string };

/** "YYYY-MM-DD" → "M/D" */
function ymdToMd(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}`;
}

function formatGapLabel(startYmd: string, endYmd: string): string {
  return startYmd === endYmd ? ymdToMd(startYmd) : `${ymdToMd(startYmd)}~${ymdToMd(endYmd)}`;
}

/**
 * 오늘(포함)부터 rangeEnd 까지 하루씩 훑으며, 확정 캠페인이 하루도 없는 연속 구간을
 * 하나의 갭으로 묶는다. 커버 판정은 날짜 문자열 비교(캠페인 startDate~endDate 슬라이스) —
 * 모바일 일자 리스트(MobileScheduleDayList)와 동일 규칙이라 화면과 어긋나지 않는다.
 */
export function computeScheduleGaps(
  now: Date,
  campaignRanges: GapCampaignRange[],
  rangeEnd: Date,
  thresholds: ScheduleThresholds,
): ScheduleGap[] {
  const todayMidnight = new Date(now);
  todayMidnight.setUTCHours(0, 0, 0, 0);

  const isCovered = (ymd: string) =>
    campaignRanges.some((r) => r.start <= ymd && r.end >= ymd);

  const gaps: ScheduleGap[] = [];
  let runStartMs: number | null = null;
  let runStartYmd = "";
  let runEndYmd = "";
  let runDays = 0;

  const flush = () => {
    if (runStartMs === null) return;
    const daysFromNow = Math.max(0, Math.round((runStartMs - todayMidnight.getTime()) / DAY_MS));
    const urgency = classifyUrgency(daysFromNow, 0, thresholds);
    gaps.push({
      label: formatGapLabel(runStartYmd, runEndYmd),
      startDate: `${runStartYmd}T00:00:00.000Z`,
      endDate: `${runEndYmd}T00:00:00.000Z`,
      daysFromNow,
      dayCount: runDays,
      urgency,
      actionLabel: actionForUrgency(urgency),
    });
    runStartMs = null;
    runDays = 0;
  };

  for (let t = todayMidnight.getTime(); t <= rangeEnd.getTime(); t += DAY_MS) {
    const ymd = new Date(t).toISOString().slice(0, 10);
    if (isCovered(ymd)) {
      flush();
    } else {
      if (runStartMs === null) {
        runStartMs = t;
        runStartYmd = ymd;
      }
      runEndYmd = ymd;
      runDays += 1;
    }
  }
  flush();

  return gaps;
}

// ── 설정 로드 ─────────────────────────────────────────────────
export async function loadScheduleThresholds(): Promise<ScheduleThresholds> {
  try {
    const prisma = getPrisma();
    const row = await prisma.reminderSettings.findFirst({
      orderBy: { updatedAt: "desc" },
    });
    if (row?.settings) {
      const parsed = JSON.parse(row.settings);
      if (parsed.scheduleThresholds) {
        return {
          idealDays: parsed.scheduleThresholds.idealDays ?? DEFAULT_SCHEDULE_THRESHOLDS.idealDays,
          minDays: parsed.scheduleThresholds.minDays ?? DEFAULT_SCHEDULE_THRESHOLDS.minDays,
          deadlineDays: parsed.scheduleThresholds.deadlineDays ?? DEFAULT_SCHEDULE_THRESHOLDS.deadlineDays,
        };
      }
    }
  } catch {
    // 설정 로드 실패 시 기본값 사용
  }
  return { ...DEFAULT_SCHEDULE_THRESHOLDS };
}

// ── 2주 버킷 생성 ─────────────────────────────────────────────
function getStartOfCurrentWeek(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0 is Sunday
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  return d;
}

export function generateBuckets(now: Date, count: number = 12): Array<{ start: Date; end: Date }> {
  const buckets: Array<{ start: Date; end: Date }> = [];
  const startOfWeek = getStartOfCurrentWeek(now);
  
  for (let i = 0; i < count; i++) {
    const start = new Date(startOfWeek.getTime() + i * BUCKET_DAYS * DAY_MS);
    const end = new Date(start.getTime() + (BUCKET_DAYS - 1) * DAY_MS);
    end.setUTCHours(23, 59, 59, 999);
    buckets.push({ start, end });
  }
  return buckets;
}

// ── 메인 분석 함수 ────────────────────────────────────────────
export async function getScheduleGapBriefing(
  now = new Date(),
): Promise<ScheduleGapBriefing> {
  const prisma = getPrisma();
  const thresholds = await loadScheduleThresholds();
  const rawBuckets = generateBuckets(now, 12);
  const rangeStart = rawBuckets[0].start;
  const rangeEnd = rawBuckets[rawBuckets.length - 1].end;

  // 향후 90일 범위 캠페인 (DROPPED, COMPLETED 제외)
  const campaigns = await prisma.salesCampaign.findMany({
    where: {
      startDate: { lte: rangeEnd },
      endDate: { gte: rangeStart },
      status: { notIn: ["DROPPED", "COMPLETED"] },
    },
    select: {
      id: true,
      startDate: true,
      endDate: true,
      status: true,
      groupId: true,
      group: { select: { name: true } },
      deal: { select: { dealName: true } },
      seller: { select: { name: true, alias: true } },
    },
  });

  // 파이프라인 퍼널: 활성 SalesTask 집계
  const salesTasks = await prisma.salesTask.findMany({
    where: { status: { notIn: ["DROPPED", "CONVERTED"] } },
    select: { status: true, updatedAt: true },
  });

  // 확정 딜 중 아직 캠페인이 없는 딜
  const confirmedDeals = await prisma.deal.findMany({
    where: {
      status: { in: ["CONFIRMED", "ARCHIVED"] },
    },
    select: {
      id: true,
      campaigns: { select: { id: true }, where: { status: { notIn: ["DROPPED", "COMPLETED"] } } },
    },
  });
  const readyDeals = confirmedDeals.filter((d) => d.campaigns.length === 0).length;

  // 버킷별 캠페인 매핑 — 그룹 멤버는 "1개 캠페인"으로 접는다(CG-1: 그룹은 실캠페인 1개의
  // 딜별 분할이라, 멤버 행 수로 세면 커버리지 확정 건수가 실세계보다 부풀려진다).
  const buckets: ScheduleBucket[] = rawBuckets.map((bucket) => {
    const matched = campaigns.filter((c) => {
      // 캠페인이 해당 버킷 기간과 겹치는지 확인
      return c.startDate <= bucket.end && c.endDate >= bucket.start;
    });
    const folded = foldBucketCampaigns(matched);

    const daysFromNow = Math.max(
      0,
      Math.floor((bucket.start.getTime() - now.getTime()) / DAY_MS),
    );

    const urgency = classifyUrgency(daysFromNow, folded.length, thresholds);

    return {
      label: formatBucketLabel(bucket.start),
      startDate: bucket.start.toISOString(),
      endDate: bucket.end.toISOString(),
      daysFromNow,
      urgency,
      confirmedCount: folded.length,
      campaigns: folded,
      actionLabel: actionForUrgency(urgency),
    };
  });

  // 퍼널 집계
  const stagnantDate = new Date(Date.now() - 7 * DAY_MS);
  
  const funnel: PipelineFunnel = {
    readyDeals,
    proposedTasks: salesTasks.filter((t) => t.status === "PROPOSED").length,
    negotiatingTasks: salesTasks.filter((t) =>
      ["NEGOTIATION", "TESTING"].includes(t.status),
    ).length,
    stagnantTasks: salesTasks.filter((t) => 
      ["NEGOTIATION", "TESTING"].includes(t.status) && t.updatedAt < stagnantDate
    ).length,
    pendingApproval: salesTasks.filter((t) => t.status === "PENDING_APPROVAL").length,
    totalActive: salesTasks.length,
  };

  const emptyBuckets = buckets.filter((b) => b.urgency !== "OK");

  // 일 단위 빈 구간(item 10) — 확보 필요 판정의 실제 소스. 주간 버킷은 커버리지 타임라인용.
  // startDate/endDate 는 Prisma DateTime(Date) — UTC ISO 슬라이스로 날짜키화(순회 키와 동일 규칙).
  const campaignRanges: GapCampaignRange[] = campaigns.map((c) => ({
    start: new Date(c.startDate).toISOString().slice(0, 10),
    end: new Date(c.endDate).toISOString().slice(0, 10),
  }));
  const gaps = computeScheduleGaps(now, campaignRanges, rangeEnd, thresholds);
  const riskyGaps = gaps.filter((g) => g.urgency === "DANGER" || g.urgency === "URGENT");

  return {
    thresholds,
    buckets,
    gaps,
    funnel,
    summary: {
      totalBuckets: buckets.length,
      emptyBuckets: emptyBuckets.length,
      dangerBuckets: buckets.filter((b) => b.urgency === "DANGER").length,
      urgentBuckets: buckets.filter((b) => b.urgency === "URGENT").length,
      gapCount: gaps.length,
      riskyGapCount: riskyGaps.length,
    },
  };
}
