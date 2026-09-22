import { formatDateTimeWithYear } from "./format-time";

/**
 * 조회 결과를 **모양을 모르는 채로** 그리는 두 기본기 (Plan 2 Task 5).
 *
 * 결재함에 쌓이는 봇 기록은 도구마다 모양이 다르고, 도구가 늘거나 필드가 바뀌면
 * 전용 뷰가 없는 기록이 그대로 남는다. 그때 화면이 비면 운영자는 **무슨 일이
 * 있었는지 알 길이 없다** — 그래서 마지막 갈래는 언제나 "있는 그대로 보여주기"다.
 *
 * ⛔ 여기에 도메인 지식(열 이름 한글화·단위·정렬 규칙)을 넣지 말 것. 넣는 순간 전용
 * 뷰의 열등한 사본이 되고, 그 사본은 도구가 바뀌어도 조용히 낡는다.
 */

/** 한 번에 그리는 행 상한 — 이 위로는 화면이 아니라 파일로 볼 것이다. */
export const MAX_TABLE_ROWS = 200;

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

/**
 * 셀 하나의 표기. 값이 없으면 빈 칸이 아니라 `-` 다(빈 칸은 「깨졌나」로 읽힌다).
 *
 * 날짜에는 **연도를 남긴다** — 이 표는 목록 카드와 달리 「최근」이라는 전제가 없다.
 * 숫자는 천 단위 구분을 넣는다(자리수를 눈으로 세는 것이 이 표의 유일한 용도일 때가 많다).
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") {
    return ISO_DATE_PREFIX.test(value) ? formatDateTimeWithYear(value) : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString("ko-KR");
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * 열 = 주어진 행들의 키 합집합, 순서는 **처음 등장한 순서**(행마다 키가 다를 수 있다).
 * ⚠️ 호출자는 **화면에 그릴 행만** 넘긴다 — 잘려 나간 뒤쪽 행에만 있는 키로 열을 만들면
 * 그 열은 표 전체가 `-` 로 채워진 빈 칸이 된다(없는 데이터를 있는 것처럼 보이게 한다).
 */
export function unionColumns(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

export function GenericTable({ rows }: { rows: ReadonlyArray<Record<string, unknown>> }) {
  const visible = rows.slice(0, MAX_TABLE_ROWS);
  const columns = unionColumns(visible);

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table data-slot="generic-table" className="w-full border border-border text-left">
          <thead className="bg-muted">
            <tr>
              {columns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="border-b border-border px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-slate-500"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-xs">
            {visible.map((row, index) => (
              <tr key={index} className="border-b border-border last:border-b-0">
                {columns.map((column) => (
                  <td key={column} className="px-2 py-1.5 align-top text-foreground">
                    {formatCellValue(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > visible.length && (
        <p className="text-xs text-muted-foreground">앞 {MAX_TABLE_ROWS}행만 표시합니다.</p>
      )}
    </div>
  );
}

/**
 * 배열이 아닌 결과(요약 객체·옛 기록)를 그대로 펼친다. 키는 저장된 원문 그대로
 * 둔다 — 한글로 옮기려면 어느 도구의 어느 필드인지 알아야 하는데, 이 갈래는
 * 정확히 "그걸 모를 때" 오는 자리다.
 */
export function KeyValueList({ value }: { value: unknown }) {
  const entries = Object.entries((value ?? {}) as Record<string, unknown>);
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">저장된 결과가 없습니다.</p>;
  }

  return (
    <dl data-slot="kv-list" className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
      {entries.map(([key, entryValue]) => (
        <div key={key} className="contents">
          <dt className="truncate text-xs text-muted-foreground">{key}</dt>
          <dd className="break-all text-sm tabular-nums text-foreground">
            {formatCellValue(entryValue)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
