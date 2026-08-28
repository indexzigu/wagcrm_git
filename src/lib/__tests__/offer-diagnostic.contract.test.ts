import { describe, expect, it } from "vitest";
import {
  diagnoseOffer,
  MANUAL_ROW_IDS,
  type OfferInput,
  type OfferRowId,
  type OfferVerdict,
} from "@/lib/offer/offer-diagnostic";

/**
 * 공구 오퍼 진단(C2 M1)의 판정 계약.
 *
 * 이 진단은 "이 오퍼가 팔릴 구조인가"를 본다(C1 클레임 게이트의 "이 표현을
 * 써도 되는가"와 다른 축 — 통합 금지). 완화·축소는 오너 승인 사안이다.
 *
 * 특히 고정하는 것:
 * - **UNKNOWN ≠ FAIL** — 증거 없음을 실패로 뭉개면 데이터가 적은 딜이 나쁜
 *   딜로 둔갑하고, 그 판정이 다시 의사결정에 들어간다.
 * - **점수는 커버리지 100%일 때만 발행한다**(M3) — UNKNOWN 이 하나라도 있으면
 *   null. 모르는 것을 0점으로 치면 "나쁜 오퍼"와 "아직 안 본 오퍼"가 같은
 *   숫자가 되고, 그 숫자가 다시 판단에 쓰인다.
 * - 모든 미충족 행은 **구체 수정**을 동반한다.
 */

/** 모든 행이 PASS 가 되는 기준 입력 — 각 테스트는 필요한 것만 덮어쓴다. */
const HEALTHY: OfferInput = {
  listPrice: 20000,
  sellingPrice: 14000,
  priceVerdict: "OK",
  shippingFee: 0,
  freeShippingThreshold: null,
  optionCount: 3,
  supplementaryInfo: "2개 구매 시 파우치 증정",
  approvedClaimCount: 3,
  measuredClaimCount: 1,
  sellerFit: "GOOD",
  priorRunCount: 3,
  manualAnswers: {
    SCARCITY_TRUTH: { verdict: "PASS", note: "확보 200개 실물 확인" },
    TIME_DELAY: { verdict: "PASS", note: "오픈 후 3일 발송" },
    RISK_REVERSAL: { verdict: "PASS", note: "단순변심 7일 반품" },
  },
};

const verdictOf = (input: OfferInput, id: OfferRowId): OfferVerdict =>
  diagnoseOffer(input).rows.find((r) => r.id === id)!.verdict;

const rowOf = (input: OfferInput, id: OfferRowId) =>
  diagnoseOffer(input).rows.find((r) => r.id === id)!;

describe("diagnoseOffer — 전체 계약", () => {
  it("건강한 오퍼는 10행 전부 PASS", () => {
    const result = diagnoseOffer(HEALTHY);
    expect(result.rows).toHaveLength(10);
    expect(result.rows.every((r) => r.verdict === "PASS")).toBe(true);
  });

  it("10행 전부 PASS 면 10/10", () => {
    expect(diagnoseOffer(HEALTHY).score).toBe(10);
  });

  it("PASS 가 아닌 행은 반드시 구체 수정을 동반한다", () => {
    const bare: OfferInput = {
      ...HEALTHY,
      approvedClaimCount: 0,
      measuredClaimCount: 0,
      priceVerdict: "VIOLATED",
      optionCount: 0,
      supplementaryInfo: null,
      sellerFit: "WEAK",
      priorRunCount: 0,
    };
    for (const r of diagnoseOffer(bare).rows) {
      if (r.verdict === "PASS" || r.verdict === "NA") continue;
      expect(r.fix, `${r.id} 에 수정 안내가 없다`).toBeTruthy();
    }
  });

  it("커버리지는 NA 를 제외하고 UNKNOWN 을 미달로 센다", () => {
    // 셀러 미배정(NA 1행) + 소구점 0건(UNKNOWN 2행: 결과·근거)
    const r = diagnoseOffer({
      ...HEALTHY,
      sellerFit: null,
      approvedClaimCount: 0,
      measuredClaimCount: 0,
    });
    expect(r.coverage.applicable).toBe(9);
    expect(r.coverage.decided).toBe(7);
  });
});

