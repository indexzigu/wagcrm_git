import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * `start-server.command` 는 오너가 **더블클릭**하는 파일이다. 2026-08-13 자체호스팅
 * 컷오버 전에는 이 맥이 개발 기계일 뿐이라 "포트 3000 을 쥔 것을 죽이고 dev 를 띄운다"가
 * 안전했다. 이제 3000 은 **프로덕션 앱**(launchd `kr.ygrd.wagcrm.app`)이 쓴다 —
 * 더블클릭 한 번이 crm.ygrd.kr 을 죽이는 상태였다.
 *
 * 두 가지를 고정한다:
 *   (A) 개발 서버 포트가 프로덕션(3000)·프리뷰(3001)와 겹치지 않는다. 겹치면 죽이지
 *       않더라도 "localhost:3000 을 열었는데 사실 프로덕션이었다"는 오독이 남는다.
 *   (B) `kill` 앞에 launchd 소유 판정이 있다. launchd 상주 서비스(부모 PID 1)는
 *       KeepAlive 로 되살아나 포트를 다투고, 무엇보다 그게 프로덕션일 수 있다.
 */
const SCRIPT = path.resolve(__dirname, "..", "..", "start-server.command");

function activeLines(src: string): string[] {
  return src.split("\n").filter((l) => !l.trim().startsWith("#"));
}

describe("start-server.command 가드", () => {
  const src = readFileSync(SCRIPT, "utf8");

  it("개발 서버 포트가 프로덕션(3000)·프리뷰(3001)와 겹치지 않는다", () => {
    const assigns = activeLines(src).filter((l) => /^PORT=/.test(l.trim()));
    expect(assigns.length).toBeGreaterThan(0); // 스캐너 고장 감지
    for (const line of assigns) {
      const value = line.trim().replace(/^PORT=/, "").replace(/["']/g, "");
      expect(value, `개발 포트가 예약된 레인과 겹친다: ${line}`).not.toBe("3000");
      expect(value, `개발 포트가 예약된 레인과 겹친다: ${line}`).not.toBe("3001");
    }
  });

  it("kill 은 launchd 소유 판정 뒤에 온다", () => {
    const lines = activeLines(src);
    const killIdx = lines.findIndex((l) => /\bkill\b/.test(l));
    expect(killIdx, "kill 줄을 찾지 못했다 — 스캐너 고장").toBeGreaterThan(-1);

    // 부모 PID 를 읽어 launchd(1) 인지 보는 판정. 이 줄이 kill 보다 앞서야 한다.
    const guardIdx = lines.findIndex((l) => /ps\s+-o\s+ppid=/.test(l));
    expect(guardIdx, "launchd 소유 판정을 찾지 못했다").toBeGreaterThan(-1);
    expect(guardIdx, "가드가 kill 뒤에 있으면 아무것도 막지 못한다").toBeLessThan(killIdx);

    // 판정 결과로 실제 분기하는지 — 읽기만 하고 안 쓰면 가드가 아니다.
    expect(src).toMatch(/PARENT["'\s]*=?["'\s]*.*\b1\b/);
  });
});
