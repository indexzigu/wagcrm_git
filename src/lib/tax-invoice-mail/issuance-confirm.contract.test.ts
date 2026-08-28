import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExpectedIssuance } from "./expected-issuances";
import type { IssuanceVerdict } from "./issuance-match";
import { buildIssuanceWritePlan } from "./issuance-confirm";

/**
 * 쓰기 계획의 계약 — **프로덕션 정산 필드를 바꾸는 유일한 경로**라 여기가 마지막 방벽이다.
 *
 * 소스 스캔이 함께 있는 이유: 단위 테스트는 "지금 코드가 지우지 않는다"만 보여 주고
 * **미래에 추가되는 되돌리기 경로**를 막지 못한다. 이 트랙의 계약 테스트 관행
 * (`mail-scan.contract.test.ts` 의 무흔적 스캔, `live-window-floor.contract.test.ts` 의
 * 읽기 창)과 같은 형태다 — 정규식이 깨져도 초록이 되지 않도록 **양성 대조군**을 둔다.
 */

const HERE = __dirname;
const CRON_ROUTE = join(
  HERE,
  "../../app/api/cron/tax-invoice-issue-confirm/route.ts",
);

function expectation(over: Partial<ExpectedIssuance> = {}): ExpectedIssuance {
  return {
    key: "c1:ISSUE:supplierInvoiceIssuedAt",
    campaignIds: ["c1"],
    campaignId: "c1",
    campaignLabel: "라벨",
    channel: "BRAND_MALL",
    counterpartBusinessNumber: "2223344444",
    counterpartLabel: "거래처",
    counterpart: "SUPPLIER",
    expectedTotalAmount: 330_000,
    amountBasis: "SETTLEMENT_SALES",
    amountBlockingReasons: [],
    trackingField: "supplierInvoiceIssuedAt",
    alreadyMarkedAt: null,
    writeTarget: { kind: "campaign", campaignId: "c1" },
    validWrittenDateFrom: null,
    validWrittenDateTo: null,
    ...over,
  };
}

function verdict(over: Partial<IssuanceVerdict> = {}): IssuanceVerdict {
  return {
    key: "c1:ISSUE:supplierInvoiceIssuedAt",
    status: "CONFIRMED",
    assigned: [
      { mailUid: 1, issueId: "A", writtenDate: "2026-08-01", totalAmount: 330_000, basis: "LINE_ITEM" },
    ],
    reasons: [],
    observed: {
      totalAmount: 330_000,
      expectedTotalAmount: 330_000,
      amountDelta: 0,
      writtenDate: "2026-08-01",
    },
    ...over,
  };
}

