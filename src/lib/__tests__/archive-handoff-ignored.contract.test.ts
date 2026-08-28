// 로컬 전용 보드 파일의 무시 계약 테스트 (P0 공개 레포 데이터 가드, 2026-07-30).
//
// 배경: AGENTS.md 의 보드 수명주기는 착지한 항목의 핸드오프를
// `docs/handoff/<slug>.md` → `docs/archive/handoff/<slug>.md` 로 **이동**하라고 지시한다.
// 그런데 `.gitignore` 는 원본(`docs/handoff/*`)만 무시하고 이관처는 무시하지 않았다.
// 두 경로의 등급이 어긋나면 **정책을 그대로 따르는 행위 자체가 사고가 된다** — 로컬
// 전용(모드 L)이라 셀러 실명·실측치를 자유롭게 적어둔 파일이, 옮기는 순간 public 레포의
// 추적 후보로 승격된다. 다음 세션의 `git add -A` 한 번이면 커밋된다.
//
// 이 테스트는 판정을 문자열 매칭이 아니라 **git 자신에게** 묻는다(`git check-ignore`).
// 그래야 나중에 누가 무시 규칙을 리팩터링하거나 부정 패턴(`!`)을 추가해 우선순위가
// 뒤집혀도 잡힌다. 선례: vercel-ignore-build(종료코드 계약) · commit-guard(유입 차단).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

/** git 이 그 경로를 무시하는가. 파일이 실재하지 않아도 판정된다. */
function isIgnored(relPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", relPath], {
      cwd: REPO_ROOT,
      stdio: "pipe",
    });
    return true; // exit 0 = 무시됨
  } catch {
    return false; // exit 1 = 무시 안 됨
  }
}