describe("① 결과 명확성 — C1 승인 소구점 기준", () => {
  it("소구점이 없으면 UNKNOWN (실패가 아니다)", () => {
    expect(
      verdictOf(
        { ...HEALTHY, approvedClaimCount: 0, measuredClaimCount: 0 },
        "RESULT_CLARITY",
      ),
    ).toBe("UNKNOWN");
  });

  it("1건이면 PARTIAL — 셀러가 쓸 각도가 하나뿐이다", () => {
    expect(
      verdictOf(
        { ...HEALTHY, approvedClaimCount: 1, measuredClaimCount: 0 },
        "RESULT_CLARITY",
      ),
    ).toBe("PARTIAL");
  });

  it("2건 이상이면 PASS", () => {
    expect(
      verdictOf({ ...HEALTHY, approvedClaimCount: 2 }, "RESULT_CLARITY"),
    ).toBe("PASS");
  });
});

describe("② 근거 실증", () => {
  it("실측 근거가 0건이면 PARTIAL — 브랜드 주장만으로는 확신이 안 선다", () => {
    expect(verdictOf({ ...HEALTHY, measuredClaimCount: 0 }, "EVIDENCE")).toBe(
      "PARTIAL",
    );
  });

  it("판정할 소구점 자체가 없으면 UNKNOWN", () => {
    expect(
      verdictOf(
        { ...HEALTHY, approvedClaimCount: 0, measuredClaimCount: 0 },
        "EVIDENCE",
      ),
    ).toBe("UNKNOWN");
  });
});

describe("③ 가격 우위 — 최저가 스냅샷이 할인율보다 우선한다", () => {
  it("최저가 방어 실패는 FAIL", () => {
    expect(
      verdictOf({ ...HEALTHY, priceVerdict: "VIOLATED" }, "PRICE_ADVANTAGE"),
    ).toBe("FAIL");
  });

  it("동가(TIE)는 PARTIAL — '공구니까 싸다'가 성립하지 않는다", () => {
    expect(
      verdictOf({ ...HEALTHY, priceVerdict: "TIE" }, "PRICE_ADVANTAGE"),
    ).toBe("PARTIAL");
  });

  it("스냅샷이 없으면 할인율이 커도 PASS 를 주지 않는다 (타처 비교 미확인)", () => {
    const r = rowOf(
      { ...HEALTHY, priceVerdict: null, listPrice: 20000, sellingPrice: 10000 },
      "PRICE_ADVANTAGE",
    );
    expect(r.verdict).toBe("PARTIAL");
    expect(r.reason).toContain("50%");
  });

  it("스냅샷도 정가도 없으면 UNKNOWN", () => {
    expect(
      verdictOf(
        { ...HEALTHY, priceVerdict: null, listPrice: null },
        "PRICE_ADVANTAGE",
      ),
    ).toBe("UNKNOWN");
  });

  it("할인율이 10% 미만이면 FAIL — 공구가라 부르기 어렵다", () => {
    expect(
      verdictOf(
        {
          ...HEALTHY,
          priceVerdict: null,
          listPrice: 20000,
          sellingPrice: 19000,
        },
        "PRICE_ADVANTAGE",
      ),
    ).toBe("FAIL");
  });

  it("VIOLATED 는 정가 할인율이 커도 뒤집히지 않는다", () => {
    expect(
      verdictOf(
        {
          ...HEALTHY,
          priceVerdict: "VIOLATED",
          listPrice: 20000,
          sellingPrice: 8000,
        },
        "PRICE_ADVANTAGE",
      ),
    ).toBe("FAIL");
  });
});

