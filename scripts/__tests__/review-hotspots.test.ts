import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HOTSPOT_RULES, selectHotspots } from "../review-hotspots.mjs";

type Hotspot = { file: string; hunk: string; ruleIds: string[]; lines: number };

function diffFor(file: string, body: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,3 +1,3 @@`,
    ...body,
    "",
  ].join("\n");
}

describe("review-hotspots — 위험 hunk 선별", () => {
  it("규칙 목록에 필수 id 가 모두 있다", () => {
    const ids = HOTSPOT_RULES.map((r: { id: string }) => r.id);
    for (const id of [
      "schema",
      "money",
      "auth",
      "external-effect",
      "seller-facing",
      "tx",
      "state-transition",
      "guard-weaken",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("prisma/schema.prisma hunk 는 schema 규칙에 걸린다", () => {
    const r = selectHotspots(diffFor("prisma/schema.prisma", ["-  a String", "+  a String?"]));
    expect(r.hotspots).toHaveLength(1);
    expect(r.hotspots[0].ruleIds).toContain("schema");
  });

  it("문구만 바뀐 일반 컴포넌트 hunk 는 선별되지 않는다", () => {
    const r = selectHotspots(
      diffFor("src/components/foo.tsx", ['-  <p>안녕</p>', '+  <p>반갑습니다</p>']),
    );
    expect(r.hotspots).toHaveLength(0);
    expect(r.oversize).toBe(false);
  });

  it("삭제된 줄에 가드(throw/if (!)가 있으면 guard-weaken", () => {
    const r = selectHotspots(
      diffFor("src/components/foo.tsx", ["-  if (!ok) throw new Error('bad');", "+  doIt();"]),
    );
    expect(r.hotspots).toHaveLength(1);
    expect(r.hotspots[0].ruleIds).toContain("guard-weaken");
  });

  it("320줄 money hunk 는 oversize", () => {
    const body = Array.from({ length: 320 }, (_, i) => `+  const v${i} = 1;`);
    const r = selectHotspots(diffFor("src/lib/settlement-status.ts", body));
    expect(r.hotspots[0].ruleIds).toContain("money");
    expect(r.totalLines).toBeGreaterThan(300);
    expect(r.oversize).toBe(true);
  });

  it("extra hunk 는 규칙과 무관하게 포함되고, 규칙 hunk 는 extra 로 빠지지 않는다", () => {
    const diff =
      diffFor("prisma/schema.prisma", ["+  b Int"]) +
      diffFor("src/components/foo.tsx", ["-  x", "+  y"]);
    const extra = [{ file: "src/components/foo.tsx", hunk: "@@ -1 +1 @@\n-  x\n+  y" }];
    const r = selectHotspots(diff, extra);
    const files = r.hotspots.map((h: Hotspot) => h.file);
    expect(files).toContain("prisma/schema.prisma");
    expect(files).toContain("src/components/foo.tsx");
    const withoutExtra = selectHotspots(diff, []);
    expect(withoutExtra.hotspots.map((h: Hotspot) => h.file)).toContain("prisma/schema.prisma");
    // extra 로만 들어온 hunk 는 ruleIds 가 비어 있어도 남는다
    const extraOnly = r.hotspots.find((h: Hotspot) => h.file === "src/components/foo.tsx");
    expect(extraOnly?.ruleIds).toEqual([]);
  });

  it("다른 규칙 신호: tx, external-effect, state-transition, seller-facing, auth", () => {
    const cases: Array<[string, string, string]> = [
      ["src/lib/x.ts", "+  await prisma.$transaction(async (t) => {})", "tx"],
      ["src/lib/x.ts", "+  await sendMail({ to })", "external-effect"],
      ["src/lib/x.ts", "+  if (!canTransition(a, b)) return", "state-transition"],
      ["src/lib/seller-portal.ts", "+  const a = 1", "seller-facing"],
      ["src/components/portal/seller-performance-card.tsx", "+  const a = 1", "seller-facing"],
      ["src/lib/auth-roles.ts", "+  const a = 1", "auth"],
    ];
    for (const [file, line, id] of cases) {
      const r = selectHotspots(diffFor(file, [line]));
      expect(r.hotspots[0]?.ruleIds, `${file} ${id}`).toContain(id);
    }
  });

  it("external-effect: fetch POST 변형(따옴표·대소문자·여러 줄 옵션)", () => {
    const bodies = [
      ["+  await fetch(url, { method: 'POST', body })"],
      ['+  await fetch(url, { method: "post" })'],
      ["+  await fetch(url, {", "+    headers: {},", '+    method: "POST",', "+  })"],
    ];
    for (const b of bodies) {
      const r = selectHotspots(diffFor("src/lib/x.ts", b));
      expect(r.hotspots[0]?.ruleIds).toContain("external-effect");
    }
    const get = selectHotspots(diffFor("src/lib/x.ts", ["+  await fetch(url)"]));
    expect(get.hotspots).toHaveLength(0);
  });

  it("규칙 id 는 선언 배열에 한 번씩만 있다", () => {
    const ids = HOTSPOT_RULES.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("money: 경로(vat/commission/margin/hometax)와 대소문자 무관 내용 신호", () => {
    for (const f of ["src/lib/vat.ts", "src/lib/commission.ts", "src/lib/margin-calc.ts", "src/lib/hometax-text.ts"]) {
      expect(selectHotspots(diffFor(f, ["+  const a = 1"])).hotspots[0]?.ruleIds).toContain("money");
    }
    for (const line of ["+  calculateSettlement(rows)", "+  const totalAmount = a + b", "+  const Fee = 3", "+  SettlementRow x"]) {
      expect(selectHotspots(diffFor("src/lib/x.ts", [line])).hotspots[0]?.ruleIds, line).toContain("money");
    }
  });

  it("auth: src/app/api/auth/**, src/lib/auth.ts, 가드 함수 호출", () => {
    for (const f of ["src/app/api/auth/login/route.ts", "src/lib/auth.ts"]) {
      expect(selectHotspots(diffFor(f, ["+  const a = 1"])).hotspots[0]?.ruleIds).toContain("auth");
    }
    for (const line of ["+  const s = await getServerSession()", "+  const a = await requireAuth()", "+  await requireRole('admin')", "+  if (!verifyCronAuth(req)) return"]) {
      expect(selectHotspots(diffFor("src/app/api/x/route.ts", [line])).hotspots[0]?.ruleIds, line).toContain("auth");
    }
  });

  it("@@ 없는 블록(순수 이름 변경·바이너리)도 경로 규칙으로 선별된다", () => {
    const rename = [
      "diff --git a/docs/old.sql b/prisma/migrations/2026_x/migration.sql",
      "similarity index 100%",
      "rename from docs/old.sql",
      "rename to prisma/migrations/2026_x/migration.sql",
      "",
    ].join("\n");
    const r = selectHotspots(rename);
    expect(r.hotspots).toHaveLength(1);
    expect(r.hotspots[0].file).toBe("prisma/migrations/2026_x/migration.sql");
    expect(r.hotspots[0].ruleIds).toContain("schema");
    const bin = "diff --git a/src/lib/vat.ts b/src/lib/vat.ts\nold mode 100644\nnew mode 100755\n";
    expect(selectHotspots(bin).hotspots[0]?.ruleIds).toContain("money");
    const plain = "diff --git a/img/a.png b/img/a.png\nBinary files a/img/a.png and b/img/a.png differ\n";
    expect(selectHotspots(plain).hotspots).toHaveLength(0);
  });

  it("파일당 여러 hunk 는 각각 나뉘고 lines 가 정확하다", () => {
    const d = [
      "diff --git a/prisma/schema.prisma b/prisma/schema.prisma",
      "--- a/prisma/schema.prisma",
      "+++ b/prisma/schema.prisma",
      "@@ -1,2 +1,3 @@",
      " ctx",
      "+a",
      "+b",
      "@@ -20,2 +21,2 @@",
      "-c",
      "+d",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const r = selectHotspots(d);
    expect(r.hotspots.map((h: Hotspot) => h.lines)).toEqual([3, 3]);
    expect(r.totalLines).toBe(6);
  });

  it("삭제된 파일 diff 도 파일 경로를 잡는다", () => {
    const d = [
      "diff --git a/src/lib/vat.ts b/src/lib/vat.ts",
      "deleted file mode 100644",
      "--- a/src/lib/vat.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-export const a = 1;",
      "-export const b = 2;",
      "",
    ].join("\n");
    const r = selectHotspots(d);
    expect(r.hotspots[0].file).toBe("src/lib/vat.ts");
    expect(r.hotspots[0].ruleIds).toContain("money");
  });

  it("extra 가 규칙 hunk 와 같으면 중복 없이 ruleIds 를 보존한다", () => {
    const diff = diffFor("prisma/schema.prisma", ["+  b Int"]);
    const base = selectHotspots(diff);
    const r = selectHotspots(diff, [{ file: base.hotspots[0].file, hunk: base.hotspots[0].hunk }]);
    expect(r.hotspots).toHaveLength(1);
    expect(r.hotspots[0].ruleIds).toContain("schema");
  });

  it("추가된 throw 는 guard-weaken 이 아니다", () => {
    const r = selectHotspots(diffFor("src/components/foo.tsx", ["+  if (!ok) throw new Error('x');"]));
    expect(r.hotspots).toHaveLength(0);
  });
});

describe("review-hotspots CLI", () => {
  const script = process.env.HOTSPOTS_SRC_FOR_MUTATION ?? path.resolve(__dirname, "../review-hotspots.mjs");
  // 호스트 git 설정을 물려받지 않는다(빈 전역 설정·시스템 설정 끔·임시 HOME).
  let isoRoot = "";
  let isoHome = "";
  let isoCfg = "";
  beforeAll(() => {
    isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hotspots-iso-"));
    isoHome = path.join(isoRoot, "home");
    fs.mkdirSync(isoHome);
    isoCfg = path.join(isoRoot, "gitconfig");
    fs.writeFileSync(isoCfg, "");
  });
  afterAll(() => fs.rmSync(isoRoot, { recursive: true, force: true }));
  const isoEnv = () => ({ PATH: process.env.PATH ?? "", HOME: isoHome, GIT_CONFIG_GLOBAL: isoCfg, GIT_CONFIG_NOSYSTEM: "1" });
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd, encoding: "utf8", env: isoEnv() });
  const runCli = (cwd: string, ...args: string[]) => spawnSync("node", [...args], { cwd, encoding: "utf8", env: isoEnv() });
  const ruleFiles = (stdout: string, id: string) =>
    (JSON.parse(stdout).hotspots as Hotspot[]).filter((h) => h.ruleIds.includes(id)).map((h) => h.file);

  function tmpRepo(dirName: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotspots-"));
    const dir = path.join(root, dirName);
    fs.mkdirSync(path.join(dir, "prisma"), { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, "prisma/schema.prisma"), "a String\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "topic");
    fs.writeFileSync(path.join(dir, "prisma/schema.prisma"), "a String?\n");
    git(dir, "commit", "-qam", "change");
    return { root, dir };
  }

  it("정상 경로: 공백이 든 경로에서도 stdout 에 JSON", () => {
    const { root, dir } = tmpRepo("dir with space");
    try {
      const link = path.join(root, "link.mjs");
      fs.symlinkSync(script, link);
      const out = execFileSync("node", [link, "main"], { cwd: dir, encoding: "utf8" });
      const json = JSON.parse(out);
      expect(json.hotspots[0].ruleIds).toContain("schema");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("없는 base ref 는 0 이 아닌 종료코드", () => {
    const { root, dir } = tmpRepo("repo");
    try {
      const r = spawnSync("node", [script, "no-such-ref"], { cwd: dir, encoding: "utf8" });
      expect(r.status).not.toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("base 인자가 없으면 사용법과 종료코드 2", () => {
    const r = spawnSync("node", [script], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });

  it("git 이 실패하면 stdout 은 비고 stderr 에 사유, 종료코드 1", () => {
    const { root, dir } = tmpRepo("repo");
    try {
      const r = runCli(dir, script, "no-such-ref");
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^git diff failed: .+/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("I5: --preserve-symlinks-main 으로 같은 이름의 링크를 실행해도 main 이 돈다(빈 출력으로 통과하지 않는다)", () => {
    const { root, dir } = tmpRepo("repo");
    try {
      const linkDir = path.join(root, "linkdir");
      fs.mkdirSync(linkDir);
      const link = path.join(linkDir, "review-hotspots.mjs");
      fs.symlinkSync(script, link);
      const r = runCli(dir, "--preserve-symlinks-main", link, "main");
      expect(r.status).toBe(0);
      expect(ruleFiles(r.stdout, "schema")).toEqual(["prisma/schema.prisma"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("I5: 한글 경로도 따옴표 이스케이프 없이 경로 규칙에 걸린다(core.quotePath=false)", () => {
    const { root, dir } = tmpRepo("repo");
    try {
      const mig = path.join(dir, "prisma/migrations/가나");
      fs.mkdirSync(mig, { recursive: true });
      fs.writeFileSync(path.join(mig, "m.sql"), "x\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "mig");
      // 대조군: 기본 설정의 git diff 는 한글 경로를 따옴표·8진수로 감싼다.
      expect(git(dir, "diff", "main...HEAD")).toContain('"b/prisma/migrations/\\352');
      const r = runCli(dir, script, "main");
      expect(r.status).toBe(0);
      expect(ruleFiles(r.stdout, "schema")).toContain("prisma/migrations/가나/m.sql");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("I5: diff.relative=true 저장소를 하위 폴더에서 돌려도 바깥 변경을 놓치지 않는다", () => {
    const { root, dir } = tmpRepo("repo");
    try {
      fs.mkdirSync(path.join(dir, "sub"));
      fs.writeFileSync(path.join(dir, "sub/k.txt"), "k\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "sub");
      git(dir, "config", "diff.relative", "true");
      const sub = path.join(dir, "sub");
      expect(git(sub, "diff", "main...HEAD")).not.toContain("schema.prisma");
      const r = runCli(sub, script, "main");
      expect(r.status).toBe(0);
      expect(ruleFiles(r.stdout, "schema")).toEqual(["prisma/schema.prisma"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("I5: diff.external 이 설정돼 있어도 내장 diff 를 쓴다", () => {
    const { root, dir } = tmpRepo("repo");
    try {
      git(dir, "config", "diff.external", "/usr/bin/true");
      expect(git(dir, "diff", "main...HEAD")).not.toContain("schema.prisma");
      const r = runCli(dir, script, "main");
      expect(r.status).toBe(0);
      expect(ruleFiles(r.stdout, "schema")).toEqual(["prisma/schema.prisma"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("I5: textconv 가 본문을 바꿔도 원문으로 내용 규칙을 본다", () => {
    const { root, dir } = tmpRepo("repo");
    try {
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src/x.ts"), "await prisma.$transaction(async () => {});\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "tx");
      git(dir, "config", "diff.hide.textconv", "sed s/transaction/zzz/");
      fs.writeFileSync(path.join(dir, ".git/info/attributes"), "*.ts diff=hide\n");
      expect(git(dir, "diff", "main...HEAD")).not.toContain("$transaction");
      const r = runCli(dir, script, "main");
      expect(r.status).toBe(0);
      expect(ruleFiles(r.stdout, "tx")).toEqual(["src/x.ts"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("셀러 포털 컴포넌트(src/components/portal) 변경은 seller-facing", () => {
    const { root, dir } = tmpRepo("repo");
    try {
      fs.mkdirSync(path.join(dir, "src/components/portal"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src/components/portal/card.tsx"), "export const a = 1;\n");
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "portal");
      const r = runCli(dir, script, "main");
      expect(r.status).toBe(0);
      expect(ruleFiles(r.stdout, "seller-facing")).toEqual(["src/components/portal/card.tsx"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
