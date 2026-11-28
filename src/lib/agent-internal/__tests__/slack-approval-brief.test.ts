/**
 * 슬랙 승인 요청 카드 글 — 간이 기술 한국어 규칙(R1~R5, `slack-approval-brief.ts` 헤더)을 고정한다.
 * 이름·금액은 모두 지어낸 값이다.
 */
import { describe, expect, it, vi } from "vitest";
import { WRITE_ACTIONS } from "@/lib/agent/write-actions";
import {
  BRIEF_TEXT,
  CONTENT_REQUIRED_ACTIONS,
  MAX_BRIEF_FIELDS,
  MONEY_ACTIONS,
  buildSlackApprovalBrief,
  type BriefDeps,
} from "../slack-approval-brief";

const names: BriefDeps = { entityName: vi.fn(async (_type, id: string) => `이름-${id}`) };

function proposal(action: string, args: Record<string, unknown>, resultSummary: string | null = null) {
  return { payload: { action, args }, resultSummary, targetEntityType: null, targetEntityId: null };
}

const SAMPLES: Record<string, Record<string, unknown>> = {
  update_settlement_amount: { campaignId: "c1", field: "sellerExpense", expectedCurrentKrw: 1_000_000, newAmountKrw: 1_200_000 },
  confirm_settlement: { campaignId: "c1", target: "payout" },
  update_record: {
    entityType: "CAMPAIGN",
    entityId: "c1",
    changes: { taxExpense: 2_000, quantity: 30 },
    expected: { taxExpense: 1_000, quantity: 20 },
  },
  create_partner: { partner: { name: "가상상사", type: "BRAND" }, contacts: [{ name: "가상 담당" }] },
  create_campaign_round: { dealId: "d1", sellerId: "s1", startDate: "2026-12-01", endDate: "2026-12-07" },
};

/** 값(「」 안 이름·금액·화살표 뒤)을 뺀 글 길이 상한 — R1 */
const PROSE_MAX = 45;
const PASSIVE = /(됩니다|될 수|되었습니다|됐습니다)/;

describe("buildSlackApprovalBrief — 줄 순서와 문구(R4)", () => {
  it("정산 금액 수정: 대상 → 지금 값 → 바꿀 값 → 차이 → 승인하면 → 되돌리기 → 주의", async () => {
    const brief = await buildSlackApprovalBrief(proposal("update_settlement_amount", SAMPLES.update_settlement_amount), names);
    expect(brief).toEqual({
      heading: "승인 요청: 정산 금액 수정",
      lines: [
        "대상: 캠페인 「이름-c1」",
        "바뀌는 값: 셀러지급액 1,000,000원 → 1,200,000원",
        "차이: +200,000원",
        BRIEF_TEXT.onApprove,
        BRIEF_TEXT.undo,
      ],
      caution: BRIEF_TEXT.caution,
      complete: true,
    });
  });

  it("지금 값이 비어 있으면 0원이 아니라 「비어 있음」이고 차이 줄을 싣지 않는다", async () => {
    const brief = await buildSlackApprovalBrief(
      proposal("update_settlement_amount", { ...SAMPLES.update_settlement_amount, expectedCurrentKrw: null }),
      names,
    );
    expect(brief.lines).toContain("바뀌는 값: 셀러지급액 비어 있음 → 1,200,000원");
    expect(brief.lines.some((l) => l.startsWith("차이:"))).toBe(false);
  });

  it("정산 확정·기록 수정·거래처 등록·회차 생성도 실행 명세에서 내용 줄을 만든다", async () => {
    const confirm = await buildSlackApprovalBrief(proposal("confirm_settlement", SAMPLES.confirm_settlement), names);
    expect(confirm.lines.slice(0, 2)).toEqual(["대상: 캠페인 「이름-c1」", "바뀌는 값: 지급완료 표시를 켭니다."]);

    const record = await buildSlackApprovalBrief(proposal("update_record", SAMPLES.update_record), names);
    expect(record.lines[0]).toBe("대상: 캠페인 「이름-c1」");
    // 칸마다 한 줄 — 칸 이름에 「 · 」가 있어도 금액이 다른 줄로 갈라지지 않는다.
    expect(record.lines[1]).toMatch(/^바뀌는 값: 공제세액 · 부가세 .*1,000.* → .*2,000/);
    expect(record.lines[2]).toMatch(/^바뀌는 값: .+ .*20.* → .*30/);
    expect(record.lines).toHaveLength(2 + 1 + 2);
    expect(record.complete).toBe(true);

    const partner = await buildSlackApprovalBrief(proposal("create_partner", SAMPLES.create_partner), names);
    expect(partner.lines[0]).toBe("새 거래처: 「가상상사」 (브랜드)");
    expect(partner.lines).toContain("계산서 정보: 채우지 않습니다. 필요하면 결재함 승인으로 채웁니다.");
    expect(partner.caution).toBeNull();

    const round = await buildSlackApprovalBrief(proposal("create_campaign_round", SAMPLES.create_campaign_round), names);
    expect(round.lines.slice(0, 3)).toEqual([
      "대상: 판매 조건 「이름-d1」",
      "대상: 셀러 「이름-s1」",
      "기간: 2026-12-01 ~ 2026-12-07",
    ]);
  });
});

