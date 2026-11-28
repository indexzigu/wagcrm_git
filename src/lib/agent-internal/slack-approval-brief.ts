import { ACTION_LABELS } from "@/lib/agent/action-labels";
import { resolveEntityLabel, type ResolvableEntityType } from "@/lib/agent/resolve-entity-label";
import { partnerTypeLabels } from "@/lib/crm-types";
import {
  RECORD_ENTITY_LABELS,
  formatRecordValue,
  isRecordEntityType,
  recordFieldLabel,
} from "@/lib/record-update-labels";
import {
  SETTLEMENT_AMOUNT_FIELD_LABELS,
  formatSettlementAmountKrw,
  isSettlementAmountField,
} from "@/lib/settlement-amount-fields";
import { parseStoredJsonObject } from "@/lib/stored-json";

/**
 * 슬랙 승인 요청 카드의 글(오너 결정 2026-11-28 — 돈이 걸린 기안도 슬랙 버튼 한 번으로 바로 적용한다. 대신 카드가
 * 결재함 표 없이도 무엇이 바뀌는지 보이게 한다). hermes 는 이 글을 그대로 카드에 싣는다 — 글을 만드는 곳은 여기 하나다.
 *
 * ## 글쓰기 규칙 — 간이 기술 한국어(ASD-STE100 의 원칙을 한국어에 옮긴 80% 수준)
 *  R1 한 줄 = 사실 하나. 값을 뺀 글은 짧게(테스트가 줄 길이 상한을 건다).
 *  R2 능동형·평서 「~합니다」. 「~됩니다」「~될 수 있습니다」를 쓰지 않는다.
 *  R3 용어는 아래 표의 낱말만 쓴다. 같은 뜻에 다른 낱말을 섞지 않는다.
 *     기안 = 승인을 기다리는 요청 / 승인 = 바로 적용 / 반려 = 적용하지 않음 / 대상 = 바뀌는 CRM 항목 /
 *     「지금 값 → 바꿀 값」 = 금액·칸 변경의 유일한 표기.
 *  R4 줄 순서는 고정이다: ① 제목(승인 요청: 종류) ② 대상 ③ 바뀌는 내용 ④ 승인하면 ⑤ 되돌리기 ⑥ 주의(돈 기안만).
 *  R5 지어낸 설명을 넣지 않는다 — 내용 줄은 기안의 실행 명세(`payload.args`)와 DB 이름에서만 만든다.
 *     봇(LLM)이 쓴 기안 요약은 돈이 걸린 기안에 싣지 않는다. 다른 기안은 「봇 설명」이라고 밝혀 싣는다.
 *
 * 글은 슬랙 mrkdwn 으로 해석되지 않는 평문이다 — 이스케이프·길이 자르기는 hermes 카드 게시기가 한 번 더 한다.
 */

export type SlackApprovalBrief = {
  /** ① 제목 — 「승인 요청: <기안 종류>」 */
  heading: string;
  /** ② ~ ⑤ — 순서 고정 */
  lines: string[];
  /** ⑥ 주의 — 돈이 걸린 기안만. 그 밖에는 null */
  caution: string | null;
  /**
   * 내용 줄을 실행 명세로 **다** 만들었는가. `CONTENT_REQUIRED_ACTIONS` 가 false 면 hermes 는 버튼을 달지 않고 결재함
   * 링크 카드로 내려간다(값을 못 보고 누르는 일을 막는다). 그 밖의 액션은 늘 true.
   */
  complete: boolean;
};

/**
 * 내용 줄 없이는 슬랙 버튼을 달지 않는 액션 — hermes `BRIEF_REQUIRED_ACTIONS` 사본(2026-11-28 결재함 전용에서 옮긴 5종).
 * 주의 줄은 이 중 돈이 오가는 `MONEY_ACTIONS` 만 붙인다(거래처 등록·회차 생성은 금액을 바꾸지 않는다).
 */
