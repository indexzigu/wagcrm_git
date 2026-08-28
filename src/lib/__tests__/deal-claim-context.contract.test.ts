import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveClaimCategory,
  selectPromptClaims,
  toGateClaims,
  type DealClaimRow,
} from "@/lib/claims/deal-claim-context";

/**
 * 딜 클레임 상속 규약의 계약 (C1 §4).
 *
 * ⚠️ **이 파일이 존재하는 이유 — 실제로 갈라졌다.**
 * 상속 규약이 `/api/deals/[id]/claims` 라우트에 **인라인으로만** 있었다. 그래서
 * C3 M1 이 콘텐츠 가이드에 게이트를 붙일 때 같은 규약을 손으로 다시 썼고,
 * 두 군데가 어긋났다(2026-07-30 실측):
 *
 * | | claims 라우트(정본) | content-guide 라우트(어긋남) |
 * | --- | --- | --- |
 * | 클레임 | `dealId: { in: [자기, 부모] }` = 합집합 | `parentDealId ?? id` = 부모 치환 |
 * | 카테고리 | `deal.category ?? parent.category` | `parent.category ?? deal.category` |
 *
 * 결과: ①옵션 딜의 **자기 전용 금지 표현이 생성 게이트에서 무시**됐고
 * ②옵션에 카테고리를 지정해도 부모 것으로 덮여 **엉뚱한 카테고리 규칙이 적용**됐다.
 * 둘 다 게이트가 헐거워지는 방향이다.
 *
 * 금지 표현 정규식의 어미 열거가 규칙마다 어긋나 검출이 갈렸던 것과 같은 종류의
 * 표류다 — 규약을 주석이 아니라 **함수 + 이 계약 테스트**로 고정한다.
 */

function claimRow(over: Partial<DealClaimRow> = {}): DealClaimRow {
  return {
    id: "c1",
    dealId: "deal-1",
    kind: "APPROVED_CLAIM",
    text: "국내산 원료 100%",
    status: "APPROVED",
    evidence: "시험성적서 2026-001",
    evidenceType: "MEASURED",
    reviewBy: null,
    approvedAt: null,
    rejectedNote: null,
    source: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    inherited: false,
    ...over,
  };
}

describe("deal-claim-context — 카테고리 상속 우선순위", () => {
  it("딜 자기 값이 부모보다 우선한다", () => {
    // ⛔ 뒤집지 말 것. 부모 우선으로 쓰면 옵션에 지정한 카테고리가 무시돼
    // 엉뚱한 카테고리 규칙이 적용된다(content-guide 라우트에서 실제 발생).
    expect(resolveClaimCategory("COSMETIC", "FOOD")).toBe("COSMETIC");
  });

  it("딜에 없으면 부모 값을 물려받는다", () => {
    // 옵션 딜은 대개 카테고리를 따로 안 넣는다 — 부모가 안 내려오면 카테고리
    // 규칙이 통째로 적용되지 않는다(오탐이 아니라 미탐).
    expect(resolveClaimCategory(null, "SUPPLEMENT")).toBe("SUPPLEMENT");
  });

  it("둘 다 없으면 null (공통 규칙만 적용)", () => {
    expect(resolveClaimCategory(null, null)).toBeNull();
  });
});

describe("deal-claim-context — 승인분만 게이트에 넣는다", () => {
  it("APPROVED 외 status 는 게이트에서 제외된다", () => {
    // PROPOSED 를 넣으면 AI 가 추출한 미검수 표현이 곧 '승인된 소구점'처럼
    // 취급된다 — C1 M3 가 막은 함정이다.
    const rows = [
      claimRow({ id: "ok", status: "APPROVED" }),
      claimRow({ id: "proposed", status: "PROPOSED" }),
      claimRow({ id: "rejected", status: "REJECTED" }),
      claimRow({ id: "expired", status: "EXPIRED" }),
    ];
    expect(toGateClaims(rows).map((c) => c.id)).toEqual(["ok"]);
  });

  it("프롬프트 주입과 게이트가 같은 승인 필터를 쓴다", () => {
    // 두 집합이 갈라지면 "주입했는데 위반으로 잡히는" 모순이 생긴다.
    const rows = [
      claimRow({ id: "a", kind: "APPROVED_CLAIM", status: "APPROVED" }),
      claimRow({ id: "b", kind: "BANNED_PHRASE", status: "APPROVED" }),
      claimRow({ id: "c", kind: "REQUIRED_DISCLOSURE", status: "APPROVED" }),
      claimRow({ id: "d", kind: "APPROVED_CLAIM", status: "PROPOSED" }),
    ];
    const prompt = selectPromptClaims(rows);
    const promptIds = [
      ...prompt.approved,
      ...prompt.banned,
      ...prompt.disclosures,
    ]
      .map((c) => c.id)
      .sort();
    expect(promptIds).toEqual(toGateClaims(rows).map((c) => c.id).sort());
    expect(promptIds).not.toContain("d");
  });

  it("kind 별로 정확히 가른다", () => {
    const rows = [
      claimRow({ id: "a", kind: "APPROVED_CLAIM" }),
      claimRow({ id: "b", kind: "BANNED_PHRASE" }),
      claimRow({ id: "c", kind: "REQUIRED_DISCLOSURE" }),
    ];
    const { approved, banned, disclosures } = selectPromptClaims(rows);
    expect(approved.map((c) => c.id)).toEqual(["a"]);
    expect(banned.map((c) => c.id)).toEqual(["b"]);
    expect(disclosures.map((c) => c.id)).toEqual(["c"]);
  });
});

