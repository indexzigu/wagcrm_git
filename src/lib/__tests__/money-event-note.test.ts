import { describe, it, expect } from "vitest";
import { buildMoneyNoteLines } from "../money-event-note";
import { resolveCampaignMoneySlots } from "../tax-filing-board";

/** 채널의 슬롯을 키로 집어 온다 — 슬롯을 손으로 만들지 않는다(SSOT 그대로 쓴다). */
function slotOf(salesChannel: string, key: string) {
  const slot = resolveCampaignMoneySlots(salesChannel).find((s) => s.key === key);
  if (!slot) throw new Error(`${salesChannel} 에 ${key} 슬롯이 없다`);
  return slot;
}

const BRAND_DEPOSIT = () => slotOf("BRAND_MALL", "deposit");
const BRAND_PAYOUT = () => slotOf("BRAND_MALL", "payout");
const OWN_SUPPLIER_PAYOUT = () => slotOf("OWN_MALL", "supplierPayout");

describe("buildMoneyNoteLines", () => {
  describe("금액 줄", () => {
    it("금액이 있으면 슬롯 동사와 함께 원화로 적는다", () => {
      const lines = buildMoneyNoteLines({
        slot: BRAND_PAYOUT(),
        amount: 1240000,
        accounts: [],
      });
      expect(lines[0]).toBe("지급 금액: ₩1,240,000");
    });

    it("입금 슬롯은 입금이라고 적는다(동사는 슬롯이 정한다)", () => {
      const lines = buildMoneyNoteLines({
        slot: BRAND_DEPOSIT(),
        amount: 500000,
        accounts: [],
      });
      expect(lines[0]).toBe("입금 금액: ₩500,000");
    });

    it("금액이 null 이면 «미정» 이다 — ₩0 으로 접지 않는다", () => {
      const lines = buildMoneyNoteLines({
        slot: OWN_SUPPLIER_PAYOUT(),
        amount: null,
        accounts: [],
      });
      expect(lines[0]).toBe("지급 금액: 미정");
      expect(lines.join("\n")).not.toContain("₩0");
    });

    it("실제 0 원은 «미정» 이 아니라 ₩0 이다", () => {
      const lines = buildMoneyNoteLines({
        slot: BRAND_PAYOUT(),
        amount: 0,
        accounts: [],
      });
      expect(lines[0]).toBe("지급 금액: ₩0");
    });
  });

  describe("계좌 줄", () => {
    it("입금 슬롯에는 계좌를 적지 않는다 — 우리가 받는 쪽이라 상대 계좌가 무의미하다", () => {
      const lines = buildMoneyNoteLines({
        slot: BRAND_DEPOSIT(),
        amount: 500000,
        accounts: [{ holder: "(주)와그물산", account: "신한 110-222-333444" }],
      });
      expect(lines.join("\n")).not.toContain("계좌");
    });

    it("지급 슬롯 · 계좌 1건 · 예금주 없음이면 계좌만 적는다", () => {
      const lines = buildMoneyNoteLines({
        slot: BRAND_PAYOUT(),
        amount: 1240000,
        accounts: [{ holder: null, account: "국민 123456-78-901234" }],
      });
      expect(lines).toEqual([
        "지급 금액: ₩1,240,000",
        "지급 계좌: 국민 123456-78-901234",
      ]);
    });

    it("지급 슬롯 · 계좌 1건 · 예금주 있으면 예금주를 앞에 병기한다", () => {
      const lines = buildMoneyNoteLines({
        slot: OWN_SUPPLIER_PAYOUT(),
        amount: null,
        accounts: [{ holder: "(주)와그물산", account: "신한 110-222-333444" }],
      });
      expect(lines[1]).toBe("지급 계좌: (주)와그물산 신한 110-222-333444");
    });

    it("계좌가 여러 건이면 전부 나열한다 — 조용히 하나를 고르지 않는다", () => {
      const lines = buildMoneyNoteLines({
        slot: OWN_SUPPLIER_PAYOUT(),
        amount: null,
        accounts: [
          { holder: "(주)와그물산", account: "신한 110-222-333444" },
          { holder: "뷰티코리아", account: "국민 123-456-789" },
        ],
      });
      expect(lines).toEqual([
        "지급 금액: 미정",
        "지급 계좌:",
        "- (주)와그물산: 신한 110-222-333444",
        "- 뷰티코리아: 국민 123-456-789",
      ]);
    });

    it("계좌가 없으면 «미등록» 이라고 적는다 — 줄을 빼면 «넣었는데 안 보인다» 로 오독된다", () => {
      const lines = buildMoneyNoteLines({
        slot: BRAND_PAYOUT(),
        amount: 1240000,
        accounts: [],
      });
      expect(lines[1]).toBe("지급 계좌: 미등록");
    });

    it("빈 문자열·공백뿐인 계좌는 미등록으로 접는다", () => {
      const lines = buildMoneyNoteLines({
        slot: BRAND_PAYOUT(),
        amount: 1240000,
        accounts: [
          { holder: "홍길동", account: "   " },
          { holder: "빈값", account: "" },
        ],
      });
      expect(lines[1]).toBe("지급 계좌: 미등록");
    });

    it("예금주·계좌 경계가 다르면 서로 다른 계좌다 (문자열을 이어 붙여 접지 않는다)", () => {
      // "가" + "나 다" 와 "가 나" + "다" 는 이어 붙이면 같은 글자가 된다.
      // 한쪽이 접히면 공급사 한 곳의 계좌 줄이 사라진다 — 이 기능이 막으려는 바로 그 사고다.
      const lines = buildMoneyNoteLines({
        slot: OWN_SUPPLIER_PAYOUT(),
        amount: null,
        accounts: [
          { holder: "가", account: "나 다" },
          { holder: "가 나", account: "다" },
        ],
      });
      expect(lines).toEqual([
        "지급 금액: 미정",
        "지급 계좌:",
        "- 가: 나 다",
        "- 가 나: 다",
      ]);
    });

    it("같은 계좌가 여러 멤버에서 올라오면 한 번만 적는다", () => {
      const lines = buildMoneyNoteLines({
        slot: OWN_SUPPLIER_PAYOUT(),
        amount: null,
        accounts: [
          { holder: "(주)와그물산", account: "신한 110-222-333444" },
          { holder: "(주)와그물산", account: "신한 110-222-333444" },
        ],
      });
      expect(lines).toEqual([
        "지급 금액: 미정",
        "지급 계좌: (주)와그물산 신한 110-222-333444",
      ]);
    });
  });
});
