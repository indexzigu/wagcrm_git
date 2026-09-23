import { TOOL_RESULT_RENDERERS, hasToolResultRenderer } from "./tool-result-views";
import { GenericTable, KeyValueList } from "./result-primitives";

/**
 * ReadResultBody — 결재함 상세의 조회 결과 본문 (Plan 2 Task 5).
 *
 * 봇 워커가 남기는 봉투는 `{ operation, jobId, query, truncated, data }` 다
 * (정본: `src/lib/agent-worker/read-result-record.ts`). 웹 채팅 시절의 READ 기록은
 * 봉투가 아니라 toolCalls **배열**이다 — 두 세대가 같은 목록에 섞여 있으므로 이
 * 컴포넌트는 **어느 쪽이 와도 무언가는 보여준다**.
 *
 * 갈래는 셋이고 순서가 곧 계약이다:
 *  ① 그 도구 전용 리치 뷰가 이 데이터를 그릴 수 있으면 그것(`hasToolResultRenderer`).
 *  ② 아니면 `data.items` 가 객체 배열일 때 제네릭 표.
 *  ③ 아니면 key/value 목록.
 *
 * ⛔ ①의 판정을 여기서 다시 쓰지 말 것 — 뷰의 타입가드가 정본이다. 뷰를 먼저 그려
 * 보고 `null` 이면 갈아끼우는 방식도 쓰지 않는다(렌더 도중 분기는 리액트에서
 * 「빈 화면」과 구별이 안 된다).
 */

export type ReadEnvelope = {
  operation: string;
  jobId?: string | null;
  query?: Record<string, unknown> | null;
  truncated?: boolean;
  data?: unknown;
};

export function isReadEnvelope(value: unknown): value is ReadEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof (value as Record<string, unknown>).operation === "string";
}

/** 목록형 결과인가 — `items` 가 배열이면 그렇다(비어 있어도 목록형이다). */
function listItemsOf(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const items = (payload as Record<string, unknown>).items;
  return Array.isArray(items) ? items : null;
}

/** 표로 그릴 수 있는 모양인가 — 행이 전부 객체여야 열을 만들 수 있다. */
function toTableRows(items: unknown[]): Record<string, unknown>[] | null {
  if (items.length === 0) return null;
  const isFlatObject = (row: unknown) => !!row && typeof row === "object" && !Array.isArray(row);
  if (!items.every(isFlatObject)) return null;
  return items as Record<string, unknown>[];
}

/** 0건은 고장이 아니다 — 조건에 맞는 것이 없었다는 **답**이므로 그렇게 말한다. */
export const EMPTY_RESULT_MESSAGE = "조회 결과가 0건입니다.";

export function ReadResultBody({ envelope }: { envelope: unknown }) {
  const isEnvelope = isReadEnvelope(envelope);
  const operation = isEnvelope ? envelope.operation : null;
  const payload = isEnvelope ? envelope.data : envelope;

  // 잘린 기록의 `data` 는 결과가 아니라 마커(`{ truncated, bytes }`)다 — 그 두 줄을
  // key/value 로 펼치면 운영자는 그것을 **조회 결과로 읽는다**(바이트 수가 데이터인
  // 것처럼 보인다). 무슨 일이 있었는지는 머리의 고지 줄(`TRUNCATED_NOTE`)이 이미
  // 말하므로, 본문은 아무 말도 하지 않는 편이 정확하다.
  if (isEnvelope && envelope.truncated === true) return null;

  return (
    <div data-slot="read-result-body" className="flex flex-col gap-3">
      {renderPayload(operation, payload)}
    </div>
  );
}

function renderPayload(operation: string | null, payload: unknown) {
  if (payload === null || payload === undefined) {
    return <p className="text-sm text-muted-foreground">저장된 결과가 없습니다.</p>;
  }

  if (operation && hasToolResultRenderer(operation, payload)) {
    const View = TOOL_RESULT_RENDERERS[operation];
    // 상세 화면은 이미 카드 안이다 — 뷰의 테두리 한 겹을 끈다(카드 속 카드 금지).
    return <View data={payload} bare />;
  }

  const items = listItemsOf(payload);
  if (items) {
    // ⛔ 빈 목록을 key/value 로 흘려보내지 말 것 — `items → []`, `rowLimitReached → false`
    // 두 줄은 운영자에게 아무 말도 하지 않는다(모양이 깨진 것처럼 보이기까지 한다).
    if (items.length === 0) {
      return <p className="text-sm text-muted-foreground">{EMPTY_RESULT_MESSAGE}</p>;
    }
    const rows = toTableRows(items);
    if (rows) return <GenericTable rows={rows} caption="조회 결과 표" />;
  }

  if (typeof payload !== "object") {
    return <p className="text-sm text-foreground">{String(payload)}</p>;
  }

  return <KeyValueList value={payload} />;
}
