import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 계약 회귀 가드: campaigns-handler의 base query가 include하는 salesCampaigns select는
// 이 응답의 "다른 소비자"인 셀러 포털 리포트(seller-portal-report.tsx)가 의존하는
// id·sellerId를 반드시 포함해야 한다.
//
// 실사고: #137 egress 정리가 select를 { startDate, endDate }로 줄이며 sellerId·id를 빼,
// 포털의 `salesCampaigns.some(sc => sc.sellerId === seller.id)` 필터가 전량 false가 되어
// 모든 셀러 포털이 "공유 중인 캠페인 없음" 빈 화면이 됐다. 응답은 any-typed JSON이라
// TypeScript가 이 결합을 못 잡는다 — 소스 계약으로 고정한다.
const HANDLER = readFileSync(
  join(__dirname, "campaigns-handler.ts"),
  "utf8",
);

describe("campaigns-handler salesCampaigns select 계약", () => {
  // base query의 salesCampaigns select 블록만 추출(응답 매핑의 다른 select와 혼동 방지)
  const selectBlock = HANDLER.match(/salesCampaigns:\s*\{\s*select:\s*\{([^}]*)\}/)?.[1] ?? "";

  it("셀러 포털 필터·콘텐츠 조회가 쓰는 sellerId를 include한다", () => {
    expect(selectBlock).toMatch(/\bsellerId:\s*true/);
  });

  it("셀러 포털 콘텐츠 성과 조회가 쓰는 id를 include한다", () => {
    expect(selectBlock).toMatch(/\bid:\s*true/);
  });

  it("핸들러 자체가 쓰는 기간 필드도 유지한다", () => {
    expect(selectBlock).toMatch(/startDate:\s*true/);
    expect(selectBlock).toMatch(/endDate:\s*true/);
  });

  it("정산 락 동결 게이트가 쓰는 status를 include한다", () => {
    // status는 집계 창 동결 판정(isSalesCampaignLocked)의 **유일한 입력**이다(오너 확정 2026-07-15:
    // 정산 시작부터 창을 얼린다). 여기서 빠지면 sc.status=undefined인데 isSalesCampaignLocked가
    // 방어적으로 false(락 아님)를 반환하도록 돼 있어 — 크래시 없이 **조용히** 모든 캠페인이
    // "락 아님"으로 읽혀, 정산이 시작된 캠페인의 창까지 계속 움직인다(마감 스냅샷·정산 귀속과 어긋남).
    // #137과 동일한 "select 축소가 조용한 회귀를 만드는" 패턴이라 소스 계약으로 고정한다.
    expect(selectBlock).toMatch(/status:\s*true/);
  });
});
