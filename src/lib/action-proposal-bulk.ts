/**
 * 기안 일괄 승인의 **요청·응답 계약**(순수·client-safe).
 *
 * 서버(`POST /api/action-proposals/bulk-approve` · `bulkApproveProposals`)와 화면
 * (`runBulkApprove` · 결재함 대기 탭)이 같은 모양을 읽는다 — 한쪽만 필드를 바꾸면
 * 요약 숫자가 조용히 0 이 되므로 타입을 한 곳에 둔다.
 */

/** 한 번의 요청이 받는 기안 수 상한. 화면은 이보다 작은 묶음으로 나눠 보낸다. */
export const BULK_APPROVE_MAX_IDS = 50;

/**
 * 건별 결과의 세 갈래.
 * - `executed`: 승인과 실행이 커밋됐다(CRM 데이터가 바뀌었다).
 * - `failed`: 승인을 시도했지만 실행되지 않았다 — 운영자가 볼 이유가 있다.
 * - `skipped`: 이미 처리됐거나 승인할 수 있는 상태가 아니라 손대지 않았다.
 */
export type BulkApproveOutcome = "executed" | "failed" | "skipped";

export type BulkApproveItemResult = {
  id: string;
  /** `outcome === "executed"` 와 같다 — 호출부가 문자열 비교 없이 거를 수 있게 둔다. */
  ok: boolean;
  outcome: BulkApproveOutcome;
  /** 처리 직후 기안 상태. 기안이 없거나 읽지 못했으면 null. */
  status: string | null;
  /** 실패·건너뜀 사유(한글). 실행 완료에도 후속 처리 경고가 있으면 담긴다. */
  error?: string;
};

export type BulkApproveCounts = {
  total: number;
  executed: number;
  failed: number;
  skipped: number;
};

export type BulkApproveResponse = {
  results: BulkApproveItemResult[];
  counts: BulkApproveCounts;
};

export function countBulkApproveResults(results: readonly BulkApproveItemResult[]): BulkApproveCounts {
  const counts: BulkApproveCounts = { total: results.length, executed: 0, failed: 0, skipped: 0 };
  for (const item of results) counts[item.outcome] += 1;
  return counts;
}

/**
 * 화면이 한 번에 보내는 묶음 크기. 서버 상한(50)보다 작게 잘라 보내는 이유는 **진행률**이다 —
 * 요청 하나에 다 실으면 끝날 때까지 「몇 건 남았는지」를 알릴 방법이 없다. 더 잘게(1건씩)
 * 자르면 요청마다 붙는 인증 왕복이 건수만큼 늘어 하루치 결재가 눈에 띄게 느려진다.
 */
export const BULK_APPROVE_CHUNK_SIZE = 5;

export type RunBulkApproveOptions = {
  /** 묶음 하나가 끝날 때마다 (처리한 건수, 전체 건수)로 불린다. */
  onProgress?: (done: number, total: number) => void;
  chunkSize?: number;
  fetchImpl?: typeof fetch;
};

const REQUEST_REJECTED_PREFIX = "서버가 요청을 받지 않아 처리하지 않았습니다";
const NO_RESPONSE_MESSAGE = "응답을 받지 못했습니다. 처리 여부는 목록에서 확인해 주세요.";
const UNREADABLE_RESPONSE_MESSAGE =
  "응답을 읽을 수 없어 멈췄습니다. 다시 로그인한 뒤 목록에서 처리 여부를 확인해 주세요.";

function failAll(ids: readonly string[], error: string): BulkApproveItemResult[] {
  return ids.map((id) => ({ id, ok: false, outcome: "failed" as const, status: null, error }));
}

/**
 * 고른 기안을 묶음으로 나눠 **순서대로** 일괄 승인 라우트에 보낸다(묶음끼리도 순차).
 *
 * 묶음 요청 자체가 실패했을 때:
 * - 4xx(권한·검증): 서버가 처리 전에 거절한 것이 확실하다. 같은 이유로 남은 묶음도 거절될
 *   것이므로 **더 보내지 않고** 남은 건까지 같은 사유의 실패로 적는다.
 * - 200 인데 결과 목록이 없음(세션 만료로 로그인 화면이 온 경우 등): 4xx 와 같이 멈춘다.
 * - 5xx·네트워크 오류: 서버가 일부를 처리했을 수 있다. 그 묶음은 「처리 여부 확인 필요」
 *   실패로 적고 다음 묶음은 계속 보낸다 — 건별 CAS 가 중복 실행을 막는다.
 *
 * 던지지 않는다 — 결과는 언제나 고른 순서 그대로의 건별 목록이다.
 */
export async function runBulkApprove(
  ids: readonly string[],
  options: RunBulkApproveOptions = {}
): Promise<BulkApproveResponse> {
  const chunkSize = Math.max(1, Math.min(options.chunkSize ?? BULK_APPROVE_CHUNK_SIZE, BULK_APPROVE_MAX_IDS));
  const fetchImpl = options.fetchImpl ?? fetch;
  const results: BulkApproveItemResult[] = [];

  for (let start = 0; start < ids.length; start += chunkSize) {
    const chunk = ids.slice(start, start + chunkSize);
    let response: Response;
    try {
      response = await fetchImpl("/api/action-proposals/bulk-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chunk }),
      });
    } catch {
      results.push(...failAll(chunk, NO_RESPONSE_MESSAGE));
      options.onProgress?.(results.length, ids.length);
      continue;
    }

    const body = (await response.json().catch(() => null)) as
      | (Partial<BulkApproveResponse> & { error?: string })
      | null;

    if (response.ok && Array.isArray(body?.results)) {
      // 서버가 돌려준 건만 믿고, 빠진 id 가 있으면 확인 필요로 채운다(응답 모양이 어긋나도
      // 고른 건수와 요약 건수가 같게 유지된다).
      const byId = new Map(body.results.map((item) => [item.id, item]));
      for (const id of chunk) {
        results.push(byId.get(id) ?? failAll([id], NO_RESPONSE_MESSAGE)[0]);
      }
    } else if (response.ok) {
      // 200 인데 결과 목록이 없다 — 대개 세션이 끊겨 로그인 화면으로 돌려보내진 경우다(프록시가
      // 307 → 로그인 HTML 200). 남은 묶음도 같은 대답을 받을 것이므로 더 보내지 않는다.
      results.push(...failAll(ids.slice(start), UNREADABLE_RESPONSE_MESSAGE));
      options.onProgress?.(results.length, ids.length);
      break;
    } else if (response.status >= 400 && response.status < 500) {
      const reason = body?.error ? `${REQUEST_REJECTED_PREFIX}: ${body.error}` : `${REQUEST_REJECTED_PREFIX} (응답 코드 ${response.status}).`;
      results.push(...failAll(ids.slice(start), reason));
      options.onProgress?.(results.length, ids.length);
      break;
    } else {
      results.push(...failAll(chunk, NO_RESPONSE_MESSAGE));
    }
    options.onProgress?.(results.length, ids.length);
  }

  return { results, counts: countBulkApproveResults(results) };
}
