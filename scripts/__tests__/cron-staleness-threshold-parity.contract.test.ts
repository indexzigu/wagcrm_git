import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STALE_GRACE_MS } from "@/lib/cron-staleness";

/**
 * 계약: 메뉴바(`status.sh`)와 레이더(`cron-staleness.ts`)가 **같은 문턱**으로 지연을 판정한다.
 *
 * 왜 필요한가: 같은 판정이 두 언어에 살아 있다. 어긋나면 레이더는 노랑인데 메뉴바는 초록인
 * 상태가 생기고, 그 불일치는 둘 다 열어 보기 전엔 드러나지 않는다. C5 가 crontab 과
 * KNOWN_JOBS 표기를 묶는 것과 같은 부류의 기계 강제 장치다.
 *
 * 🪤 앵커 함정: 변수를 못 찾으면 "위반 없음"으로 공허 통과한다 — 파싱 실패를 먼저 실패로 만든다.
 */
const STATUS_SH = path.resolve(__dirname, "..", "..", "infra", "selfhost", "status.sh");
const SRC = readFileSync(STATUS_SH, "utf8");

const HOUR_MS = 60 * 60 * 1000;

function shellIntVar(name: string): number {
  const m = new RegExp(`^\\s*${name}=(\\d+)`, "m").exec(SRC);
  expect(m, `${name} 를 status.sh 에서 찾지 못했다(앵커 함정 — 이름을 바꿨으면 이 테스트도 함께 고칠 것)`).not.toBeNull();
  return Number(m![1]);
}

describe("크론 지연 문턱 정합 (status.sh ↔ cron-staleness.ts)", () => {
  it("매일 잡의 문턱이 24h + 유예와 같다", () => {
    const expectedH = (24 * HOUR_MS + STALE_GRACE_MS.매일) / HOUR_MS;
    expect(shellIntVar("CRON_DAILY_LIMIT_H")).toBe(expectedH);
  });

  it("매주 잡의 문턱이 7d + 유예와 같다", () => {
    const expectedH = (7 * 24 * HOUR_MS + STALE_GRACE_MS.매주) / HOUR_MS;
    expect(shellIntVar("CRON_WEEKLY_LIMIT_H")).toBe(expectedH);
  });

  it("양성 대조군 — 없는 변수는 실패로 잡힌다", () => {
    expect(() => shellIntVar("CRON_NOT_A_REAL_VAR_H")).toThrow();
  });
});
