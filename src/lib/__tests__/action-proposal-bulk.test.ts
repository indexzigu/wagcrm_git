/**
 * runBulkApprove — 화면의 일괄 승인 묶음 전송기.
 *
 * ① 고른 순서대로 묶음을 나눠 **순차** 전송하고, 묶음마다 진행률을 알린다
 * ② 서버 결과를 고른 순서대로 이어 붙이고 집계한다
 * ③ 4xx(권한·검증)는 남은 묶음을 보내지 않고 같은 사유의 실패로 채운다
 * ④ 5xx·네트워크 오류는 그 묶음만 「처리 여부 확인 필요」로 적고 다음 묶음을 계속 보낸다
 * ⑤ 던지지 않는다
 */
import { describe, expect, it, vi } from "vitest";
import {
  BULK_APPROVE_CHUNK_SIZE,
  countBulkApproveResults,
  runBulkApprove,
  type BulkApproveItemResult,
} from "../action-proposal-bulk";

function okResponse(ids: string[]): Response {
  const results: BulkApproveItemResult[] = ids.map((id) => ({ id, ok: true, outcome: "executed", status: "EXECUTED" }));
  return new Response(JSON.stringify({ results, counts: countBulkApproveResults(results) }), { status: 200 });
}

function sentIds(call: unknown[]): string[] {
  return JSON.parse((call[1] as RequestInit).body as string).ids;
}

describe("runBulkApprove", () => {
  it("묶음 크기로 나눠 순서대로 보내고 묶음마다 진행률을 알린다", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) =>
      okResponse(JSON.parse(init.body as string).ids)
    );
    const onProgress = vi.fn();
    const ids = ["a", "b", "c", "d", "e"];

    const response = await runBulkApprove(ids, {
      chunkSize: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onProgress,
    });

    expect(fetchImpl.mock.calls.map(sentIds)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/action-proposals/bulk-approve");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: "POST" });
    expect(onProgress.mock.calls).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
    expect(response.results.map((item) => item.id)).toEqual(ids);
    expect(response.counts).toEqual({ total: 5, executed: 5, failed: 0, skipped: 0 });
  });

  it("기본 묶음 크기는 서버 상한보다 작다(진행률을 알릴 수 있게)", () => {
    expect(BULK_APPROVE_CHUNK_SIZE).toBeLessThan(50);
  });

  it("4xx 면 남은 묶음을 보내지 않고 남은 건 전부를 같은 사유의 실패로 적는다", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse(["a", "b"]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }));

    const response = await runBulkApprove(["a", "b", "c", "d", "e"], {
      chunkSize: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.counts).toEqual({ total: 5, executed: 2, failed: 3, skipped: 0 });
    expect(response.results.slice(2).every((item) => item.error?.includes("Forbidden"))).toBe(true);
  });

  it("5xx·네트워크 오류는 그 묶음만 실패로 적고 다음 묶음을 계속 보낸다", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response("oops", { status: 500 }))
      .mockResolvedValueOnce(okResponse(["e"]));

    const response = await runBulkApprove(["a", "b", "c", "d", "e"], {
      chunkSize: 2,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(response.results.map((item) => item.outcome)).toEqual(["failed", "failed", "failed", "failed", "executed"]);
    expect(response.results[0].error).toMatch(/처리 여부/);
  });

  it("200 인데 결과 목록이 없으면(세션 만료로 로그인 화면이 온 경우) 남은 묶음을 보내지 않는다", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<html>login</html>", { status: 200 }));

    const response = await runBulkApprove(["a", "b", "c"], {
      chunkSize: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.counts).toEqual({ total: 3, executed: 0, failed: 3, skipped: 0 });
    expect(response.results[0].error).toMatch(/다시 로그인/);
  });

  it("서버 응답에 빠진 id 는 확인 필요 실패로 채워 건수를 맞춘다", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(okResponse(["a"]));

    const response = await runBulkApprove(["a", "b"], { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(response.results.map((item) => [item.id, item.outcome])).toEqual([
      ["a", "executed"],
      ["b", "failed"],
    ]);
  });
});
