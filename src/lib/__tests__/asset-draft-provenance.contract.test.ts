import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 채택분 저장의 **출처 기록** 계약 (C3 §6).
 *
 * 스펙은 저장 시 "생성에 쓰인 **승인 클레임 id 목록** · 게이트 판정 · **모델명**"을
 * 함께 남기라고 요구한다. 이유는 §6 서두의 **소구점 A/B 실험**과 **평가 루프**다 —
 * *"이 브리프가 어떤 표현을 근거로 만들어졌나"* 를 되짚을 수 없으면 실험이 성립하지
 * 않는다.
 *
 * 🪤 **왜 계약이 필요한가 (실측 2026-07-31):** `DealAssetDraft` 에 `claimIds`·`model`
 * 컬럼이 **이미 있었고**, `asset-drafts` 라우트도 두 값을 받아 저장하게 **이미 돼
 * 있었다**. 그런데 ①생성 라우트가 응답에 담지 않았고 ②화면이 저장 요청에 싣지 않아
 * **두 컬럼이 항상 null 로 쌓였다.** 스키마와 수신부가 준비돼도 **호출부가 안 채우면
 * 데이터는 안 쌓인다** — 그리고 이건 나중에 소급 복원이 안 된다(승인 클레임 집합은
 * 그 뒤 승인·거절로 바뀐다).
 *
 * 그래서 판정을 런타임이 아니라 **소스 스캔**으로 건다(이 레포의 확립된 방식 —
 * `deal-claim-context.contract` · `mobile-breakpoint-contract` 선례). 생성 라우트는
 * Gemini 호출이 있어 단위테스트 대상이 아니고, 막으려는 회귀는 "값이 배선에서
 * 빠지는 것"이라 배선 자체를 보는 것이 맞다.
 */

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const GUIDE_ROUTE = "src/app/api/deals/[id]/content-guide/route.ts";
const DRAFTS_ROUTE = "src/app/api/deals/[id]/asset-drafts/route.ts";
/**
 * 출처를 실어 보내는 **배선**의 현재 위치. 원래 `deals-panel.tsx` 였는데 딜 패널
 * 분할(2026-08-07)로 요청 조립이 이 훅으로 내려갔다 — 화면 컴포넌트
 * (`deal-asset-section.tsx`)에는 이 네 줄이 **하나도 없다**(실측).
 * ⛔ 앵커를 옮길 때는 대상 파일에 그 문자열이 실제로 있는지 먼저 확인할 것 —
 * 없는 파일을 가리키면 계약이 빨간불이 되고, 우연히 있는 파일을 가리키면
 * 공허 통과가 된다.
 */
const ASSET_WIRING = "src/hooks/useDealAssets.ts";

/** 주석을 걷어낸 코드만 — 설명 문구가 단언을 통과시키지 않게 한다. */
function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*"))
    .filter((line) => !line.trim().startsWith("//"))
    .filter((line) => !line.trim().startsWith("/*"))
    .join("\n");
}

describe("생성 라우트가 출처를 응답에 싣는다", () => {
  it("주입된 승인 클레임 id 를 내려준다", () => {
    // 저장 시점에 DB 를 다시 읽으면 "그때 무엇을 썼나"가 아니라 "지금 무엇이
    // 승인돼 있나"가 된다 — 그래서 생성 시점 값을 실어 보내야 한다.
    expect(codeOnly(read(GUIDE_ROUTE))).toContain("claimIds:");
  });

  it("클레임 id 는 게이트에 넣은 **승인분**에서 뽑는다", () => {
    // PROPOSED 를 섞으면 "AI 가 추출한 미검수 표현으로 만든 자료"가 승인 근거로
    // 기록된다(C1 M3 가 막은 함정과 같은 계열).
    expect(codeOnly(read(GUIDE_ROUTE))).toContain("gateClaims.map(");
  });

  it("모델명을 **채택된 시도의 결과**에서 가져온다 — 상수를 다시 읽지 않는다", () => {
    // 폴백 사다리가 붙으면 레그마다 모델이 달라질 수 있다. 상수를 읽으면
    // "설정된 모델"이 기록되고 "실제 응답한 모델"과 갈린다.
    const code = codeOnly(read(GUIDE_ROUTE));
    expect(code).toContain("model: result.model");
    expect(code).toMatch(/const \{ guide, gate, model \}/);
  });
});

