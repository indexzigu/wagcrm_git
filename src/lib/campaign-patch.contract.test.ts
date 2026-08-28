import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAMPAIGN_GROUP_CONFLICT_MESSAGE,
  patchCampaign,
  patchCampaignSettlementStatus,
} from "./campaign-patch";

/**
 * 캠페인 PATCH 의 409(그룹 멤버십 충돌) 안내 계약.
 *
 * 결함(2026-08-07 전수조사): 라우트는 저장 도중 그룹 멤버 구성이 바뀌면 409 +
 * "Campaign group membership changed; retry the update" 를 반환했는데, 클라이언트
 * 8개 파일 17개 호출처가 전부 `if (!response.ok)` 만 검사해 일반 실패 토스트를
 * 띄웠다 — **재시도하면 된다는 정보가 한 곳도 사용자에게 닿지 않았다.**
 *
 * 그래서 이 테스트는 두 가지를 함께 고정한다:
 * ① 헬퍼가 409 를 한국어 안내로 갈라내는 **행위**
 * ② 호출처가 헬퍼를 우회해 raw fetch 로 되돌아가지 못하게 하는 **소스 스캔**
 *
 * ②가 없으면 새 호출처 하나가 조용히 옛 형태로 추가되고, 그 화면에서만 안내가
 * 다시 사라진다(타입도 ①도 못 잡는다).
 */

const SRC_ROOT = path.join(process.cwd(), "src");

/** 이 파일들만 캠페인 PATCH 를 직접 만들 수 있다. */
const ALLOWED = new Set([path.join("src", "lib", "campaign-patch.ts")]);

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    acc.push(full);
  }
  return acc;
}

/**
 * `fetch("/api/campaigns/<보간>"...)` 호출 뒤 옵션 객체에 `method: "PATCH"` 가
 * 붙어 있는 자리를 찾는다. 옵션 객체 길이가 제각각이라 중괄호를 파싱하지 않고
 * 호출 시작점 이후 일정 구간을 본다 — 이 레포의 실제 호출 형태를 전부 덮는다.
 *
 * ⚠️ **대상은 409 를 반환하는 두 엔드포인트뿐이다** — `/api/campaigns/[id]` 와
 * `/api/campaigns/[id]/settlement-status`. 하위 리소스 PATCH(`/posts/classification`
 * ·`/stories` 등)는 그룹 멤버십 낙관적 동시성 제어가 없어 이 계약의 대상이
 * 아니다. 초판 정규식이 경로 끝을 고정하지 않아 그 3곳을 오검출했다.
 */