describe("buildIssuanceWritePlan", () => {
  it("CONFIRMED 는 작성일자를 찍는 op 를 만든다", () => {
    const { ops } = buildIssuanceWritePlan([verdict()], [expectation()]);
    expect(ops).toHaveLength(1);
    expect(ops[0].writtenDate).toBe("2026-08-01");
    expect(ops[0].target).toEqual({ kind: "campaign", campaignId: "c1" });
    expect(ops[0].evidence.issueIds).toEqual(["A"]);
  });

  it("그룹 확정은 멤버 전원을 감사 로그 대상으로 싣는다", () => {
    const { ops } = buildIssuanceWritePlan(
      [verdict()],
      [expectation({ campaignIds: ["c1", "c2"], writeTarget: { kind: "group", groupId: "g1" } })],
    );
    expect(ops[0].target).toEqual({ kind: "group", groupId: "g1" });
    expect(ops[0].campaignIds).toEqual(["c1", "c2"]);
  });

  // ── 음성 대조군
  it("CONFIRMED 가 아니면 op 를 만들지 않는다", () => {
    for (const status of ["NEEDS_REVIEW", "UNSEEN", "UNMATCHABLE"] as const) {
      const { ops } = buildIssuanceWritePlan([verdict({ status })], [expectation()]);
      expect(ops).toHaveLength(0);
    }
  });

  it("writeTarget 이 null 이면 CONFIRMED 여도 op 를 만들지 않는다(판정 가드가 뚫려도 막는다)", () => {
    const { ops, skipped } = buildIssuanceWritePlan([verdict()], [expectation({ writeTarget: null })]);
    expect(ops).toHaveLength(0);
    expect(skipped[0].code).toBe("NO_WRITE_TARGET");
  });

  it("작성일자가 없으면 op 를 만들지 않는다", () => {
    const { ops, skipped } = buildIssuanceWritePlan(
      [verdict({ observed: { ...verdict().observed, writtenDate: null } })],
      [expectation()],
    );
    expect(ops).toHaveLength(0);
    expect(skipped[0].code).toBe("NO_WRITTEN_DATE");
  });

  it("같은 대상·같은 필드에 서로 다른 날짜를 쓰려 하면 **둘 다** 버린다", () => {
    const target = { kind: "group", groupId: "g1" } as const;
    const { ops, skipped } = buildIssuanceWritePlan(
      [
        verdict({ key: "a" }),
        verdict({ key: "b", observed: { ...verdict().observed, writtenDate: "2026-08-09" } }),
      ],
      [
        expectation({ key: "a", writeTarget: target }),
        expectation({ key: "b", writeTarget: target }),
      ],
    );
    expect(ops).toHaveLength(0);
    expect(skipped.map((s) => s.code)).toEqual(["CONFLICTING_TARGET", "CONFLICTING_TARGET"]);
  });

  it("같은 대상·같은 날짜면 하나만 실행한다(멱등)", () => {
    const target = { kind: "group", groupId: "g1" } as const;
    const { ops } = buildIssuanceWritePlan(
      [verdict({ key: "a" }), verdict({ key: "b" })],
      [expectation({ key: "a", writeTarget: target }), expectation({ key: "b", writeTarget: target })],
    );
    expect(ops).toHaveLength(1);
  });
});

