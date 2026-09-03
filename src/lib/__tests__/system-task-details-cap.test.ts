import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ getPrisma: vi.fn() }));

import { getPrisma } from "@/lib/prisma";
import { capDetailsForLog, recordSystemTaskRun } from "@/lib/system-task-status";

/**
 * `SystemTaskLog.details` 저장 상한 처리.
 *
 * **왜 이 파일이 있나(T-084):** 종전 구현은 상한을 넘으면 **직렬화 문자열을 그 자리에서
 * 싹둑 잘라** `{ truncated, preview }` 로 남겼다. 그 조각은 JSON 중간에서 끊긴 문자열이라
 * 기계로 읽을 수 없고, 뒤쪽에 있던 **요약 필드(실패 여부·사유·집계)까지 함께 사라진다** —
 * 정작 사고를 판정할 때 가장 먼저 보는 값들이다.
 *
 * 덩치의 정체는 언제나 **반복 항목 배열**(`errors[]`·`skipped[]`·`failures[]`)이므로,
 * 문자열을 자르는 대신 그 배열만 줄이고 나머지는 통째로 보존한다. 레포에 같은 사상의
 * 선례가 있다(`serializeToolCalls` — 상한 초과 시 덩치 큰 필드만 버리고 진단 필드는 남긴다).
 */
describe("capDetailsForLog — 이력 저장 상한", () => {
  it("상한 미만이면 손대지 않는다", () => {
    const details = { ok: true, failed: false, errors: ["가"], durationMs: 12 };

    expect(capDetailsForLog(details)).toEqual(details);
  });

  it("넘치면 항목 배열만 줄이고 요약 필드는 전부 남긴다", () => {
    const errorItems = Array.from({ length: 40 }, (_, i) => `핸들${i} 실패: ${"사유".repeat(60)}`);
    const oversized = {
      failed: true,
      failureReason: "대상 전원 실패",
      handlesFailed: 40,
      errors: errorItems,
    };
    // 픽스처가 실제로 상한을 넘는지 못박는다 — 안 넘으면 이 테스트는 아무것도 검증하지 않는다.
    expect(JSON.stringify(oversized).length).toBeGreaterThan(4_000);

    const capped = capDetailsForLog(oversized) as Record<string, unknown>;

    // 판정에 먼저 보는 값들은 절대 사라지지 않는다 — 종전엔 이것들이 꼬리에 있으면 잘렸다.
    expect(capped.failed).toBe(true);
    expect(capped.failureReason).toBe("대상 전원 실패");
    expect(capped.handlesFailed).toBe(40);
    // 배열은 줄어들되 남은 것은 온전한 항목이다(문자열 중간에서 끊기지 않는다).
    const errors = capped.errors as string[];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.length).toBeLessThan(40);
    expect(errors[0]).toBe(errorItems[0]);
    // 줄인 결과는 상한 안에 든다.
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(4_000);
  });

  it("몇 건을 덜어냈는지 남긴다(조용히 줄이지 않는다)", () => {
    const items = Array.from({ length: 40 }, (_, i) => `핸들${i} 실패: ${"사유".repeat(60)}`);
    const capped = capDetailsForLog({ failed: true, errors: items }) as Record<string, unknown>;

    const kept = (capped.errors as string[]).length;
    // 이 표시가 없으면 "원래 그만큼이었다"와 "우리가 줄였다"를 구분할 수 없다.
    expect(capped.truncated).toEqual({ errors: items.length - kept });
  });

  it("결과는 언제나 다시 읽을 수 있는 형태다(문자열 중간에서 끊기지 않는다)", () => {
    const capped = capDetailsForLog({
      failed: true,
      errors: Array.from({ length: 40 }, (_, i) => `핸들${i}: ${"사유".repeat(60)}`),
    });

    // 종전 구현은 여기서 깨진 JSON 조각을 남겼다.
    expect(() => JSON.parse(JSON.stringify(capped))).not.toThrow();
  });

  it("배열을 다 줄여도 넘치면 그 사실을 남긴다(요약은 여전히 보존)", () => {
    // 덩치가 배열이 아니라 거대한 문자열 하나인 경우 — 줄일 배열이 없다.
    const capped = capDetailsForLog({
      failed: true,
      failureReason: "설명이 아주 긴 사고",
      note: "가".repeat(5_000),
    }) as Record<string, unknown>;

    // 판정 필드는 살아 있어야 한다 — 여기가 종전 구현이 가장 크게 실패하던 자리다.
    expect(capped.failed).toBe(true);
    expect(capped.failureReason).toBe("설명이 아주 긴 사고");
    expect(capped.truncated).toBeTruthy();
  });
});

/**
 * 상한이 걸리는 **자리**에 대한 회귀.
 *
 * **왜 이 절이 있나(T-084):** 종전엔 상한이 `toDetails`(HTTP 응답을 해석하는 자리)에만
 * 있었다. 그런데 같은 잡이 두 레인으로 돈다 — 예약 실행은 HTTP 라우트를 타지만, 로컬
 * 러너(`scripts/capture-stories-local.ts`)는 `recordSystemTaskRun` 을 **직접** 부른다.
 * 그래서 같은 잡인데 **어느 레인으로 돌았느냐에 따라 저장 규칙이 달랐다.**
 * 상한은 응답을 해석하는 자리가 아니라 **쓰는 자리**에 있어야 한다.
 */
describe("recordSystemTaskRun — 상한은 쓰는 지점에서 걸린다", () => {
  const logCreate = vi.fn();

  beforeEach(() => {
    logCreate.mockReset().mockResolvedValue({});
    vi.mocked(getPrisma).mockReturnValue({
      systemTaskStatus: { upsert: vi.fn().mockResolvedValue({}) },
      systemTaskLog: { create: logCreate },
    } as unknown as ReturnType<typeof getPrisma>);
  });

  it("직접 호출(로컬 러너 레인)로 넘긴 페이로드도 상한 안으로 줄여 저장한다", async () => {
    const huge = {
      ok: true,
      failed: true,
      failureReason: "대상 전원 실패",
      lane: "local",
      errors: Array.from({ length: 60 }, (_, i) => `핸들${i} 실패: ${"사유".repeat(60)}`),
    };
    expect(JSON.stringify(huge).length).toBeGreaterThan(4_000);

    await recordSystemTaskRun("capture-stories", "ERROR", "대상 전원 실패", huge, 1_234);

    const saved = logCreate.mock.calls[0][0].data.details as Record<string, unknown>;
    expect(JSON.stringify(saved).length).toBeLessThanOrEqual(4_000);
    // 줄이되 판정 필드와 계측은 남는다.
    expect(saved.failed).toBe(true);
    expect(saved.failureReason).toBe("대상 전원 실패");
    expect(saved.lane).toBe("local");
    expect(saved.durationMs).toBe(1_234);
    expect(saved.truncated).toBeTruthy();
  });
});
