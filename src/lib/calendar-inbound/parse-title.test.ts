import { describe, expect, it } from "vitest";
import {
  DEPOSIT_RE,
  KEYWORD_STRIP_RE,
  PAYOUT_RE,
  SUPPLIER_RE,
  normalizeToken,
  parseCalendarTitle,
} from "./parse-title";
import type { InboundDictionary } from "./types";

const dict: InboundDictionary = {
  sellers: [
    { id: "s1", names: ["샘플셀러", "샘플"] },
    { id: "s2", names: ["다른셀러"] },
  ],
  deals: [
    {
      id: "d1",
      brandNames: ["테스트브랜드"],
      dealName: "테스트브랜드 봄딜",
      partnerName: "테스트상사",
    },
    {
      id: "d2",
      brandNames: ["다른브랜드"],
      dealName: "다른브랜드 딜",
      partnerName: null,
    },
  ],
};

describe("parseCalendarTitle", () => {
  it("캠페인 회차: 셀러 X 브랜드 2차", () => {
    const r = parseCalendarTitle("샘플셀러 X 테스트브랜드 2차", dict);
    expect(r).toEqual({
      ok: true,
      intent: {
        kind: "campaign",
        sellerId: "s1",
        dealIds: ["d1"],
        round: 2,
        supplierHint: false,
        matchedBy: "rule",
      },
    });
  });

  it("지급 → payout", () => {
    const r = parseCalendarTitle("샘플셀러 테스트브랜드 지급", dict);
    expect(r.ok && r.intent.kind).toBe("payout");
  });

  it("입금 → deposit", () => {
    const r = parseCalendarTitle("샘플셀러 테스트브랜드 입금", dict);
    expect(r.ok && r.intent.kind).toBe("deposit");
  });

  it("셀러 둘 맞음 → ambiguous_seller", () => {
    const d: InboundDictionary = {
      ...dict,
      sellers: [
        { id: "s1", names: ["샘플셀러A"] },
        { id: "s2", names: ["샘플셀러B"] },
      ],
    };
    expect(parseCalendarTitle("샘플셀러 테스트브랜드 지급", d)).toEqual({
      ok: false,
      reason: "ambiguous_seller",
    });
  });

  it("브랜드 없음 → no_brand", () => {
    expect(parseCalendarTitle("샘플셀러 없는곳 지급", dict)).toEqual({
      ok: false,
      reason: "no_brand",
    });
  });

  it("셀러 없음 → no_seller", () => {
    expect(parseCalendarTitle("모르는사람 테스트브랜드 지급", dict)).toEqual({
      ok: false,
      reason: "no_seller",
    });
  });

  it("공급사 단어 → supplierHint", () => {
    const r = parseCalendarTitle("샘플셀러 테스트브랜드 공급사 지급", dict);
    expect(r.ok && r.intent.supplierHint).toBe(true);
    expect(r.ok && r.intent.kind).toBe("payout");
  });

  it("NFD 자모 제목도 매칭", () => {
    const r = parseCalendarTitle(
      "샘플셀러 X 테스트브랜드 2차".normalize("NFD"),
      dict,
    );
    expect(r.ok && r.intent.sellerId).toBe("s1");
    expect(r.ok && r.intent.round).toBe(2);
  });

  it("같은 브랜드 딜 둘 → ok, dealIds 2개", () => {
    const d: InboundDictionary = {
      ...dict,
      deals: [
        ...dict.deals,
        {
          id: "d3",
          brandNames: ["테스트브랜드"],
          dealName: "테스트브랜드 가을딜",
          partnerName: "테스트상사",
        },
      ],
    };
    const r = parseCalendarTitle("샘플셀러 테스트브랜드 3차", d);
    expect(r.ok && r.intent.dealIds.sort()).toEqual(["d1", "d3"]);
  });

  it("서로 다른 브랜드 둘 → ambiguous_brand", () => {
    const r = parseCalendarTitle("샘플셀러 브랜드 지급", {
      ...dict,
      deals: [
        {
          id: "d1",
          brandNames: ["테스트브랜드"],
          dealName: "a",
          partnerName: null,
        },
        {
          id: "d2",
          brandNames: ["다른브랜드"],
          dealName: "b",
          partnerName: null,
        },
      ],
    });
    expect(r).toEqual({ ok: false, reason: "ambiguous_brand" });
  });

  it("셀러에 쓴 토큰은 브랜드로 재사용하지 않는다", () => {
    const d: InboundDictionary = {
      sellers: [{ id: "s1", names: ["보바"] }],
      deals: [
        {
          id: "d1",
          brandNames: ["보바티"],
          dealName: "보바티 딜",
          partnerName: null,
        },
      ],
    };
    expect(parseCalendarTitle("보바 지급", d)).toEqual({
      ok: false,
      reason: "no_brand",
    });
  });

  it("셀러는 정확 일치가 포함 일치보다 우선", () => {
    const d: InboundDictionary = {
      ...dict,
      sellers: [
        { id: "s1", names: ["샘플셀러"] },
        { id: "s2", names: ["샘플셀러주니어"] },
      ],
    };
    const r = parseCalendarTitle("샘플셀러 테스트브랜드 입금", d);
    expect(r.ok && r.intent.sellerId).toBe("s1");
  });

  it("힌트: 제목으로 못 맞춘 것을 힌트로 맞추고 matchedBy=llm", () => {
    const r = parseCalendarTitle("뭔가 이상한 제목", dict, {
      sellerHint: "샘플셀러",
      brandHint: "테스트브랜드",
      round: 4,
      kind: "payout",
    });
    expect(r).toEqual({
      ok: true,
      intent: {
        kind: "payout",
        sellerId: "s1",
        dealIds: ["d1"],
        round: 4,
        supplierHint: false,
        matchedBy: "llm",
      },
    });
  });

  it("힌트의 round·kind 는 제목에 없을 때만 적용", () => {
    const r = parseCalendarTitle("샘플셀러 테스트브랜드 입금 2차", dict, {
      sellerHint: "샘플셀러",
      brandHint: "테스트브랜드",
      round: 9,
      kind: "payout",
    });
    expect(r.ok && r.intent.kind).toBe("deposit");
    expect(r.ok && r.intent.round).toBe(2);
  });
});

