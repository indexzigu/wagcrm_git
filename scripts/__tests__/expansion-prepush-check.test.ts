import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { addedLines, checkBranchName, countFigures, findExposures, loadTerms } from "../expansion-prepush-check.mjs";

const TERM = "zxqholder"; // made-up marker, not a real name
const HANGUL_TERM = "가나다라";
// HANGUL_TERM 의 CP949(EUC-KR) 바이트 — Node 는 CP949 로 인코딩하지 못해 바이트를 직접 적는다(아래 테스트가 디코드로 대조).
const CP949_TERM = Buffer.from([0xb0, 0xa1, 0xb3, 0xaa, 0xb4, 0xd9, 0xb6, 0xf3]);
// 커밋 가드 대상 표본은 실행 중에 조립한다 — 이 파일 자체가 레포 커밋 가드에 걸리지 않게(리터럴로 두지 않는다).
const FAKE_KEY = ["sk", "-", "Q".repeat(8), "r".repeat(8), "7".repeat(8)].join("");
const FAKE_EMAIL = ["zq.holder", "zxq-mail.io"].join("@");
const FAKE_FIGURE = ["9,876", ",543", "원"].join("");

function tmpFile(content: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-terms-"));
  const file = path.join(dir, "terms.txt");
  fs.writeFileSync(file, content);
  return { dir, file };
}

describe("checkBranchName", () => {
  it("exp/ 접두 + 소문자 슬러그는 허용", () => {
    expect(checkBranchName("exp/daily-dup-guard").ok).toBe(true);
  });
  it.each(["claude/홍길동-fix", "main", "HEAD", "exp/ab", "exp/Upper-case", "exp/-lead", "exp/" + "a".repeat(50), "exp/a/b", ""])(
    "거부: %s",
    (name) => {
      const r = checkBranchName(name);
      expect(r.ok).toBe(false);
      expect(r.reason).toBeTruthy();
    },
  );
});

describe("findExposures", () => {
  it("대소문자 무시", () => {
    expect(findExposures("메모 HongGD 님", ["honggd"])).toEqual(["honggd"]);
  });
  it("2자 미만 term 은 무시", () => {
    expect(findExposures("a b c", ["a"])).toEqual([]);
  });
  it("한글 term 도 동작", () => {
    expect(findExposures(`메모 ${HANGUL_TERM} 님`, [HANGUL_TERM])).toEqual([HANGUL_TERM]);
  });
  it("NFD 로 들어온 한글도 NFC term 과 일치", () => {
    expect(findExposures(HANGUL_TERM.normalize("NFD"), [HANGUL_TERM])).toEqual([HANGUL_TERM]);
  });
  it("없으면 빈 배열", () => {
    expect(findExposures("깨끗한 텍스트", [TERM])).toEqual([]);
  });
});

describe("countFigures", () => {
  it("단위·쉼표 표기 금액을 센다", () => {
    expect(countFigures(FAKE_FIGURE)).toBe(1);
    expect(countFigures(["120", ",000"].join(""))).toBe(1);
    expect(countFigures(["1,234", ",567 원"].join(""))).toBe(1);
    expect(countFigures(["100000", "원"].join(""))).toBe(1);
    expect(countFigures(["10", "만원"].join(""))).toBe(1);
    expect(countFigures(["3", "억"].join(""))).toBe(1);
  });
  it("맨 숫자·작은 금액·코드 숫자는 세지 않는다", () => {
    for (const t of [
      "1731900000000",
      "256 * 1024 * 1024",
      "deadbeefcafebabe1234567890",
      "1,000",
      "9만원",
      "기억",
      "maxBuffer: 268435456",
      "rgb(255,255,255)",
      'points="100,200 300,400"',
    ]) {
      expect(countFigures(t)).toBe(0);
    }
  });
});