describe("로컬 전용 보드 파일 무시 계약 (모드 L)", () => {
  it("핸드오프 원본과 이관처가 **같은 등급**으로 무시된다", () => {
    // 이 짝이 깨지면 "정책대로 옮겼더니 P0" 가 된다.
    expect(isIgnored(join("docs", "handoff", "some-item.md"))).toBe(true);
    expect(isIgnored(join("docs", "archive", "handoff", "some-item.md"))).toBe(true);
  });

  it("보드·로그 본체도 무시된다", () => {
    expect(isIgnored("PROJECT_MASTER.md")).toBe(true);
    expect(isIgnored("PROJECT_LOG.md")).toBe(true);
  });

  it("핸드오프 템플릿(README)은 의도적 예외라 추적된다", () => {
    // 무시 규칙을 넓히다 이 부정 패턴을 밟으면 템플릿이 레포에서 사라진다.
    expect(isIgnored(join("docs", "handoff", "README.md"))).toBe(false);
  });

  it("마케팅 스킬 검토 체계도 같은 등급으로 무시된다 (2026-08-01 등재)", () => {
    // `docs/marketing-skills/` 는 오너 호칭·셀러 모수·매출 임계값을 담는다(P0 금지).
    // 구축(2026-07-31) 후 8일간 **미추적이면서 무시도 안 되는** 상태였다 — 보드 파일이
    // `.bak` 사본으로 밟았던 것과 같은 구멍이라, 발견 즉시 모드 L 로 등재했다.
    expect(isIgnored(join("docs", "marketing-skills", "OWNER_DECISIONS.md"))).toBe(true);
    expect(isIgnored(join("docs", "marketing-skills", "inventory", "some-repo.md"))).toBe(true);
    expect(isIgnored(join("docs", "marketing-skills", "reviews", "2026-01-01-topic.md"))).toBe(true);
    // 디렉터리 와일드카드라 접미사 사본도 이미 덮인다(별도 패턴 추가 금지).
    expect(isIgnored(join("docs", "marketing-skills", "REGISTRY.md.bak"))).toBe(true);
  });

  it("로컬 문서 서고(docs/private/)도 같은 등급으로 무시된다 (2026-08-28 등재)", () => {
    // 공개 전환 준비 설계: 종전 docs/superpowers/(추적)의 설계서·계획서가 여기로
    // 이동했다. 상세 설계 근거·오너 확정 배경·약점 목록을 담으므로 추적 승격 금지.
    expect(isIgnored(join("docs", "private", "specs", "some-design.md"))).toBe(true);
    expect(isIgnored(join("docs", "private", "plans", "some-plan.md"))).toBe(true);
    // 디렉터리 와일드카드라 접미사 사본도 덮인다(별도 패턴 추가 금지).
    expect(isIgnored(join("docs", "private", "specs", "some-design.md.bak"))).toBe(true);
    // 2026-08-28 2차 이관: 루트 계획서·역사 자료·PR 본문 아카이브도 같은 서고로.
    expect(isIgnored(join("docs", "private", "plans", "SOME_PLAN.md"))).toBe(true);
    expect(isIgnored(join("docs", "private", "history", "chatlog.md"))).toBe(true);
    expect(isIgnored(join("docs", "private", "pr-archive", "bodies.json"))).toBe(true);
  });

  it("루트 QA 산출물·데이터 파일이 무시되고, 앱 자산·픽스처는 통과한다 (2026-08-28)", () => {
    // 실사고: 루트 QA 스크린샷 36장 중 일부에 셀러 실명·거래처명·정산 실측액이,
    // 반품 엑셀 1건에는 일반 고객의 실명·연락처·주소가 들어 있었다(P0). 앱이
    // 서빙하지 않는 일회성 산출물이라 애초에 추적 후보가 되지 않게 막는다.
    expect(isIgnored("settlement-visual-check.png")).toBe(true);
    expect(isIgnored("return.xlsx")).toBe(true);
    expect(isIgnored("test_image_1.jpg")).toBe(true);
    // ⛔ 이 규칙이 넓어져 앱 자산·테스트 픽스처를 삼키면 빌드와 테스트가 깨진다.
    expect(isIgnored(join("public", "icon-512.png"))).toBe(false);
    expect(isIgnored(join("src", "app", "apple-icon.png"))).toBe(false);
    expect(
      isIgnored(join("src", "lib", "order-converter", "__tests__", "fixtures", "t.xlsx")),
    ).toBe(false);
  });

  it("Kiro 스펙 산출물(.kiro/)도 무시된다 (2026-08-28 등재)", () => {
    // `.claude/agents/kfc/spec-design.md` 가 앞으로도 이 경로에 설계 문서를 쓴다 —
    // 무시해 두지 않으면 그 산출물이 매번 추적 후보로 떠서 실수로 실린다.
    expect(isIgnored(join(".kiro", "specs", "some-feature", "design.md"))).toBe(true);
    expect(isIgnored(join(".kiro", "steering", "product.md"))).toBe(true);
  });

  it("`docs/archive/` 루트는 무시하지 않는다 — 추적 문서의 이관처이기 때문", () => {
    // AGENTS.md 문서 관리 정책: 일회성 워크시트·디버그 덤프 등 **추적되던** 문서의
    // 이관처는 `docs/archive/` 다. 핸드오프(로컬 전용)와 출처가 달라 등급도 다르다 —
    // 여기까지 통째로 무시하면 이관한 문서가 조용히 레포에서 사라진다.
    expect(isIgnored(join("docs", "archive", "some-retired-worksheet.md"))).toBe(false);
  });
});

/**
 * 백업 사본 무시 계약 (2026-07-30 추가).
 *
 * ⚠️ **지침 두 개가 서로를 사고로 만들던 지점이다.** 전역 지침은 "파일 전체
 * 덮어쓰기 전 백업(`cp file file.bak`)"을 요구하는데, `.gitignore` 는 보드 파일을
 * **정확한 파일명으로만** 등재했다. 그래서 지침을 성실히 따르면
 * `PROJECT_MASTER.md.bak` 이 `git status` 에 `??` 로 떴고, 누가 `git add -A` 하면
 * 셀러 실명·프로덕션 실측치가 public 레포에 실린다.
 *
 * 2026-07-30 하루에 **세 세션이 같은 함정을 밟았다**(한 세션은 5회). 세 세션 모두
 * 규칙을 알고 있었다 — 아는 것과 지키는 것이 갈리는 자리였고, 그래서 지침 문구가
 * 아니라 **git 규칙**으로 닫는다.
 */
