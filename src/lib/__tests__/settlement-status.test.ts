/**
 * 정산 상태기계 단위 테스트 (confirm_settlement 청사진 §2).
 * deriveSettlementState / isValidSettlementAction / computeAutoStatus 순수 함수 검증.
 */
import { describe, expect, it } from "vitest";
import {
  deriveSettlementState,
  isValidSettlementAction,
  computeAutoStatus,
} from "@/lib/settlement-status";

/** 종전 두 축(입금·지급)만 있는 채널의 플래그 묶음. */
const legacyFlags = (deposit: boolean, payout: boolean) => ({
  salesChannel: "BRAND_MALL",
  isDepositReceived: deposit,
  isPayoutCompleted: payout,
  isSupplierPayoutCompleted: false,
});

/** 자사몰 = [공급사 지급, 셀러 지급] · 입금 칸 없음. */
const ownMallFlags = (supplierPayout: boolean, sellerPayout: boolean) => ({
  salesChannel: "OWN_MALL_NAVER",
  isDepositReceived: false,
  isPayoutCompleted: sellerPayout,
  isSupplierPayoutCompleted: supplierPayout,
});

describe("deriveSettlementState", () => {
  it("둘 다 false → pending", () => {
    expect(deriveSettlementState(legacyFlags(false, false))).toBe("pending");
  });
  it("입금만 → confirmed", () => {
    expect(deriveSettlementState(legacyFlags(true, false))).toBe("confirmed");
  });
  it("지급 완료 → paid (입금 플래그 무관)", () => {
    expect(deriveSettlementState(legacyFlags(true, true))).toBe("paid");
    expect(deriveSettlementState(legacyFlags(false, true))).toBe("paid");
  });

  // 자사몰 회귀 — 종전에는 `isDepositReceived` 가 영원히 false 라 confirmed 단계가
  // 존재할 수 없었다(공급사 지급을 마쳐도 화면이 「예정」이었다).
  it("자사몰: 공급사 지급만 완료 → confirmed", () => {
    expect(deriveSettlementState(ownMallFlags(true, false))).toBe("confirmed");
  });
  it("자사몰: 셀러 지급 완료 → paid", () => {
    expect(deriveSettlementState(ownMallFlags(true, true))).toBe("paid");
  });
  it("자사몰: 아무것도 없으면 pending — 입금 플래그가 켜져 있어도 판정에 안 들어간다", () => {
    expect(
      deriveSettlementState({ ...ownMallFlags(false, false), isDepositReceived: true }),
    ).toBe("pending");
  });
});

describe("isValidSettlementAction (전진 전용 · 슬롯 순서)", () => {
  it("pending + deposit → OK", () => {
    expect(isValidSettlementAction(legacyFlags(false, false), "deposit")).toEqual({ ok: true });
  });
  it("pending + payout → 거부(입금 선행)", () => {
    const r = isValidSettlementAction(legacyFlags(false, false), "payout");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/공급사 입금 완료가 선행/);
  });
  it("confirmed + payout → OK", () => {
    expect(isValidSettlementAction(legacyFlags(true, false), "payout")).toEqual({ ok: true });
  });
  it("confirmed + deposit → 거부(이미 입금)", () => {
    const r = isValidSettlementAction(legacyFlags(true, false), "deposit");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/이미 입금 확정/);
  });
  it("paid + deposit/payout → 모두 거부", () => {
    expect(isValidSettlementAction(legacyFlags(true, true), "deposit").ok).toBe(false);
    expect(isValidSettlementAction(legacyFlags(true, true), "payout").ok).toBe(false);
    // 입금 없이 지급만 완료된 레거시 조합도 전진 대상이 아니다(종전 `state === "paid"` 계약).
    expect(isValidSettlementAction(legacyFlags(false, true), "deposit").ok).toBe(false);
  });

  // 자사몰 회귀 — 종전에는 입금 플래그가 영원히 false 라 어시스턴트로 지급 완료가
  // **원천 불가**했다(오너 확정 2026-08-25: 슬롯 순서로 일반화).
  it("자사몰: deposit 타깃은 절차 자체가 없어 거부한다", () => {
    const r = isValidSettlementAction(ownMallFlags(false, false), "deposit");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/절차가 없습니다/);
  });
  it("자사몰: 공급사 지급 전 셀러 지급은 거부(선행 조건)", () => {
    const r = isValidSettlementAction(ownMallFlags(false, false), "payout");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/공급사 지급 완료가 선행/);
  });
  it("자사몰: 공급사 지급이 끝나면 셀러 지급 OK", () => {
    expect(isValidSettlementAction(ownMallFlags(true, false), "payout")).toEqual({ ok: true });
  });
});

describe("computeAutoStatus (채널 인지 SSOT — 세 쓰기 경로 공유)", () => {
  const flags = (overrides: Partial<Parameters<typeof computeAutoStatus>[2]> = {}) => ({
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
    ...overrides,
  });

  it("일반 채널: 입금+지급 true → COMPLETED", () => {
    expect(
      computeAutoStatus("SETTLEMENT_WAIT", "BRAND_MALL", flags({ isDepositReceived: true, isPayoutCompleted: true })),
    ).toBe("COMPLETED");
  });
  it("일반 채널: 하나만 true & 이전 COMPLETED → SETTLEMENT_WAIT 강등", () => {
    expect(computeAutoStatus("COMPLETED", "BRAND_MALL", flags({ isDepositReceived: true }))).toBe("SETTLEMENT_WAIT");
    expect(computeAutoStatus("COMPLETED", "SELLER_MALL", flags({ isPayoutCompleted: true }))).toBe("SETTLEMENT_WAIT");
  });
  it("일반 채널: 하나만 true & 이전 COMPLETED 아님 → undefined(무변경)", () => {
    expect(computeAutoStatus("SETTLEMENT_WAIT", "BRAND_MALL", flags({ isDepositReceived: true }))).toBeUndefined();
    expect(computeAutoStatus("PROPOSAL", "BRAND_MALL", flags({ isDepositReceived: true }))).toBeUndefined();
  });
  it("일반 채널: 전부 false → undefined", () => {
    expect(computeAutoStatus("SETTLEMENT_WAIT", "BRAND_MALL", flags())).toBeUndefined();
  });
  it("자사몰: 공급사+셀러 지급 true → 입금 false 여도 COMPLETED", () => {
    expect(
      computeAutoStatus(
        "SETTLEMENT_WAIT",
        "OWN_MALL_NAVER",
        flags({ isPayoutCompleted: true, isSupplierPayoutCompleted: true }),
      ),
    ).toBe("COMPLETED");
  });
  it("자사몰: 셀러 지급만 true & 이전 COMPLETED → SETTLEMENT_WAIT 강등", () => {
    expect(
      computeAutoStatus("COMPLETED", "OWN_MALL", flags({ isPayoutCompleted: true })),
    ).toBe("SETTLEMENT_WAIT");
  });
  it("자사몰: 입금 플래그는 판정 집합 밖 — 입금만 true 여도 undefined", () => {
    expect(computeAutoStatus("SETTLEMENT_WAIT", "OWN_MALL", flags({ isDepositReceived: true }))).toBeUndefined();
  });
});
