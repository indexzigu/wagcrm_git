/**
 * 가격표 상태 배지의 색=의미 계약 (오너 승인 2026-08-26).
 *
 * ⛔ 이 표들이 한 번에 세 가지를 잘못하고 있었다:
 * ① 「검수완료」·「반영완료」가 브랜드 네이비(`status-active`)였다 — P8 §4 가 금지하는
 *    판정 용법이고, 생애주기 SSOT 에서 네이비는 ACTIVE(=진행 중)라 의미가 정반대였다.
 * ② 같은 화면의 반영 결과 카드는 「반영 완료」를 이미 초록으로 그리고 있어, 한 화면에서
 *    같은 사실이 두 색으로 보였다.
 * ③ 실제 런타임 값 2종(시트 APPLYING · 행 APPLIED)이 표에 없어 화면에 영문이 그대로
 *    노출되고 색도 엉뚱한 것으로 떨어졌다.
 *
 * 셋 다 tsc·eslint·기존 테스트를 전부 통과한다(폴백이 있어 렌더는 성공한다).
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PriceSheetStatusBadge, MappingStatusBadge } from "../status-badge";
import { ApplyResultCard } from "../apply-result-card";
import type { ApplySummary } from "@/lib/price-sheet/apply-summary";

/** ⛔ 판정·생애주기 의미로 쓰는 것이 금지된 브랜드 네이비 틴트(P8 §4). */
const FORBIDDEN = "status-active";

function renderedBadge(el: HTMLElement): { label: string; variant: string | null } {
  const badge = el.querySelector('[data-slot="badge"]');
  if (!badge) throw new Error("배지가 렌더되지 않았다");
  return {
    label: (badge.textContent ?? "").trim(),
    variant: badge.getAttribute("data-variant"),
  };
}

// 시트 상태 사다리 — 대기 → 진행(파랑 3단) → 반영 중(대기) → 종착점(초록) / 실패
const SHEET_CASES: Array<[status: string, label: string, variant: string]> = [
  ["UPLOADED", "업로드됨", "status-pending"],
  ["EXTRACTED", "추출완료", "status-info"],
  ["MAPPED", "매핑완료", "status-info"],
  // 「완료」 어휘지만 종착점이 아니다 — 검수는 끝났고 아직 딜에 반영 안 됨.
  ["REVIEWED", "검수완료", "status-info"],
  ["APPLYING", "반영 중", "status-pending"],
  ["APPLIED", "반영완료", "status-success"],
  ["EXTRACT_FAILED", "추출실패", "status-urgent"],
];

// 행 단위 매핑 상태 — 매핑확정/신규 딜은 우열이 아니라 갈래라 같은 톤.
const MAPPING_CASES: Array<[status: string, label: string, variant: string]> = [
  ["UNMAPPED", "미매핑", "outline"],
  ["SUGGESTED", "제안됨", "status-pending"],
  ["MAPPED", "매핑확정", "status-info"],
  ["NEW_DEAL", "신규 딜", "status-info"],
  ["APPLIED", "반영완료", "status-success"],
];

describe("PriceSheetStatusBadge", () => {
  it.each(SHEET_CASES)("%s → 「%s」 / %s", (status, label, variant) => {
    const { container } = render(<PriceSheetStatusBadge status={status} />);
    expect(renderedBadge(container)).toEqual({ label, variant });
  });

  it("어떤 상태도 브랜드 네이비를 쓰지 않는다 (P8 §4)", () => {
    for (const [status] of SHEET_CASES) {
      const { container, unmount } = render(<PriceSheetStatusBadge status={status} />);
      expect(renderedBadge(container).variant, status).not.toBe(FORBIDDEN);
      unmount();
    }
  });

  it("초록(종착점)은 반영완료 하나뿐이다 — 검수완료가 함께 올라오면 회귀", () => {
    // ⛔ SHEET_CASES(기대표)가 아니라 **실제 렌더**에서 모은다 — 기대표를 세면
    // 소스를 되돌려도 초록으로 남는 동어반복이 된다.
    const green: string[] = [];
    for (const [status] of SHEET_CASES) {
      const { container, unmount } = render(<PriceSheetStatusBadge status={status} />);
      if (renderedBadge(container).variant === "status-success") green.push(status);
      unmount();
    }
    expect(green).toEqual(["APPLIED"]);
  });

  it("모르는 상태는 원문 그대로 + 대기색으로 떨어진다 (폴백)", () => {
    const { container } = render(<PriceSheetStatusBadge status="WAT" />);
    expect(renderedBadge(container)).toEqual({ label: "WAT", variant: "status-pending" });
  });
});

