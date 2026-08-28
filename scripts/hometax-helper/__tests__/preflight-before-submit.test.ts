// 발행 전 자체 검토(`preflightBeforeSubmit`)의 계약 — 헬퍼가 「발급하기」까지 누르게
// 되면서(2026-08-08 개정) 오너가 폼을 눈으로 보는 단계가 사라졌다. 이 함수가 그 자리를
// 대신하는 **유일한 자동 방어선**이므로, "읽기 실패를 통과로 착각"하는 일이 없어야 한다.
import { describe, it, expect, vi } from "vitest";
import { preflightBeforeSubmit } from "../fill";
import type { SelectorMap } from "../selectors";
import type { InvoicePayload } from "../fill";

const BASE_MAP: SelectorMap = {
  fields: {
    remark: "#remark",
    itemName: "#itemName",
    buyerBusinessNumber: "#buyerBiz",
    itemSupplyAmount: "#supplyAmount",
  },
};

const BASE_PAYLOAD: InvoicePayload = {
  buyerBusinessNumber: "1234567890",
  buyerName: "",
  buyerCeo: "",
  buyerAddress: "",
  buyerBusinessType: "",
  buyerBusinessItem: "",
  buyerEmail1: "",
  totalSupplyAmount: 100_000,
  totalTaxAmount: 10_000,
  lineItems: [{ name: "테스트 품목", supplyAmount: 100_000, taxAmount: 10_000, remark: "짧은 비고" }],
};

/** `page.locator(selector).inputValue()` 만 흉내 낸 가짜 Page — 이 함수가 쓰는 표면이 그것뿐이다. */
function fakePage(values: Record<string, string | (() => Promise<string>)>): any {
  return {
    locator: (selector: string) => ({
      inputValue: async () => {
        const v = values[selector];
        if (v === undefined) throw new Error(`no fixture for ${selector}`);
        return typeof v === "function" ? await v() : v;
      },
    }),
  };
}

describe("preflightBeforeSubmit — 정상 경로", () => {
  it("모든 값이 상한 안이고 CRM 값과 같으면 문제가 없다", async () => {
    const page = fakePage({
      "#remark": "짧은 비고",
      "#itemName": "테스트 품목",
      "#buyerBiz": "1234567890",
      "#supplyAmount": "100000",
    });
    const problems = await preflightBeforeSubmit(page, BASE_MAP, BASE_PAYLOAD);
    expect(problems).toEqual([]);
  });
});

describe("preflightBeforeSubmit — 바이트 상한", () => {
  it("한글 비고가 바이트 상한을 넘으면 잡는다", async () => {
    const page = fakePage({
      "#remark": "가".repeat(40), // 40 * 3바이트 = 120 > 100
      "#itemName": "테스트 품목",
      "#buyerBiz": "1234567890",
      "#supplyAmount": "100000",
    });
    const problems = await preflightBeforeSubmit(page, BASE_MAP, BASE_PAYLOAD);
    expect(problems).toEqual([expect.objectContaining({ field: "품목비고" })]);
  });
});

describe("preflightBeforeSubmit — 값 대조", () => {
  it("화면 값이 CRM 값과 다르면 잡는다", async () => {
    const page = fakePage({
      "#remark": "짧은 비고",
      "#itemName": "테스트 품목",
      "#buyerBiz": "9999999999", // CRM 은 1234567890
      "#supplyAmount": "100000",
    });
    const problems = await preflightBeforeSubmit(page, BASE_MAP, BASE_PAYLOAD);
    expect(problems).toEqual([expect.objectContaining({ field: "공급받는자 등록번호" })]);
  });
});

