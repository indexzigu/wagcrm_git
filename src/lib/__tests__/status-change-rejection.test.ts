import { describe, expect, it } from "vitest";
import {
  dealSaveFailure,
  outreachStatusChangeFailure,
  STATUS_REJECTION_FALLBACK,
} from "../status-change-rejection";
import { DEFAULT_MUTATION_ERROR } from "../use-mutation-feedback";

// 서버가 상태 변경을 거절하면 「지금 무슨 상태라서 어디로 못 가는지」를 화면 낱말로 말해야 한다.
// 종전에는 딜 패널이 영문 "Save failed" 를, 영업 화면이 「상태 변경에 실패했습니다.」만 띄워
// 사유가 버려졌다. 영문 코드(DROPPED 등)는 화면에 나가면 안 된다(product-ux UI Copy ③).
const RAW_CODE = /[A-Z]{2,}_?[A-Z]*/;

describe("dealSaveFailure", () => {
  it("상태 거절이면 서버가 읽은 현재 상태와 요청 상태를 화면 낱말로 말한다", () => {
    const result = dealSaveFailure({
      error: "허용되지 않는 상태 변경입니다",
      currentStatus: "DROPPED",
      requestedStatus: "NEGOTIATING",
    });
    expect(result.title).toBe("지금 “드랍” 상태라 “협의”(으)로 바꿀 수 없습니다.");
    expect(result.title).not.toMatch(RAW_CODE);
    expect(result.hint).toBeTruthy();
  });

  it("표에 없는 코드가 오면 코드를 내지 않고 일반 거절 문장을 쓴다", () => {
    const result = dealSaveFailure({
      error: "허용되지 않는 상태 변경입니다",
      currentStatus: "LEGACY_STATE",
      requestedStatus: "NEGOTIATING",
    });
    expect(result.title).toBe(STATUS_REJECTION_FALLBACK);
  });

  it("다른 실패의 문자열 오류는 그대로, 객체 오류는 일반 문장으로 바꾼다", () => {
    expect(dealSaveFailure({ error: "해당 판매 조건을 찾을 수 없습니다" }).title).toBe(
      "해당 판매 조건을 찾을 수 없습니다",
    );
    const fromObject = dealSaveFailure({ error: { fieldErrors: { status: ["Invalid"] } } });
    expect(typeof fromObject.title).toBe("string");
    expect(fromObject.title).toBe(DEFAULT_MUTATION_ERROR);
    expect(dealSaveFailure(null).title).toBe(DEFAULT_MUTATION_ERROR);
    expect(dealSaveFailure({ error: "x" }).hint).toBeUndefined();
  });
});

describe("outreachStatusChangeFailure", () => {
  it("상태 거절이면 영업 단계 낱말로 말하고 영문 코드를 내지 않는다", () => {
    const result = outreachStatusChangeFailure({
      error: "허용되지 않는 상태 변경입니다: CONVERTED → TESTING",
      currentStatus: "CONVERTED",
      requestedStatus: "TESTING",
    });
    expect(result.title).toBe("지금 “전환완료” 상태라 “테스트중”(으)로 바꿀 수 없습니다.");
    expect(result.title).not.toMatch(RAW_CODE);
  });

  it("옛 저장값(CONFIRMED)처럼 표에 없는 현재 상태면 일반 거절 문장을 쓴다", () => {
    const result = outreachStatusChangeFailure({
      error: "허용되지 않는 상태 변경입니다: CONFIRMED → TESTING",
      currentStatus: "CONFIRMED",
      requestedStatus: "TESTING",
    });
    expect(result.title).toBe(STATUS_REJECTION_FALLBACK);
  });

  it("두 코드가 실리지 않은 거절 문장이 와도 영문 코드를 내지 않는다", () => {
    const result = outreachStatusChangeFailure({
      error: "허용되지 않는 상태 변경입니다: CONVERTED → TESTING",
    });
    expect(result.title).toBe("상태 변경에 실패했습니다.");
  });

  it("검증 실패(객체 오류)는 토스트에 객체를 넘기지 않는다", () => {
    const result = outreachStatusChangeFailure({ error: { formErrors: [], fieldErrors: {} } });
    expect(typeof result.title).toBe("string");
    expect(result.title).toBe("상태 변경에 실패했습니다.");
    expect(outreachStatusChangeFailure({ error: "해당 영업 테스크를 찾을 수 없습니다" }).title).toBe(
      "해당 영업 테스크를 찾을 수 없습니다",
    );
  });
});
