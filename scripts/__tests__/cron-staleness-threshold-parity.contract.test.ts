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

  it("상시(분 단위) 잡의 유예가 STALE_GRACE_MS.상시와 같다", () => {
    expect(shellIntVar("CRON_CONTINUOUS_GRACE_MIN")).toBe(STALE_GRACE_MS.상시 / (60 * 1000));
  });

  it("양성 대조군 — 없는 변수는 실패로 잡힌다", () => {
    expect(() => shellIntVar("CRON_NOT_A_REAL_VAR_H")).toThrow();
  });
});

/**
 * 계약: 두 판정이 **같은 칸**을 읽는다 — 문턱이 같아도 출처가 다르면 어긋난다.
 *
 * 2026-10-18 실사고: 레이더는 SystemTaskStatus.lastRunAt 을 읽는데 status.sh 는
 * SystemTaskLog 의 SUCCESS 행만 읽었다. 할 일 없던 회차(quiet)는 이력 행을 남기지 않아
 * (withSystemTaskStatus skipLog), 2분마다 정상으로 도는 잡이 메뉴바·텔레그램 요약에서만
 * 매일 「늦었습니다」였다.
 */
describe("크론 지연 판정 출처 정합 (status.sh ↔ system-radar-card)", () => {
  const RADAR = readFileSync(
    path.resolve(__dirname, "..", "..", "src", "components", "crm", "system-radar-card.tsx"),
    "utf8",
  );
  const SKIP_LOG = readFileSync(path.resolve(__dirname, "..", "..", "src", "lib", "system-task-status.ts"), "utf8");

  it("레이더는 상태 표의 lastRunAt 으로 지연을 잰다", () => {
    expect(RADAR).toMatch(/overdueSummary\(\s*job\s*,\s*task\?\.lastRunAt/);
  });

  it("status.sh 도 상태 표의 lastRunAt 을 읽는다 — quiet 회차가 이력에 안 남기 때문이다", () => {
    // 전제가 살아 있는지 먼저 확인한다: skipLog 가 사라지면 이 계약의 이유도 바뀐다.
    expect(SKIP_LOG).toMatch(/skipLog:\s*body\?\.quiet === true/);
    const sql = /^\s*CRON_SQL="(.*)"$/m.exec(SRC)?.[1];
    expect(sql, "CRON_SQL 을 status.sh 에서 찾지 못했다(앵커 함정)").toBeTruthy();
    expect(sql).toMatch(/from \\"SystemTaskStatus\\"/);
    expect(sql).toMatch(/\\"lastRunAt\\"/);
  });
});
