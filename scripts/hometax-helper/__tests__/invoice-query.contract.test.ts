// 발급 목록조회(`query.ts`)의 계약 — **읽기 전용**과 **단정하지 않는 파싱**을 고정한다.
//
// 이 경로가 위험한 이유는 발급 화면 옆에서 클릭을 하기 때문이다. 목록조회 화면 주변에는
// 「수정발급」과 「재발송」이 실제로 있고, 메뉴 라벨 자체가 「발급 목록조회」다. 그래서
// ①금지선이 그대로 작동하는지 ②이 모듈이 정말 읽기만 하는지 ③표를 어떻게 읽는지를
// 전부 기계로 고정한다.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertClickAllowed, ForbiddenClickError } from "../guards";
import {
  parseQueryRow,
  parseQueryRows,
  filterByBusinessNumber,
  splitDateRange,
  maxWindowEnd,
  bisectRange,
  parseTotalCount,
  findDuplicateKeys,
} from "../query";

const QUERY_SRC = readFileSync(resolve(process.cwd(), "scripts/hometax-helper/query.ts"), "utf8");

describe("메뉴 라벨 함정 — 「발급 목록조회」를 그대로 쓰면 막힌다", () => {
  it("홈택스 실제 메뉴 텍스트는 가드에 걸린다", () => {
    // 이건 결함이 아니라 설계대로다. 이 테스트가 초록이어야 금지선이 살아 있는 것이다.
    expect(() => assertClickAllowed("발급 목록조회", ["발급 목록조회"])).toThrow(ForbiddenClickError);
  });

  it("에러가 처방을 알려준다 — 라벨을 바꾸라고", () => {
    // 처방을 모르면 다음 사람이 금지 목록을 건드린다. 그게 이 도구의 최악 시나리오다.
    try {
      assertClickAllowed("발급 목록조회", ["발급 목록조회"]);
      throw new Error("가드가 통과시켰다 — 금지선이 깨졌다");
    } catch (err) {
      expect((err as Error).message).toContain("라벨");
    }
  });

  it("개명한 라벨은 통과한다 — 셀렉터는 그대로 둔 채", () => {
    expect(() => assertClickAllowed("목록 화면", ["목록 화면"])).not.toThrow();
    expect(() => assertClickAllowed("조회 메뉴", ["조회 메뉴"])).not.toThrow();
  });
});