describe("preflightBeforeSubmit — 읽기 실패는 fail-closed 다 (2026-08-08 리뷰 반영)", () => {
  // 🪤 이 describe 가 지키는 것: "맵에 셀렉터가 없음"(검사 대상 아님)과 "셀렉터는
  // 있는데 읽기가 실패함"(DOM 일시 재렌더 등 실제 이상)을 같은 값으로 합치면, 유일한
  // 자동 방어선이 원인 모를 실패에서 조용히 통과가 된다. 종전 구현은 둘 다 `null` 로
  // 합쳐 이 조건을 놓쳤다.
  it("바이트 상한 검사 중 읽기가 예외를 던지면 통과시키지 않고 문제로 잡는다", async () => {
    const page = fakePage({
      "#remark": () => Promise.reject(new Error("element detached")),
      "#itemName": "테스트 품목",
      "#buyerBiz": "1234567890",
      "#supplyAmount": "100000",
    });
    const problems = await preflightBeforeSubmit(page, BASE_MAP, BASE_PAYLOAD);
    expect(problems.some((p) => p.field === "품목비고")).toBe(true);
  });

  it("값 대조 중 읽기가 예외를 던지면 통과시키지 않고 문제로 잡는다", async () => {
    const page = fakePage({
      "#remark": "짧은 비고",
      "#itemName": "테스트 품목",
      "#buyerBiz": () => Promise.reject(new Error("element detached")),
      "#supplyAmount": "100000",
    });
    const problems = await preflightBeforeSubmit(page, BASE_MAP, BASE_PAYLOAD);
    expect(problems.some((p) => p.field === "공급받는자 등록번호")).toBe(true);
  });

  it("셀렉터가 애초에 맵에 없으면 판단 보류다 — 읽기 실패와는 다른 사실이다", async () => {
    const map: SelectorMap = { fields: { remark: "#remark", itemName: "#itemName" } }; // 대조 필드 없음
    const page = fakePage({ "#remark": "짧은 비고", "#itemName": "테스트 품목" });
    const problems = await preflightBeforeSubmit(page, map, BASE_PAYLOAD);
    expect(problems).toEqual([]); // 검사 대상으로 선언된 적 없는 필드는 막지 않는다
  });
});

describe("자동계산 팝업 경로 — 공급가액은 우리가 대조하지 않는다 (2026-08-09)", () => {
  // 🪤 이 경로에서 공급가액은 **홈택스가 계산한 값**이라 우리 페이로드와 1원 단위로
  // 다를 수 있다(그게 이 경로를 택한 이유다 — 우리는 반올림, 홈택스는 절사). 그런데도
  // 우리 값과 대조하면 정상 상태가 매번 「금액 불일치」로 보고돼 발급이 막힌다.
  // 금액 검증은 fillAmountViaCalcPopup 의 「공급가액 + 세액 == 합계」가 담당한다.
  const MAP_WITH_POPUP: SelectorMap = {
    ...BASE_MAP,
    calcPopup: {
      openLabel: "금액 계산",
      open: "#open",
      totalInput: "#total",
      calcButton: { label: "합계 계산", selector: "#calc" },
      supplyResult: "#supply",
      taxResult: "#tax",
      confirm: { label: "계산 확인", selector: "#confirm" },
    },
  };

  it("팝업 경로에서는 공급가액이 우리 값과 달라도 문제로 잡지 않는다", async () => {
    const page = fakePage({
      "#remark": "",
      "#itemName": "테스트 품목",
      "#buyerBiz": "1234567890",
      "#supplyAmount": "99999", // CRM 값(100000)과 다르지만 홈택스가 계산한 값이다
    });
    const problems = await preflightBeforeSubmit(page, MAP_WITH_POPUP, BASE_PAYLOAD);
    expect(problems).toEqual([]);
  });

  it("팝업이 없는 종전 경로에서는 공급가액 불일치를 그대로 잡는다", async () => {
    const page = fakePage({
      "#remark": "",
      "#itemName": "테스트 품목",
      "#buyerBiz": "1234567890",
      "#supplyAmount": "99999",
    });
    const problems = await preflightBeforeSubmit(page, BASE_MAP, BASE_PAYLOAD);
    expect(problems.some((p) => p.field === "품목 공급가액")).toBe(true);
  });
});