describe("백업 사본 무시 계약 (전역 지침 ↔ P0 모순 해소)", () => {
  /** 실제로 관측된 접미사들 + 편집기 관례. */
  const SUFFIXES = [".bak", "~", ".orig", ".bak_v1", ".save", ".tmp"];

  it.each(SUFFIXES)("PROJECT_MASTER.md%s 가 무시된다", (suffix) => {
    expect(isIgnored(`PROJECT_MASTER.md${suffix}`)).toBe(true);
  });

  it.each(SUFFIXES)("PROJECT_LOG.md%s 가 무시된다", (suffix) => {
    expect(isIgnored(`PROJECT_LOG.md${suffix}`)).toBe(true);
  });

  it("핸드오프 사본은 디렉터리 와일드카드가 이미 덮는다 (원본·이관처 양쪽)", () => {
    expect(isIgnored(join("docs", "handoff", "item.md.bak"))).toBe(true);
    expect(isIgnored(join("docs", "archive", "handoff", "item.md.bak"))).toBe(true);
  });

  it("템플릿 예외는 **정확한 파일명**이라 그 사본까지 풀리지는 않는다", () => {
    // `!docs/handoff/README.md` 를 `!docs/handoff/README.md*` 로 넓히면 여기서 깨진다 —
    // 템플릿 사본에 실 항목 내용을 붙여 쓰다 그대로 커밋되는 경로가 열린다.
    expect(isIgnored(join("docs", "handoff", "README.md"))).toBe(false);
    expect(isIgnored(join("docs", "handoff", "README.md.bak"))).toBe(true);
  });

  it("⚠️ 음성 대조군 — 추적 대상은 계속 추적된다", () => {
    // 무시 규칙을 넓히다 이쪽이 걸리면 파일이 **조용히** 레포에서 사라진다.
    // 하네스 자체가 고장났을 때(예: check-ignore 가 항상 true) 이 단언이 먼저 깨진다.
    for (const tracked of [
      "AGENTS.md",
      join("docs", "agents", "codebase-map.md"),
      join("src", "lib", "claims", "claim-gate.ts"),
      join("docs", "archive", "some-retired-worksheet.md"),
    ]) {
      expect(isIgnored(tracked), `${tracked} 가 잘못 무시됨`).toBe(false);
    }
  });

  it("레포 전역 `*.bak` — 이름을 등재하지 않은 백업본도 무시된다", () => {
    // ⛔ 종전 단언 `.toBe(false)` 와 그 사유("`test-order-parser.ts.bak` 가 추적
    // 상태라 전역 규칙을 넣으면 규칙과 실태가 어긋난다", #165)는 **SUPERSEDED**
    // (2026-08-27, 오너 승인). 그 파일이 같은 PR 에서 삭제돼 추적 `*.bak` 이 0건이
    // 됐고, 전역 규칙이 도입됐다.
    //
    // ⚠️ **이 단언이 지키는 것은 "미래의 이름"이다.** 종전 방어는 정확한 파일명
    // 등재였는데, 사고는 언제나 **아직 등재되지 않은 새 이름**에서 났다(2026-07-30
    // 하루에 세 세션). 그래서 프로브는 일부러 실재하지 않는 경로를 쓴다 — 실재
    // 파일로 검사하면 그 파일이 사라지는 날 프로브도 함께 죽는다.
    expect(isIgnored(join("src", "lib", "foo.ts.bak"))).toBe(true);
    expect(isIgnored(join("아무데나", "무엇이든.md.bak"))).toBe(true);
    // 음성 대조군 — `.bak` 이 아니면 이 규칙에 걸리지 않는다.
    expect(isIgnored(join("src", "lib", "foo.ts"))).toBe(false);
  });
});