describe("④ 구성 차별", () => {
  it("옵션도 구성 설명도 없으면 FAIL — 단품과 같은 오퍼다", () => {
    expect(
      verdictOf(
        { ...HEALTHY, optionCount: 0, supplementaryInfo: null },
        "BUNDLE_DIFF",
      ),
    ).toBe("FAIL");
  });

  it("한쪽만 있으면 PARTIAL", () => {
    expect(
      verdictOf(
        { ...HEALTHY, optionCount: 2, supplementaryInfo: null },
        "BUNDLE_DIFF",
      ),
    ).toBe("PARTIAL");
    expect(
      verdictOf(
        { ...HEALTHY, optionCount: 0, supplementaryInfo: "사은품 증정" },
        "BUNDLE_DIFF",
      ),
    ).toBe("PARTIAL");
  });

  it("공백뿐인 구성 설명은 없는 것으로 본다", () => {
    expect(
      verdictOf(
        { ...HEALTHY, optionCount: 0, supplementaryInfo: "   " },
        "BUNDLE_DIFF",
      ),
    ).toBe("FAIL");
  });
});

describe("⑤ 구매 마찰", () => {
  it("무료배송·적정 옵션이면 PASS", () => {
    expect(verdictOf(HEALTHY, "PURCHASE_FRICTION")).toBe("PASS");
  });

  it("무료 문턱이 판매가보다 높으면 사실상 항상 배송비다 → 지적", () => {
    const r = rowOf(
      {
        ...HEALTHY,
        shippingFee: 3000,
        freeShippingThreshold: 30000,
        sellingPrice: 14000,
      },
      "PURCHASE_FRICTION",
    );
    expect(r.verdict).toBe("PARTIAL");
    expect(r.reason).toContain("판매가보다 높음");
  });

  it("옵션 과다 + 배송비 문제가 겹치면 FAIL", () => {
    expect(
      verdictOf(
        {
          ...HEALTHY,
          optionCount: 12,
          shippingFee: 3000,
          freeShippingThreshold: 50000,
          sellingPrice: 14000,
        },
        "PURCHASE_FRICTION",
      ),
    ).toBe("FAIL");
  });

  it("배송비가 있어도 문턱이 판매가 이하면 통과시킨다", () => {
    expect(
      verdictOf(
        {
          ...HEALTHY,
          shippingFee: 3000,
          freeShippingThreshold: 10000,
          sellingPrice: 14000,
        },
        "PURCHASE_FRICTION",
      ),
    ).toBe("PASS");
  });
});

describe("⑥ 셀러 정합", () => {
  it("셀러 미배정·적합도 미산출이면 NA (실패가 아니다)", () => {
    expect(verdictOf({ ...HEALTHY, sellerFit: null }, "SELLER_FIT")).toBe("NA");
  });

  it("정합이 약하면 FAIL", () => {
    expect(verdictOf({ ...HEALTHY, sellerFit: "WEAK" }, "SELLER_FIT")).toBe(
      "FAIL",
    );
  });
});

describe("수동 4행 (M3)", () => {
  const NO_ANSWERS = { ...HEALTHY, manualAnswers: undefined };

  it("응답이 없으면 UNKNOWN 이고 무엇을 확인할지 알려준다", () => {
    const r = diagnoseOffer(NO_ANSWERS);
    for (const id of MANUAL_ROW_IDS) {
      const manual = r.rows.find((x) => x.id === id)!;
      expect(manual.verdict, id).toBe("UNKNOWN");
      // 자동 행과 달리 "확인 절차"를 안내해야 운영자가 답할 수 있다
      expect(manual.fix, id).toBeTruthy();
    }
  });

  it("응답이 없으면 점수를 내지 않는다", () => {
    expect(diagnoseOffer(NO_ANSWERS).score).toBeNull();
  });

  it("하나라도 모름이면 점수를 내지 않는다", () => {
    const r = diagnoseOffer({
      ...HEALTHY,
      manualAnswers: {
        ...HEALTHY.manualAnswers,
        RISK_REVERSAL: { verdict: "UNKNOWN", note: null },
      },
    });
    expect(r.score).toBeNull();
    expect(r.coverage.decided).toBe(r.coverage.applicable - 1);
  });

  it("운영자 미충족 판정은 FAIL 이고 왜 문제인지 설명한다", () => {
    const r = diagnoseOffer({
      ...HEALTHY,
      manualAnswers: {
        ...HEALTHY.manualAnswers,
        SCARCITY_TRUTH: { verdict: "FAIL", note: "수량 근거 없음" },
      },
    });
    const manual = r.rows.find((x) => x.id === "SCARCITY_TRUTH")!;
    expect(manual.verdict).toBe("FAIL");
    expect(manual.reason).toBe("수량 근거 없음");
    // 가짜 한정이 왜 위험한지가 안내에 있어야 한다 — 셀러 신뢰가 우리 자산이다
    expect(manual.fix).toContain("셀러");
    // FAIL 1건이면 9/10 (NA 없음, 10행 중 9 PASS)
    expect(r.score).toBe(9);
  });

  it("메모가 비어 있어도 판정은 선다", () => {
    const r = diagnoseOffer({
      ...HEALTHY,
      manualAnswers: {
        ...HEALTHY.manualAnswers,
        RISK_REVERSAL: { verdict: "PASS", note: "   " },
      },
    });
    expect(r.rows.find((x) => x.id === "RISK_REVERSAL")!.verdict).toBe("PASS");
    expect(r.score).toBe(10);
  });
});

