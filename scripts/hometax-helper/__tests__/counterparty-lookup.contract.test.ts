// 「거래처 조회」 경로의 **선택 판정** 계약.
//
// 이 경로에서 가장 비싼 실수는 폼을 못 채우는 것이 아니라 **엉뚱한 거래처를 고르는
// 것**이다. 못 채우면 오너가 손으로 채우면 되지만, 잘못 고르면 다른 회사 앞으로
// 계산서가 나가고 그건 발급하고 나서야 드러난다(수정세금계산서 절차).
//
// 그래서 판정 로직을 브라우저에서 떼어내 순수 함수로 두고 여기서 고정한다 — 실화면
// 없이도 "고르지 않아야 할 때 고르지 않는가"를 매번 검증할 수 있어야 한다.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  chooseCounterpartyRow,
  extractBusinessNumbers,
  sameBusinessNumber,
  type CounterpartyRow,
} from "../fill";

const row = (index: number, ...numbers: string[]): CounterpartyRow => ({ index, numbers });

describe("사업자등록번호 추출", () => {
  it("하이픈이 있든 없든 10자리 숫자로 뽑는다", () => {
    expect(extractBusinessNumbers("123-45-67890")).toEqual(["1234567890"]);
    expect(extractBusinessNumbers("1234567890")).toEqual(["1234567890"]);
  });

  it("한 행에 여러 번호가 있으면 전부 뽑는다", () => {
    // 행에 사업자번호와 종사업장 번호가 함께 들어 있는 화면이 있을 수 있다.
    expect(extractBusinessNumbers("123-45-67890 / 111-22-33333")).toEqual([
      "1234567890",
      "1112233333",
    ]);
  });

  it("⛔ 더 긴 숫자 덩어리에서 10자리를 잘라내지 않는다", () => {
    // 경계 검사가 없으면 12자리에서 10자리를 오려내 **없는 번호를 만들어낸다.**
    // 그 번호가 우연히 우리가 찾는 값과 같으면 엉뚱한 행을 고른다.
    expect(extractBusinessNumbers("123456789012")).toEqual([]);
    expect(extractBusinessNumbers("전화 0212345678901")).toEqual([]);
  });

  it("번호가 없는 행은 빈 배열", () => {
    expect(extractBusinessNumbers("합계 3건")).toEqual([]);
  });
});

describe("사업자등록번호 동일성", () => {
  it("표기 차이를 흡수한다", () => {
    expect(sameBusinessNumber("123-45-67890", "1234567890")).toBe(true);
    expect(sameBusinessNumber(" 123 45 67890 ", "123-45-67890")).toBe(true);
  });

  it("다른 번호는 다르다", () => {
    expect(sameBusinessNumber("1234567890", "1234567891")).toBe(false);
  });

  it("10자리가 아니면 같다고 하지 않는다 — 빈 값끼리도 마찬가지", () => {
    // 화면에서 값을 못 읽어 빈 문자열이 왔을 때 "같다"가 되면 대조가 무력화된다.
    expect(sameBusinessNumber("", "")).toBe(false);
    expect(sameBusinessNumber("12345", "12345")).toBe(false);
  });
});

describe("거래처 행 선택 — 정확히 한 건일 때만 고른다", () => {
  it("정확히 일치하는 행이 하나면 고른다", () => {
    const rows = [row(0, "1112233333"), row(1, "1234567890"), row(2, "9998877777")];
    expect(chooseCounterpartyRow(rows, "123-45-67890")).toEqual({ ok: true, index: 1 });
  });

  it("일치가 없으면 고르지 않는다(미등록)", () => {
    const rows = [row(0, "1112233333")];
    expect(chooseCounterpartyRow(rows, "1234567890")).toEqual({ ok: false, reason: "none" });
  });

  it("결과가 비어 있어도 고르지 않는다", () => {
    expect(chooseCounterpartyRow([], "1234567890")).toEqual({ ok: false, reason: "none" });
  });

  it("⛔ 일치가 둘 이상이면 고르지 않는다 — 첫 행 우선 같은 규칙을 두지 않는다", () => {
    // 같은 사업자번호로 거래처가 중복 등록된 상태. 어느 쪽이 맞는지는 오너만 안다.
    const rows = [row(0, "1234567890"), row(1, "1234567890")];
    expect(chooseCounterpartyRow(rows, "1234567890")).toEqual({ ok: false, reason: "ambiguous" });
  });

  it("⛔ 결과가 하나뿐이어도 번호가 다르면 고르지 않는다", () => {
    // 검색이 부분일치로 동작해 엉뚱한 한 건만 돌려주는 경우가 가장 위험하다 —
    // "결과가 하나니까 이것" 규칙이었다면 여기서 오발행이 난다.
    const rows = [row(0, "9998877777")];
    expect(chooseCounterpartyRow(rows, "1234567890")).toEqual({ ok: false, reason: "none" });
  });

  it("번호를 못 읽은 행은 후보가 되지 못한다", () => {
    const rows = [row(0), row(1, "1234567890")];
    expect(chooseCounterpartyRow(rows, "1234567890")).toEqual({ ok: true, index: 1 });
  });
});

describe("소스 계약 — 경로가 안전 순서를 지킨다", () => {
  const source = readFileSync(resolve(process.cwd(), "scripts/hometax-helper/fill.ts"), "utf8");

  it("거래처 조회가 성공하면 사업자번호 「확인」을 누르지 않는다", () => {
    // 둘 다 타면 이미 들어온 조회 결과를 국세청 재조회가 흔들고, 종사업장 선택 창이
    // 다시 뜬다. 폴백은 **배타적**이어야 한다.
    expect(source).toContain('if (counterparty.method !== "lookup")');
  });

  it("거래처를 고른 뒤 폼의 사업자번호를 되읽어 대조한다", () => {
    // 팝업이 닫혔다는 사실만으로 성공이라 말하지 않는다 — 이 대조가 최종 방어선이다.
    expect(source).toContain("sameBusinessNumber(applied, digits)");
  });

  it("팝업 조작 클릭도 가드를 통과한다", () => {
    // 새 클릭 경로가 생길 때마다 금지선을 다시 통과시켜야 한다.
    const lookupFn = source.slice(
      source.indexOf("async function tryCounterpartyLookup"),
      source.indexOf("export async function fillInvoiceForm"),
    );
    expect(lookupFn).not.toBe("");
    const clicks = (lookupFn.match(/\.click\s*\(/g) ?? []).length;
    const guards = (lookupFn.match(/assertClickAllowed/g) ?? []).length;
    expect(clicks).toBeGreaterThan(0);
    // 행 클릭은 라벨이 없는 검색 결과라 가드 대상이 아니지만(우리가 만든 이름이 없다),
    // **맵에서 온 버튼 클릭은 전부** 가드를 지난다: 열기·검색·선택 3종.
    expect(guards).toBeGreaterThanOrEqual(3);
  });
});
