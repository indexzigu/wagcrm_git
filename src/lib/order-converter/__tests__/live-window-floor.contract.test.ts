import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 계약: **스냅샷 읽기 창에 `now − N일` 하한을 두지 않는다.**
 *
 * 이 계약이 필요한 이유(실사고 2026-08-03): 네 곳이 각자
 * `Math.max(캠페인_시작, now − 30일)` 로 조회 시작을 정했다. 캠페인 시작일은 고정인데
 * 하한은 매일 전진하므로, **시작 후 30일이 지나는 순간부터 캠페인 초반 날짜가 하루에 하나씩
 * 조회 밖으로 밀려나 집계가 조용히 줄었다.** 차트 표시가 아니라 주문 건수·매출 숫자 자체가
 * 주는 침묵형 결함이고, 마감하면 cached 경로가 전 기간 동결본을 읽어 자연 치유되므로
 * "마감을 늦게 누를수록 수치가 줄어드는" 형태로만 드러난다.
 *
 * **단위 테스트로는 미래의 새 호출부를 못 막는다** — 창을 새로 계산하는 파일이 생기면
 * 아무도 모르게 같은 결함이 재발한다. 그래서 소스 스캔으로 고정한다
 * (`product-order-range-type.contract.test.ts` 와 같은 관례).
 *
 * ⚠️ `naver-order-sync.enumerateSnapshotDateKeys` 는 **의도적으로 이 목록에 없다** —
 * 그쪽은 "어느 날짜를 **쓰는가**"(dirty 무효화 폭)이라 스냅샷 쓰기 창으로 좁히는 것이 맞다.
 * 읽기 창과 혼동하지 말 것: 30일은 무엇을 쓰는가의 상한이지 무엇이 존재하는가가 아니다
 * (`NaverOrderSnapshot` 행을 지우는 코드는 레포에 없다).
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** 스냅샷 조회 창을 결정하는 읽기 경로 — 새 호출부가 생기면 여기 등재한다. */
const WINDOW_RESOLVING_READ_PATHS = [
  "src/lib/mobile-campaign-sales.ts",
  "src/lib/mobile-pulse-loader.ts",
  "src/app/order-converter/api/campaigns/campaigns-handler.ts",
  "src/app/order-converter/api/campaigns/[id]/undispatched-orders/route.ts",
];

/**
 * `now` 상대 하한의 서명. 실제로 있던 4가지 형태를 전부 덮는다:
 * `capMs` · `windowFloorMs` · `MAX_DAYS` · `MAX_WINDOW_DAYS`.
 */
const NOW_RELATIVE_FLOOR = /(cap(Ms|MS)?|windowFloorMs|MAX_DAYS|MAX_WINDOW_DAYS)\b/;

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

describe("스냅샷 읽기 창 계약 — now 상대 하한 금지", () => {
  it.each(WINDOW_RESOLVING_READ_PATHS)(
    "%s 는 창 결정을 resolveLiveWindowKeys(SSOT)에 위임한다",
    (relPath) => {
      expect(read(relPath)).toContain("resolveLiveWindowKeys");
    },
  );

  it.each(WINDOW_RESOLVING_READ_PATHS)(
    "%s 에 now 상대 하한(capMs·windowFloorMs·MAX_DAYS 등)이 되살아나지 않았다",
    (relPath) => {
      // 주석은 이 결함을 **설명**하므로(금지 문구 포함) 코드 줄만 본다.
      const codeLines = read(relPath)
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          return trimmed !== "" && !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
        });
      const offenders = codeLines.filter((line) => NOW_RELATIVE_FLOOR.test(line));
      expect(offenders).toEqual([]);
    },
  );

  it("양성 대조군 — 스캐너가 실제로 하한 서명을 잡는다(항상 통과하는 고장 방지)", () => {
    // 이 프로브가 없으면 정규식이 깨져도 위 테스트가 전부 초록으로 통과한다.
    const oldCode = "const capMs = now.getTime() - MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;";
    expect(NOW_RELATIVE_FLOOR.test(oldCode)).toBe(true);
    expect(NOW_RELATIVE_FLOOR.test("const windowFloorMs = now.getTime() - 30 * DAY;")).toBe(true);
    expect(NOW_RELATIVE_FLOOR.test("const { startKey } = resolveLiveWindowKeys(startMs, now);")).toBe(false);
  });

  it("등재 파일이 실재한다 — 경로가 바뀌면 스캔이 조용히 0건이 된다", () => {
    for (const relPath of WINDOW_RESOLVING_READ_PATHS) {
      expect(() => read(relPath)).not.toThrow();
    }
  });
});