describe("읽기 전용 계약", () => {
  it("⛔ 입력은 기간 두 칸뿐이다", () => {
    // `.fill(` 이 늘었다면 이 모듈이 읽기 전용이기를 그만뒀다는 뜻이다. 목록조회
    // 화면에서 무언가를 더 입력하기 시작하면 그 옆의 발급 계열 동작과의 거리가
    // 줄어든다 — 늘려야 한다면 그건 리뷰받을 변경이지 조용히 지나갈 변경이 아니다.
    const fills = QUERY_SRC.match(/\.fill\s*\(/g) ?? [];
    expect(fills).toHaveLength(2); // 비우기 1 + 값 넣기 1 (기간 두 칸을 루프로 처리)
  });

  it("모든 클릭이 가드를 지난다", () => {
    expect(QUERY_SRC).toContain("assertClickAllowed");
    const clicks = (QUERY_SRC.match(/\.click\s*\(/g) ?? []).length;
    expect(clicks).toBeGreaterThan(0); // 양성 대조군 — 정규식이 실제로 잡는다
  });

  it("표는 텍스트만 읽는다 — 결과 행에서 클릭·입력을 하지 않는다", () => {
    // 행을 클릭하면 상세 화면으로 들어가고, 거기엔 수정발급이 있다.
    expect(QUERY_SRC).toContain("evaluateAll");
    expect(QUERY_SRC).not.toMatch(/resultRow[^\n]*\.click/);
  });
});

describe("parseQueryRow — 형태로 알아볼 수 있는 것만 뽑는다", () => {
  it("승인번호·작성일자·사업자번호·금액을 뽑는다", () => {
    const row = parseQueryRow([
      "20260806-41000000-00000001",
      "2026-07-10",
      "123-45-67890",
      "○○상사",
      "1,000,000",
      "100,000",
    ]);
    expect(row.approvalNumber).toBe("20260806-41000000-00000001");
    expect(row.issueDate).toBe("2026-07-10");
    expect(row.businessNumbers).toEqual(["1234567890"]);
    expect(row.amounts).toEqual([1_000_000, 100_000]);
  });

  it("점 구분 날짜도 읽는다", () => {
    expect(parseQueryRow(["2026.07.10"]).issueDate).toBe("2026-07-10");
  });

  it("⛔ 원문 셀을 그대로 보존한다 — 파싱이 틀려도 사람이 볼 수 있어야 한다", () => {
    const cells = ["알 수 없는 열", "?", ""];
    expect(parseQueryRow(cells).cells).toEqual(cells);
  });

  it("⛔ 승인번호의 숫자 덩어리를 금액으로 읽지 않는다", () => {
    // 경계가 없으면 "41000000" 같은 조각이 금액 후보로 섞인다.
    const row = parseQueryRow(["20260806-41000000-00000001"]);
    expect(row.amounts).toEqual([]);
  });

  it("⛔ 열 순서를 단정하지 않는다 — 「3번째 열이 공급가액」 같은 규칙이 없다", () => {
    // 순서를 바꿔도 같은 값이 나와야 한다. 순서 규칙을 넣으면 화면이 한 열만
    // 바뀌어도 조용히 틀린 금액을 낸다(이 도구에서 가장 비싼 실패).
    const a = parseQueryRow(["123-45-67890", "1,000,000", "2026-07-10"]);
    const b = parseQueryRow(["2026-07-10", "123-45-67890", "1,000,000"]);
    expect(a.businessNumbers).toEqual(b.businessNumbers);
    expect(a.amounts).toEqual(b.amounts);
    expect(a.issueDate).toBe(b.issueDate);
  });

  it("못 찾은 값은 null 이다 — 지어내지 않는다", () => {
    const row = parseQueryRow(["합계", "3건"]);
    expect(row.approvalNumber).toBeNull();
    expect(row.issueDate).toBeNull();
    expect(row.businessNumbers).toEqual([]);
  });

  it("여러 줄을 한 번에 파싱한다", () => {
    expect(parseQueryRows([["2026-07-10"], ["2026-07-11"]]).map((r) => r.issueDate)).toEqual([
      "2026-07-10",
      "2026-07-11",
    ]);
  });
});

describe("filterByBusinessNumber — 번호로만 고른다", () => {
  const rows = parseQueryRows([
    ["2026-07-10", "123-45-67890", "1,000,000"],
    ["2026-07-11", "999-88-77777", "2,000,000"],
  ]);

  it("표기가 달라도 같은 번호를 찾는다", () => {
    expect(filterByBusinessNumber(rows, "1234567890")).toHaveLength(1);
    expect(filterByBusinessNumber(rows, "123-45-67890")).toHaveLength(1);
  });

  it("없는 번호는 빈 배열", () => {
    expect(filterByBusinessNumber(rows, "1112223334")).toEqual([]);
  });

  it("⛔ 10자리가 아니면 아무것도 고르지 않는다 — 빈 값으로 전건이 걸리지 않게", () => {
    expect(filterByBusinessNumber(rows, "")).toEqual([]);
    expect(filterByBusinessNumber(rows, "12345")).toEqual([]);
  });
});

describe("요약 셀 중복 — 실화면에서 나온 형태", () => {
  // 🪤 홈택스 그리드의 각 행은 첫 칸에 행 전체를 이어 붙인 **요약 셀**을 갖는다
  // (2026-08-06 실측). 그대로 뽑으면 같은 번호가 2~3번씩 잡힌다.
  const row = () =>
    parseQueryRow([
      "",
      "123-45-67890 ○○상사 홍길동 5,000,000 4,545,455 454,545 20260101-10260101-11111111 일반 선택",
      "2026-07-31",
      "123-45-67890",
      "999-88-77777",
      "5,000,000",
      "4,545,455",
      "454,545",
      "20260101-10260101-11111111",
    ]);

  it("사업자번호는 중복을 지운다 — 집합 질문이다", () => {
    expect(row().businessNumbers).toEqual(["1234567890", "9998877777"]);
  });

  it("⛔ 금액은 중복을 지우지 않는다 — 같은 금액의 품목이 실제로 둘일 수 있다", () => {
    // 지우면 존재하던 값이 사라진다. 요약 셀 탓의 반복은 cells 원문으로 판단할 몫이다.
    expect(row().amounts.filter((a) => a === 5_000_000)).toHaveLength(2);
  });

  it("승인번호와 작성일자는 요약 셀에서도 같은 값을 낸다", () => {
    expect(row().approvalNumber).toBe("20260101-10260101-11111111");
    expect(row().issueDate).toBe("2026-07-31");
  });
});

// ── 조회 범위·절단 계약 (2026-08-07 실사고에서 나왔다) ─────────────────────────
//
// 두 가지가 **조용히** 틀렸다:
//   ① 2024-12~2026-08 한 방 조회가 에러 없이 **0건**을 냈다. 화면 안내는 「조회기간은
//      3개월 범위 내로 제한됩니다」인데, 넘겨도 배너 하나 안 뜨고 빈 표가 나온다.
//   ② 「총 11건」인 구간에서 10건만 읽고 끝났다(페이지 크기 10, 페이저 2페이지).
//      두 경우 모두 "발행 이력이 없다"로 오독되기 직전이었다 — 이 도메인에서 그 오독은
//      미발행을 발행으로, 발행을 미발행으로 뒤집는다.
//
// 그래서 여기서 고정하는 것은 **숫자가 아니라 정직성**이다: 못 본 구간은 못 봤다고 말한다.
describe("splitDateRange — 화면의 3개월 상한을 넘는 구간을 만들지 않는다", () => {
  it("긴 구간을 상한 이하로 자른다 — 판정은 일수가 아니라 달력이다", () => {
    const chunks = splitDateRange("2024-12-01", "2026-08-07");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // to <= from + 3개월 - 1일. 일수로 재면 2월을 걸칠 때 조용히 넘어간다.
      expect(Date.parse(`${c.to}T00:00:00Z`)).toBeLessThanOrEqual(
        Date.parse(`${maxWindowEnd(c.from)}T00:00:00Z`),
      );
    }
  });

  it("⛔ 2월을 걸치는 89일 구간을 만들지 않는다 — 실측에서 조용히 0건이었다", () => {
    // 2026-02-24~2026-05-24(89일) = 0건 / ~2026-05-23(88일) = 10건 (2026-08-07 실측).
    expect(maxWindowEnd("2026-02-24")).toBe("2026-05-23");
    for (const c of splitDateRange("2026-02-24", "2026-12-31")) {
      expect(c.to <= maxWindowEnd(c.from)).toBe(true);
    }
  });

  it("말일을 보정한다 — 1/31 + 3개월은 4/31 이 없다", () => {
    expect(maxWindowEnd("2026-01-31")).toBe("2026-04-29");
  });

  it("구간이 겹치지 않고 이어진다 — 겹치면 같은 계산서를 두 번 센다", () => {
    const chunks = splitDateRange("2025-01-01", "2025-12-31");
    for (let i = 1; i < chunks.length; i += 1) {
      const prevEnd = Date.parse(`${chunks[i - 1].to}T00:00:00Z`);
      const curStart = Date.parse(`${chunks[i].from}T00:00:00Z`);
      expect(curStart - prevEnd).toBe(86_400_000); // 정확히 하루 뒤
    }
  });

  it("전 구간을 빠짐없이 덮는다", () => {
    const chunks = splitDateRange("2025-01-01", "2025-12-31");
    expect(chunks[0].from).toBe("2025-01-01");
    expect(chunks[chunks.length - 1].to).toBe("2025-12-31");
  });

  it("상한 이하면 그대로 한 구간", () => {
    expect(splitDateRange("2026-01-01", "2026-02-01")).toEqual([{ from: "2026-01-01", to: "2026-02-01" }]);
  });

  it("경계값 — 정확히 상한이면 쪼개지 않는다", () => {
    expect(splitDateRange("2026-02-24", "2026-05-23")).toEqual([{ from: "2026-02-24", to: "2026-05-23" }]);
  });

  it("역전된 구간은 조용히 뒤집지 않고 빈 배열", () => {
    expect(splitDateRange("2026-08-01", "2026-01-01")).toEqual([]);
  });
});

describe("parseTotalCount — 「총 N건」을 읽는다(절단 판정의 유일한 축)", () => {
  it("콤마가 있어도 읽는다", () => {
    expect(parseTotalCount("이전 1 2 다음 총 1,234건")).toBe(1234);
  });

  it("실측 문자열(총 11건)을 읽는다", () => {
    expect(parseTotalCount("‹ 이전 1 2 다음 › 총 11건")).toBe(11);
  });

  it("0건도 0으로 읽는다 — null 과 구분되어야 한다", () => {
    expect(parseTotalCount("총 0건")).toBe(0);
  });

  it("⛔ 못 찾으면 null 이다 — 0으로 단정하지 않는다", () => {
    // 여기서 0을 반환하면 「화면을 못 읽었다」가 「발행이 없다」로 둔갑한다.
    expect(parseTotalCount("아무 관계 없는 텍스트")).toBeNull();
  });
});

describe("findDuplicateKeys — 중복을 지우지 않고 신호로 올린다", () => {
  it("같은 승인번호가 두 번 나오면 키를 돌려준다", () => {
    const rows = parseQueryRows([
      ["2026-07-31", "20260101-10260101-11111111", "5,000,000"],
      ["2026-07-31", "20260101-10260101-11111111", "5,000,000"],
    ]);
    expect(findDuplicateKeys(rows)).toEqual(["20260101-10260101-11111111"]);
  });

  it("중복이 없으면 빈 배열", () => {
    const rows = parseQueryRows([
      ["2026-07-31", "20260101-10260101-11111111", "5,000,000"],
      ["2026-07-31", "20260101-10260101-22222222", "5,000,000"],
    ]);
    expect(findDuplicateKeys(rows)).toEqual([]);
  });
});

describe("음수 금액 — 수정세금계산서(취소)를 부호째 읽는다", () => {
  it("⛔ -1,234,567 이 234,567 로 둔갑하지 않는다", () => {
    // 2026-08-07 실사고. 부호가 빠지는 정도가 아니라 자릿수가 잘린 다른 숫자가 나왔다.
    const row = parseQueryRow(["2025-09-19", "-1,234,567", "-1,122,334", "-112,233"]);
    expect(row.amounts).toEqual([-1234567, -1122334, -112233]);
    expect(row.amounts).not.toContain(234567);
  });

  it("양수는 그대로", () => {
    expect(parseQueryRow(["3,000,000", "2,700,000"]).amounts).toEqual([3000000, 2700000]);
  });

  it("승인번호·사업자번호를 금액으로 읽지 않는다", () => {
    const row = parseQueryRow(["20250101-10250101-33333333", "220-88-43130", "1,000,000"]);
    expect(row.amounts).toEqual([1000000]);
  });
});

describe("구분(매출/매입) — 방향이 뒤집힌 답을 내지 않는다", () => {
  it("PURCHASE 를 요청했는데 kind 셀렉터가 없으면 NOT_CONFIGURED 다", () => {
    // ⛔ 조용히 매출을 돌려주면 「수취했는가」를 묻고 「발행했는가」의 답을 받는다.
    //    화면도 결과도 그럴듯해서 사람 눈으로는 안 걸린다.
    expect(QUERY_SRC).toContain('return { status: "NOT_CONFIGURED", missing: ["invoiceQuery.kind"] }');
  });

  it("결과에 kind 를 되실어 방향을 확인할 수 있게 한다", () => {
    expect(QUERY_SRC).toContain("kind: InvoiceQueryKind;");
  });

  it("구분 선택도 클릭 가드를 지난다", () => {
    expect(QUERY_SRC).toMatch(/assertClickAllowed\(label, \[label\]\)/);
  });

  it("「매출 구분」·「매입 구분」 라벨은 금지어가 아니다", () => {
    expect(() => assertClickAllowed("매출 구분", ["매출 구분"])).not.toThrow();
    expect(() => assertClickAllowed("매입 구분", ["매입 구분"])).not.toThrow();
  });
});

describe("그리드 갱신 판정 — 두 실패 모드를 모두 막는다(소스 계약)", () => {
  it("표 변화와 총건수 일치를 **함께** 요구한다", () => {
    // 지문 변화만 보면 `총3 수집10`(수집 > 총건수) 중간 상태를 통과시키고,
    // 총건수 일치만 보면 `총5 수집5` 완전 정지 상태를 통과시킨다. 둘 다 실측 사고다.
    expect(QUERY_SRC).toMatch(/\(changed\(grid\) \|\| settledEmpty\(grid\)\) && agrees\(grid\)/);
  });

  it("일치 조건은 min(총건수, 페이지크기) 다", () => {
    expect(QUERY_SRC).toMatch(/g\.rows\.length === Math\.min\(g\.totalCount, PAGE_SIZE\)/);
  });

  it("고정 대기(waitForTimeout)만으로 조회 완료를 판정하지 않는다", () => {
    // 고정 대기는 "보통 충분한 시간"이지 "끝났다는 증거"가 아니다.
    const afterSearch = QUERY_SRC.slice(QUERY_SRC.indexOf("assertClickAllowed(q.search.label"));
    expect(afterSearch).toContain("deadline");
  });
});

describe("bisectRange — 절단된 구간을 하루 단위까지 실제로 쪼갠다", () => {
  it("⛔ 이틀짜리 구간을 하루짜리 둘로 쪼갠다 (한 단계 일찍 멈추지 않는다)", () => {
    // 2026-08-07 교차 검증 지적. `span <= 1` 로 멈추면 각 날짜가 페이지 크기 이내라
    // 무손실 수집이 가능한데도 포기하고, "하루까지 쪼갰다"는 거짓 사유를 남긴다.
    expect(bisectRange("2026-08-01", "2026-08-02")).toEqual({
      left: { from: "2026-08-01", to: "2026-08-01" },
      right: { from: "2026-08-02", to: "2026-08-02" },
    });
  });

  it("하루짜리는 더 못 쪼갠다 — null (무한 재귀 방지선)", () => {
    expect(bisectRange("2026-08-01", "2026-08-01")).toBeNull();
  });

  it("역전 구간도 null", () => {
    expect(bisectRange("2026-08-02", "2026-08-01")).toBeNull();
  });

  it("좌우가 겹치지 않고 원 구간을 빠짐없이 덮는다", () => {
    const s = bisectRange("2026-01-01", "2026-03-31")!;
    expect(s.left.from).toBe("2026-01-01");
    expect(s.right.to).toBe("2026-03-31");
    const gap =
      (Date.parse(`${s.right.from}T00:00:00Z`) - Date.parse(`${s.left.to}T00:00:00Z`)) / 86_400_000;
    expect(gap).toBe(1);
  });

  it("반복 적용하면 반드시 하루짜리로 수렴한다 — 어떤 구간에서도 멈춘다", () => {
    // 재귀가 끝난다는 것 자체를 고정한다(무한 루프는 브라우저를 붙잡아 둔다).
    let queue = [{ from: "2026-01-01", to: "2026-03-31" }];
    let guard = 0;
    const leaves: Array<{ from: string; to: string }> = [];
    while (queue.length > 0 && guard++ < 5_000) {
      const next: typeof queue = [];
      for (const r of queue) {
        const s = bisectRange(r.from, r.to);
        if (s) next.push(s.left, s.right);
        else leaves.push(r);
      }
      queue = next;
    }
    expect(guard).toBeLessThan(5_000);
    expect(leaves.every((l) => l.from === l.to)).toBe(true);
    expect(leaves).toHaveLength(90); // 1/1~3/31 = 90일
  });
});

describe("⛔ 조용한 절단을 만들지 않는다(소스 계약)", () => {
  it("결과 타입이 complete·incompleteReasons 를 갖는다", () => {
    // 이 두 필드가 없으면 호출부가 "다 봤다"와 "일부만 봤다"를 구분할 수 없다.
    expect(QUERY_SRC).toContain("complete: boolean");
    expect(QUERY_SRC).toContain("incompleteReasons");
  });

  it("페이저를 클릭하지 않는다 — 기간 분할로 해결한다", () => {
    // 없는 셀렉터를 추측해 누르는 것이 이 도구의 최악 시나리오다.
    expect(QUERY_SRC).not.toMatch(/["'](다음|next|nextPage)["']\s*\]/i);
  });
});
