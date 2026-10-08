import type { CampaignRow, CampaignStatus } from "./crm-types";
import { isStagnantAfterDays } from "./stagnant";

export type CampaignActionTone = "overdue" | "today" | "upcoming" | "done";

/** 기한 판정의 화면 낱말 — 판정 코드를 그대로 찍지 않는다. */
export const ACTION_TONE_WORD: Record<CampaignActionTone, string> = {
  overdue: "지연",
  today: "오늘",
  upcoming: "예정",
  done: "—",
};

type CampaignAction = {
  label: string;
  dueDate: string | null;
  tone: CampaignActionTone;
  isStagnant: boolean;
  stagnantDays: number | null;
};

// 「다음 할 일」은 **명사 + 기한**으로 읽힌다(「셀러확정 10.12」) — 지시문(「~ 필요」)을 쓰지 않는다
// (오너 확정 2026-10-08, 설계 정본 docs/private/specs/2026-10-08-status-wording-proposal.md A3).
// 할 일이 끝난 단계(COMPLETED·DROPPED)는 낱말이 없다 — 기한도 없어 표면이 그리지 않는다.
const ACTION_COPY: Record<CampaignStatus, { label: string; offsetDays: number | null }> = {
  PROPOSAL: { label: "셀러확정", offsetDays: -3 },
  PREPARATION: { label: "오픈준비", offsetDays: -1 },
  ACTIVE: { label: "판매마감", offsetDays: 0 },
  CLOSED: { label: "매출수집", offsetDays: 1 },
  SETTLEMENT_WAIT: { label: "정산확인", offsetDays: 10 },
  SETTLEMENT_IN_PROGRESS: { label: "정산처리", offsetDays: 14 },
  COMPLETED: { label: "", offsetDays: null },
  DROPPED: { label: "", offsetDays: null },
};

// 정체 임계는 `stagnant.ts`(SSOT)가 소유한다 — 여기 있던 두 번째 표는 크론과 값이
// 어긋나(PREPARATION 3 vs 7) 화면과 알림이 다른 답을 말하게 했다(2026-07-17 제거).

const DAY_MS = 24 * 60 * 60 * 1000;

function parseYmd(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

function isValidDate(value: Date) {
  return !Number.isNaN(value.getTime());
}

function formatYmd(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string | null | undefined, amount: number) {
  if (!value) return null;
  const date = parseYmd(value);
  if (!isValidDate(date)) return null;
  date.setUTCDate(date.getUTCDate() + amount);
  return formatYmd(date);
}

function dayDiff(from: Date, to: Date) {
  const fromDay = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  const toDay = new Date(Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()));
  return Math.floor((toDay.getTime() - fromDay.getTime()) / DAY_MS);
}

export function getCampaignAction(campaign: CampaignRow, now = new Date()): CampaignAction {
  const action = ACTION_COPY[campaign.status];
  const dueDate =
    action.offsetDays == null
      ? null
      : addDays(
          campaign.status === "ACTIVE" ||
            campaign.status === "CLOSED" ||
            campaign.status === "SETTLEMENT_WAIT" ||
            campaign.status === "SETTLEMENT_IN_PROGRESS"
            ? campaign.endDate
            : campaign.startDate,
          action.offsetDays,
        );

  const dueDateValue = dueDate ? parseYmd(dueDate) : null;
  const tone: CampaignActionTone =
    dueDateValue == null || !isValidDate(dueDateValue)
      ? "done"
      : dayDiff(now, dueDateValue) < 0
        ? "overdue"
        : dayDiff(now, dueDateValue) === 0
          ? "today"
          : "upcoming";

  const daysSinceUpdate = dayDiff(new Date(campaign.updatedAt), now);
  const isStagnant = isStagnantAfterDays(campaign.status, daysSinceUpdate);

  return {
    label: action.label,
    dueDate,
    tone,
    isStagnant,
    stagnantDays: isStagnant ? daysSinceUpdate : null,
  };
}

export function formatCampaignActionDate(value: string | null) {
  if (!value) return null;
  return value.slice(5).replace("-", ".");
}
