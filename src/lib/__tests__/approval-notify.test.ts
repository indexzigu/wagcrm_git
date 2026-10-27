// 결재 대기 알림 문구 계약 — 텔레그램 한 통에 기안 종류·대상·올린 곳·요약·링크가 실리고, 많이 쌓이면 1통으로 묶는다.
import { describe, expect, it } from "vitest";
import {
  APPROVAL_BATCH_THRESHOLD,
  formatApprovalBatch,
  formatApprovalMessage,
  formatApprovalMessages,
  type ApprovalNotifyProposal,
} from "../approval-notify";

const BASE = "https://crm.example.com";

function proposal(over: Partial<ApprovalNotifyProposal> = {}): ApprovalNotifyProposal {
  return {
    id: "p1",
    title: "테스트 판매 조건 상태 변경",
    resultSummary: "판매 조건을 진행 중으로 바꿉니다.",
    payload: { action: "change_deal_status", args: { status: "ACTIVE" } },
    createdBy: "AGENT_WORKER",
    createdAt: new Date("2026-10-27T01:05:00Z"), // KST 10:05
    targetEntityType: "DEAL",
    targetName: "테스트 상품",
    argLabels: null,
    ...over,
  };
}

describe("formatApprovalMessage", () => {
  it("제목·종류·대상·올린 곳·요약·열기 링크를 싣는다", () => {
    const m = formatApprovalMessage(proposal(), BASE);
    expect(m).toMatchObject({ key: "approval-p1", icon: "📝", ackField: "ownerNotifiedAt", proposalIds: ["p1"] });
    expect(m.title).toBe("결재 대기: 테스트 판매 조건 상태 변경");
    expect(m.detail.split("\n")).toEqual([
      "판매 조건 상태 변경",
      "대상: 판매 조건 테스트 상품",
      "올린 곳: 슬랙봇 · 10-27 10:05",
      "",
      "판매 조건을 진행 중으로 바꿉니다.",
      "",
      "열기: https://crm.example.com/approvals/p1",
    ]);
  });

  it("요약이 제목과 같으면 한 번만 싣는다", () => {
    const m = formatApprovalMessage(proposal({ resultSummary: "테스트 판매 조건 상태 변경" }), BASE);
    expect(m.detail).not.toContain("\n\n테스트 판매 조건 상태 변경");
  });

  it("새 회차 기안은 대상 대신 셀러·판매 조건 이름을 싣는다", () => {
    const m = formatApprovalMessage(
      proposal({
        payload: { action: "create_campaign_round", args: {} },
        targetEntityType: null,
        targetName: null,
        argLabels: { seller: "테스트셀러", deal: "테스트 상품" },
        createdBy: "SYSTEM_CALENDAR_INBOUND",
      }),
      BASE,
    );
    expect(m.detail).toContain("새 회차 생성\n대상: 셀러 테스트셀러 · 판매 조건 테스트 상품");
  });

  it("모르는 액션은 카드처럼 「알 수 없음」, 액션이 없으면 「기안」, 주소가 없으면 링크를 뺀다", () => {
    expect(formatApprovalMessage(proposal({ payload: { action: "new_tool" } }), BASE).detail.split("\n")[0]).toBe("알 수 없음");
    const m = formatApprovalMessage(proposal({ payload: null, targetName: null }), null);
    expect(m.detail.split("\n")[0]).toBe("기안");
    expect(m.detail).not.toContain("대상:");
    expect(m.detail).not.toContain("열기:");
  });

  it("긴 요약은 잘라 텔레그램 한 통 상한 안에 둔다", () => {
    const m = formatApprovalMessage(proposal({ resultSummary: "가".repeat(5000) }), BASE);
    expect(`${m.icon} ${m.title} — ${m.detail}`.length).toBeLessThan(4096);
    expect(m.detail).toContain("…");
  });
});

describe("formatApprovalMessages", () => {
  it("빈 목록은 빈 배열", () => {
    expect(formatApprovalMessages([], BASE)).toEqual([]);
  });

  it(`${APPROVAL_BATCH_THRESHOLD - 1}건까지는 기안마다 1통`, () => {
    const list = Array.from({ length: APPROVAL_BATCH_THRESHOLD - 1 }, (_, i) => proposal({ id: `p${i}` }));
    expect(formatApprovalMessages(list, BASE).map((m) => m.key)).toEqual(list.map((p) => `approval-${p.id}`));
  });

  it(`${APPROVAL_BATCH_THRESHOLD}건부터는 묶음 1통에 전부 실어 확인한다`, () => {
    const list = Array.from({ length: APPROVAL_BATCH_THRESHOLD }, (_, i) => proposal({ id: `p${i}`, title: `기안 ${i}` }));
    const messages = formatApprovalMessages(list, BASE);
    expect(messages).toHaveLength(1);
    expect(messages[0].title).toBe(`결재 대기 ${APPROVAL_BATCH_THRESHOLD}건`);
    expect(messages[0].proposalIds).toEqual(list.map((p) => p.id));
  });
});

describe("formatApprovalBatch", () => {
  it("키는 구성 전체의 지문이다 — 첫 기안이 같아도 구성이 바뀌면 다른 키, 순서만 바뀌면 같은 키", () => {
    const abcd = ["a", "b", "c", "d"].map((id) => ({ id, title: id, payload: null }));
    const key = (list: { id: string; title: string; payload: unknown }[]) => formatApprovalBatch(list, BASE).key;
    expect(key([...abcd, { id: "e", title: "e", payload: null }])).not.toBe(key(abcd));
    expect(key([...abcd].reverse())).toBe(key(abcd));
  });

  it("종류·제목은 10건까지 나열하고 나머지는 개수로 · 결재함 링크", () => {
    const list = Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, title: `기안 ${i}`, payload: { action: "confirm_settlement" } }));
    const m = formatApprovalBatch(list, BASE);
    const lines = m.detail.split("\n");
    expect(lines.slice(0, 10)).toEqual(list.slice(0, 10).map((p) => `· [정산 확정] ${p.title}`));
    expect(lines).toContain("외 3건");
    expect(lines.at(-1)).toBe("결재함: https://crm.example.com/approvals");
    expect(m.key).toMatch(/^approval-batch-[0-9a-f]{16}$/);
    expect(m.proposalIds).toHaveLength(13);
  });
});