describe("⛔ 되돌리기 경로가 생기지 않는다 (소스 스캔)", () => {
  const source = readFileSync(CRON_ROUTE, "utf8");

  it("양성 대조군 — 스캔 대상 파일을 실제로 읽고 있다", () => {
    // 정규식이 깨져도 초록이 되지 않게, 반드시 존재하는 문자열을 먼저 확인한다.
    expect(source).toContain("tax-invoice-issue-confirm");
    expect(source).toContain("verifyCronAuth");
  });

  it("크론이 발행일 필드를 null 로 되돌리는 코드를 갖지 않는다", () => {
    // 메일 커버리지가 100% 가 아니므로 "메일이 없으니 취소"는 곧 데이터 손상이다.
    //
    // 🪤 초판은 `data: { …InvoiceIssuedAt… }` 를 찾았는데 라우트는 **계산된 키**
    //    (`[op.field]`)로 쓰므로 리터럴 필드명이 그 블록에 없다 — 매치 0건이라 루프가
    //    한 번도 안 돌고 초록이 될 뻔했다. 그래서 아래 양성 대조군(매치가 실제로 잡히는가)
    //    을 먼저 세운다.
    const dataWrites = source.match(/data:\s*\{\s*\[op\.field\]:[^}]*\}/g) ?? [];
    expect(dataWrites.length).toBeGreaterThan(0);
    for (const write of dataWrites) {
      expect(write).not.toMatch(/null/);
    }
    // ⚠️ 전역으로 `[op.field]: null` 을 금지하면 **안 된다** — 덮어쓰기 방지 가드
    //    (`where: { …, [op.field]: null }`)가 바로 그 모양이라 정당한 코드를 잡는다.
    //    금지 대상은 `data:` 쪽뿐이고 그건 위 루프가 이미 본다. 리터럴 필드명으로
    //    되돌리는 우회만 여기서 따로 막는다.
    expect(source).not.toMatch(/(supplier|seller)InvoiceIssuedAt:\s*null/);
  });

  it("이미 찍힌 값을 덮지 않는다 — 갱신 조건에 `null` 가드가 있다", () => {
    // 이 가드가 재실행 멱등성이자, 오너가 손으로 넣은 날짜를 기계가 밀어내지 않는 근거다.
    expect(source).toMatch(/where:\s*\{[^}]*\[op\.field\]:\s*null/);
  });

  it("갱신 0건이면 감사 로그를 남기지 않는다", () => {
    // 교차 검증(2026-08-06): WHERE 가드가 값을 지켜도, 0건 갱신에 "…로 기록했습니다"
    // 로그가 붙으면 **그 값을 감사하려고 만든 기록 자체가 오염된다.**
    expect(source).toMatch(/if\s*\(result\.count === 0\)\s*return false/);
    // 그리고 그 경우는 `applied` 가 아니라 별도 카운터로 보고한다.
    expect(source).toContain("noop.push(op.key)");
  });

  it("그룹 멤버 절단 방지 — 캠페인 로더가 groupId 로 멤버십을 다시 읽는다", () => {
    // 조회 창만으로 뽑으면 창 경계를 걸친 그룹의 멤버가 잘리고, 후퇴 가드가 부분집합만
    // 보고 "상대 동일"로 오판해 그룹 전체를 찍는다(교차 검증 2026-08-06).
    const loader = readFileSync(join(HERE, "campaign-facts.ts"), "utf8");
    expect(loader).toContain("groupId: { not: null }"); // ① 창 안에서 그룹 id 수집
    expect(loader).toMatch(/groupId:\s*\{\s*in:\s*groupIds\s*\}/); // ② 창 없이 멤버 재조회
    expect(loader).toContain("OR: [");
  });

  it("⛔ 쓰기는 env 게이트 뒤에 있고 기본이 예행이다", () => {
    // 이 크론은 머지→승격과 동시에 스케줄에 올라 매일 스스로 쓴다. 그런데 오너 지시는
    // "자동 확정의 첫 실행은 오너 확인 하에"였다 — `?dryRun=1` 은 사람이 부를 때만
    // 유효하고 스케줄 발화를 막지 못한다. 게이트가 빠지면 그 조건이 배포 즉시 깨진다.
    expect(source).toMatch(/process\.env\.TAX_INVOICE_AUTO_CONFIRM === "1"/);
    // fail-safe 방향: 변수 누락·오타는 "안 쓴다"로 떨어져야 한다.
    expect(source).toMatch(/const dryRun = dryRunRequested \|\| !writeEnabled/);
  });

  it("허용오차는 리터럴이 아니라 정책 상수를 import 한다", () => {
    // 수취·발행이 서로 다른 숫자를 들면 정책이 갈린다.
    expect(source).toContain("SUB_HUNDRED_TRUNCATION_TOLERANCE_WON");
    expect(source).not.toMatch(/amountToleranceWon:\s*\d/);
  });

  it("흡수한 오차는 감사 로그 문장에 실린다(응답만으로는 부족하다)", () => {
    // 응답은 휘발되고, "이 날짜가 왜 찍혔나"를 되짚을 때 남는 것은 타임라인뿐이다.
    expect(source).toContain("toleratedDelta");
    expect(source).toMatch(/허용오차로 흡수했습니다/);
  });

  it("⛔ outOfScanRange 를 unseen 과 합치지 않는다", () => {
    // 병행 세션(#301) 권고: 이 레포는 "합치지 말 것" 서술만 남긴 규칙이 실제로 여러 번
    // 합쳐졌다. 두 카운터가 응답에서 **각자의 키**로 나가는 것을 코드로 고정한다.
    expect(source).toMatch(/unseen:\s*verdicts\.filter/);
    expect(source).toMatch(/outOfScanRange:\s*verdicts\.filter/);
    // 한쪽을 다른 쪽에 더하는 형태가 생기면 잡는다.
    expect(source).not.toMatch(/unseen[^\n]*\+[^\n]*outOfScanRange/);
    expect(source).not.toMatch(/outOfScanRange[^\n]*\+[^\n]*unseen/);
  });

  it("흡수 건은 감사 로그 type 을 갈라 인덱스로 셀 수 있다", () => {
    // 오너가 「이번 달 허용오차로 자동 확정된 N건」을 보드에서 보게 할 예정이다
    // (오너 확정 2026-08-06). 한 type 에 몰아 두면 그 수를 세려고 `content` 한국어
    // 문장을 파싱해야 하고, 문구를 다듬는 순간 조용히 0건이 된다.
    expect(source).toContain("TAX_INVOICE_AUTO_CONFIRM_TOLERATED");
    expect(source).toMatch(/type:\s*toleratedDelta\s*\n?\s*\?\s*"TAX_INVOICE_AUTO_CONFIRM_TOLERATED"/);
  });

  it("크론 인증은 SSOT 를 import 한다(자체 재구현 금지)", () => {
    expect(source).toContain('from "@/lib/cron-auth"');
    expect(source).not.toMatch(/process\.env\.CRON_SECRET/);
  });

  it("NEEDS_REVIEW 사유 상세를 응답에 싣는다(오너 요청 2026-08-06)", () => {
    // 집계 숫자만으론 "확인 필요 2건"이 금액 불일치인지 수정계산서인지 알 수 없어
    // 자동 확정을 켤지 판단할 근거가 부족했다. 상세는 NEEDS_REVIEW 건에만 붙인다
    // (CONFIRMED·UNSEEN 등은 사유가 없거나 이미 자명하다).
    expect(source).toContain("needsReviewDetail");
    expect(source).toMatch(/status === "NEEDS_REVIEW"/);
    // 상한 없이 무제한으로 실으면 SystemTaskLog 직렬화 상한(4,000자)에 걸려 집계
    // 숫자까지 통째로 잘린다 — 상한과 절단 고지가 함께 있어야 한다.
    expect(source).toContain("NEEDS_REVIEW_DETAIL_BUDGET_CHARS");
    expect(source).toContain("needsReviewDetailCapped");
  });

  it("상세 상한은 건수가 아니라 직렬화 바이트로 건다(2026-08-07 prod 실측 정정)", () => {
    // ⛔ 건수 상한으로 되돌리지 말 것. 처음 넣은 30건은 봉투를 재보지 않고 고른 값이라
    // 실제 한계(약 6건)의 3배였다 — 7건째부터 details 가 통째로 {truncated, preview} 로
    // 대체돼 사유 상세는 물론 집계 숫자까지 사라진다. 항목 길이는 사유 문장에 딸린
    // 금액·매수에 따라 변하므로, 안전한 건수는 고정 상수로 표현할 수 없다.
    const budget = source.match(/NEEDS_REVIEW_DETAIL_BUDGET_CHARS\s*=\s*([\d_]+)/);
    expect(budget).not.toBeNull();
    // 봉투 4,000자 중 집계 본문(prod 실측 1,383자)이 쓸 자리를 남겨야 한다.
    expect(Number(budget![1].replace(/_/g, ""))).toBeLessThanOrEqual(2_500);
    // 누적 길이로 끊는다 — slice(0, N) 류 건수 절단이면 이 단언이 무너진다.
    expect(source).toMatch(/JSON\.stringify\(entry\)\.length/);
    expect(source).toMatch(/>\s*NEEDS_REVIEW_DETAIL_BUDGET_CHARS\)\s*break/);
    // capped 는 "실제로 실린 수 < 판정된 수"여야 한다(상수 비교로 되돌리면 거짓 신고).
    expect(source).toContain("needsReviewDetail.length < needsReviewVerdicts.length");
  });
});
