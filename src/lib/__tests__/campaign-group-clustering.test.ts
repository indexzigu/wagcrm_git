/**
 * CG-1 조합 캠페인 클러스터링 유틸 단위 테스트 (블루프린트 §4).
 * overlap / near / 윈도우 경계 / 같은-딜 분리 / 셀러 파티션을 고정한다.
 */

import { describe, it, expect } from "vitest";
import {
  overlapsOrNear,
  clusterByDateWindow,
  type CampaignClusterInput,
} from "../campaign-group-clustering";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function campaign(
  id: string,
  sellerId: string,
  dealId: string,
  start: string,
  end: string,
): CampaignClusterInput {
  return { id, sellerId, dealId, startDate: d(start), endDate: d(end) };
}

describe("overlapsOrNear", () => {
  it("겹치는 기간은 true", () => {
    const a = { startDate: d("2026-07-01"), endDate: d("2026-07-10") };
    const b = { startDate: d("2026-07-05"), endDate: d("2026-07-15") };
    expect(overlapsOrNear(a, b, 3)).toBe(true);
  });

  it("맞닿은 기간(간격 0)은 true", () => {
    const a = { startDate: d("2026-07-01"), endDate: d("2026-07-10") };
    const b = { startDate: d("2026-07-10"), endDate: d("2026-07-12") };
    expect(overlapsOrNear(a, b, 0)).toBe(true);
  });

  it("간격이 정확히 windowDays면 true(경계 포함)", () => {
    const a = { startDate: d("2026-07-01"), endDate: d("2026-07-10") };
    const b = { startDate: d("2026-07-13"), endDate: d("2026-07-20") }; // 간격 3일
    expect(overlapsOrNear(a, b, 3)).toBe(true);
  });

  it("간격이 windowDays를 넘으면 false", () => {
    const a = { startDate: d("2026-07-01"), endDate: d("2026-07-10") };
    const b = { startDate: d("2026-07-14"), endDate: d("2026-07-20") }; // 간격 4일
    expect(overlapsOrNear(a, b, 3)).toBe(false);
  });

  it("순서 무관 — b가 앞서도 동일 판정", () => {
    const a = { startDate: d("2026-07-14"), endDate: d("2026-07-20") };
    const b = { startDate: d("2026-07-01"), endDate: d("2026-07-10") };
    expect(overlapsOrNear(a, b, 3)).toBe(false);
    expect(overlapsOrNear(a, b, 4)).toBe(true);
  });
});

describe("clusterByDateWindow", () => {
  it("같은 셀러·다른 딜·기간 겹침 2건은 크기 2 제안 1개", () => {
    const rows = [
      campaign("c1", "s1", "dA", "2026-07-01", "2026-07-05"),
      campaign("c2", "s1", "dB", "2026-07-03", "2026-07-08"),
    ];
    const { proposals, clusters, sameDealSplits } = clusterByDateWindow(rows, 3);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(clusters).toHaveLength(1);
    expect(sameDealSplits).toHaveLength(0);
  });

  it("셀러가 다르면 묶이지 않는다(파티션) — 제안 0", () => {
    const rows = [
      campaign("c1", "s1", "dA", "2026-07-01", "2026-07-05"),
      campaign("c2", "s2", "dB", "2026-07-01", "2026-07-05"),
    ];
    const { proposals } = clusterByDateWindow(rows, 3);
    expect(proposals).toHaveLength(0);
  });

  it("같은 딜이 한 윈도우에 두 번(회차)이면 분리 — 제안 0 + split 기록", () => {
    const rows = [
      campaign("c1", "s1", "dA", "2026-07-01", "2026-07-05"),
      campaign("c2", "s1", "dA", "2026-07-04", "2026-07-08"), // 같은 딜, 겹침
    ];
    const { proposals, sameDealSplits } = clusterByDateWindow(rows, 3);
    expect(proposals).toHaveLength(0);
    expect(sameDealSplits).toHaveLength(1);
    expect(sameDealSplits[0]).toMatchObject({ sellerId: "s1", dealId: "dA", campaignId: "c2" });
  });

  it("조합(다른 딜) 2건 + 같은-딜 회차 1건: 조합만 묶고 회차는 분리", () => {
    const rows = [
      campaign("c1", "s1", "dA", "2026-07-01", "2026-07-05"),
      campaign("c2", "s1", "dB", "2026-07-02", "2026-07-06"),
      campaign("c3", "s1", "dA", "2026-07-04", "2026-07-08"), // dA 재등장 → 분리
    ];
    const { proposals, sameDealSplits } = clusterByDateWindow(rows, 3);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(sameDealSplits.map((s) => s.campaignId)).toEqual(["c3"]);
  });

  it("윈도우 경계: 3일 간격은 묶이고 4일 간격은 새 클러스터", () => {
    const near = [
      campaign("c1", "s1", "dA", "2026-07-01", "2026-07-05"),
      campaign("c2", "s1", "dB", "2026-07-08", "2026-07-10"), // 간격 3일
    ];
    expect(clusterByDateWindow(near, 3).proposals).toHaveLength(1);

    const far = [
      campaign("c3", "s1", "dA", "2026-07-01", "2026-07-05"),
      campaign("c4", "s1", "dB", "2026-07-09", "2026-07-12"), // 간격 4일
    ];
    const farResult = clusterByDateWindow(far, 3);
    expect(farResult.proposals).toHaveLength(0);
    expect(farResult.clusters).toHaveLength(2);
  });

  it("롤링 엔벨로프: 사슬처럼 이어지는 3건을 한 클러스터로", () => {
    const rows = [
      campaign("c1", "s1", "dA", "2026-07-01", "2026-07-04"),
      campaign("c2", "s1", "dB", "2026-07-05", "2026-07-09"),
      campaign("c3", "s1", "dC", "2026-07-10", "2026-07-14"),
    ];
    const { proposals } = clusterByDateWindow(rows, 3);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toHaveLength(3);
  });

  it("빈 입력은 빈 결과", () => {
    const { proposals, clusters, sameDealSplits } = clusterByDateWindow([], 3);
    expect(proposals).toEqual([]);
    expect(clusters).toEqual([]);
    expect(sameDealSplits).toEqual([]);
  });
});
