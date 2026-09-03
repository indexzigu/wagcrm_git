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

  it("최후 수단이 실제로 도는 상황에서도 확인필요 목록을 비우지 않는다", () => {
    // ⚠️ 앞선 픽스처는 주 루프에서 이미 상한을 맞춰 **최후 수단에 도달하지 않았고**, 그래서
    // 보호 목록에서 이 키를 빼는 변이가 살아남았다(리뷰 실측). 주 루프 반복을 소진시킬 만큼
    // 잡다한 필드를 깔아 최후 수단까지 밀어 넣는다.
    // ⚠️ 목록이 **최후 수단의 첫 대상**이 되도록 만든다. 잡다한 필드가 더 크면 그것들만
    // 비우고 상한에 닿아 목록에 도달조차 하지 않는다(그래서 변이가 살아남았다).
    // 주 루프가 손댈 수 없게 항목은 1건, 안쪽 문자열은 짧게 둔다.
    const input = Object.fromEntries([
      ["failed", true],
      [
        "needsReviewDetail",
        [Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, `값${i}`]))],
      ],
      ...Array.from({ length: 300 }, (_, i) => [`bulk${i}`, { x: `값${i}` }]),
    ]);
    const capped = capDetailsForLog(input) as Record<string, unknown>;

    // 최후 수단이 실제로 돌았음을 확인한다(잡다한 필드가 비워졌다).
    const emptied = Array.from({ length: 300 }, (_, i) => capped[`bulk${i}`]).filter(
      (v) => v != null && typeof v === "object" && Object.keys(v as object).length === 0,
    );
    expect(emptied.length).toBeGreaterThan(0);
    // 그런데도 화면이 읽는 목록은 배열로 살아 있다.
    expect(Array.isArray(capped.needsReviewDetail)).toBe(true);
    expect((capped.needsReviewDetail as unknown[]).length).toBeGreaterThan(0);
  });

  it("표시 자리가 다 차도 잃은 양을 단위별로 합쳐 알린다", () => {
    // ⚠️ 종전엔 경로 수만 세어 13건이 사라져도 숫자가 안 남았고, 그다음엔 문자와 항목을
    // 한 자리에 합쳐 9,000자 손실을 9,000"건"으로 발표했다. 단위를 갈라 센다.
    const input = Object.fromEntries([
      ["failed", true],
      ...Array.from({ length: 20 }, (_, i) => [`s${i}`, "문".repeat(600)]),
    ]);
    const capped = capDetailsForLog(input) as Record<string, unknown>;
    const marker = capped.detailsTrimmed as Record<string, number>;

    // 문자로 줄인 몫은 문자 자리에만 합쳐진다.
    expect(marker.andMoreItems).toBeUndefined();
    // ⚠️ `> 0` 만 보면 "경로 수를 센다"로 바꿔도 통과한다(변이 생존 실측). 넘친 경로가
    // 한 자리씩만 셌다면 한 자리 수인데, 실제로는 문자 수라 수천이다 — 자릿수로 가른다.
    expect(marker.andMoreChars).toBeGreaterThan(1_000);
  });

  it("잡이 표시 이름을 쓰고 그 값이 크면 그것도 줄인다", () => {
    // ⚠️ 그 이름을 수집 대상에서 통째로 빼면 아무도 못 건드리는 자리가 되어, 잡이 거기에
    // 큰 값을 담으면 상한을 크게 넘긴 채 조용히 나간다(리뷰 실측 10,775자).
    const capped = capDetailsForLog({
      failed: true,
      detailsTrimmed: Array.from({ length: 200 }, (_, i) => `내가쓰는값${i}: ${"값".repeat(40)}`),
    }) as Record<string, unknown>;

    expect(Array.isArray(capped.detailsTrimmed)).toBe(true);
    const kept = (capped.detailsTrimmed as unknown[]).length;
    // ⚠️ `< 200` 만 보면 **통째로 비워진 0건**도 통과한다(변이 생존 실측). 수집 대상에서
    // 빼면 최후 수단이 통째로 비우는데, 그건 "줄였다"가 아니라 "다 잃었다"이다.
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(200);
    expect(capped.detailsTrimmed2).toBeTruthy(); // 우리 표시는 옆자리로
  });

  it("진단 배열을 품은 부모는 다른 것을 다 비운 뒤에 손댄다", () => {
    // ⚠️ 최후 수단의 보호 판정이 **루트 키만** 보면, 진단 배열이 한 겹 아래 있을 때 부모째
    // 비워져 사라진다. 실제로 그런 모양을 내는 잡이 있다(수집 결과를 감싼 뒤 그 안에 errors).
    const capped = capDetailsForLog(
      Object.fromEntries([
        ["failed", true],
        ["engagement", { errors: Array.from({ length: 40 }, (_, i) => `e${i}: ${"사유".repeat(20)}`), scanned: 40 }],
        ...Array.from({ length: 300 }, (_, i) => [`m${i}`, { x: `값${i}` }]),
      ]),
    ) as Record<string, unknown>;

    const engagement = capped.engagement as { errors?: unknown[] };
    expect(Array.isArray(engagement?.errors)).toBe(true);
    expect(engagement.errors!.length).toBeGreaterThan(0);
  });

  it("중첩된 error·message 는 요약 자격을 얻지 않는다", () => {
    // ⚠️ 요약 순위를 깊이 상관없이 주면, 안쪽 `message` 가 최상위 `failureReason` 과 같은
    // 자격을 얻어 **상위 진단 배열이 먼저 깎인다.** 요약은 최상위에서만이다.
    // ⚠️ **덩치를 배열에 담지 말 것** — 종전 픽스처는 안쪽 message 를 `detail` **배열**에
    // 담았는데, 그러면 순위 0 인 그 배열이 어느 쪽이든 먼저 깎여 **안쪽 문자열의 순위가
    // 결과에 관여하지 않는다**(`!prefix` 가드를 지워도 통과했다 — 변이 생존 실측).
    // 여기서는 `detail` 을 객체로 둬 후보에서 빼고, 경합을 **안쪽 문자열 대 진단 배열**로
    // 좁힌다.
    const errorItems = Array.from({ length: 20 }, (_, i) => `e${i} 실패: ${"사유".repeat(20)}`);
    const innerMessage = `안쪽 메시지: ${"값".repeat(3_000)}`;
    const input = { failed: true, errors: errorItems, detail: { message: innerMessage } };
    expect(JSON.stringify(input).length).toBeGreaterThan(4_000);

    const capped = capDetailsForLog(input) as Record<string, unknown>;

    // 안쪽 message 만 깎아도 상한을 맞출 수 있으므로 진단 배열은 손도 대지 않는다.
    expect((capped.errors as string[]).length).toBe(errorItems.length);
    expect((capped.detail as { message: string }).message.length).toBeLessThan(innerMessage.length);
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

  it("값 낮은 자리가 여럿이면 그 하한부터 내놓는다(적자를 진단 배열이 떠안지 않게)", () => {
    // ⚠️ T-085. 하한(`MIN_KEPT_ITEMS`·`MIN_KEPT_CHARS`)은 **자리마다** 주는 약속인데
    // 예산은 전체가 하나다. 값 낮은 자리가 여럿이면 그 하한들의 **합**이 예산을 먼저
    // 먹고, 남은 적자를 순위 높은 진단 배열이 혼자 떠안는다.
    // 베이스 실측(같은 픽스처): 사유 40건이 **3건**까지 깎이는 동안 값 낮은 문구 16개는
    // 전부 하한(200자)에 딱 붙어 살아남았다. 값 낮은 쪽 개수를 늘리면 사유는 1건까지
    // 내려가고 그러고도 상한을 넘겼다.
    const errorItems = Array.from({ length: 40 }, (_, i) => `핸들${i} 실패: ${"사유".repeat(20)}`);
    const input = Object.fromEntries([
      ["failed", true],
      ["errors", errorItems],
      // 하한보다 길어야 "하한을 지키느라 자리를 차지한다"가 성립한다(250자 → 하한 200자).
      ...Array.from({ length: 16 }, (_, i) => [`note${i}`, `안내 ${i}: ${"값".repeat(250)}`]),
    ]);
    expect(JSON.stringify(input).length).toBeGreaterThan(4_000);

    const capped = capDetailsForLog(input) as Record<string, unknown>;

    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(4_000);
    // ⚠️ **`> 1` 로 재지 말 것** — 베이스도 3건은 남겼다. 적자가 이쪽에 오지 **않았다**를
    // 보려면 진단 배열이 **통째로 온전한지**를 봐야 한다.
    expect((capped.errors as string[]).length).toBe(errorItems.length);
    // 그 자리는 값 낮은 쪽이 하한 아래로 내려가며 내줬다. 하한에 딱 붙어 있으면(=베이스)
    // 아무도 하한을 내놓지 않은 것이다.
    const noteLengths = Array.from({ length: 16 }, (_, i) => (capped[`note${i}`] as string).length);
    expect(noteLengths.filter((n) => n < 200).length).toBeGreaterThan(0);
  });

  it("값 낮은 자리가 회차 예산보다 많아도 하한을 내놓는다", () => {
    // ⚠️ 순위 상승은 "값 낮은 쪽을 다 훑었다"는 **신호**일 뿐이다. 값 낮은 문자열이
    // 회차 예산(`MAX_TRIM_ROUNDS`)보다 많으면 하한까지 깎는 데만 예산이 다 들어가
    // **그 신호가 영영 오지 않는다** — 티켓 메모가 든 모양(값 낮은 메시지 50개)이
    // 정확히 이 구간이라, 개수를 회차 예산 아래로 두면 이 계약이 통째로 헛돈다.
    //
    // ⚠️ **이 구간의 베이스 증상은 앞 계약과 다르다 — 숫자를 옮겨 적지 말 것.**
    // 베이스 실측(같은 픽스처, 값 낮은 문구 M개):
    //   M=16    → 상한 안, 사유 3/40 (적자를 진단 배열이 떠안는다)
    //   M=18~39 → 상한 초과, 사유 1/40
    //   M=50    → **13,445자**(상한의 세 배)를 저장하는데 사유는 40/40 **그대로**다.
    // 즉 여기서는 사유가 깎여서가 아니라, 회차가 먼저 끝나 **아무것도 못 줄인 채
    // 조용히 상한을 넘겨** 저장된다. 그래서 이 계약의 1차 단언은 "상한 안에 든다"이다.
    const errorItems = Array.from({ length: 40 }, (_, i) => `핸들${i} 실패: ${"사유".repeat(20)}`);
    const input = Object.fromEntries([
      ["failed", true],
      ["errors", errorItems],
      ...Array.from({ length: 50 }, (_, i) => [`note${i}`, `안내 ${i}: ${"값".repeat(250)}`]),
    ]);
    expect(JSON.stringify(input).length).toBeGreaterThan(4_000);

    const capped = capDetailsForLog(input) as Record<string, unknown>;

    // 조용한 초과가 아니라 실제로 상한 안에 들어온다(베이스는 세 배를 넘겼다).
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(4_000);
    expect((capped.errors as string[]).length).toBe(errorItems.length);
    // ⚠️ 이 단언이 **회차 예산과 무관하게** 판별력을 유지시킨다 — 하한을 내놓지 않았다면
    // 값 낮은 쪽은 전부 정확히 하한(200자)에 붙어 있다.
    const noteLengths = Array.from({ length: 50 }, (_, i) => (capped[`note${i}`] as string).length);
    expect(noteLengths.filter((n) => n < 200).length).toBeGreaterThan(0);
  });

  it("값 낮은 배열도 하한을 내놓는다(한 건만 남겨도 그 한 건이 덩치인 경우)", () => {
    // ⚠️ 하한은 **개수**로 걸리는데 자리를 먹는 것은 **부피**다. 순위 낮은 배열이 항목
    // 하나만 남겨도 그 한 건이 거대하면 예산은 그대로 잠긴 채다 — 문자열 쪽 하한만
    // 내놓아서는 이 모양이 안 풀린다.
    // 베이스 실측(같은 픽스처): 사유가 1건까지 깎이고 결과가 187자로 쪼그라들었다.
    const errorItems = Array.from({ length: 40 }, (_, i) => `핸들${i} 실패: ${"사유".repeat(20)}`);
    const input = Object.fromEntries([
      ["failed", true],
      ["errors", errorItems],
      // 항목마다 300개 필드짜리 객체 — 1건만 남겨도 예산을 통째로 먹는다.
      [
        "list",
        Array.from({ length: 2 }, (_, k) =>
          Object.fromEntries(Array.from({ length: 300 }, (_, j) => [`f${k}_${j}`, j])),
        ),
      ],
      ...Array.from({ length: 4 }, (_, i) => [`note${i}`, `안내 ${i}`]),
    ]);
    expect(JSON.stringify(input).length).toBeGreaterThan(4_000);

    const capped = capDetailsForLog(input) as Record<string, unknown>;

    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(4_000);
    // 값 낮은 배열이 개수 하한까지 내놓은 덕에 진단 배열이 온전히 남는다.
    expect((capped.errors as string[]).length).toBe(errorItems.length);
    // 타입은 유지한다 — 소비처가 `list.map()` 을 쓴다.
    expect(Array.isArray(capped.list)).toBe(true);
  });

  it("값 낮은 배열이 여럿이어도 회차를 태우지 않는다", () => {
    // ⚠️ **회차가 진짜 희소 자원이다.** 값 낮은 배열은 금세 하한(1건)에 닿는데, 종전엔
    // ①하한에 닿은 자리도 한 번 골라 보고 "진전 없음"을 확인해야 소진 처리됐고
    // ②하한을 포기한 뒤 그 자리들을 되돌려 **또 한 번씩** 골랐다. 자리마다 두 회차씩
    // 드는 셈이라 배열 스무 개면 예산이 거기서 끝나고, 정작 요약·진단은 손도 못 댄 채
    // **상한을 넘긴 채로 저장된다.** 실측(이 픽스처): 4,447자 → 3,760자.
    // 그래서 배열 비우기는 회차를 쓰지 않는 일괄 처리로 옮겼고, 하한에 닿은 자리는
    // 애초에 고르지 않는다.
    const input = Object.fromEntries([
      ["failed", true],
      ["failureReason", `사유: ${"가".repeat(2_500)}`],
      ["errors", Array.from({ length: 30 }, (_, i) => `e${i}: ${"사유".repeat(20)}`)],
      // 값 낮은 배열 20개 — 하나씩 회차를 쓰면 그것만으로 예산의 절반이 사라진다.
      ...Array.from({ length: 20 }, (_, i) => [
        `rows${i}`,
        Array.from({ length: 10 }, (_, j) => ({ v: j, t: "값".repeat(20) })),
      ]),
      ...Array.from({ length: 4 }, (_, i) => [`note${i}`, `안내${i}: ${"값".repeat(300)}`]),
    ]);
    expect(JSON.stringify(input).length).toBeGreaterThan(4_000);

    const capped = capDetailsForLog(input) as Record<string, unknown>;

    // 회차를 헛되이 쓰지 않았다면 상한 안에 들어온다.
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(4_000);
    // 그 대가로 진단 배열도 일부 깎이지만 전멸하지는 않는다.
    expect((capped.errors as string[]).length).toBeGreaterThan(0);
  });

  it("보호 판정은 이름이 아니라 값이 배열인지를 본다", () => {
    // ⚠️ `holdsDiagnostic` 이 키 이름만 보면, 잡이 `errors: 7` 처럼 **집계 수치**에 같은
    // 이름을 쓰는 순간 그 부모가 보호 순위를 얻어 뒤로 밀린다. 지킬 진단 내용이 하나도
    // 없는 쪽이 살아남고, 정작 진단 배열을 품은 쪽이 먼저 비워진다.
    // 베이스 실측(같은 픽스처): `engagement` 가 통째로 비워져 `errors` 배열이 사라지는
    // 동안 `counters` 는 61개 필드가 전부 살아남았다.
    // 숫자만 담은 뭉치를 쓰는 이유: 문자열이면 주 루프가 먼저 깎아 최후 수단의 순서를
    // 겨루기 전에 크기가 뒤바뀐다(이 계약이 보려는 것은 최후 수단의 **순서**다).
    const numbers = (prefix: string, n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, i]));
    const input = Object.fromEntries([
      ["failed", true],
      // 이름만 진단 — 값이 배열이 아니다.
      ["counters", { errors: 7, ...numbers("c", 60) }],
      // 진짜 진단 배열을 품은 부모.
      ["engagement", { errors: ["끊김", "차단", "시간초과"], meta: numbers("g", 80) }],
      ...Array.from({ length: 280 }, (_, i) => [`m${i}`, { x: `값${i}` }]),
    ]);
    expect(JSON.stringify(input).length).toBeGreaterThan(4_000);

    const capped = capDetailsForLog(input) as Record<string, unknown>;

    // 이름만 같은 집계 뭉치는 보호받지 못하고 먼저 비워진다.
    expect(Object.keys(capped.counters as object).length).toBe(0);
    // 그 덕에 진짜 진단 배열은 배열인 채로 살아남는다.
    const engagement = capped.engagement as { errors?: unknown[] };
    expect(Array.isArray(engagement?.errors)).toBe(true);
    expect(engagement.errors!.length).toBeGreaterThan(0);
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

  it("거대한 원소 하나 때문에 짧은 진단을 버리지 않는다", () => {
    // ⚠️ 배열 크기는 **원소들의 합**이라 크기순 정렬은 언제나 배열을 자기 원소보다 먼저
    // 집는다. 그대로 두면 거대한 원소 하나를 줄이겠다고 **배열을 깎아** 짧고 멀쩡한
    // 진단이 사라진다 — 크기는 거의 안 주는데 값만 잃는 최악의 교환이다.
    // 🪤 이 계약이 없던 동안 "최소 한 건은 남긴다" 계약이 `toBe(1)` 로 **그 손실을 규약으로
    // 굳혀** 놓았다(베이스는 3건을 지키는데 1건으로 줄이는 것을 정답으로 적었다).
    const items = [`거대한 사유: ${"가".repeat(6_000)}`, "네트워크 끊김", "인증 만료"];
    const capped = capDetailsForLog({ failed: true, errors: items }) as Record<string, unknown>;

    const errors = capped.errors as string[];
    expect(errors.length).toBe(items.length); // 한 건도 잃지 않는다
    expect(errors[1]).toBe("네트워크 끊김");
    expect(errors[2]).toBe("인증 만료");
    // 대신 덩치를 진 원소가 줄어든다(줄이되 계열은 읽히게).
    expect(errors[0].length).toBeLessThan(items[0].length);
    expect(errors[0].startsWith("거대한 사유")).toBe(true);
    expect(JSON.stringify(capped).length).toBeLessThanOrEqual(4_000);
  });

  it("항목이 아무리 커도 최소 한 건은 남긴다(무엇이 실패했는지 아예 못 읽지 않게)", () => {
    // ⚠️ 하한이 **실제로 일하는** 모양이라야 한다. 원소 하나가 압도적이면 위 계약이
    // 그 원소를 줄여 배열은 손도 안 대므로 하한에 닿지 않는다 — 그래서 **비슷한 덩치
    // 둘**을 둔다(어느 쪽도 압도적이지 않아 배열을 깎을 수밖에 없고, 한 건만 남겨도
    // 상한을 넘어 하한이 마지막 방어선이 된다).
    const items = [`첫 사유: ${"가".repeat(4_000)}`, `둘째 사유: ${"나".repeat(4_000)}`];
    const capped = capDetailsForLog({ failed: true, errors: items }) as Record<string, unknown>;

    const errors = capped.errors as string[];
    // ⚠️ **`>= 1` 만 보면 하한을 0 으로 낮추는 변이가 살아남는다**(실측). 남은 개수가
    // 정확히 하한인지를 본다 — 그래야 "한 건은 지킨다"가 계약이 된다.
    expect(errors.length).toBe(1);
    expect((capped.detailsTrimmed as Record<string, number>).errors).toBe(items.length - 1);
    // 남은 한 건이 빈 문자열이면 "종류조차 못 가린다"는 목적이 그대로 무너진다.
    expect(errors[0].startsWith("첫 사유")).toBe(true);
    expect(errors[0].length).toBeGreaterThanOrEqual(200);
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
