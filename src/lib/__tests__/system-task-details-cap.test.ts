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
    expect(capped.detailsTrimmed).toEqual({ errors: items.length - kept });
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
    expect(capped.detailsTrimmed).toBeTruthy();
  });

  it("덩치가 중첩 객체 안에 있어도 상한을 넘긴 채 조용히 저장하지 않는다", () => {
    // 최상위엔 줄일 배열도 긴 문자열도 없고, 덩치가 한 겹 아래에 있는 모양.
    const nested = {
      failed: true,
      failureReason: "중첩 구조",
      detail: { errors: Array.from({ length: 60 }, (_, i) => `${i}: ${"사유".repeat(60)}`) },
    };
    expect(JSON.stringify(nested).length).toBeGreaterThan(4_000);

    const capped = capDetailsForLog(nested) as Record<string, unknown>;

    expect(capped.failed).toBe(true);
    expect(capped.failureReason).toBe("중첩 구조");
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(4_000);
    // ⚠️ 한 겹 아래라는 이유로 **통째로 버리지 않는다** — 안쪽 배열을 줄여 필요한 만큼만
    // 잃는다(실제 잡 중에 `engagement.errors` 같은 중첩 배열을 내는 것이 있다).
    const detail = capped.detail as { errors: string[] };
    expect(Array.isArray(detail.errors)).toBe(true);
    expect(detail.errors.length).toBeGreaterThan(0);
    expect(detail.errors.length).toBeLessThan(60);
    expect(capped.detailsTrimmed).toEqual({ "detail.errors": 60 - detail.errors.length });
  });

  it("요약 문자열은 맨 나중에 줄인다(판정 근거를 먼저 잃지 않게)", () => {
    // ⚠️ 요약이 상세 배열보다 **더 커야** 이 계약이 발동한다. 상세가 더 크면 크기순만으로도
    // 상세가 먼저 걸려, 후순위 규칙을 지워도 테스트가 통과한다(실측으로 겪음).
    const longReason = `대상 전원 실패: ${"사유".repeat(1_500)}`;
    const errorItems = Array.from({ length: 20 }, (_, i) => `${i}: ${"내역".repeat(30)}`);
    expect(longReason.length).toBeGreaterThan(JSON.stringify(errorItems).length);

    const capped = capDetailsForLog({
      failed: true,
      failureReason: longReason,
      errors: errorItems,
    }) as Record<string, unknown>;

    // 상세 배열을 줄여 상한을 맞출 수 있으면 요약 문자열은 손대지 않는다.
    expect(capped.failureReason).toBe(longReason);
    expect((capped.errors as string[]).length).toBeLessThan(errorItems.length);
  });

  it("배열을 깎으면 그 잡의 화면이 '전부'로 오해하지 않게 표시를 세운다", () => {
    // 이 규약을 쓰는 화면은 `needsReviewDetailCapped` 로 "다 못 보여준다"를 판단한다.
    // 저장부가 목록을 깎았는데 그 표시를 안 세우면, 부분 목록이 전부인 것처럼 보인다.
    const capped = capDetailsForLog({
      needsReviewDetail: Array.from({ length: 60 }, (_, i) => ({
        key: `k${i}`,
        reasons: [{ code: "X", message: "사유".repeat(30) }],
      })),
      needsReviewDetailCapped: false,
    }) as Record<string, unknown>;

    expect((capped.needsReviewDetail as unknown[]).length).toBeLessThan(60);
    expect(capped.needsReviewDetailCapped).toBe(true);
  });

  it("큰 배열부터 줄인다(작은 것을 먼저 비워 정보만 잃지 않게)", () => {
    // 작은 배열은 다 비워도 상한에 못 닿는다 — 순서가 뒤집히면 그걸 먼저 없애고도
    // 결국 큰 배열까지 손대게 되어, 아무 이득 없이 두 종류를 다 잃는다.
    const capped = capDetailsForLog({
      failed: true,
      handles: Array.from({ length: 12 }, (_, i) => `h${i}`),
      errors: Array.from({ length: 60 }, (_, i) => `${i}: ${"사유".repeat(60)}`),
    }) as Record<string, unknown>;

    expect((capped.handles as string[]).length).toBe(12); // 작은 쪽은 온전
    expect((capped.errors as string[]).length).toBeLessThan(60); // 큰 쪽에서 덜어냄
  });

  it("항목이 아무리 커도 최소 한 건은 남긴다(무엇이 실패했는지 아예 못 읽지 않게)", () => {
    const capped = capDetailsForLog({
      failed: true,
      errors: [`거대한 사유: ${"가".repeat(6_000)}`, "두 번째", "세 번째"],
    }) as Record<string, unknown>;

    // 한 건도 안 남기면 종류조차 못 가린다. 그래서 상한을 넘기더라도 하나는 지킨다.
    expect((capped.errors as string[]).length).toBeGreaterThanOrEqual(1);
  });

  it("요약이 예산을 거의 다 먹어도 문자열을 계열 가릴 만큼은 남긴다", () => {
    // ⚠️ 요약 필드로 예산을 미리 채운다. 이게 없으면 남길 길이가 넉넉히 계산돼
    // **하한에 도달하지 않고**, 하한 상수를 낮추는 변이를 못 잡는다(실측).
    const bulkySummary: Record<string, string> = {};
    // 남길 여유가 하한 아래로 내려갈 때까지 채운다 — 길이를 손으로 고르면 상한값이
    // 바뀔 때 조용히 하한을 비켜 가 이 계약이 공허해진다(실측으로 겪음).
    while (JSON.stringify(bulkySummary).length < 3_900) {
      bulkySummary[`집계${Object.keys(bulkySummary).length}`] = "값".repeat(24);
    }
    const capped = capDetailsForLog({
      ...bulkySummary,
      failed: true,
      note: `차단 화면입니다: ${"가".repeat(9_000)}`,
    }) as Record<string, unknown>;

    // 너무 짧게 자르면 "무슨 실패였나"를 못 읽는다.
    expect((capped.note as string).length).toBeGreaterThanOrEqual(200);
    expect(capped.note as string).toContain("차단 화면");
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
    expect(saved.detailsTrimmed).toBeTruthy();
  });
});
