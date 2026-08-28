// 멱등성 4종 세트 계약.
//
// 이 규칙이 무너지면 같은 항목이 반복 노출돼 승인함이 마비되고, 오너가 출력 전체를
// 무시하게 된다 — F1 스펙이 스스로 경고한 "기안 남발"의 정확한 원인이다.
//
// ⏰ 고정 날짜 픽스처 금지(P9) — 기준 시각을 주입한다.

import { describe, it, expect } from "vitest";
import {
  PROPOSAL_COOLDOWN_DAYS,
  buildProposalHistory,
  decideProposable,
  selectProposable,
} from "../proposal-idempotency";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-05T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

const row = (over: Partial<Parameters<typeof buildProposalHistory>[0][number]> = {}) => ({
  dedupeKey: "k1",
  status: "EXECUTED",
  lastActivityAt: daysAgo(200) as Date | string,
  ...over,
});

describe("쿨다운 창 (③)", () => {
  it("D3 의 3개월이 기본값이다", () => {
    expect(PROPOSAL_COOLDOWN_DAYS).toBe(90);
  });

  it("창 안이면 막고, 창을 넘기면 다시 올린다", () => {
    const inside = buildProposalHistory([row({ lastActivityAt: daysAgo(PROPOSAL_COOLDOWN_DAYS - 1) })]);
    const outside = buildProposalHistory([row({ lastActivityAt: daysAgo(PROPOSAL_COOLDOWN_DAYS) })]);
    expect(decideProposable("k1", inside, NOW)).toEqual({
      eligible: false,
      skipReason: "COOLDOWN",
    });
    expect(decideProposable("k1", outside, NOW)).toEqual({ eligible: true });
  });

  it("이력이 없는 키는 바로 통과한다", () => {
    expect(decideProposable("never-seen", buildProposalHistory([]), NOW)).toEqual({
      eligible: true,
    });
  });
});

describe("'이미 처리' 집합 (④) — 상태를 가리지 않는다", () => {
  it.each([["REJECTED"], ["APPROVED"], ["EXECUTED"], ["FAILED"]])(
    "%s 도 쿨다운 안이면 다시 올리지 않는다",
    (status) => {
      const history = buildProposalHistory([row({ status, lastActivityAt: daysAgo(10) })]);
      expect(decideProposable("k1", history, NOW)).toEqual({
        eligible: false,
        skipReason: "COOLDOWN",
      });
    },
  );

  // 🔴 오너 확정(2026-08-04): 거부는 **쿨다운 3개월 뒤 재등장**한다.
  // ⚠️ 활동 시각이 아니라 생성 시각으로 재면 이 케이스가 뚫린다 — 오래 전에 올라와
  // 어제 거부된 기안이 하루 만에 다시 올라온다.
  it("오래 전에 올라와 어제 거부된 기안은 아직 쿨다운 안이다", () => {
    const history = buildProposalHistory([
      row({ status: "REJECTED", lastActivityAt: daysAgo(1) }),
    ]);
    expect(decideProposable("k1", history, NOW)).toEqual({
      eligible: false,
      skipReason: "COOLDOWN",
    });
  });

  it("거부 후 3개월이 지나면 다시 올라온다", () => {
    const history = buildProposalHistory([
      row({ status: "REJECTED", lastActivityAt: daysAgo(PROPOSAL_COOLDOWN_DAYS) }),
    ]);
    expect(decideProposable("k1", history, NOW)).toEqual({ eligible: true });
  });
});

describe("열린 기안 (②) — 나이와 무관하게 막는다", () => {
  it.each([["DRAFT"], ["PENDING_APPROVAL"]])("%s 는 쿨다운이 지났어도 중복이다", (status) => {
    const history = buildProposalHistory([row({ status, lastActivityAt: daysAgo(999) })]);
    expect(decideProposable("k1", history, NOW)).toEqual({ eligible: false, skipReason: "OPEN" });
  });

  it("같은 키에 닫힌 이력과 열린 기안이 섞여 있으면 열린 쪽이 이긴다", () => {
    const history = buildProposalHistory([
      row({ status: "REJECTED", lastActivityAt: daysAgo(999) }),
      row({ status: "PENDING_APPROVAL", lastActivityAt: daysAgo(999) }),
    ]);
    expect(decideProposable("k1", history, NOW)).toMatchObject({ skipReason: "OPEN" });
  });

  it("키가 다르면 서로를 막지 않는다 (과차단 방지 — D2 2단계의 이유)", () => {
    const history = buildProposalHistory([row({ dedupeKey: "other", status: "PENDING_APPROVAL" })]);
    expect(decideProposable("k1", history, NOW)).toEqual({ eligible: true });
  });
});

describe("selectProposable — 상한과 집계", () => {
  const item = (key: string) => ({ key });
  const keyOf = (i: { key: string }) => i.key;

  it("통과분만 고르고 사유별로 센다", () => {
    const history = buildProposalHistory([
      row({ dedupeKey: "open", status: "PENDING_APPROVAL" }),
      row({ dedupeKey: "cool", status: "EXECUTED", lastActivityAt: daysAgo(1) }),
    ]);
    const result = selectProposable([item("ok"), item("open"), item("cool")], keyOf, history, {
      now: NOW,
      cap: 10,
    });
    expect(result.selected.map(keyOf)).toEqual(["ok"]);
    expect(result.skippedOpen).toBe(1);
    expect(result.skippedCooldown).toBe(1);
    expect(result.droppedByCap).toBe(0);
  });

  it("입력 순서가 우선순위다 — 상한에 걸리면 앞쪽이 남는다", () => {
    const result = selectProposable(
      [item("a"), item("b"), item("c")],
      keyOf,
      buildProposalHistory([]),
      { now: NOW, cap: 2 },
    );
    expect(result.selected.map(keyOf)).toEqual(["a", "b"]);
  });

  // ⚠️ 조용한 절단은 "전부 처리했다"로 읽힌다 — 빠진 수가 반드시 드러나야 한다.
  it("상한에 걸려 빠진 수를 보고한다", () => {
    const result = selectProposable(
      [item("a"), item("b"), item("c")],
      keyOf,
      buildProposalHistory([]),
      { now: NOW, cap: 1 },
    );
    expect(result.droppedByCap).toBe(2);
  });

  it("상한 초과분은 건너뛴 것으로 세지 않는다 (사유가 다르다)", () => {
    const result = selectProposable([item("a"), item("b")], keyOf, buildProposalHistory([]), {
      now: NOW,
      cap: 1,
    });
    expect([result.skippedOpen, result.skippedCooldown]).toEqual([0, 0]);
    expect(result.droppedByCap).toBe(1);
  });
});
