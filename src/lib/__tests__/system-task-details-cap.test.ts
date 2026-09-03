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

  it.each([
    ["항목 하나가 거대한 배열", { failed: true, errors: ["가".repeat(6_000), "b", "c"] }],
    ["배열 안의 배열", { failed: true, rows: [Array.from({ length: 500 }, (_, i) => `행${i}: ${"값".repeat(30)}`)] }],
    [
      "작은 필드가 아주 많은 모양",
      Object.fromEntries([
        ["failed", true],
        ...Array.from({ length: 200 }, (_, i) => [`g${i}`, { errors: [`e${i}: ${"사유".repeat(20)}`] }]),
      ]),
    ],
  ])("%s 도 상한 안으로 들여보낸다", (_name, input) => {
    // ⚠️ 이 세 모양은 전부 리뷰가 **실측으로** 잡아낸 초과 경로다. 각각 다른 이유로 새어
    // 나갔다: 배열 원소 문자열을 후보로 안 셌고, 배열 안의 배열을 못 봤고, 줄일 자리가
    // 없는데 통째로 들어내지 않았다.
    expect(JSON.stringify(input).length).toBeGreaterThan(4_000);

    const capped = capDetailsForLog(input) as Record<string, unknown>;

    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(4_000);
    expect(capped.failed).toBe(true); // 판정 필드는 어느 경로에서도 살아남는다
    expect(capped.detailsTrimmed).toBeTruthy();
  });

  it("표시 숫자가 실제로 덜어낸 양과 일치한다(여러 회차에 걸쳐 줄여도)", () => {
    // ⚠️ 같은 자리를 여러 회차에 걸쳐 줄이는데 덮어쓰면 마지막 회차 몫만 남는다.
    // 실측으로 149건을 잃고 1건이라 적은 적이 있다 — 표시가 있으되 숫자가 틀리면
    // 읽는 사람이 "거의 다 남았다"고 믿어, 없는 것보다 나쁘다.
    const input = {
      failed: true,
      needsReviewDetail: [
        {
          key: "k1",
          reasons: Array.from({ length: 200 }, (_, i) => ({ code: `C${i}`, message: "사유".repeat(20) })),
        },
      ],
    };
    const capped = capDetailsForLog(input) as Record<string, unknown>;

    const kept = ((capped.needsReviewDetail as Array<{ reasons: unknown[] }>)[0].reasons).length;
    const noted = (capped.detailsTrimmed as Record<string, number>)["needsReviewDetail[0].reasons"];
    expect(noted).toBe(200 - kept);
    // 목록 **안쪽**이 깎여도 화면이 쓰는 짝 표시는 세워진다.
    expect(capped.needsReviewDetailCapped).toBe(true);
  });

  it("배열 원소 안의 덩치도 줄인다(배열만 깎고 원소는 그대로 두지 않게)", () => {
    // ⚠️ 종전엔 배열 원소를 후보로 안 세어, 항목 하나가 거대하면 배열을 1건까지 깎고도
    // 그 1건이 6,000자라 그대로 새어 나갔다. 크기·`failed` 만 보는 단언은 이 회귀를
    // 못 잡는다(변이 생존 실측) — **원소가 실제로 짧아졌는지**를 본다.
    const capped = capDetailsForLog({
      failed: true,
      errors: ["가".repeat(6_000), "b", "c"],
    }) as Record<string, unknown>;

    const errors = capped.errors as string[];
    expect(Array.isArray(errors)).toBe(true); // 타입이 바뀌면 소비처가 터진다
    expect(errors[0].length).toBeLessThan(6_000); // 원소 자체가 줄었다
    expect(errors[0].startsWith("가")).toBe(true); // 앞부분은 남는다
  });

  it("배열 안의 배열도 줄인다", () => {
    const capped = capDetailsForLog({
      failed: true,
      rows: [Array.from({ length: 500 }, (_, i) => `행${i}: ${"값".repeat(30)}`)],
    }) as Record<string, unknown>;

    const rows = capped.rows as string[][];
    expect(Array.isArray(rows[0])).toBe(true);
    expect(rows[0].length).toBeLessThan(500);
    expect(rows[0].length).toBeGreaterThan(0);
  });

  it("잡이 같은 이름을 쓰고 있으면 그 값을 덮지 않는다", () => {
    // ⚠️ 후보 이름을 하나만 두면 그것마저 쓰일 때 남의 값을 지운다(실측). 빈 자리를
    // 찾을 때까지 접미를 늘린다.
    const capped = capDetailsForLog({
      failed: true,
      detailsTrimmed: { mineToo: 2 },
      detailsTrimmed2: { alsoMine: 3 },
      errors: Array.from({ length: 120 }, (_, i) => `e${i}: ${"사유".repeat(40)}`),
    }) as Record<string, unknown>;

    expect(capped.detailsTrimmed).toEqual({ mineToo: 2 });
    expect(capped.detailsTrimmed2).toEqual({ alsoMine: 3 });
    expect(capped.detailsTrimmed3).toBeTruthy(); // 우리 표시는 빈 자리로 갔다
  });

  it("최후 수단으로 비울 때도 진단 배열과 확인필요 목록은 지키고 타입도 유지한다", () => {
    // ⚠️ 순위를 안 보고 비우면 순위 도입이 지키려던 것을 같은 함수가 지운다. 그리고
    // 배열을 문자열로 바꾸면 `errors.map()` 쓰는 소비처가 그 자리에서 터진다(리뷰 실측).
    const input = Object.fromEntries([
      ["failed", true],
      ["errors", Array.from({ length: 60 }, (_, i) => `e${i}: ${"사유".repeat(20)}`)],
      ["needsReviewDetail", Array.from({ length: 20 }, (_, i) => ({ key: `k${i}` }))],
      // 비워질 쪽 — 보호 대상이 아니고 덩치가 크다.
      ["debugRows", Array.from({ length: 400 }, (_, i) => ({ i, note: "값".repeat(10) }))],
      ...Array.from({ length: 300 }, (_, i) => [`g${i}`, { x: "값".repeat(10) }]),
    ]);
    const capped = capDetailsForLog(input) as Record<string, unknown>;

    // 지켜야 할 것은 배열로 살아남는다.
    expect(Array.isArray(capped.errors)).toBe(true);
    expect((capped.errors as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(capped.needsReviewDetail)).toBe(true);
    expect((capped.needsReviewDetail as unknown[]).length).toBeGreaterThan(0);
    // ⚠️ 비운 자리도 **타입은 유지**한다 — 문자열로 바꾸면 `rows.map()` 쓰는 소비처가
    // 그 자리에서 터진다(단언이 보호 필드만 보면 이 회귀를 못 잡는다 — 변이로 겪었다).
    expect(Array.isArray(capped.debugRows)).toBe(true);
    expect((capped.debugRows as unknown[]).length).toBe(0);
  });

  it("요약 스칼라만으로 넘치면 줄이지 않고 넘쳤다는 사실만 남긴다", () => {
    // 판정 근거를 줄이느니 봉투를 넘긴다 — 다만 조용히 넘기지는 않는다.
    const scalarsOnly = Object.fromEntries([
      ["failed", true],
      ...Array.from({ length: 400 }, (_, i) => [`집계${i}`, i]),
    ]);
    const capped = capDetailsForLog(scalarsOnly) as Record<string, unknown>;

    expect(capped.failed).toBe(true);
    expect(capped["집계399"]).toBe(399); // 하나도 버리지 않았다
    expect((capped.detailsTrimmed as Record<string, number>).overCap).toBeGreaterThan(4_000);
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

  it("진단 배열보다 값이 낮은 배열을 먼저 줄인다", () => {
    // ⚠️ 크기순으로만 줄이면 **가장 값진 것을 먼저 잃는다.** 실측(리뷰): 셀러 전량 실패
    // 회차에서 `errors` 가 3건까지 깎이는 동안 `handles` 는 전량 살아남아 예산을 점유했다 —
    // 그 이름들은 각 `errors` 문자열 안에 이미 들어 있는데도.
    const capped = capDetailsForLog({
      failed: true,
      handles: Array.from({ length: 120 }, (_, i) => `아주긴핸들이름${i}`),
      errors: Array.from({ length: 120 }, (_, i) => `핸들${i} 실패: ${"사유".repeat(40)}`),
    }) as Record<string, unknown>;

    const errors = capped.errors as string[];
    const handles = capped.handles as string[];
    // 값이 낮은 쪽이 먼저 깎이고, 진단 배열이 더 많이 살아남는다.
    expect(handles.length).toBeLessThan(120);
    expect(errors.length).toBeGreaterThan(handles.length);
  });

  it("같은 값어치끼리는 덩치 큰 것부터 줄인다", () => {
    const capped = capDetailsForLog({
      failed: true,
      small: Array.from({ length: 8 }, (_, i) => `s${i}`),
      large: Array.from({ length: 80 }, (_, i) => `${i}: ${"내역".repeat(50)}`),
    }) as Record<string, unknown>;

    expect((capped.small as string[]).length).toBe(8); // 작은 쪽은 온전
    expect((capped.large as string[]).length).toBeLessThan(80);
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