function findDirectPatchCalls(source: string): number[] {
  const hits: number[] = [];
  const callSite = /fetch\(\s*`\/api\/campaigns\/\$\{[^}]*\}(?:\/settlement-status)?`/g;
  let match: RegExpExecArray | null;
  while ((match = callSite.exec(source)) !== null) {
    const window = source.slice(match.index, match.index + 400);
    if (/method:\s*["']PATCH["']/.test(window)) {
      hits.push(source.slice(0, match.index).split("\n").length);
    }
  }
  return hits;
}

describe("campaign-patch — 409 그룹 충돌 안내", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: Partial<Response> & { status: number; ok: boolean }) {
    const spy = vi.fn().mockResolvedValue(response as Response);
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("409 는 라우트의 영문 본문이 아니라 한국어 안내로 갈라진다", async () => {
    stubFetch({
      ok: false,
      status: 409,
      json: async () => ({ error: "Campaign group membership changed; retry the update" }),
    });

    const result = await patchCampaign("c1", { status: "ACTIVE" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.conflict).toBe(true);
    expect(result.error).toBe(CAMPAIGN_GROUP_CONFLICT_MESSAGE);
    // 사용자에게 영문이 새면 안내가 아니라 잡음이다.
    expect(result.error).not.toMatch(/[A-Za-z]{4,}/);
  });

  it("settlement-status 라우트도 같은 안내를 쓴다 — 같은 낙관적 동시성 제어다", async () => {
    stubFetch({ ok: false, status: 409, json: async () => ({}) });

    const result = await patchCampaignSettlementStatus("c1", { isDepositReceived: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.conflict).toBe(true);
    expect(result.error).toBe(CAMPAIGN_GROUP_CONFLICT_MESSAGE);
  });

  it("409 가 아닌 실패는 conflict 로 표시하지 않는다 — 재시도해도 소용없다", async () => {
    stubFetch({ ok: false, status: 404, json: async () => ({ error: "Campaign not found" }) });

    const result = await patchCampaign("ghost", { status: "ACTIVE" }, { fallbackError: "저장 실패" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.conflict).toBe(false);
    // 기본값은 서버 영문 문구가 아니라 호출처의 한국어 문구다.
    expect(result.error).toBe("저장 실패");
  });

  it("preferServerError 를 켠 호출처만 서버 문구를 노출한다(종전 동작 보존)", async () => {
    stubFetch({ ok: false, status: 400, json: async () => ({ error: "Drop reason is required" }) });

    const result = await patchCampaign("c1", {}, { fallbackError: "저장 실패", preferServerError: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("Drop reason is required");
  });

  it("zod 실패처럼 error 가 문자열이 아니면 호출처 문구로 떨어진다", async () => {
    stubFetch({
      ok: false,
      status: 400,
      json: async () => ({ error: { fieldErrors: { status: ["invalid"] } } }),
    });

    const result = await patchCampaign("c1", {}, { fallbackError: "저장 실패", preferServerError: true });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // "[object Object]" 가 토스트에 뜨면 안 된다.
    expect(result.error).toBe("저장 실패");
  });

  it("fetch 가 던져도 결과로 흡수한다 — 호출처마다 try/catch 를 복사하지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const result = await patchCampaign("c1", {}, { networkError: "네트워크 오류" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("네트워크 오류");
    expect(result.status).toBe(0);
  });

  it("성공하면 응답 본문을 그대로 돌려준다", async () => {
    stubFetch({ ok: true, status: 200, json: async () => ({ id: "c1", status: "ACTIVE" }) });

    const result = await patchCampaign<{ id: string }>("c1", { status: "ACTIVE" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.id).toBe("c1");
  });
});

describe("campaign-patch — 소스 스캔(우회 금지)", () => {
  it("헬퍼 밖에서 캠페인 PATCH 를 직접 만들지 않는다", () => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles(SRC_ROOT)) {
      const relative = path.relative(process.cwd(), file);
      if (ALLOWED.has(relative)) continue;
      for (const line of findDirectPatchCalls(readFileSync(file, "utf8"))) {
        offenders.push(`${relative}:${line}`);
      }
    }

    expect(
      offenders,
      `캠페인 PATCH 는 patchCampaign()/patchCampaignSettlementStatus() 를 통해야 한다 — ` +
        `raw fetch 는 409 재시도 안내를 삼킨다. 위반: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("스캔이 실제로 동작한다(양성 대조군) — 하네스가 고장나면 위 테스트가 무의미해진다", () => {
    const positive = [
      "const response = await fetch(`/api/campaigns/${id}`, {",
      '  method: "PATCH",',
      "  body: JSON.stringify(patch),",
      "});",
    ].join("\n");

    expect(findDirectPatchCalls(positive)).toHaveLength(1);
    expect(
      findDirectPatchCalls('await fetch(`/api/campaigns/${id}/settlement-status`, { method: "PATCH" });'),
    ).toHaveLength(1);

    // 음성 대조군 ①: 같은 URL 의 GET·DELETE 는 이 계약의 대상이 아니다.
    expect(findDirectPatchCalls('await fetch(`/api/campaigns/${id}`, { method: "DELETE" });')).toEqual([]);
    expect(findDirectPatchCalls("await fetch(`/api/campaigns/${id}`, { cache: 'no-store' });")).toEqual([]);

    // 음성 대조군 ②: 하위 리소스 PATCH 는 409 를 내지 않으므로 대상이 아니다.
    // (초판 정규식이 이걸 잡아 asset-manager 3곳을 오검출했다 — 대조군으로 고정한다.)
    expect(
      findDirectPatchCalls('await fetch(`/api/campaigns/${id}/posts/classification`, { method: "PATCH" });'),
    ).toEqual([]);
    expect(findDirectPatchCalls('await fetch(`/api/campaigns/${id}/stories`, { method: "PATCH" });')).toEqual([]);
  });
});
