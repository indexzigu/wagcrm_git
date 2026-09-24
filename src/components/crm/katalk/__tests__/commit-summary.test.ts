import { describe, expect, it } from "vitest";
import { summarizeCommitResult } from "../commit-summary";

/**
 * 종전에는 개별 실패와 무관하게 「업로드 확정이 완료되었습니다」를 띄웠다(interfaces 점검 #10).
 * 실패가 하나라도 있으면 성공처럼 읽히지 않아야 한다.
 */
describe("summarizeCommitResult", () => {
  it("전부 성공이면 성공 한 줄", () => {
    expect(summarizeCommitResult(3, 0)).toEqual({ kind: "success", message: "3건 업로드를 확정했습니다." });
  });

  it("일부 실패면 확정·실패 건수를 함께 말하는 오류", () => {
    const summary = summarizeCommitResult(2, 1);
    expect(summary.kind).toBe("error");
    expect(summary.message).toBe("2건 확정, 1건 실패했습니다.");
  });

  it("전부 실패면 성공 건수를 말하지 않는 오류", () => {
    const summary = summarizeCommitResult(0, 2);
    expect(summary.kind).toBe("error");
    expect(summary.message).toBe("2건 모두 확정하지 못했습니다.");
  });

  it("실패가 있으면 실재하는 복구 경로(같은 파일 다시 올리기)를 준다", () => {
    const summary = summarizeCommitResult(1, 1);
    // 확정 버튼은 미리보기가 끝난 파일만 보낸다 — 실패 파일을 「다시 확정」할 길은 없다.
    expect(summary.kind === "error" && summary.description).toContain("다시 올려");
    expect(summary.kind === "error" && summary.description).not.toContain("다시 확정");
  });
});
