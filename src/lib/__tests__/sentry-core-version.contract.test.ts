import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * `@sentry/core` 직접 import 의 전제 고정 (자가 정상화 3단계, 2026-10-21).
 *
 * `system-task-status.ts` 는 재시도로 넘긴 크론 예외를 `@sentry/core` 의 `captureException` 으로 보낸다
 * (`@sentry/nextjs` 를 import 하면 scripts 타입체크가 깨진다 — 그 파일 머리 주석). 코어는 package.json 에
 * 직접 선언된 의존성이 아니라 `@sentry/nextjs` 가 끌어오는 패키지다. 둘의 버전이 갈라지면 코어가 두 벌이 되고,
 * 서버 설정(`sentry.server.config.ts`)이 초기화한 쪽이 아닌 벌로 보고가 가서 **오류 없이 사라진다.**
 * 그래서 「앱이 해석하는 코어 = `@sentry/nextjs` 가 고정한 코어」를 여기서 단언한다.
 */
const require = createRequire(import.meta.url);

describe("@sentry/core 버전 정합", () => {
  it("앱이 해석하는 @sentry/core 가 @sentry/nextjs 가 고정한 버전과 같다", () => {
    const nextjs = require("@sentry/nextjs/package.json") as { dependencies?: Record<string, string> };
    const pinned = nextjs.dependencies?.["@sentry/core"];
    expect(pinned, "@sentry/nextjs 가 @sentry/core 를 더 이상 의존하지 않는다 — import 경로를 다시 정할 것").toBeTruthy();
    const core = require("@sentry/core/package.json") as { version: string };
    expect(core.version).toBe(pinned);
  });
});
