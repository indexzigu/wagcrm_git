// 배포 CI 게이트의 분할 대응 계약 테스트 (2026-08-28).
//
// 배경: `infra/selfhost/deploy.sh` 의 CI 게이트는 머지된 PR 의 required 검사가 전부
// success 인지 확인하고서야 프로덕션 배포를 진행한다. 브랜치 보호가 무료 플랜에서
// 정지돼 있던 동안 이 게이트가 **마지막 방어선**이었다(T-069).
//
// 이 테스트가 고정하는 것은 두 가지 실사고다.
//
//   ① **이름 고정의 함정** — 게이트가 `guard`·`preflight`·`test` 를 **정확 일치**로
//      찾았다. 2026-08-28 에 테스트를 4분할하면서 체크 이름이 `test (1)`…`test (4)`
//      가 되자, 게이트가 `test` 를 영영 못 찾아 **모든 배포가 막혔다**(공개 레포
//      전환 중 실제로 멈췄다). 분할 수를 바꾸거나 되돌려도 깨지지 않도록,
//      "`test` 로 시작하는 검사 전부 + 전부 success" 로 판정해야 한다.
//
//   ② **`grep -qv` 가 거짓말한다** — 이 맥의 `grep` 은 ugrep 이고, `-q` 가 **반전 전**
//      패턴 기준으로 종료코드를 낸다. 실측: `grep -v '=success$'` 는 실패한 조각을
//      출력하는데 `grep -qv '=success$'` 는 1(미발견)을 냈다. 그래서 ①을 고치는
//      첫 시도가 **조각 하나가 failure 여도 게이트를 통과**시켰다 — 깨진 테스트가
//      프로덕션으로 나가는 경로였다. 종료코드가 아니라 **출력의 유무**로 판정한다.
//
// 판정은 문자열 존재가 아니라 **게이트 판정부를 실제로 실행**해서 한다 — 소스에
// 특정 문구가 있는지만 보면 로직이 바뀌어도 통과한다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DEPLOY_SH = join(process.cwd(), "infra", "selfhost", "deploy.sh");
const SRC = readFileSync(DEPLOY_SH, "utf8");

/**
 * deploy.sh 의 게이트 판정부와 **같은 로직**을 bash 로 실행해 결과를 얻는다.
 * 스크립트 전체는 네트워크·launchd 에 의존하므로, 판정부만 떼어 같은 셸에서 돌린다.
 * ⚠️ 이 복제본이 원본과 어긋나면 아래 "원본과의 동기화" 테스트가 잡는다.
 */
function judge(checks: string): string {
  const script = `
    GATE_CHECKS="$1"; GATE_FAIL_NAME=""
    for GATE_NAME in guard preflight; do
      grep -qx "\${GATE_NAME}=success" <<<"$GATE_CHECKS" || { GATE_FAIL_NAME="$GATE_NAME"; break; }
    done
    if [ -z "$GATE_FAIL_NAME" ]; then
      GATE_TEST_LINES="$(grep -E '^test( \\(|=)' <<<"$GATE_CHECKS" || true)"
      GATE_BAD_TEST="$(grep -v '=success$' <<<"$GATE_TEST_LINES" || true)"
      if [ -z "$GATE_TEST_LINES" ]; then GATE_FAIL_NAME="test(검사 없음)"
      elif [ -n "$GATE_BAD_TEST" ]; then GATE_FAIL_NAME="$(head -1 <<<"$GATE_BAD_TEST" | cut -d= -f1)"; fi
    fi
    printf '%s' "\${GATE_FAIL_NAME:-PASS}"
  `;
  return execFileSync("bash", ["-c", script, "_", checks], { encoding: "utf8" });
}

describe("배포 CI 게이트 — 분할된 test 검사 판정", () => {
  it("4조각이 전부 success 면 통과한다", () => {
    expect(
      judge("guard=success\npreflight=success\ntest (1)=success\ntest (2)=success\ntest (3)=success\ntest (4)=success"),
    ).toBe("PASS");
  });

  it("⛔ 조각 하나라도 실패하면 차단한다 — 이 단언이 ②의 재발을 막는다", () => {
    // `grep -qv` 로 되돌리면 여기서 "PASS" 가 나온다(실측된 오동작).
    expect(
      judge("guard=success\npreflight=success\ntest (1)=success\ntest (2)=failure\ntest (3)=success\ntest (4)=success"),
    ).toBe("test (2)");
  });

  it("조각이 취소돼도 차단한다 — success 가 아닌 모든 결론을 막는다", () => {
    expect(judge("guard=success\npreflight=success\ntest (1)=success\ntest (2)=cancelled")).toBe("test (2)");
  });

  it("분할하지 않은 단일 `test` 도 그대로 판정한다 (분할 되돌림 대비)", () => {
    expect(judge("guard=success\npreflight=success\ntest=success")).toBe("PASS");
    expect(judge("guard=success\npreflight=success\ntest=failure")).toBe("test");
  });

  it("⛔ test 검사가 아예 없으면 차단한다 — 없음을 통과로 읽으면 게이트가 무의미하다", () => {
    expect(judge("guard=success\npreflight=success")).toBe("test(검사 없음)");
  });

  it("guard·preflight 는 종전대로 정확 일치로 요구한다", () => {
    expect(judge("guard=success\npreflight=failure\ntest (1)=success")).toBe("preflight");
    expect(judge("preflight=success\ntest (1)=success")).toBe("guard");
  });
});