describe("loadTerms", () => {
  it("없는 경로는 throw", () => {
    expect(() => loadTerms("/nonexistent/terms.txt")).toThrow();
  });
  it("빈 파일은 throw", () => {
    const { dir, file } = tmpFile("");
    try {
      expect(() => loadTerms(file)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("공백·빈 줄·1자 줄만 있으면 throw", () => {
    const { dir, file } = tmpFile("\n  \r\n x \n");
    try {
      expect(() => loadTerms(file)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("UTF-8 이 아니면 throw", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-terms-"));
    const file = path.join(dir, "terms.txt");
    fs.writeFileSync(file, Buffer.concat([CP949_TERM, Buffer.from("\n")]));
    try {
      expect(() => loadTerms(file)).toThrow(/UTF-8/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("CRLF·공백·빈 줄을 정리해 읽는다", () => {
    const { dir, file } = tmpFile(`  ${TERM}  \r\n\r\n${HANGUL_TERM}\r\n`);
    try {
      expect(loadTerms(file)).toEqual([TERM, HANGUL_TERM]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("expansion-prepush-check CLI", () => {
  const script = process.env.PREPUSH_SRC_FOR_MUTATION ?? path.resolve(__dirname, "../expansion-prepush-check.mjs");
  const GUARD = path.resolve(__dirname, "../commit-guard.mjs");
  // 호스트 git 설정을 물려받지 않는다: 빈 전역 설정 파일·시스템 설정 끔·임시 HOME(push 테스트와 같은 격리).
  let isoRoot = "";
  let isoHome = "";
  let isoCfg = "";
  beforeAll(() => {
    isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-iso-"));
    isoHome = path.join(isoRoot, "home");
    fs.mkdirSync(isoHome);
    isoCfg = path.join(isoRoot, "gitconfig");
    fs.writeFileSync(isoCfg, "");
  });
  afterAll(() => fs.rmSync(isoRoot, { recursive: true, force: true }));
  const isoEnv = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? "",
    HOME: isoHome,
    GIT_CONFIG_GLOBAL: isoCfg,
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  });
  const gitEnv = (env: Record<string, string>, cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, encoding: "utf8", env: isoEnv(env) });
  const git = (cwd: string, ...a: string[]) => gitEnv({}, cwd, ...a);
  const run = (cwd: string, ...args: string[]) => spawnSync("node", [script, ...args], { cwd, encoding: "utf8", env: isoEnv() });
  const runEnv = (env: Record<string, string>, cwd: string, ...args: string[]) =>
    spawnSync("node", [script, ...args], { cwd, encoding: "utf8", env: isoEnv(env) });

  function setup(opts: { branch?: string; fileBody?: string; message?: string; fileName?: string } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepush-"));
    const dir = path.join(root, "repo dir");
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", opts.branch ?? "exp/ok-branch");
    fs.writeFileSync(path.join(dir, opts.fileName ?? "a.txt"), opts.fileBody ?? "base\nclean line\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", opts.message ?? "feat: clean change");
    const terms = path.join(root, "terms.txt");
    fs.writeFileSync(terms, `${TERM}\n`, { mode: 0o600 });
    return { root, dir, terms };
  }
  const cleanup = (root: string) => fs.rmSync(root, { recursive: true, force: true });

  it("깨끗하면 exit 0 (공백 든 경로·심볼릭 링크 실행)", () => {
    const { root, dir, terms } = setup();
    try {
      const link = path.join(root, "link.mjs");
      fs.symlinkSync(script, link);
      const r = spawnSync("node", [link, "main", terms], { cwd: dir, encoding: "utf8", env: isoEnv() });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^OK:/m);
    } finally {
      cleanup(root);
    }
  });

  it("추가 줄에 term 이 있으면 exit 1, 출력에 term 원문 없음", () => {
    const { root, dir, terms } = setup({ fileBody: `base\nmemo ${TERM.toUpperCase()} here\n` });
    try {
      const r = run(dir, "main", terms);
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`.toLowerCase()).not.toContain(TERM);
      expect(r.stderr).toMatch(/added diff lines: 금지어 1종/);
    } finally {
      cleanup(root);
    }
  });

  it("삭제 줄의 term 은 추가가 아니므로 통과", () => {
    const { root, dir, terms } = setup();
    try {
      // base 에 term 이 있었고 브랜치가 지우는 경우
      git(dir, "checkout", "-q", "main");
      fs.writeFileSync(path.join(dir, "a.txt"), `base ${TERM}\n`);
      git(dir, "commit", "-qam", "base with term");
      git(dir, "checkout", "-q", "-b", "exp/removes-term");
      fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
      git(dir, "commit", "-qam", "feat: remove");
      expect(run(dir, "main", terms).status).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  it("커밋 메시지에 term 이 있으면 exit 1, 출력에 term 없음", () => {
    const { root, dir, terms } = setup({ message: `feat: for ${TERM}` });
    try {
      const r = run(dir, "main", terms);
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`.toLowerCase()).not.toContain(TERM);
    } finally {
      cleanup(root);
    }
  });

  it("파일 이름에 term 이 있으면 exit 1", () => {
    const { root, dir, terms } = setup({ fileName: `${TERM}-notes.txt` });
    try {
      const r = run(dir, "main", terms);
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`.toLowerCase()).not.toContain(TERM);
    } finally {
      cleanup(root);
    }
  });

  it("나쁜 브랜치명이면 exit 1", () => {
    const { root, dir, terms } = setup({ branch: "feature/foo" });
    try {
      expect(run(dir, "main", terms).status).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it("detached HEAD 면 exit 1", () => {
    const { root, dir, terms } = setup();
    try {
      git(dir, "checkout", "-q", "--detach");
      expect(run(dir, "main", terms).status).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it("terms 파일이 없으면 exit 1 (fail-closed)", () => {
    const { root, dir } = setup();
    try {
      const r = run(dir, "main", path.join(root, "missing.txt"));
      expect(r.status).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it("terms 파일이 비었으면 exit 1 (fail-closed)", () => {
    const { root, dir } = setup();
    try {
      const empty = path.join(root, "empty.txt");
      fs.writeFileSync(empty, "");
      expect(run(dir, "main", empty).status).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it("없는 base ref 는 exit 1", () => {
    const { root, dir, terms } = setup();
    try {
      expect(run(dir, "no-such-ref", terms).status).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  const blocked = (r: { status: number | null; stdout: string; stderr: string }) => {
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`.toLowerCase()).not.toContain(TERM);
    expect(`${r.stdout}${r.stderr}`).not.toContain(HANGUL_TERM);
  };

  it("I1: 추가된 바이너리(.png/.xlsx 류)는 내용 불문 차단", () => {
    const { root, dir, terms } = setup();
    try {
      fs.writeFileSync(path.join(dir, "sheet.xlsx"), Buffer.from([0x50, 0x4b, 0, 1, 2, 0, 0xff, 0xfe, 0]));
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "feat: add blob");
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(/binary changes: 1건/);
    } finally {
      cleanup(root);
    }
  });

  it("I1: .gitattributes 로 -diff 처리된 텍스트 파일도 차단", () => {
    const { root, dir, terms } = setup();
    try {
      fs.writeFileSync(path.join(dir, ".gitattributes"), "*.dat -diff\n");
      fs.writeFileSync(path.join(dir, "x.dat"), "plain text\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "feat: add dat");
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(/\.gitattributes changes: 1건/);
    } finally {
      cleanup(root);
    }
  });

  it("저장소 설정 diff.<drv>.textconv 가 금지어를 가려도 원문으로 잡는다", () => {
    const { root, dir, terms } = setup();
    try {
      git(dir, "config", "diff.hide.textconv", `sed s/${TERM}/xxx/`);
      // 속성은 $GIT_DIR/info/attributes 에 둔다 — 설정으로 중화할 수 없는 자리라 --no-textconv 만이 막는다.
      fs.writeFileSync(path.join(dir, ".git/info/attributes"), "*.txt diff=hide\n");
      fs.writeFileSync(path.join(dir, "a.txt"), `base\nmemo ${TERM} here\n`);
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "feat: memo");
      // 대조군: 이 설정에서 그냥 git log -p 는 금지어를 못 본다(textconv 가 실제로 작동한다).
      expect(git(dir, "log", "-p", "-U0", "--format=", "main..HEAD")).not.toContain(TERM);
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(/added diff lines: 금지어 1종/);
    } finally {
      cleanup(root);
    }
  });

  // 속성으로 diff 를 강제한 압축 파일: numstat 은 텍스트로 보고 압축이라 추가 줄에도 금지어가 안 보인다 — 내용 검사만 잡는다.
  const commitGzip = (dir: string) => {
    fs.writeFileSync(path.join(dir, "z.dat"), zlib.gzipSync(Buffer.from(`memo ${TERM} here\n`)));
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "feat: data");
  };
  const BINARY_REASON = /binary content \(NUL·압축\/컨테이너 서명\): 1건/;
  it("C1: 브랜치가 .gitattributes 로 *.dat diff 를 커밋해도 압축 파일을 차단", () => {
    const { root, dir, terms } = setup();
    try {
      fs.writeFileSync(path.join(dir, ".gitattributes"), "*.dat diff\n");
      commitGzip(dir);
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(BINARY_REASON);
    } finally {
      cleanup(root);
    }
  });
  it("C2: 상속된 전역 core.attributesFile 이 *.dat diff 여도 압축 파일을 차단", () => {
    const { root, dir, terms } = setup();
    try {
      const attrs = path.join(root, "global-attributes");
      fs.writeFileSync(attrs, "*.dat diff\n");
      const gcfg = path.join(root, "global-gitconfig");
      fs.writeFileSync(gcfg, `[core]\n\tattributesFile = ${attrs}\n`);
      commitGzip(dir);
      // 대조군: 그 전역 설정 아래 그냥 numstat 은 텍스트로 보고한다(속성이 실제로 작동한다).
      const plain = spawnSync("git", ["log", "--numstat", "--format=", "main..HEAD"], {
        cwd: dir,
        encoding: "utf8",
        env: isoEnv({ GIT_CONFIG_GLOBAL: gcfg }),
      });
      expect(plain.stdout).not.toMatch(/^-\t-\t/m);
      const r = runEnv({ GIT_CONFIG_GLOBAL: gcfg }, dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(BINARY_REASON);
    } finally {
      cleanup(root);
    }
  });
  it("C3: diff.x.binary=false + info/attributes 의 *.dat diff=x 여도 압축 파일을 차단", () => {
    const { root, dir, terms } = setup();
    try {
      git(dir, "config", "diff.x.binary", "false");
      fs.writeFileSync(path.join(dir, ".git/info/attributes"), "*.dat diff=x\n");
      commitGzip(dir);
      expect(git(dir, "log", "--numstat", "--format=", "main..HEAD")).not.toMatch(/^-\t-\t/m);
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(BINARY_REASON);
    } finally {
      cleanup(root);
    }
  });
  it("zip 서명으로 시작하는 파일(NUL 없음)도 차단", () => {
    const { root, dir, terms } = setup();
    try {
      fs.writeFileSync(path.join(dir, "book.dat"), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("plain tail\n")]));
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "feat: book");
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(BINARY_REASON);
    } finally {
      cleanup(root);
    }
  });
  it("NUL 없는 평문 .dat 은 통과", () => {
    const { root, dir, terms } = setup();
    try {
      fs.writeFileSync(path.join(dir, "notes.dat"), "plain text only\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "feat: notes");
      const r = run(dir, "main", terms);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^OK:/m);
    } finally {
      cleanup(root);
    }
  });
  it(".gitattributes 수정도 차단(개수만)", () => {
    const { root, dir, terms } = setup();
    try {
      git(dir, "checkout", "-q", "main");
      fs.writeFileSync(path.join(dir, ".gitattributes"), "*.md text\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "base attrs");
      git(dir, "checkout", "-q", "-b", "exp/attr-edit");
      fs.writeFileSync(path.join(dir, ".gitattributes"), "*.md text\n*.txt text\n");
      git(dir, "commit", "-qam", "chore: attrs");
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(/\.gitattributes changes: 1건/);
    } finally {
      cleanup(root);
    }
  });
  it("서브모듈(gitlink) 추가는 점검 불가라 차단", () => {
    const { root, dir, terms } = setup();
    try {
      const head = git(dir, "rev-parse", "HEAD").trim();
      git(dir, "update-index", "--add", "--cacheinfo", `160000,${head},vendored`);
      git(dir, "commit", "-qm", "feat: link");
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(/submodule \(gitlink\) changes: 1건/);
    } finally {
      cleanup(root);
    }
  });

  it("I2: 한 커밋에서 넣고 다음 커밋에서 지워도 차단(이력에 남는다)", () => {
    const { root, dir, terms } = setup();
    try {
      fs.writeFileSync(path.join(dir, "a.txt"), `base\nleak ${TERM}\n`);
      git(dir, "commit", "-qam", "feat: add");
      fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
      git(dir, "commit", "-qam", "feat: remove");
      blocked(run(dir, "main", terms));
    } finally {
      cleanup(root);
    }
  });

  it("I3: 내용이 ++ 로 시작하는 추가 줄도 검사", () => {
    const { root, dir, terms } = setup({ fileBody: `base\n++ ${TERM}\n` });
    try {
      blocked(run(dir, "main", terms));
    } finally {
      cleanup(root);
    }
    const d = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -0,0 +1 @@", "+++ secret"].join("\n");
    expect(addedLines(d)).toBe("++ secret");
  });

  it("I4: 한글 파일명의 한글 금지어를 잡는다", () => {
    const { root, dir, terms } = setup({ fileName: `${HANGUL_TERM}-메모.txt` });
    try {
      fs.writeFileSync(terms, `${HANGUL_TERM}\n`);
      blocked(run(dir, "main", terms));
    } finally {
      cleanup(root);
    }
  });

  it("머지 커밋은 점검 불가라 차단", () => {
    const { root, dir, terms } = setup();
    try {
      git(dir, "checkout", "-q", "main");
      fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "main moves");
      git(dir, "checkout", "-q", "exp/ok-branch");
      git(dir, "merge", "-q", "--no-ff", "-m", "merge main", "main");
      const r = run(dir, "main~1", terms);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/merge commits/);
    } finally {
      cleanup(root);
    }
  });

  it("브랜치명에 term 이 있으면 exit 1, 출력에 term 없음", () => {
    const { root, dir, terms } = setup({ branch: `exp/${TERM}-fix` });
    try {
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(/branch: 금지어 1종/);
    } finally {
      cleanup(root);
    }
  });

  it("--title-file 에 term 이 있으면 exit 1, 출력에 term 없음", () => {
    const { root, dir, terms } = setup();
    try {
      const t = path.join(root, "title.txt");
      fs.writeFileSync(t, `feat: ${TERM.toUpperCase()} support\n`);
      const r = run(dir, "main", terms, "--title-file", t);
      blocked(r);
      expect(r.stderr).toMatch(/PR title: 금지어 1종/);
    } finally {
      cleanup(root);
    }
  });

  it("--title-file 이 깨끗하면 통과", () => {
    const { root, dir, terms } = setup();
    try {
      const t = path.join(root, "title.txt");
      fs.writeFileSync(t, "feat: clean title\n");
      const r = run(dir, "main", terms, "--title-file", t);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^OK:.*PR 제목/m);
    } finally {
      cleanup(root);
    }
  });

  it("--title-file 이 없는 파일이면 exit 1 (fail-closed)", () => {
    const { root, dir, terms } = setup();
    try {
      const r = run(dir, "main", terms, "--title-file", path.join(root, "nope.txt"));
      expect(r.status).toBe(1);
      expect(r.stdout).not.toMatch(/^OK:/m);
    } finally {
      cleanup(root);
    }
  });

  it("--title-file 값이 없으면 사용법 오류 exit 2", () => {
    const { root, dir, terms } = setup();
    try {
      expect(run(dir, "main", terms, "--title-file").status).toBe(2);
    } finally {
      cleanup(root);
    }
  });

  it.each(["zxq_holder", "zxq.holder", "zxq holder"])("브랜치명 exp/zxq-holder-fix 는 구분자 변형 term %j 로도 차단", (term) => {
    const { root, dir, terms } = setup({ branch: "exp/zxq-holder-fix" });
    try {
      fs.writeFileSync(terms, `${term}\n`);
      const r = run(dir, "main", terms);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/branch: 금지어 1종/);
      expect(`${r.stdout}${r.stderr}`).not.toContain("holder");
    } finally {
      cleanup(root);
    }
  });

  it("PR 제목 Zxq-Holder 개선 은 term 'zxq holder' 로 차단", () => {
    const { root, dir, terms } = setup();
    try {
      fs.writeFileSync(terms, "zxq holder\n");
      const t = path.join(root, "title.txt");
      fs.writeFileSync(t, "Zxq-Holder 개선\n");
      const r = run(dir, "main", terms, "--title-file", t);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/PR title: 금지어 1종/);
    } finally {
      cleanup(root);
    }
  });

  it("깨끗한 브랜치는 구분자 변형 term 이 있어도 통과", () => {
    const { root, dir, terms } = setup();
    try {
      fs.writeFileSync(terms, "zxq holder\nzxq_holder\n");
      expect(run(dir, "main", terms).status).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  it("--title-file 중복이면 사용법 오류 exit 2", () => {
    const { root, dir, terms } = setup();
    try {
      const t = path.join(root, "title.txt");
      fs.writeFileSync(t, "feat: x\n");
      expect(run(dir, "main", terms, "--title-file", t, "--title-file", t).status).toBe(2);
    } finally {
      cleanup(root);
    }
  });

  it("커밋 메시지의 구분자 변형도 차단(느슨한 대조)", () => {
    const { root, dir, terms } = setup({ message: "feat: zxq-holder 정리" });
    try {
      fs.writeFileSync(terms, "zxq holder\n");
      const r = run(dir, "main", terms);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/commit messages: 금지어 1종/);
      expect(`${r.stdout}${r.stderr}`).not.toContain("holder");
    } finally {
      cleanup(root);
    }
  });

  it("변경 경로의 구분자 변형도 차단(느슨한 대조)", () => {
    const { root, dir, terms } = setup({ fileName: "zxq_holder-notes.txt" });
    try {
      fs.writeFileSync(terms, "zxq holder\n");
      const r = run(dir, "main", terms);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/changed file paths: 금지어 1종/);
    } finally {
      cleanup(root);
    }
  });

  it("인자가 모자라면 사용법과 exit 2", () => {
    const r = spawnSync("node", [script, "main"], { encoding: "utf8", env: isoEnv() });
    expect(r.status).toBe(2);
  });

  // ── AA: 고아 루트·log.showRoot·diff.relative ──
  it("AA: 상속된 log.showRoot=false + 고아 루트 커밋이어도 차단(공통 조상 없음 + 추가 줄)", () => {
    const { root, dir, terms } = setup();
    try {
      git(dir, "checkout", "-q", "--orphan", "exp/orphan-root");
      git(dir, "rm", "-rqf", ".");
      fs.writeFileSync(path.join(dir, "b.txt"), `memo ${TERM} here\n`);
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "feat: orphan");
      const gcfg = path.join(root, "showroot-gitconfig");
      fs.writeFileSync(gcfg, "[log]\n\tshowRoot = false\n");
      // 대조군: 그 설정 아래 그냥 git log -p 는 루트 커밋의 추가 줄을 안 보인다.
      expect(gitEnv({ GIT_CONFIG_GLOBAL: gcfg }, dir, "log", "-p", "--format=", "main..HEAD")).not.toContain(TERM);
      const r = runEnv({ GIT_CONFIG_GLOBAL: gcfg }, dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(/orphan: base 와 공통 조상이 없다/);
      expect(r.stderr).toMatch(/added diff lines: 금지어 1종/);
    } finally {
      cleanup(root);
    }
  });

  it("AA: diff.relative=true 저장소를 하위 폴더에서 돌려도 상위 경로의 추가 줄을 잡는다", () => {
    const { root, dir, terms } = setup({ fileBody: `base\nmemo ${TERM} here\n` });
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "sub/keep.txt"), "keep\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "feat: sub");
      git(dir, "config", "diff.relative", "true");
      const sub = path.join(dir, "sub");
      // 대조군: 하위 폴더에서 그냥 git log -p 는 상위 파일의 추가 줄을 안 보인다.
      expect(git(sub, "log", "-p", "--format=", "main..HEAD")).not.toContain(TERM);
      const r = run(sub, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(/added diff lines: 금지어 1종/);
    } finally {
      cleanup(root);
    }
  });

  // ── I1: replace ref ──
  it("I1: git replace 로 누출 커밋을 깨끗한 커밋으로 가려도 차단", () => {
    const { root, dir, terms } = setup({ fileBody: `base\nmemo ${TERM} here\n`, message: "feat: memo" });
    try {
      const leak = git(dir, "rev-parse", "HEAD").trim();
      git(dir, "checkout", "-q", "-b", "tmp-clean", "main");
      fs.writeFileSync(path.join(dir, "a.txt"), "base\nclean line\n");
      git(dir, "commit", "-qam", "feat: memo");
      const clean = git(dir, "rev-parse", "HEAD").trim();
      git(dir, "checkout", "-q", "exp/ok-branch");
      git(dir, "branch", "-q", "-D", "tmp-clean");
      git(dir, "replace", leak, clean);
      // 대조군: replace 가 걸린 채 그냥 git log -p 는 금지어를 못 본다.
      expect(git(dir, "log", "-p", "--format=", "main..HEAD")).not.toContain(TERM);
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(/added diff lines: 금지어 1종/);
    } finally {
      cleanup(root);
    }
  });

  // ── I2: UTF-8 이 아닌 내용 ──
  const NON_UTF8 = /non-UTF-8 content: 1건/;
  it("I2: CP949 로 쓴 한글 금지어 파일은 차단(개수만)", () => {
    expect(new TextDecoder("euc-kr").decode(CP949_TERM)).toBe(HANGUL_TERM);
    const { root, dir, terms } = setup();
    try {
      fs.writeFileSync(terms, `${HANGUL_TERM}\n`);
      fs.writeFileSync(path.join(dir, "cp.txt"), Buffer.concat([Buffer.from("memo "), CP949_TERM, Buffer.from("\n")]));
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "feat: cp");
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(NON_UTF8);
      expect(r.stderr).not.toMatch(/added diff lines/);
    } finally {
      cleanup(root);
    }
  });
  it("I2: CP949 금지어 파일은 BLOCKED(fail-closed)", () => {
    const { root, dir, terms } = setup();
    try {
      fs.writeFileSync(terms, Buffer.concat([CP949_TERM, Buffer.from("\n")]));
      const r = run(dir, "main", terms);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("금지어 파일이 UTF-8 이 아니다");
    } finally {
      cleanup(root);
    }
  });
  it("I2: CP949 커밋 메시지는 차단", () => {
    const { root, dir, terms } = setup();
    try {
      // git commit 은 UTF-8 이 아닌 메시지를 latin1 로 보고 UTF-8 로 바꿔 저장한다 — 원 바이트 커밋은 객체를 직접 쓴다.
      const tree = git(dir, "rev-parse", "HEAD^{tree}").trim();
      const head = git(dir, "rev-parse", "HEAD").trim();
      const who = "t <t@example.com> 1700000000 +0000";
      const body = Buffer.concat([
        Buffer.from(`tree ${tree}\nparent ${head}\nauthor ${who}\ncommitter ${who}\n\nfeat: `),
        CP949_TERM,
        Buffer.from("\n"),
      ]);
      const commit = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: dir, input: body, env: isoEnv() })
        .toString()
        .trim();
      git(dir, "update-ref", "HEAD", commit);
      // 대조군: 저장된 메시지는 정말 UTF-8 이 아니다.
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(execFileSync("git", ["cat-file", "commit", commit], { cwd: dir, env: isoEnv() }))).toThrow();
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(NON_UTF8);
    } finally {
      cleanup(root);
    }
  });
  it("I2: CP949 PR 제목 파일은 차단", () => {
    const { root, dir, terms } = setup();
    try {
      const t = path.join(root, "title.txt");
      fs.writeFileSync(t, Buffer.concat([Buffer.from("feat: "), CP949_TERM, Buffer.from("\n")]));
      const r = run(dir, "main", terms, "--title-file", t);
      blocked(r);
      expect(r.stderr).toMatch(NON_UTF8);
    } finally {
      cleanup(root);
    }
  });
  it("I2: UTF-8 이 아닌 경로 이름은 차단", () => {
    const { root, dir, terms } = setup();
    try {
      // 맥 파일시스템은 이런 이름을 못 만든다 — 트리를 직접 만든다.
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, input: "x\n", env: isoEnv() }).toString().trim();
      const baseTree = git(dir, "rev-parse", "HEAD^{tree}").trim();
      const entries = execFileSync("git", ["ls-tree", "-z", baseTree], { cwd: dir, env: isoEnv() });
      const extra = Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), CP949_TERM, Buffer.from(".txt\0")]);
      const tree = execFileSync("git", ["mktree", "-z"], { cwd: dir, input: Buffer.concat([entries, extra]), env: isoEnv() })
        .toString()
        .trim();
      const commit = git(dir, "commit-tree", tree, "-p", "HEAD", "-m", "feat: odd name").trim();
      git(dir, "update-ref", "HEAD", commit); // 작업 트리는 건드리지 않는다(점검기는 커밋만 본다).
      const r = run(dir, "main", terms);
      blocked(r);
      expect(r.stderr).toMatch(NON_UTF8);
    } finally {
      cleanup(root);
    }
  });

  // ── I3: --guard(커밋 가드)·금액 ──
  const guardOut = (r: { stdout: string; stderr: string }) => `${r.stdout}${r.stderr}`;
  it("I3: --guard 와 함께 추가 줄의 키 형태를 차단, 원문은 출력하지 않는다", () => {
    const { root, dir, terms } = setup({ fileBody: `base\nconst k = "${FAKE_KEY}";\n` });
    try {
      const r = run(dir, "main", terms, "--guard", GUARD);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/commit-guard \(시크릿·이메일·주민번호 형태\): 1건/);
      expect(guardOut(r)).not.toContain(FAKE_KEY.slice(3));
    } finally {
      cleanup(root);
    }
  });
  it("I3: --guard 와 함께 추가 줄의 이메일·금액 표기를 차단", () => {
    const { root, dir, terms } = setup({ fileBody: `base\ncontact ${FAKE_EMAIL}\n정산 ${FAKE_FIGURE}\n` });
    try {
      const r = run(dir, "main", terms, "--guard", GUARD);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/commit-guard \(시크릿·이메일·주민번호 형태\): 1건/);
      expect(r.stderr).toMatch(/currency figures \(금액 표기\): 1건/);
      expect(guardOut(r)).not.toContain(FAKE_EMAIL);
      expect(guardOut(r)).not.toContain(FAKE_FIGURE);
    } finally {
      cleanup(root);
    }
  });
  it("I3: --guard 와 함께 커밋 메시지의 이메일을 차단", () => {
    const { root, dir, terms } = setup({ message: `feat: contact ${FAKE_EMAIL}` });
    try {
      const r = run(dir, "main", terms, "--guard", GUARD);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/commit-guard \(시크릿·이메일·주민번호 형태\): 1건/);
      expect(guardOut(r)).not.toContain(FAKE_EMAIL);
    } finally {
      cleanup(root);
    }
  });
  it("I3: --guard 와 함께 PR 제목의 금액 표기를 차단", () => {
    const { root, dir, terms } = setup();
    try {
      const t = path.join(root, "title.txt");
      fs.writeFileSync(t, `feat: 정산 ${FAKE_FIGURE} 반영\n`);
      const r = run(dir, "main", terms, "--title-file", t, "--guard", GUARD);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/currency figures \(금액 표기\): 1건/);
      expect(guardOut(r)).not.toContain(FAKE_FIGURE);
    } finally {
      cleanup(root);
    }
  });
  it("I3: --guard 와 함께 깨끗하면 통과하고 OK 줄에 표지가 붙는다", () => {
    const { root, dir, terms } = setup();
    try {
      const t = path.join(root, "title.txt");
      fs.writeFileSync(t, "feat: clean title\n");
      const r = run(dir, "main", terms, "--title-file", t, "--guard", GUARD);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^OK:.*PR 제목·커밋 가드·금액/m);
    } finally {
      cleanup(root);
    }
  });
  it("I3: --guard 없이는 예전 동작 그대로(키 형태도 통과, OK 줄 형식 그대로)", () => {
    const { root, dir, terms } = setup({ fileBody: `base\nconst k = "${FAKE_KEY}";\n` });
    try {
      const t = path.join(root, "title.txt");
      fs.writeFileSync(t, "feat: clean title\n");
      const r = run(dir, "main", terms, "--title-file", t);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^OK: 브랜치명\(형식·금지어\)·커밋 메시지·커밋별 추가 줄·경로·바이너리·머지·PR 제목 점검 통과/m);
      expect(r.stdout).not.toContain("커밋 가드");
    } finally {
      cleanup(root);
    }
  });
  it("I3: --guard 파일이 없으면 BLOCKED(fail-closed)", () => {
    const { root, dir, terms } = setup();
    try {
      const r = run(dir, "main", terms, "--guard", path.join(root, "missing-guard.mjs"));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("커밋 가드를 불러올 수 없다");
      expect(r.stdout).not.toMatch(/^OK:/m);
    } finally {
      cleanup(root);
    }
  });
  it("I3: --guard 파일에 scanText 가 없으면 BLOCKED", () => {
    const { root, dir, terms } = setup();
    try {
      const g = path.join(root, "guard.mjs");
      fs.writeFileSync(g, "export const other = 1;\n");
      const r = run(dir, "main", terms, "--guard", g);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("scanText 가 없다");
    } finally {
      cleanup(root);
    }
  });
  it("I3: --guard 값이 없거나 중복이면 사용법 오류 exit 2", () => {
    const { root, dir, terms } = setup();
    try {
      expect(run(dir, "main", terms, "--guard").status).toBe(2);
      expect(run(dir, "main", terms, "--guard", GUARD, "--guard", GUARD).status).toBe(2);
    } finally {
      cleanup(root);
    }
  });
});
