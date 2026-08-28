import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * dev.sh 는 프로덕션과 같은 launchd 도메인·docker 데몬 옆에서 도는 온디맨드
 * 제어 스크립트다(메뉴바 앱의 위임 대상). 최악 사고 3종을 소스 계약으로 막는다:
 *   (A) 포트가 예약 레인과 겹침 — 3000=프로덕션 / 3001=프리뷰 (#387 과 동일 계약).
 *   (B) launchd 상주 서비스 kill — 부모 PID 1 판정이 kill 보다 앞서야 한다.
 *   (C) `docker rm` 이 프로덕션 컨테이너(supabase-db)를 잡음 — 파괴 대상은
 *       이름 가드를 통과한 프리뷰 DB 컨테이너 변수 하나뿐이어야 한다.
 * 각 계약은 "잡히는 줄이 0건이면 실패"(스캐너 고장 감지)를 유지한다.
 */
const SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "dev.sh");
const SRC = readFileSync(SCRIPT, "utf8");

function activeLines(src: string): string[] {
  return src.split("\n").filter((l) => !l.trim().startsWith("#"));
}

describe("dev.sh 가드 계약", () => {
  const lines = activeLines(SRC);

  it("개발 포트가 프로덕션(3000)·프리뷰(3001)와 겹치지 않는다", () => {
    const assigns = lines.filter((l) => /^DEV_PORT=/.test(l.trim()));
    expect(assigns.length).toBeGreaterThan(0); // 스캐너 고장 감지
    for (const line of assigns) {
      const value = line.trim().replace(/^DEV_PORT=/, "").replace(/["']/g, "");
      expect(value, `개발 포트가 예약된 레인과 겹친다: ${line}`).not.toBe("3000");
      expect(value, `개발 포트가 예약된 레인과 겹친다: ${line}`).not.toBe("3001");
    }
    // 포트 이름 가드(대입 오염 방어)도 존재해야 한다.
    expect(SRC).toMatch(/case "\$DEV_PORT" in\s*\n\s*3002\)/);
  });

  it("kill 은 launchd 소유 판정(부모 PID 1) 뒤에 온다", () => {
    const killIdx = lines.findIndex((l) => /\bkill\s+"?\$/.test(l));
    expect(killIdx, "kill 줄을 찾지 못했다 — 스캐너 고장").toBeGreaterThan(-1);
    const guardIdx = lines.findIndex((l) => /ps\s+-o\s+ppid=/.test(l));
    expect(guardIdx, "launchd 소유 판정을 찾지 못했다").toBeGreaterThan(-1);
    expect(guardIdx, "가드가 kill 뒤에 있으면 아무것도 막지 못한다").toBeLessThan(killIdx);
    // 판정 결과로 실제 분기하는지 — 읽기만 하고 안 쓰면 가드가 아니다.
    expect(SRC).toMatch(/"\$parent"\s*=\s*"1"/);
  });

  it("파괴적 docker 는 이름 가드를 통과한 프리뷰 DB 컨테이너 변수만 잡는다", () => {
    const destructive = lines.filter((l) => /docker\s+(rm|stop|kill|compose\s+down)/.test(l));
    expect(destructive.length, "docker rm 줄이 없다 — 스캐너 고장(다운 정리가 사라졌다)").toBeGreaterThan(0);
    for (const l of destructive) {
      expect(l, `파괴 대상이 변수(가드 통과)가 아니다: ${l}`).toMatch(/docker\s+rm\s+-f\s+"\$DB_CONTAINER"/);
    }
    // 이름 가드 존재.
    expect(SRC).toMatch(/case "\$DB_CONTAINER" in\s*\n\s*wagcrm-preview-db\)/);
    // 프로덕션 좌표 리터럴이 아예 등장하지 않는다.
    expect(SRC).not.toContain("supabase-db");
    expect(SRC).not.toContain("kr.ygrd.wagcrm.app");
  });

  it("launchctl 을 아예 쓰지 않는다(레인 정지는 preview.sh 소유)", () => {
    const launchctl = lines.filter((l) => /\blaunchctl\b/.test(l));
    expect(launchctl).toEqual([]);
  });

  it("DB 정리는 프리뷰 plist 부재 조건 뒤에만 온다(프리뷰가 쓰는 DB 를 뺏지 않는다)", () => {
    const rmIdx = lines.findIndex((l) => /docker\s+rm/.test(l));
    const plistIdx = lines.findIndex((l) => /-f\s+"\$PREVIEW_PLIST"/.test(l));
    expect(plistIdx, "프리뷰 plist 판정을 찾지 못했다").toBeGreaterThan(-1);
    expect(plistIdx, "plist 판정이 docker rm 뒤면 프리뷰의 DB 를 뺏는다").toBeLessThan(rmIdx);
  });
});