describe("MappingStatusBadge", () => {
  it.each(MAPPING_CASES)("%s → 「%s」 / %s", (status, label, variant) => {
    const { container } = render(<MappingStatusBadge status={status} />);
    expect(renderedBadge(container)).toEqual({ label, variant });
  });

  it("어떤 상태도 브랜드 네이비를 쓰지 않는다 (P8 §4)", () => {
    for (const [status] of MAPPING_CASES) {
      const { container, unmount } = render(<MappingStatusBadge status={status} />);
      expect(renderedBadge(container).variant, status).not.toBe(FORBIDDEN);
      unmount();
    }
  });

  it("매핑확정과 신규 딜은 같은 톤이다 — 한쪽만 튀면 없는 위계가 생긴다", () => {
    // ⛔ 기대표가 아니라 실제 렌더 두 개를 맞대 본다(위 동어반복 주석과 같은 이유).
    const { container: mapped, unmount } = render(<MappingStatusBadge status="MAPPED" />);
    const mappedVariant = renderedBadge(mapped).variant;
    unmount();

    const { container: newDeal } = render(<MappingStatusBadge status="NEW_DEAL" />);
    expect(mappedVariant).toBe(renderedBadge(newDeal).variant);
  });
});

/**
 * 두 컴포넌트가 같은 화면(가격표 상세)에 함께 뜬다 — 같은 사실을 다른 색으로 말하면
 * 그 자체가 결함이다. 종전에 카드는 초록, 배지는 네이비였다.
 */
describe("반영 결과 카드와 시트 배지의 어휘 정합", () => {
  function summary(outcome: ApplySummary["outcome"]): ApplySummary {
    return {
      proposalId: "p1",
      outcome,
      createdCount: 1,
      updatedCount: 0,
      finishedAt: outcome === "RUNNING" ? null : "2026-08-26T00:00:00.000Z",
      errorMessage: null,
    };
  }

  it("반영 완료: 카드와 배지가 같은 초록이다", () => {
    const { container: card, unmount } = render(<ApplyResultCard summary={summary("SUCCEEDED")} />);
    const cardVariant = renderedBadge(card).variant;
    unmount();

    const { container: badge } = render(<PriceSheetStatusBadge status="APPLIED" />);
    expect(cardVariant).toBe("status-success");
    expect(renderedBadge(badge).variant).toBe(cardVariant);
  });

  it("반영 중: 카드와 배지가 같은 대기색이고 라벨 문구도 같다", () => {
    const { container: card, unmount } = render(<ApplyResultCard summary={summary("RUNNING")} />);
    const cardBadge = renderedBadge(card);
    unmount();

    const { container: badge } = render(<PriceSheetStatusBadge status="APPLYING" />);
    expect(cardBadge).toEqual({ label: "반영 중", variant: "status-pending" });
    expect(renderedBadge(badge)).toEqual(cardBadge);
  });

  it("반영 중·반영완료에서 영문이 화면에 노출되지 않는다", () => {
    for (const status of ["APPLYING", "APPLIED"]) {
      const { container, unmount } = render(<PriceSheetStatusBadge status={status} />);
      expect(renderedBadge(container).label, status).not.toMatch(/[A-Z]{3,}/);
      unmount();
    }
    const { container } = render(<MappingStatusBadge status="APPLIED" />);
    expect(renderedBadge(container).label).not.toMatch(/[A-Z]{3,}/);
  });
});