describe("화면이 저장 요청에 출처를 싣는다", () => {
  it("보냄 표시 저장에 claimIds·model 을 넣는다", () => {
    // 이 두 줄이 빠진 것이 실제 결함이었다 — 라우트는 받게 돼 있었는데
    // 아무도 보내지 않아 컬럼이 항상 null 이었다.
    const code = codeOnly(read(ASSET_WIRING));
    expect(code).toContain("claimIds: guideMeta.claimIds");
    expect(code).toContain("model: guideMeta.model");
  });

  it("⚠️ 유형(kind)을 반드시 실어 보낸다 — 안 보내면 브랜드용이 셀러 기록이 된다", () => {
    /**
     * 수신 라우트가 `kind: kind ?? "CONTENT_GUIDE"` 로 **기본값을 접는다.** 그래서
     * 화면이 유형을 빠뜨리면 에러 없이 **브랜드용 자료가 셀러 보냄 기록으로 쌓인다**
     * — 그 기록은 캠페인 오픈 게이트(`launch-readiness`)가 "셀러에게 보낸 문안"으로
     * 읽는 값이라, 조용히 잘못된 판정으로 이어진다. 소급 복원도 안 된다.
     *
     * 이 규칙은 주석으로만 있었고 2026-08-07 딜 패널 분할 때 그 주석이 사라졌다
     * (배선은 살아남았다). 같은 사고의 재발을 막으려 계약으로 승격한다.
     */
    expect(codeOnly(read(ASSET_WIRING))).toContain("kind: guideKind");
  });

  it("생성 응답에서 받은 값을 그대로 들고 있는다", () => {
    const code = codeOnly(read(ASSET_WIRING));
    expect(code).toContain("claimIds: data.claimIds");
    expect(code).toContain("model: data.model");
  });
});

describe("수신 라우트가 출처를 저장한다", () => {
  it("claimIds·model 을 받아 저장한다", () => {
    const code = codeOnly(read(DRAFTS_ROUTE));
    expect(code).toContain("claimIds");
    expect(code).toContain("model");
  });

  it("⚠️ 빈 배열을 null 로 접지 않는다 — 0건 생성과 미배선을 구분한다", () => {
    /**
     * 승인 소구점 0건이어도 생성은 허용된다(`claimGuided` 는 차단이 아니라 플래그).
     * 그래서 빈 배열은 도달 가능한 **정상 상태**다. 이걸 null 로 접으면 "클레임 없이
     * 자유 생성함"과 "배선이 끊겨 아무것도 안 보냄"이 DB 에서 똑같이 보인다 — 이
     * PR 이 고친 결함과 같은 계열의 관측 불능이고, 역시 소급 복원이 안 된다.
     *
     * 빈 문자열 = 보냈고 0건 · null = 애초에 안 보냄.
     */
    const code = codeOnly(read(DRAFTS_ROUTE));
    expect(code).not.toMatch(/claimIds\?\.length\s*\?/);
    expect(code).toContain("claimIds ? claimIds.join(");
  });

  it("⚠️ claimIds 상한이 감사 흔적 때문에 저장 전체를 실패시키지 않는다", () => {
    // 상한은 **저장 실패를 막는 안전 상한**이지 정책이 아니다. 초과하면 요청 전체가
    // 400 이 되어 "보냄 표시" 자체가 실패하고 운영자에게는 형식 오류로만 보인다 —
    // 감사 흔적 하나 때문에 채택분 기록을 통째로 잃는 쪽이 나쁘다.
    const m = read(DRAFTS_ROUTE).match(/claimIds:\s*z\.array\(z\.string\(\)\)\.max\((\d+)\)/);
    expect(m, "claimIds 상한 선언을 찾지 못했다").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(200);
  });
});