/**
 * 상속 쿼리 자체는 Prisma 를 타서 단위테스트가 어렵다. 그래서 **호출부가 규약을
 * 다시 구현하지 않는지**를 소스 스캔으로 막는다(이 레포의 확립된 방식 —
 * `mobile-breakpoint-contract`·`instagram-scrape-callers.contract` 선례).
 *
 * 막으려는 회귀는 구체적이다: 새 호출부가 클레임을 직접 조회하면서
 * `parentDealId ?? id` 로 **부모 치환**을 쓰는 것. 그 한 줄이 옵션 딜의 자기
 * 제약을 조용히 없앤다.
 */
describe("deal-claim-context — 호출부가 상속을 재구현하지 않는다", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  const DELEGATING_ROUTES = [
    "src/app/api/deals/[id]/content-guide/route.ts",
    "src/app/api/deals/[id]/claims/route.ts",
  ];

  it.each(DELEGATING_ROUTES)("%s 는 정본 함수에 위임한다", (rel) => {
    expect(read(rel)).toContain("loadDealClaimContext");
  });

  it.each(DELEGATING_ROUTES)("%s 는 부모 딜을 직접 해석하지 않는다", (rel) => {
    // `parentDealId` 가 등장하면 상속을 손으로 다시 쓰고 있다는 뜻이다.
    // 주석에서 언급하는 것은 허용하되, 코드에서 참조하면 실패한다.
    const code = read(rel)
      .split("\n")
      .filter((line) => !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("parentDealId");
  });

  it("C2 오퍼 진단의 부모 치환 규약은 건드리지 않는다", () => {
    // ⚠️ 오퍼는 **본품 단위로 성립**하므로 `parentDealId ?? id`(부모 치환)가
    // 맞다. 표현 제약(합집합)과 다른 규약이며 통일 대상이 아니다 — 이 테스트는
    // "둘을 같게 만들자"는 정리가 들어오면 깨지도록 남겨 둔다.
    const readiness = read(
      "src/app/api/campaigns/[id]/launch-readiness/route.ts",
    );
    expect(readiness).toContain("parentDealId ?? ");
  });

  /**
   * 오픈 준비 감사는 **두 규약이 한 파일에서 만나는 유일한 지점**이다. 위
   * 테스트가 오퍼 쪽(부모 치환)을 지키고, 아래가 표현 쪽(합집합)을 지킨다.
   * 한쪽만 있으면 "통일하자"는 정리에 다른 쪽이 조용히 쓸려간다.
   */
  it("오픈 준비 감사의 표현 게이트는 합집합 정본에 위임한다", () => {
    const readiness = read(
      "src/app/api/campaigns/[id]/launch-readiness/route.ts",
    );
    // 게이트 입력을 부모 치환된 `dealId` 로 만들면 옵션 딜의 자기 전용 금지
    // 표현이 감사에서 무시된다 — 정본 함수를 거쳐야 한다.
    expect(readiness).toContain("loadDealClaimContext");
    // 승인분만 게이트에 넣는 필터(C1 M3)를 우회하지 않는다.
    expect(readiness).toContain("toGateClaims");
  });

  it("감사가 저장된 gateVerdict 를 재사용하지 않는다", () => {
    /**
     * `DealAssetDraft.gateVerdict` 는 **생성 시점** 판정이라 그 뒤 규칙이
     * 추가되면 낡고, 감사가 요구하는 `missingDisclosures` 는 애초에 저장돼
     * 있지도 않다(고지 누락 = BLOCK 축의 나머지 절반). 감사는 본문을 **현재
     * 규칙으로** 다시 판정해야 한다 — 저장값 재사용은 조용한 미탐이다.
     */
    const readiness = read(
      "src/app/api/campaigns/[id]/launch-readiness/route.ts",
    );
    const code = readiness
      .split("\n")
      .filter((line) => !line.trim().startsWith("*"))
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("gateVerdict");
    expect(code).toContain("checkText(");
  });
});