export const CONTENT_REQUIRED_ACTIONS: ReadonlySet<string> = new Set([
  "update_settlement_amount",
  "confirm_settlement",
  "update_record",
  "create_partner",
  "create_campaign_round",
]);

/** 결재함 표 없이 슬랙에서 승인하는 돈 기안 — 카드에 주의 줄을 붙인다. */
export const MONEY_ACTIONS: ReadonlySet<string> = new Set([
  "update_settlement_amount",
  "confirm_settlement",
  "update_record",
]);

export const BRIEF_TEXT = {
  headingPrefix: "승인 요청: ",
  onApprove: "승인하면: 바로 적용합니다. 결재함에서 다시 승인하지 않습니다.",
  undo: "되돌리기: 자동으로 되돌리지 않습니다. 고치려면 새 기안을 올립니다.",
  caution: "⚠️ 돈이 걸린 기안입니다. 금액과 대상을 확인한 뒤 누릅니다.",
  unknownTarget: "(이름 없음)",
  noDetail: "바뀌는 내용: 「전체 보기」에서 확인합니다.",
  botNotePrefix: "봇 설명: ",
} as const;

const BOT_NOTE_MAX = 300;
/** 값 하나의 표기 상한 — 긴 주소·메모가 「→ 바꿀 값」을 줄 밖으로 밀어내지 않게 값마다 자른다. */
const VALUE_MAX = 80;
/** 기록 수정 기안이 카드에 칸별로 싣는 최대 칸 수 — 넘으면 내용을 다 못 보이므로 complete=false 로 결재함에 보낸다. */
export const MAX_BRIEF_FIELDS = 8;

export type BriefProposal = {
  payload: unknown;
  resultSummary: string | null;
  targetEntityType: string | null;
  targetEntityId: string | null;
};

export type BriefDeps = {
  /** 대상 이름 — 못 찾으면 null */
  entityName: (type: ResolvableEntityType, id: string) => Promise<string | null>;
};

const defaultDeps: BriefDeps = { entityName: (type, id) => resolveEntityLabel(type, id) };

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function isResolvable(type: string | null): type is ResolvableEntityType {
  return type === "PARTNER" || type === "SELLER" || type === "DEAL" || type === "CAMPAIGN";
}

const ENTITY_WORD: Record<ResolvableEntityType, string> = {
  CAMPAIGN: "캠페인",
  DEAL: "판매 조건",
  PARTNER: "거래처",
  SELLER: "셀러",
};

async function targetLine(deps: BriefDeps, type: ResolvableEntityType, id: string | null): Promise<string> {
  const name = id ? await deps.entityName(type, id).catch(() => null) : null;
  return `대상: ${ENTITY_WORD[type]} 「${name ?? BRIEF_TEXT.unknownTarget}」`;
}