describe("원본과의 동기화 — 위 복제 로직이 deploy.sh 와 같은 판정을 쓰는가", () => {
  it("게이트가 `startswith(\"test\")` 로 조각을 모은다", () => {
    // 정확 일치(`.name == "test"`)로 되돌리면 분할 후 모든 배포가 막힌다(①).
    expect(SRC).toContain('(.name | startswith("test"))');
  });

  it("⛔ 게이트 판정에 `grep -qv` 를 쓰지 않는다 (②)", () => {
    // 주석은 이 함정을 **설명**하므로 매치된다 — 주석을 걷어낸 뒤 검사한다.
    const code = SRC.split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/grep\s+(-\w*q\w*v|-\w*v\w*q)\b/);
    expect(code).toContain('GATE_BAD_TEST="$(grep -v');
  });

  it("루트 커밋은 PR 검사를 건너뛴다 — 첫 배포가 영구 차단되지 않게", () => {
    // 레포의 첫 커밋은 베이스가 없어 PR 을 만들 수 없다. 이 예외가 빠지면
    // 새 레포의 첫 배포가 「PR 없음 = 직접 push 의심」으로 영구 차단된다.
    const code = SRC.split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).toContain('git rev-parse -q --verify "${GATE_SHA}^"');
    expect(code).toContain("루트 커밋(부모 없음)");
    // ⛔ `cut -d' ' -f2-` 로 부모를 뽑지 말 것 — 구분자가 없으면 줄 전체를 반환해
    // 루트 커밋이 "부모 있음"으로 보인다(2026-08-28 실측).
    expect(code).not.toMatch(/rev-list --parents[^\n]*cut -d' ' -f2-/);
  });

  it("루트 판정 방법이 실제로 루트와 비루트를 가른다 (격리된 임시 레포)", () => {
    // 소스에 문자열이 있는 것과 그 명령이 옳게 동작하는 것은 다르다 — 실행해서 본다.
    //
    // 🪤 **이 레포의 git 상태로 검사하지 말 것.** 초판이 `HEAD` 와
    // `rev-list --max-parents=0 HEAD` 로 검사했는데, CI 의 `actions/checkout` 은
    // **얕은 복제(depth 1)** 라 HEAD 조차 부모가 없다 — 로컬(전체 이력)에서는
    // 통과하고 CI 에서만 실패했다(2026-08-28 실측). 주변 환경에 기대는 단언은
    // 그 환경이 다른 곳에서 거짓이 된다. 그래서 레포를 하나 만들어 검사한다.
    const dir = mkdtempSync(join(tmpdir(), "gate-root-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
      git("init", "-q");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "a"), "1");
      git("add", "-A");
      git("commit", "-q", "-m", "root");
      const rootSha = git("rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "a"), "2");
      git("add", "-A");
      git("commit", "-q", "-m", "child");
      const childSha = git("rev-parse", "HEAD").trim();

      // deploy.sh 가 쓰는 바로 그 판정.
      const hasParent = (sha: string) => {
        try {
          execFileSync("git", ["rev-parse", "-q", "--verify", `${sha}^`], { cwd: dir, stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      };
      expect(hasParent(rootSha), "루트 커밋인데 부모가 있다고 판정됐다").toBe(false);
      expect(hasParent(childSha), "자식 커밋인데 부모가 없다고 판정됐다").toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("⛔ 얕은 복제는 fail-closed 로 막는다 — 게이트 전면 무력화 방지", () => {
    // 얕은 복제에서는 잘린 지점의 커밋이 전부 "부모 없음"으로 보여, 위 루트 예외가
    // **모든 커밋을 건너뛴다**. 조용한 전면 통과이므로 판정 불능으로 처리해야 한다.
    const code = SRC.split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).toContain("--is-shallow-repository");
    // 루트 예외보다 **먼저** 와야 한다 — 뒤에 오면 이미 건너뛴 뒤다.
    expect(code.indexOf("--is-shallow-repository")).toBeLessThan(
      code.indexOf('git rev-parse -q --verify "${GATE_SHA}^"'),
    );
  });

  it("조각 실패 시 어느 조각인지 이름을 보고한다", () => {
    const code = SRC.split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).toContain('GATE_FAIL_NAME="$(head -1 <<<"$GATE_BAD_TEST" | cut -d= -f1)"');
  });
});
