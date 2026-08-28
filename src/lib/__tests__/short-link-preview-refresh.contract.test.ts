// 캐시 우회 링크의 **받침대 계약**.
//
// 이 기능은 리다이렉터가 코드를 `pathname` 첫 세그먼트에서만 읽고 목적지 병합은
// `searchParams` 만 본다는 사실 위에 서 있다. 그래서 경로 꼬리가 불활성이고,
// Worker 를 고치지 않아도 된다. 그 전제가 깨지면 모든 새로고침 링크가 조용히
// 폴백으로 떨어진다 — 화면에는 아무 신호도 없다.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPreviewRefreshUrl } from "../short-link";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const WORKER = readFileSync(join(REPO_ROOT, "ygrd-link", "src", "index.ts"), "utf8");

/** 꼬리를 손으로 조립하면 두 표면의 URL 이 갈린다 — SSOT 경유를 강제한다. */
const SURFACES = [
  "src/components/crm/link-preview-refresh.tsx",
  "src/components/crm/campaign-short-link-card.tsx",
  "src/components/crm/inflow-report-client.tsx",
];

describe("Worker 불변식 tripwire", () => {
  it("스캔 하네스가 살아 있다 (음성 프로브)", () => {
    // 존재할 리 없는 문자열이 잡히면 읽기 경로가 고장난 것이다.
    expect(WORKER).not.toContain("__ABSENT_PROBE_STRING__");
    expect(WORKER.length).toBeGreaterThan(1000);
  });

  it("코드는 pathname 첫 세그먼트에서만 나온다", () => {
    expect(WORKER).toContain("url.pathname.replace(/^\\/+/, '').split('/')[0]");
  });

  it("목적지 병합은 searchParams 만 본다 — pathname 을 읽지 않는다", () => {
    const fn = WORKER.slice(
      WORKER.indexOf("function buildTargetUrl"),
      WORKER.indexOf("async function recordClick"),
    );
    expect(fn).toContain("incoming");
    expect(fn).not.toContain("pathname");
  });
});

describe("캐시 우회 URL 은 SSOT 를 거친다", () => {
  it("표면이 꼬리를 손으로 조립하지 않는다", () => {
    for (const path of SURFACES) {
      const source = readFileSync(join(REPO_ROOT, path), "utf8");
      // 템플릿으로 `${shortUrl}/r…` 를 짜는 형태를 막는다.
      expect(source).not.toMatch(/shortUrl\}\s*\/r/);
    }
  });

  it("SSOT 가 만든 URL 은 코드 세그먼트를 보존한다", () => {
    const url = new URL(buildPreviewRefreshUrl("https://go.ygrd.kr/Kp7mQ2xd"));
    expect(url.pathname.split("/")[1]).toBe("Kp7mQ2xd");
  });
});