describe("KEYWORD_STRIP_RE", () => {
  it("종류·공급사 정규식의 낱말을 전부 걷어낸다(공유 정규식에서 파생)", () => {
    const words = [DEPOSIT_RE, PAYOUT_RE, SUPPLIER_RE].flatMap((re) =>
      re.source.split("|"),
    );
    expect(words.length).toBeGreaterThan(5);
    for (const word of words) {
      expect(`샘플${word}브랜드`.replace(KEYWORD_STRIP_RE, " ")).toBe(
        "샘플 브랜드",
      );
    }
  });
});

describe("normalizeToken", () => {
  it("NFC·공백·기호 제거·소문자", () => {
    expect(normalizeToken(" A-b_C! ")).toBe("abc");
    expect(normalizeToken("가".normalize("NFD"))).toBe("가");
  });
});

describe("parseCalendarTitle — 붙여 쓴 제목(전체 부분 문자열 보조 패스)", () => {
  it("셀러+브랜드가 붙은 지급 제목", () => {
    const r = parseCalendarTitle("샘플셀러테스트브랜드 지급", dict);
    expect(r).toEqual({
      ok: true,
      intent: {
        kind: "payout",
        sellerId: "s1",
        dealIds: ["d1"],
        round: null,
        supplierHint: false,
        matchedBy: "rule",
      },
    });
  });

  it("X 로 이어진 붙임 + 회차: 샘플셀러X테스트브랜드3차", () => {
    const r = parseCalendarTitle("샘플셀러X테스트브랜드3차", dict);
    expect(r.ok && r.intent.kind).toBe("campaign");
    expect(r.ok && r.intent.round).toBe(3);
    expect(r.ok && r.intent.sellerId).toBe("s1");
    expect(r.ok && r.intent.dealIds).toEqual(["d1"]);
  });

  it("셀러 별칭이 브랜드 이름의 일부여도 겹치지 않는 가장 긴 일치가 이긴다", () => {
    const d: InboundDictionary = {
      sellers: [{ id: "s1", names: ["샘플", "샘플셀러"] }],
      deals: [
        {
          id: "d1",
          brandNames: ["샘플브랜드"],
          dealName: "샘플브랜드 딜",
          partnerName: null,
        },
      ],
    };
    const r = parseCalendarTitle("샘플브랜드샘플셀러 지급", d);
    expect(r.ok && r.intent.sellerId).toBe("s1");
    expect(r.ok && r.intent.dealIds).toEqual(["d1"]);
  });

  it("사전 이름이 2자 미만이면 무시한다", () => {
    const d: InboundDictionary = {
      sellers: [{ id: "s1", names: ["샘"] }],
      deals: dict.deals,
    };
    expect(parseCalendarTitle("샘테스트브랜드 지급", d)).toEqual({
      ok: false,
      reason: "no_seller",
    });
  });

  it("셀러·브랜드가 같은 구간을 다투면(길이 동률) 실패 사유를 그대로 낸다", () => {
    const d: InboundDictionary = {
      sellers: [{ id: "s1", names: ["겹침이름"] }],
      deals: [
        {
          id: "d1",
          brandNames: ["겹침이름"],
          dealName: "딜",
          partnerName: null,
        },
      ],
    };
    const r = parseCalendarTitle("겹침이름 지급", d);
    expect(r.ok).toBe(false);
  });

  it("붙여 써도 브랜드가 둘이면 유일하지 않아 토큰 패스의 실패 사유 그대로", () => {
    expect(
      parseCalendarTitle("샘플셀러테스트브랜드다른브랜드 지급", dict),
    ).toEqual({ ok: false, reason: "no_brand" });
  });

  it("보조 패스로도 못 찾으면 기존 실패 사유 그대로(no_brand)", () => {
    expect(parseCalendarTitle("샘플셀러없는곳 지급", dict)).toEqual({
      ok: false,
      reason: "no_brand",
    });
  });

  it("토큰 패스가 이미 성공하면 보조 패스는 돌지 않는다", () => {
    // 이어 붙인 "샘플테스트브랜드" 에서는 더 긴 딜 이름 "플테스트브랜"(6자)이 셀러 별칭을
    // 잘라 내므로 보조 패스를 돌렸다면 실패했을 제목이다. 토큰 패스 결과가 그대로 나와야 한다.
    const d: InboundDictionary = {
      sellers: [{ id: "s1", names: ["샘플"] }],
      deals: [
        ...dict.deals,
        {
          id: "d3",
          brandNames: ["플테스트브랜"],
          dealName: "딜3",
          partnerName: null,
        },
      ],
    };
    const r = parseCalendarTitle("샘플 테스트브랜드 지급", d);
    expect(r.ok && r.intent.sellerId).toBe("s1");
    expect(r.ok && r.intent.dealIds).toEqual(["d1"]);
    expect(parseCalendarTitle("샘플테스트브랜드 지급", d).ok).toBe(false);
  });
});
