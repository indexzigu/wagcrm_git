/**
 * 계약 — 「세무 처리」 보드의 대조 상태 4종은 화면에서 **서로 다른 말**이어야 한다.
 *
 * ## 무엇을 막는가
 *
 * 판정 계층은 네 상태를 갈라 놓았다(`board-evidence.ts`·`issuance-match.ts`):
 *
 * | 상태 | 뜻 | 오너의 처방 |
 * | --- | --- | --- |
 * | `unseen` | 안 왔다(스캔 범위 안인데 대응 계산서가 없다) | 상대에게 발행 독촉 |
 * | `no_data` | **안 봤다**(이 스캔의 대상 목록에 애초에 없다) | 조회 창·대상 확인 |
 * | `unmatchable` | 대조 수단이 없다(상대 사업자번호 미등록) | 우리가 번호를 등록 |
 * | `needs_review` | 봤는데 안 맞는다 | 계산서를 직접 확인 |
 *
 * 판정 계층의 분리는 `board-evidence.test.ts`·`issuance-match.test.ts` 가 이미 고정한다.
 * **고정되지 않은 곳이 화면이었다** — 네 상태가 같은 문구로 렌더되면 판정을 아무리 갈라
 * 놓아도 오너에게는 한 상태로 도착한다. PR #304 가 고친 결함(크론의 캠페인 창 270일 vs
 * 메일 창 90일의 차집합이 「미발행」으로 보고되던 것)이 화면 문구만으로 원위치된다.
 *
 * 특히 **`unseen`·`unmatchable` 을 「미수취」로 쓰지 않는다** — 메일 커버리지가 100% 가
 * 아님이 실측됐고(실물 계산서가 있는데 국세청 메일이 편지함 15개 폴더에 0건),
 * 상대 번호가 없으면 계산서가 와 있어도 영원히 매칭되지 않는다. 둘 다 「안 받았다」가
 * 아니라 「이 도구로는 확인되지 않았다」다.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EvidenceCell } from "./tax-filing-dialog";
import type { RowEvidence } from "@/lib/tax-invoice-mail/board-evidence";

const CASES: Array<{ label: string; evidence: RowEvidence }> = [
  { label: "unseen", evidence: { kind: "unseen", memberCount: 1 } },
  { label: "no_data", evidence: { kind: "no_data" } },
  { label: "unmatchable", evidence: { kind: "unmatchable", memberCount: 1 } },
  {
    label: "needs_review",
    evidence: { kind: "needs_review", reasons: ["금액 불일치"], memberCount: 1 },
  },
];

function renderText(evidence: RowEvidence): string {
  const { container, unmount } = render(<EvidenceCell evidence={evidence} />);
  const text = container.textContent ?? "";
  unmount();
  return text;
}

describe("대조 상태 4종의 화면 문구", () => {
  it("네 상태가 서로 다른 문구로 렌더된다 — 하나라도 겹치면 오너에게 같은 사실로 도착한다", () => {
    const texts = CASES.map((c) => renderText(c.evidence).trim());

    expect(new Set(texts).size).toBe(CASES.length);
    // 양성 대조군 — 문구가 전부 빈 문자열이라 "전부 다르다"가 거짓으로 통과하는 하네스
    // 고장을 잡는다.
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
  });

  it("「안 왔다」와 「안 봤다」는 서로의 문구를 포함하지 않는다", () => {
    const unseen = renderText({ kind: "unseen", memberCount: 1 });
    const noData = renderText({ kind: "no_data" });

    expect(unseen).not.toContain(noData.trim());
    expect(noData).not.toContain(unseen.trim());
  });

  it("확인되지 않은 상태를 「미수취」로 단정하지 않는다", () => {
    for (const kind of ["unseen", "unmatchable"] as const) {
      const text = renderText(
        kind === "unseen" ? { kind: "unseen", memberCount: 1 } : { kind: "unmatchable", memberCount: 1 },
      );
      // 「미수취 단정 아님」처럼 부정하는 문장은 허용한다 — 금지 대상은 단정하는 표기다.
      expect(text.replace(/미수취 단정 아님/g, "")).not.toContain("미수취");
    }
  });

  it("VERIFIED 만 「확인됨」으로 읽힌다", () => {
    const verified = renderText({ kind: "verified", detail: null, memberCount: 1 });
    expect(verified).toContain("확인됨");

    for (const c of CASES) {
      expect(renderText(c.evidence)).not.toContain("확인됨");
    }
  });
});

describe("자동 확정 표식", () => {
  it("EvidenceCell 은 증거가 없으면 아무것도 그리지 않는다 — 빈 셀을 「확인됨」으로 오독시키지 않는다", () => {
    render(<EvidenceCell evidence={null} />);
    expect(screen.queryByText("확인됨")).toBeNull();
  });
});