/** ③ 바뀌는 내용 — 기안 종류마다 실행 명세에서만 만든다(R5). 못 만들면 null. */
async function detailLines(
  action: string,
  args: Record<string, unknown>,
  proposal: BriefProposal,
  deps: BriefDeps,
): Promise<string[] | null> {
  switch (action) {
    case "update_settlement_amount": {
      const field = args.field;
      const next = num(args.newAmountKrw);
      if (!isSettlementAmountField(field) || next === null) return null;
      const expected = args.expectedCurrentKrw === null ? null : num(args.expectedCurrentKrw);
      const lines = [
        await targetLine(deps, "CAMPAIGN", str(args.campaignId)),
        `바뀌는 값: ${SETTLEMENT_AMOUNT_FIELD_LABELS[field]} ${formatSettlementAmountKrw(expected)} → ${formatSettlementAmountKrw(next)}`,
      ];
      if (expected !== null) {
        const delta = next - expected;
        lines.push(`차이: ${delta >= 0 ? "+" : "−"}${Math.abs(delta).toLocaleString("ko-KR")}원`);
      }
      return lines;
    }
    case "confirm_settlement": {
      const target = args.target;
      if (target !== "deposit" && target !== "payout") return null;
      return [
        await targetLine(deps, "CAMPAIGN", str(args.campaignId)),
        `바뀌는 값: ${target === "deposit" ? "입금확정" : "지급완료"} 표시를 켭니다.`,
      ];
    }
    case "update_record": {
      const entityType = args.entityType;
      const changes = args.changes;
      const expected = args.expected;
      if (!isRecordEntityType(entityType) || !isPlainObject(changes) || !isPlainObject(expected)) return null;
      const fields = Object.keys(changes);
      if (fields.length === 0 || fields.length > MAX_BRIEF_FIELDS) return null;
      const target = isResolvable(entityType)
        ? await targetLine(deps, entityType, str(args.entityId))
        : `대상: ${RECORD_ENTITY_LABELS[entityType]}`;
      // 칸마다 한 줄 — 칸 이름·값에 「 · 」가 들어 있어도(예: 「공제세액 · 부가세」) 줄이 갈라지지 않는다.
      const lines = fields.map(
        (field) =>
          `바뀌는 값: ${recordFieldLabel(entityType, field)} ` +
          `${clip(formatRecordValue(entityType, field, expected[field]), VALUE_MAX)} → ` +
          clip(formatRecordValue(entityType, field, changes[field]), VALUE_MAX),
      );
      return [target, ...lines];
    }
    case "create_partner": {
      const partner = isPlainObject(args.partner) ? args.partner : null;
      const name = partner ? str(partner.name) : null;
      if (!name) return null;
      const type = partner ? str(partner.type) : null;
      const typeLabel = type && Object.hasOwn(partnerTypeLabels, type)
        ? partnerTypeLabels[type as keyof typeof partnerTypeLabels]
        : null;
      const contacts = Array.isArray(args.contacts) ? args.contacts.length : 0;
      return [
        `새 거래처: 「${clip(name, VALUE_MAX)}」${typeLabel ? ` (${typeLabel})` : ""}`,
        `담당자: ${contacts}명을 함께 등록합니다.`,
        "계산서 정보: 채우지 않습니다. 필요하면 결재함 승인으로 채웁니다.",
      ];
    }
    case "create_campaign_round": {
      const start = str(args.startDate);
      const end = str(args.endDate);
      if (!start || !end) return null;
      return [
        await targetLine(deps, "DEAL", str(args.dealId)),
        await targetLine(deps, "SELLER", str(args.sellerId)),
        `기간: ${start} ~ ${end}`,
      ];
    }
    default: {
      const lines: string[] = [];
      const type = proposal.targetEntityType;
      if (isResolvable(type) && proposal.targetEntityId) lines.push(await targetLine(deps, type, proposal.targetEntityId));
      const note = str(proposal.resultSummary);
      lines.push(note ? `${BRIEF_TEXT.botNotePrefix}${clip(note, BOT_NOTE_MAX)}` : BRIEF_TEXT.noDetail);
      return lines;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function buildSlackApprovalBrief(
  proposal: BriefProposal,
  deps: BriefDeps = defaultDeps,
): Promise<SlackApprovalBrief> {
  const payload = parseStoredJsonObject(proposal.payload);
  const action = typeof payload.action === "string" ? payload.action : "";
  const args = isPlainObject(payload.args) ? payload.args : {};
  const label = ACTION_LABELS[action] ?? "기안";
  const money = MONEY_ACTIONS.has(action);

  const built = await detailLines(action, args, proposal, deps);
  // 명세에서 내용을 못 만들면 봇 요약으로 메우지 않는다(R5) — 「전체 보기」로 보내고, 내용 필수 액션이면 버튼도 막는다.
  const complete = (built !== null && built.length > 0) || !CONTENT_REQUIRED_ACTIONS.has(action);
  const detail = built && built.length > 0 ? built : [BRIEF_TEXT.noDetail];

  return {
    heading: `${BRIEF_TEXT.headingPrefix}${label}`,
    lines: [...detail, BRIEF_TEXT.onApprove, BRIEF_TEXT.undo],
    caution: money ? BRIEF_TEXT.caution : null,
    complete,
  };
}
