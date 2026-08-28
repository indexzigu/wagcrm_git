// 「반영 결과」 카드가 프로바이더 모양에 흔들리지 않는지 고정한다.
//
// 🔴 실측 결함: `GET /api/price-sheets/[id]` 가 `executionResult` 를 raw Prisma 로 읽어
// 그대로 넘겼고, `summarizeApplyProposal` 이 `as ExecutionResult` 로 캐스팅했다. SQLite
// 에서는 그 값이 **문자열**이라 `results` 를 못 읽어 **성공한 반영이 "생성 0건 · 갱신 0건"**
// 으로 그려졌다. Postgres 에서는 객체라 통과 — 그래서 프로덕션에서는 안 보이고 로컬에서만
// 났고, 객체 픽스처만 쓰던 테스트도 초록이었다.
//
// 라우트가 `parseStoredJson` 을 통과시키도록 고쳤고, 이 테스트는 **두 모양이 같은 답을
// 내는지**를 요약 함수 입력 계약으로 고정한다.

import { describe, it, expect } from "vitest";
import { summarizeApplyProposal } from "../apply-summary";
import { parseStoredJson } from "@/lib/stored-json";

const results = [
  { dealId: "d1", action: "CREATE" as const },
  { dealId: "d2", action: "CREATE" as const },
  { dealId: "d3", action: "UPDATE" as const },
];

const base = {
  id: "p1",
  status: "EXECUTED",
  executedAt: new Date("2026-08-04T00:00:00.000Z"),
  errorMessage: null,
};

describe("summarizeApplyProposal — 프로바이더 모양 무관", () => {
  it("Postgres 모양(객체)에서 건수를 센다", () => {
    const s = summarizeApplyProposal({ ...base, executionResult: { results } });
    expect([s.createdCount, s.updatedCount]).toEqual([2, 1]);
  });

  it("SQLite 모양(문자열)도 라우트의 파싱을 거치면 같은 답이다", () => {
    const stored = JSON.stringify({ results });
    const s = summarizeApplyProposal({ ...base, executionResult: parseStoredJson(stored) });
    expect([s.createdCount, s.updatedCount]).toEqual([2, 1]);
  });

  it("파싱을 건너뛴 문자열은 0건이 된다 — 이 회귀가 실제로 났다", () => {
    // 고친 내용을 되돌리면 어떤 화면이 나오는지 고정해 둔다(양성 프로브 대용).
    const s = summarizeApplyProposal({ ...base, executionResult: JSON.stringify({ results }) });
    expect([s.createdCount, s.updatedCount]).toEqual([0, 0]);
  });

  it("실행 기록이 없으면 0건이고 터지지 않는다", () => {
    const s = summarizeApplyProposal({ ...base, executionResult: parseStoredJson(null) });
    expect([s.createdCount, s.updatedCount]).toEqual([0, 0]);
    expect(s.outcome).toBe("SUCCEEDED");
  });
});