describe("buildSlackApprovalBrief — 지어낸 설명 금지(R5)", () => {
  it("내용 필수 액션이 명세에서 내용을 못 만들면 complete=false 다(hermes 가 버튼을 달지 않는다)", async () => {
    for (const action of CONTENT_REQUIRED_ACTIONS) {
      const brief = await buildSlackApprovalBrief(proposal(action, {}, "봇이 쓴 설명"), names);
      expect([action, brief.complete]).toEqual([action, false]);
      expect(brief.lines.join("\n")).not.toContain("봇이 쓴");
    }
    const ok = await buildSlackApprovalBrief(proposal("create_deal", {}, null), names);
    expect(ok.complete).toBe(true);
  });

  it("기록 수정 칸이 상한을 넘으면 칸을 자르지 않고 complete=false 로 결재함에 보낸다", async () => {
    const fields = Array.from({ length: MAX_BRIEF_FIELDS + 1 }, (_, i) => `f${i}`);
    const changes = Object.fromEntries(fields.map((f) => [f, "새 값"]));
    const brief = await buildSlackApprovalBrief(
      proposal("update_record", { entityType: "CAMPAIGN", entityId: "c1", changes, expected: changes }),
      names,
    );
    expect(brief.complete).toBe(false);
    expect(brief.lines[0]).toBe(BRIEF_TEXT.noDetail);
  });

  it("긴 값은 값마다 잘라 「→ 바꿀 값」이 줄 안에 남는다", async () => {
    const long = "가".repeat(500);
    const brief = await buildSlackApprovalBrief(
      proposal("update_record", {
        entityType: "PARTNER",
        entityId: "p1",
        changes: { address: "새 주소" },
        expected: { address: long },
      }),
      names,
    );
    expect(brief.lines[1]).toMatch(/…\s*→ .*새 주소/);
    expect(brief.lines[1].length).toBeLessThan(200);
  });

  it("돈 기안은 명세가 깨져도 봇 요약으로 메우지 않는다", async () => {
    for (const action of MONEY_ACTIONS) {
      const brief = await buildSlackApprovalBrief(proposal(action, {}, "봇이 쓴 그럴듯한 설명"), names);
      expect(brief.lines.join("\n")).not.toContain("봇이 쓴");
      expect(brief.lines[0]).toBe(BRIEF_TEXT.noDetail);
      expect(brief.caution).toBe(BRIEF_TEXT.caution);
    }
  });

  it("그 밖의 기안은 봇 요약을 「봇 설명」이라고 밝혀 싣는다", async () => {
    const brief = await buildSlackApprovalBrief(proposal("create_deal", {}, "가상 판매 조건 등록"), names);
    expect(brief.lines[0]).toBe("봇 설명: 가상 판매 조건 등록");
    expect(brief.caution).toBeNull();
  });

  it("이름 조회가 실패해도 글을 만든다(이름 자리는 「(이름 없음)」)", async () => {
    const failing: BriefDeps = { entityName: vi.fn(async () => Promise.reject(new Error("db down"))) };
    const brief = await buildSlackApprovalBrief(proposal("confirm_settlement", SAMPLES.confirm_settlement), failing);
    expect(brief.lines[0]).toBe("대상: 캠페인 「(이름 없음)」");
  });
});

describe("buildSlackApprovalBrief — 짧은 문장·능동형·용어 통일(R1~R3)", () => {
  it("모든 쓰기 액션의 글이 규칙을 지킨다", async () => {
    for (const action of Object.keys(WRITE_ACTIONS)) {
      const brief = await buildSlackApprovalBrief(proposal(action, SAMPLES[action] ?? {}, "가상 설명"), names);
      expect(brief.heading.startsWith(BRIEF_TEXT.headingPrefix)).toBe(true);
      const prose = [...brief.lines, brief.caution ?? ""]
        .filter((l) => !l.startsWith(BRIEF_TEXT.botNotePrefix))
        .map((l) => l.replace(/「[^」]*」/g, "").replace(/:.*→.*/, ":"));
      for (const line of prose) {
        expect([action, line, line.length <= PROSE_MAX]).toEqual([action, line, true]);
        expect([action, line, PASSIVE.test(line)]).toEqual([action, line, false]);
      }
      // 마지막 두 줄은 늘 같은 고정 문구다 — 승인 결과·되돌리기 용어를 섞지 않는다.
      expect(brief.lines.slice(-2)).toEqual([BRIEF_TEXT.onApprove, BRIEF_TEXT.undo]);
    }
  });
});
