import type { SalesChannel } from "@/lib/crm-types";
import { salesChannelLabels } from "@/lib/crm-types";

/**
 * `SystemTaskLog.details` 안의 「확인 필요」 상세를 화면이 쓸 형태로 좁힌다.
 *
 * 시스템 레이더는 잡마다 다른 `details` 를 `unknown` 으로 받는다 — 이 파서는 그중
 * `needsReviewDetail` 규약을 따르는 잡(현재 `tax-invoice-issue-confirm`)만 인식하고,
 * 나머지는 빈 결과를 돌려 화면에서 섹션이 아예 안 그려지게 한다. 잡별 분기를 컴포넌트에
 * 심지 않으려는 배치다 — 같은 규약을 내는 잡이 생기면 그 잡도 그대로 표시된다.
 *
 * ⚠️ `details` 는 4,000자를 넘으면 통째로 `{truncated, preview}` 로 대체된다
 * (`system-task-status.ts`). 그때 이 파서는 빈 결과를 낸다 — 잘린 문자열에서 항목을
 * 되살리려 들지 않는다. 반쯤 복원한 목록을 "확인 필요 전부"로 보여주는 것이 더 나쁘다.
 */

export interface NeedsReviewReason {
  code: string;
  message: string;
}

export interface NeedsReviewItem {
  key: string;
  campaignLabel: string | null;
  counterpartLabel: string | null;
  /** 이미 한국어로 옮긴 채널명. 원본 enum(`BRAND_MALL`)을 화면에 그대로 내보내지 않는다. */
  channelLabel: string | null;
  reasons: NeedsReviewReason[];
}

export interface NeedsReviewDetail {
  items: NeedsReviewItem[];
  /**
   * 실제 확인 필요 **총**건수(`details.needsReview`). `items.length` 와 다를 수 있다 —
   * 예산에 걸려 일부만 실렸을 때 표시 건수를 총계로 말하면 화면이 숫자를 속인다.
   */
  total: number;
  /** 예산에 걸려 일부만 실렸다 — 화면이 "이게 전부"라고 말하면 안 된다. */
  capped: boolean;
}

const EMPTY: NeedsReviewDetail = { items: [], total: 0, capped: false };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseReasons(value: unknown): NeedsReviewReason[] {
  if (!Array.isArray(value)) return [];
  const reasons: NeedsReviewReason[] = [];
  for (const raw of value) {
    const row = asRecord(raw);
    if (!row) continue;
    const message = asNonEmptyString(row.message);
    // 사유 문장이 없으면 행을 만들지 않는다 — 코드만 있는 줄은 오너에게 아무것도 말하지 않는다.
    if (!message) continue;
    reasons.push({ code: asNonEmptyString(row.code) ?? "UNKNOWN", message });
  }
  return reasons;
}

function toChannelLabel(value: unknown): string | null {
  const channel = asNonEmptyString(value);
  if (!channel) return null;
  return salesChannelLabels[channel as SalesChannel] ?? channel;
}

export function parseNeedsReviewDetail(details: unknown): NeedsReviewDetail {
  const root = asRecord(details);
  if (!root || !Array.isArray(root.needsReviewDetail)) return EMPTY;

  const items: NeedsReviewItem[] = [];
  for (const raw of root.needsReviewDetail) {
    const row = asRecord(raw);
    if (!row) continue;
    const key = asNonEmptyString(row.key);
    if (!key) continue;
    const reasons = parseReasons(row.reasons);
    // 사유가 하나도 없으면 「확인 필요」라고만 적힌 빈 줄이 된다 — 판단 가치가 없어 버린다(P2).
    if (reasons.length === 0) continue;
    items.push({
      key,
      campaignLabel: asNonEmptyString(row.campaignLabel),
      counterpartLabel: asNonEmptyString(row.counterpartLabel),
      channelLabel: toChannelLabel(row.channel),
      reasons,
    });
  }

  // 총계는 집계 필드가 정본이다 — 실린 항목 수를 총계로 되쓰면 잘렸을 때 화면이 과소보고한다.
  const reported = root.needsReview;
  const total =
    typeof reported === "number" && Number.isFinite(reported) && reported >= items.length
      ? reported
      : items.length;

  return { items, total, capped: root.needsReviewDetailCapped === true };
}