describe("⑦ 앵콜·재진행 이력 (오너 결정 2026-08-01, 스펙 §9-Q1)", () => {
  it("2회 이상 실행이면 PASS — 재진행은 오퍼가 통한다는 사후 증거다", () => {
    expect(verdictOf({ ...HEALTHY, priorRunCount: 2 }, "ENCORE_HISTORY")).toBe(
      "PASS",
    );
  });

  it("1회 실행이면 PARTIAL — 실행됐지만 재진행은 아니다", () => {
    const r = rowOf({ ...HEALTHY, priorRunCount: 1 }, "ENCORE_HISTORY");
    expect(r.verdict).toBe("PARTIAL");
    expect(r.fix).toBeTruthy();
  });

  it("첫 공구(0회)는 UNKNOWN 이 아니라 PARTIAL — 신규 딜의 점수를 막지 않는다", () => {
    // UNKNOWN 을 주면 커버리지 100% 규칙 때문에 신규 딜은 영원히 점수가 null 이 된다.
    const r = diagnoseOffer({ ...HEALTHY, priorRunCount: 0 });
    expect(r.rows.find((x) => x.id === "ENCORE_HISTORY")!.verdict).toBe(
      "PARTIAL",
    );
    expect(r.score).toBe(9.5);
  });

  it("운영자에게 묻지 않는다 — 수동 행 목록에 없다", () => {
    // 이미 CRM 이 아는 사실을 매 딜마다 되물으면 체크되지 않는 체크리스트가 된다.
    expect(MANUAL_ROW_IDS as readonly string[]).not.toContain("ENCORE_HISTORY");
  });
});

describe("행 세트는 오너 결정 사안이다 (스펙 §9-Q1)", () => {
  it("수동 행은 3개다 — 명명은 2026-08-01 오너 결정으로 제거됐다", () => {
    expect(MANUAL_ROW_IDS).toHaveLength(3);
    expect(MANUAL_ROW_IDS as readonly string[]).not.toContain("NAMING");
  });

  it("루브릭에 없는 옛 응답은 판정을 흔들지 않는다", () => {
    const r = diagnoseOffer({
      ...HEALTHY,
      // 제거된 행의 응답이 DB 에 남아 있어도(문자열 rowId) 10행 그대로여야 한다.
      manualAnswers: {
        ...HEALTHY.manualAnswers,
        NAMING: { verdict: "FAIL", note: "옛 응답" },
      } as OfferInput["manualAnswers"],
    });
    expect(r.rows).toHaveLength(10);
    expect(r.score).toBe(10);
  });
});

describe("점수 환산", () => {
  it("PARTIAL 은 0.5점", () => {
    // 근거 실증만 PARTIAL(실측 0건) → 9.5/10
    const r = diagnoseOffer({ ...HEALTHY, measuredClaimCount: 0 });
    expect(r.rows.find((x) => x.id === "EVIDENCE")!.verdict).toBe("PARTIAL");
    expect(r.score).toBe(9.5);
  });

  it("NA 는 분모에서 빠진다 — 셀러 미배정이 점수를 깎지 않는다", () => {
    const r = diagnoseOffer({ ...HEALTHY, sellerFit: null });
    expect(r.coverage.applicable).toBe(9);
    expect(r.score).toBe(10);
  });
});
