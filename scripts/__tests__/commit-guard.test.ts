import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * commit-guard.mjs 의 검출 계약을 고정한다(P0 Public Repo Data Guard 의
 * 커밋 시점 강제 장치). 깨지면 코드가 아니라 규칙이 어긋난 것이다 —
 * 패턴 완화는 오너 승인 사안.
 *
 * ⚠️ 픽스처의 가짜 시크릿·이메일·주민번호는 전부 문자열 조합으로 만든다.
 * 리터럴로 쓰면 이 테스트 파일 자체가 가드에 걸린다.
 */

const SCRIPT = path.resolve(__dirname, "..", "commit-guard.mjs");
const PASS = 0;
const BLOCK = 1;

const tmpRoots: string[] = [];
function tmpDir(prefix: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], cwd?: string) {
  const result = spawnSync("node", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function messageCheck(text: string) {
  const dir = tmpDir("guard-msg-");
  const file = path.join(dir, "COMMIT_EDITMSG");
  writeFileSync(file, text);
  return run(["--message", file], dir);
}

// ---- 가짜 픽스처(조합 생성) ------------------------------------------------
const FAKE_GH_TOKEN = ["ghp", "_"].join("") + "Ab1".repeat(8); // ghp_ + 24자
const FAKE_GOOGLE_KEY = "AIza" + "a1".repeat(16); // AIza + 32자
const FAKE_RRN = "900101" + "-" + "2345678"; // 주민번호 형태
const FAKE_EMAIL = "someone" + "@" + "gmail" + ".com";
const FAKE_DB_URL =
  "postgresql" + "://" + "wag" + ":" + "s3cretpw" + "@" + "db.host:5432/app";

describe("commit-guard --message", () => {
  it("깨끗한 메시지는 통과한다", () => {
    expect(messageCheck("fix(cron): 유령 타깃 제거").status).toBe(PASS);
  });

  it("GitHub 토큰을 차단한다", () => {
    const r = messageCheck(`디버그용 토큰 ${FAKE_GH_TOKEN}`);
    expect(r.status).toBe(BLOCK);
    expect(r.output).toContain("GitHub 토큰");
  });

  it("주민등록번호 형태를 차단한다", () => {
    expect(messageCheck(`테스트 계정 ${FAKE_RRN}`).status).toBe(BLOCK);
  });

  it("비허용 이메일을 차단하고 허용 도메인은 통과시킨다", () => {
    expect(messageCheck(`문의: ${FAKE_EMAIL}`).status).toBe(BLOCK);
    expect(messageCheck("문의: dev@example.com").status).toBe(PASS);
  });

  it("URL 내장 자격증명을 차단한다", () => {
    expect(messageCheck(FAKE_DB_URL).status).toBe(BLOCK);
  });

  it("자리표시자 토큰은 면제한다(토큰 단위 앵커링)", () => {
    // AWS 문서의 공식 예시 키 — 토큰 안에 EXAMPLE 이 있어 면제된다.
    expect(messageCheck("AKIA" + "IOSFODNN7" + "EXAMPLE").status).toBe(PASS);
  });

  it("실키는 같은 줄에 placeholder 가 있어도 잡는다", () => {
    const r = messageCheck(`placeholder 참고: ${FAKE_GOOGLE_KEY}`);
    expect(r.status).toBe(BLOCK);
  });

  it("주석(#) 줄은 커밋에 실리지 않으므로 무시한다", () => {
    expect(messageCheck(`# ${FAKE_GH_TOKEN}\nfeat: 정상 제목`).status).toBe(PASS);
  });
});

// ---- staged 모드: 임시 git 레포에서 검증 -----------------------------------
function makeRepo() {
  const dir = tmpDir("guard-repo-");
  const g = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  g("init", "-q");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "guard-test");
  return { dir, g };
}

describe("commit-guard --staged", () => {
  it("깨끗한 스테이징은 통과한다", () => {
    const { dir, g } = makeRepo();
    writeFileSync(path.join(dir, "a.ts"), "export const ok = 1;\n");
    g("add", "a.ts");
    expect(run(["--staged"], dir).status).toBe(PASS);
  });

  it("추가 줄의 시크릿을 파일:줄과 함께 차단한다", () => {
    const { dir, g } = makeRepo();
    writeFileSync(
      path.join(dir, "b.ts"),
      `const key = "${FAKE_GOOGLE_KEY}";\n`,
    );
    g("add", "b.ts");
    const r = run(["--staged"], dir);
    expect(r.status).toBe(BLOCK);
    expect(r.output).toContain("b.ts:1");
    expect(r.output).toContain("Google API 키");
    // 원문 전체를 터미널에 재노출하지 않는다(마스킹).
    expect(r.output).not.toContain(FAKE_GOOGLE_KEY);
  });

  it("기존 커밋에 있던 매치는 무관한 수정 시 소음을 내지 않는다(추가 줄만 검사)", () => {
    const { dir, g } = makeRepo();
    const file = path.join(dir, "legacy.md");
    writeFileSync(file, `옛 기록 ${FAKE_GH_TOKEN}\n둘째 줄\n`);
    g("add", "legacy.md");
    g("commit", "-q", "--no-verify", "-m", "seed");
    writeFileSync(file, `옛 기록 ${FAKE_GH_TOKEN}\n둘째 줄 수정됨\n`);
    g("add", "legacy.md");
    expect(run(["--staged"], dir).status).toBe(PASS);
  });

  it(".env 파일 스테이징을 차단하고 example 계열은 허용한다", () => {
    const { dir, g } = makeRepo();
    writeFileSync(path.join(dir, ".env"), "SAFE=1\n");
    writeFileSync(path.join(dir, ".env.example"), "SAFE=\n");
    g("add", "-f", ".env", ".env.example");
    const r = run(["--staged"], dir);
    expect(r.status).toBe(BLOCK);
    expect(r.output).toContain(".env 파일 스테이징");
    expect(r.output).not.toContain(".env.example");
  });

  it("로컬 denylist(.git/info) 금지어를 차단한다", () => {
    const { dir, g } = makeRepo();
    const infoDir = path.join(dir, ".git", "info");
    mkdirSync(infoDir, { recursive: true });
    writeFileSync(
      path.join(infoDir, "commit-guard-denylist"),
      "# 로컬 전용 금지어\n김가상셀러\n",
    );
    writeFileSync(path.join(dir, "c.md"), "이번 회차는 김가상셀러 진행\n");
    g("add", "c.md");
    const r = run(["--staged"], dir);
    expect(r.status).toBe(BLOCK);
    expect(r.output).toContain("로컬 금지어");
  });
});
