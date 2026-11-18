#!/usr/bin/env node
/**
 * expansion-prepush-check — 무인 루프가 공개 레포에 push 하기 직전의 마지막 관문.
 *
 * 검사: ①현재 브랜치명(형식 + 금지어) ②`<base>..HEAD` 커밋 메시지 ③커밋별 추가 줄과 변경 파일 경로의
 * 금지어(셀러 실명·별칭·핸들) ④바이너리·머지 커밋 차단 ⑤`--title-file` 을 주면 PR 제목의 금지어.
 * PR 본문·코멘트는 이 도구가 보지 않는다(호출자가 본문을 표준 문구로만 채운다).
 *
 * FAIL-CLOSED: 금지어 파일이 없거나 비면(유효 항목 0개) 통과가 아니라 실패다 — 점검이
 * 조용히 꺼진 채 exit 0 이 되는 것이 이 도구의 최악의 버그다. stdout/stderr 는 로그로
 * 흘러가므로 일치한 금지어 원문은 절대 출력하지 않고 개수만 낸다.
 *
 * 사용법: node scripts/expansion-prepush-check.mjs <base-ref> <terms-file> [--title-file <path>] [--guard <commit-guard.mjs>]
 * --title-file 을 줬는데 파일을 못 읽으면 통과가 아니라 BLOCKED(fail-closed).
 * --guard 를 주면 그 파일(기준 커밋에서 꺼낸 scripts/commit-guard.mjs)의 `scanText` 로 추가 줄·커밋 메시지·PR 제목의
 * 시크릿·이메일·주민번호 형태를 보고, 금액 표기(아래 FIGURE)도 본다. 파일이 없거나 못 불러오면 BLOCKED(fail-closed).
 * 주지 않으면 이 두 검사는 돌지 않는다(옛 호출자 호환 — 배포된 래퍼가 점검기보다 늦게 바뀔 수 있다).
 * 종료코드: 0 안전 · 1 차단/점검 불능 · 2 사용법 오류
 *
 * ⚠️ 호출자는 「exit 0 **그리고** stdout 에 `OK:` 로 시작하는 줄」을 둘 다 요구해야 한다.
 * 어떤 이유로든 main 이 안 돌고 조용히 끝나면 exit 0 + 출력 없음이 되는데, 그것은 통과가 아니다.
 *
 * 범위: push 는 base..HEAD 의 **모든 커밋**을 공개한다 — 순 diff 가 아니라 커밋별 추가 줄·경로를 본다
 * (한 커밋에서 넣고 다음 커밋에서 지워도 이력엔 남는다). 바이너리(이미지·엑셀·압축 등)는 내용을 못 읽으므로
 * 추가·수정 자체를 차단한다. 판정의 본체는 **내용 검사**다: 범위 안에서 추가·수정된 모든 blob 을 꺼내 앞 8000 바이트의
 * NUL 또는 압축/컨테이너 서명(gzip·zip·7z·bzip2·xz·zstd·PDF·PNG·JPEG·GIF)이면 차단 — gitattributes 와 무관하다
 * (속성으로 `diff` 를 강제하면 numstat 의 `-\t-` 판정은 비껴간다). numstat 판정은 보조 층으로 남긴다.
 * 속성 중화: 모든 git 호출에 core.attributesFile=/dev/null, 그리고 git 이 지원하면(2.40+) --attr-source=<빈 트리>
 * ($GIT_DIR/info/attributes 는 설정으로 못 끈다 — 그래서 내용 검사가 진짜 방벽이다). 미지원이면 stderr 에 알리고
 * 내용 검사에 맡긴다. 범위 안의 .gitattributes 추가·수정과 서브모듈(gitlink) 변경도 점검 불가라 차단. 머지 커밋도 차단.
 * 알려진 오탐: 서명 바이트로 시작하는 텍스트(예: `%PDF`·`BZh`·`GIF8` 로 시작)는 차단된다 — 보수적 선택.
 *
 * 인코딩: 추가·수정된 모든 텍스트 blob·커밋 메시지·변경 경로·PR 제목·금지어 파일은 엄격한 UTF-8 이어야 한다
 * (CP949 등은 금지어 대조를 비껴간다) — 아니면 개수만 내고 차단(`non-UTF-8 content`).
 * 이력 기준: 모든 git 호출에 --no-replace-objects(replace ref 로 점검기가 보는 커밋과 push 되는 커밋이 갈리지 않게),
 * log.showRoot=true·diff.relative=false(상속 설정이 루트 커밋 diff 를 숨기거나 하위 폴더로 좁히지 않게).
 * base 와 공통 조상이 없는 브랜치(고아 루트)는 점검 범위가 정의되지 않으므로 차단.
 *
 * 알려진 한계(잡지 못한다): base64·hex·URL 인코딩 등으로 감싼 텍스트, 글자 사이에 끼운 zero-width 문자,
 * 다른 문자 체계의 닮은꼴 글자(homoglyph)로 쪼갠 금지어. 금액 검사(FIGURE)는 단위·쉼표 표기만 본다 —
 * 단위 없는 맨 숫자·끝 묶음이 세 개의 0 이 아닌 단위 없는 쉼표 묶음은 못 잡고, 반대로 숫자 뒤에 원·만원·억 단위가 붙은 표기와
 * 끝 묶음이 세 개의 0 인 6자리 이상 쉼표 묶음(예: 그런 숫자를 쓴 함수 인자)은 합성 예시여도 차단한다(오탐).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BRANCH_RE = /^exp\/[a-z0-9][a-z0-9-]{2,48}$/;
const MIN_TERM_LENGTH = 2;

/** 비교용 정규화: NFC(맥 파일명은 NFD 로 올 수 있다) + 소문자(한글엔 무해). */
const norm = (s) => s.normalize("NFC").toLowerCase();

export function checkBranchName(name) {
  if (typeof name === "string" && BRANCH_RE.test(name)) return { ok: true };
  return { ok: false, reason: "브랜치명이 exp/<소문자-숫자-하이픈 3~49자> 형식이 아니다" };
}

export function findExposures(text, terms) {
  const hay = norm(text);
  const found = [];
  for (const term of terms) {
    const t = norm(term);
    if (t.length < MIN_TERM_LENGTH) continue;
    if (hay.includes(t) && !found.includes(term)) found.push(term);
  }
  return found;
}

/** 구분자 변형(`zxq_holder`·`zxq.holder`·`zxq holder` ↔ `zxq-holder`)용: 글자·숫자(유니코드)만 남긴 비교. */
const strip = (s) => norm(s).replace(/[^\p{L}\p{N}]/gu, "");
export function findExposuresLoose(text, terms) {
  const hay = strip(text);
  const found = [];
  for (const term of terms) {
    const t = strip(term);
    if (t.length < MIN_TERM_LENGTH) continue;
    if (hay.includes(t) && !found.includes(term)) found.push(term);
  }
  return found;
}
const hitCount = (text, terms) => new Set([...findExposures(text, terms), ...findExposuresLoose(text, terms)]).size;

/** 엄격한 UTF-8 해석 — 잘못된 바이트면 null(대체 문자로 넘어가 금지어 대조를 비껴가지 못하게). */
export function decodeUtf8Strict(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** 파일 없음·읽기 실패·UTF-8 아님·유효 항목 0개면 throw(fail-closed). CRLF·공백·빈 줄·1자 줄은 정리/제외. */
export function loadTerms(path) {
  const raw = decodeUtf8Strict(fs.readFileSync(path));
  if (raw === null) throw new Error("금지어 파일이 UTF-8 이 아니다");
  const terms = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= MIN_TERM_LENGTH);
  if (terms.length === 0) throw new Error("금지어 파일에 유효한 항목이 없다");
  return terms;
}

// core.quotePath=false: 한글 경로가 \354\225… 8진수 이스케이프로 나와 금지어와 안 맞는 것을 막는다.
// i18n.logOutputEncoding=UTF-8: 상속된 설정이 메시지를 다른 인코딩으로 바꿔 금지어 대조를 비껴가게 하지 못하게 한다.
// core.attributesFile=/dev/null: 상속된 전역 속성 파일이 바이너리·diff 판정을 바꾸지 못하게 한다.
// --no-replace-objects: `git replace` 로 점검기에는 깨끗한 커밋을 보이고 push 는 원본을 보내는 갈림을 막는다.
// log.showRoot=true: 상속된 false 가 루트 커밋의 diff·raw·numstat 을 통째로 숨기지 못하게 한다.
// diff.relative=false: 하위 폴더에서 돌 때 상속된 true 가 점검 범위를 그 폴더로 좁히지 못하게 한다.
const GIT_OPTS = [
  "--no-replace-objects",
  "-c", "core.quotePath=false",
  "-c", "i18n.logOutputEncoding=UTF-8",
  "-c", "core.attributesFile=/dev/null",
  "-c", "log.showRoot=true",
  "-c", "diff.relative=false",
];
let attrSourceOpts = []; // neutralizeAttributes() 가 지원 확인 뒤 채운다.
const GIT_EXEC = { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
const git = (...args) => execFileSync("git", [...GIT_OPTS, ...attrSourceOpts, ...args], { ...GIT_EXEC, encoding: "utf8" });
const gitBuffer = (...args) => execFileSync("git", [...GIT_OPTS, ...attrSourceOpts, ...args], GIT_EXEC);

/** 작업 트리·색인의 .gitattributes 대신 빈 트리에서 속성을 읽게 한다(git 2.40+ `--attr-source`).
 *  미지원 git 이면 null 이 아니라 안내 문구를 돌려준다(호출자가 stderr 에 낸다 — 조용한 폴백 금지). 다른 실패는 throw. */
function neutralizeAttributes() {
  const emptyTree = git("hash-object", "-t", "tree", "/dev/null").trim();
  try {
    execFileSync("git", [...GIT_OPTS, `--attr-source=${emptyTree}`, "rev-parse", "--git-dir"], { ...GIT_EXEC, encoding: "utf8" });
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr) : "";
    if (/unknown option/i.test(stderr)) {
      return "NOTE: 이 git 은 --attr-source 를 지원하지 않는다 — 저장소 내 .gitattributes 는 중화되지 않고, 바이너리 판정은 내용 검사가 맡는다\n";
    }
    throw err;
  }
  attrSourceOpts = [`--attr-source=${emptyTree}`];
  return null;
}

const MAGICS = [
  [0x1f, 0x8b], // gzip
  [0x50, 0x4b, 0x03, 0x04], // zip·xlsx·docx
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x42, 0x5a, 0x68], // bzip2
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
  [0x25, 0x50, 0x44, 0x46], // PDF
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
].map((b) => Buffer.from(b));

/** 내용만으로 바이너리 판정 — 앞 8000 바이트에 NUL 이 있거나 압축/컨테이너 서명으로 시작하면 true. 속성과 무관. */
export function isBinaryContent(buf) {
  if (buf.subarray(0, 8000).includes(0)) return true;
  return MAGICS.some((m) => buf.length >= m.length && buf.subarray(0, m.length).equals(m));
}

/** `git log --raw -z --no-renames --no-abbrev --format=` 출력에서 추가·수정된 blob SHA(중복 제거)와
 *  gitlink·.gitattributes 변경 수를 센다. 형식을 모르는 항목은 throw(fail-closed). 경로는 반환하지 않는다. */
export function parseRawChanges(out) {
  const blobs = new Set();
  let gitlinks = 0;
  let attributeFiles = 0;
  const toks = out.split("\0");
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i].replace(/^\n+/, "");
    if (tok === "") continue;
    if (!tok.startsWith(":")) throw new Error("raw 출력 형식을 알 수 없다");
    const meta = tok.slice(1).split(" ");
    if (meta.length !== 5) throw new Error("raw 항목 형식을 알 수 없다");
    const [, newMode, , newSha, status] = meta;
    const nPaths = /^[CR]/.test(status) ? 2 : 1;
    const filePath = toks[i + nPaths];
    if (filePath === undefined) throw new Error("raw 항목에 경로가 없다");
    i += nPaths;
    if (status === "D") continue;
    if (!/^[AMTCR]/.test(status)) throw new Error(`raw 항목 상태를 알 수 없다 (${status})`);
    if (path.posix.basename(filePath).toLowerCase() === ".gitattributes") attributeFiles++;
    if (newMode === "160000") gitlinks++;
    else if (/^1[02]0[0-7]{3}$/.test(newMode) && /^[0-9a-f]{40,64}$/.test(newSha)) blobs.add(newSha);
    else throw new Error(`raw 항목 모드를 알 수 없다 (${newMode})`);
  }
  return { blobs: [...blobs], gitlinks, attributeFiles };
}

/** `git log -p -U0` 출력에서 추가 줄만 모은다. 파일 헤더(`+++ `)는 hunk 밖에서만 존재하므로 hunk 상태를 추적한다
 *  (내용이 `++` 로 시작하는 추가 줄은 `+++ …` 로 보이지만 hunk 안이라 그대로 센다). */
export function addedLines(diff) {
  const out = [];
  let inHunk = false;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) inHunk = false;
    else if (l.startsWith("@@")) inHunk = true;
    else if (inHunk && l.startsWith("+")) out.push(l.slice(1));
  }
  return out.join("\n");
}

/**
 * 금액 표기 개수(FIGURE). 보수적으로 단위·쉼표가 붙은 것만 센다 — 맨 숫자(타임스탬프·SHA·바이트 수)는 보지 않는다.
 *  ① 쉼표 묶음 숫자가 6자리 이상이면서 뒤에 원 단위가 붙거나 끝 묶음이 세 개의 0 — 끝 묶음 제한은
 *     CSS 색상 함수 인자·SVG 좌표처럼 공백 없는 세 자리 숫자 목록을 금액으로 오인하지 않으려는 것
 *  ② 쉼표 없는 6자리 이상 숫자 뒤에 원 단위  ③ 열 이상의 값 뒤에 만원 단위(사이 공백 허용)  ④ 아무 숫자 뒤에 억 단위.
 *  같은 시작 위치는 한 번만 센다.
 */
export function countFigures(text) {
  const starts = new Set();
  for (const m of text.matchAll(/(?<![\d,.])\d{1,3}(?:,\d{3})+(?![\d,])(\s*원)?/g)) {
    const digits = m[0].replace(/[^\d]/g, "");
    if (digits.length >= 6 && (m[1] !== undefined || m[0].trimEnd().endsWith(",000"))) starts.add(m.index);
  }
  for (const m of text.matchAll(/(?<![\d,.])\d{6,}\s*원/g)) starts.add(m.index);
  for (const m of text.matchAll(/(?<![\d,.])(\d[\d,]*(?:\.\d+)?)\s*만\s*원/g)) {
    if (Number.parseFloat(m[1].replace(/,/g, "")) >= 10) starts.add(m.index);
  }
  for (const m of text.matchAll(/(?<![\d,.])\d[\d,]*(?:\.\d+)?\s*억/g)) starts.add(m.index);
  return starts.size;
}

/** --guard 파일을 불러 scanText 를 돌려준다. 없거나·못 불러오거나·scanText 가 함수가 아니면 throw(fail-closed). */
async function loadGuard(guardPath) {
  const abs = path.resolve(guardPath);
  if (!fs.statSync(abs).isFile()) throw new Error("커밋 가드가 파일이 아니다");
  const mod = await import(pathToFileURL(abs).href);
  if (typeof mod.scanText !== "function") throw new Error("커밋 가드에 scanText 가 없다");
  return (text, source) => {
    const findings = mod.scanText(text, source, []);
    if (!Array.isArray(findings)) throw new Error("커밋 가드 scanText 결과가 배열이 아니다");
    return findings.length;
  };
}

const USAGE = "usage: node scripts/expansion-prepush-check.mjs <base-ref> <terms-file> [--title-file <path>] [--guard <commit-guard.mjs>]\n";
function usage() {
  process.stderr.write(USAGE);
  return 2;
}

async function main(argv) {
  const positional = [];
  let titlePath = null;
  let guardPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--title-file" || argv[i] === "--guard") {
      const isTitle = argv[i] === "--title-file";
      if ((isTitle ? titlePath : guardPath) !== null) return usage();
      const v = argv[i + 1] ?? "";
      i++;
      if (isTitle) titlePath = v;
      else guardPath = v;
    } else positional.push(argv[i]);
  }
  const [base, termsPath] = positional;
  if (!base || !termsPath || titlePath === "" || guardPath === "" || positional.length > 2) return usage();
  const problems = [];
  let nonUtf8 = 0;
  let terms;
  try {
    terms = loadTerms(termsPath);
  } catch (err) {
    // 오류 메시지엔 금지어가 없다(경로·사유만).
    process.stderr.write(`BLOCKED: 금지어 파일을 쓸 수 없다 (${err instanceof Error ? err.message : String(err)})\n`);
    return 1;
  }
  let guardScan = null;
  if (guardPath !== null) {
    try {
      guardScan = await loadGuard(guardPath);
    } catch (err) {
      process.stderr.write(`BLOCKED: 커밋 가드를 불러올 수 없다 (${err instanceof Error ? err.code ?? err.message.split("\n")[0] : "load error"})\n`);
      return 1;
    }
  }
  let title = null;
  if (titlePath !== null) {
    let titleBuf;
    try {
      titleBuf = fs.readFileSync(titlePath);
    } catch (err) {
      process.stderr.write(`BLOCKED: PR 제목 파일을 읽을 수 없다 (${err instanceof Error ? err.code ?? "read error" : "read error"})\n`);
      return 1;
    }
    title = decodeUtf8Strict(titleBuf);
    if (title === null) {
      nonUtf8++;
      title = titleBuf.toString("utf8");
    }
    const titleHits = hitCount(title, terms);
    if (titleHits) problems.push(`PR title: 금지어 ${titleHits}종 발견`);
  }
  try {
    const attrNote = neutralizeAttributes();
    if (attrNote) process.stderr.write(attrNote);
    const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    const b = checkBranchName(branch);
    if (!b.ok) problems.push(`branch: ${b.reason}`);
    const branchHits = hitCount(branch, terms);
    if (branchHits) problems.push(`branch: 금지어 ${branchHits}종 발견`);

    // 공통 조상이 없으면(고아 루트) base..HEAD 가 무엇을 공개하는지 정의되지 않는다 — 차단. exit 1 = 조상 없음, 그 밖은 throw.
    try {
      git("merge-base", base, "HEAD");
    } catch (err) {
      if (err && typeof err === "object" && "status" in err && err.status === 1) {
        problems.push("orphan: base 와 공통 조상이 없다 — 점검 범위 불명, 차단");
      } else throw err;
    }

    const merges = git("rev-list", "--merges", `${base}..HEAD`).split("\n").filter(Boolean).length;
    if (merges) problems.push(`merge commits: ${merges}개 — 점검 불가, 차단`);

    // 메시지는 원 바이트로 받아 커밋마다 엄격 해석한다(-z: 커밋 사이 NUL).
    const messageParts = [];
    for (const part of gitBuffer("log", "-z", "--format=%B", `${base}..HEAD`).toString("latin1").split("\0")) {
      const bytes = Buffer.from(part, "latin1");
      const decoded = decodeUtf8Strict(bytes);
      if (decoded === null) nonUtf8++;
      messageParts.push(decoded ?? bytes.toString("utf8"));
    }
    const messages = messageParts.join("\n");
    const msgHits = hitCount(messages, terms);
    if (msgHits) problems.push(`commit messages: 금지어 ${msgHits}종 발견`);

    // 커밋별 경로·바이너리: numstat 줄 = `추가\t삭제\t경로`, 바이너리는 `-\t-\t경로`.
    const numstat = git("log", "--no-renames", "--numstat", "--format=", `${base}..HEAD`);
    const binaries = numstat.split("\n").filter((l) => l.startsWith("-\t-\t")).length;
    if (binaries) problems.push(`binary changes: ${binaries}건 — 내용 점검 불가, 차단`);
    const nameHits = hitCount(numstat, terms);
    if (nameHits) problems.push(`changed file paths: 금지어 ${nameHits}종 발견`);

    // 내용 기반 바이너리 판정(본체): 속성으로 diff 를 강제해도 비껴갈 수 없다.
    // raw 출력은 원 바이트로 받아 엄격 해석한다 — 메타는 ASCII 라 실패 원인은 UTF-8 이 아닌 경로다.
    const rawBuf = gitBuffer("log", "--raw", "-z", "--no-renames", "--no-abbrev", "--format=", `${base}..HEAD`);
    let rawText = decodeUtf8Strict(rawBuf);
    if (rawText === null) {
      nonUtf8++;
      rawText = rawBuf.toString("utf8");
    }
    const raw = parseRawChanges(rawText);
    let binaryBlobs = 0;
    for (const sha of raw.blobs) {
      const buf = gitBuffer("cat-file", "blob", sha);
      if (isBinaryContent(buf)) binaryBlobs++;
      else if (decodeUtf8Strict(buf) === null) nonUtf8++;
    }
    if (binaryBlobs) problems.push(`binary content (NUL·압축/컨테이너 서명): ${binaryBlobs}건 — 내용 점검 불가, 차단`);
    if (raw.gitlinks) problems.push(`submodule (gitlink) changes: ${raw.gitlinks}건 — 점검 불가, 차단`);
    if (raw.attributeFiles) problems.push(`.gitattributes changes: ${raw.attributeFiles}건 — 속성 변경은 이 관문이 검토할 수 없다, 차단`);

    // 커밋별 추가 줄(순 diff 가 아니다). --no-textconv·--no-ext-diff: 저장소 설정(diff.<drv>.textconv·diff.external)이
    // 점검기가 보는 내용을 바꿔 금지어를 가리지 못하게 한다 — push 되는 것은 변환 전 원문이다.
    const added = addedLines(git("log", "-p", "--no-textconv", "--no-ext-diff", "--no-renames", "--no-color", "-U0", "--format=", `${base}..HEAD`));
    const addHits = findExposures(added, terms).length;
    if (addHits) problems.push(`added diff lines: 금지어 ${addHits}종 발견`);

    if (nonUtf8) problems.push(`non-UTF-8 content: ${nonUtf8}건 — 금지어 대조 불가, 차단`);

    if (guardScan) {
      const texts = [
        [added, "added"],
        [messages, "commit messages"],
        ...(title !== null ? [[title, "PR title"]] : []),
      ];
      const guardHits = texts.reduce((n, [t, src]) => n + guardScan(t, src), 0);
      if (guardHits) problems.push(`commit-guard (시크릿·이메일·주민번호 형태): ${guardHits}건 발견`);
      const figures = texts.reduce((n, [t]) => n + countFigures(t), 0);
      if (figures) problems.push(`currency figures (금액 표기): ${figures}건 발견`);
    }
  } catch (err) {
    process.stderr.write(`BLOCKED: git 점검 실패 (${err instanceof Error ? err.message.split("\n")[0] : String(err)})\n`);
    return 1;
  }
  if (problems.length) {
    process.stderr.write(`BLOCKED: push 금지\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(
    `OK: 브랜치명(형식·금지어)·커밋 메시지·커밋별 추가 줄·경로·바이너리·머지${title !== null ? "·PR 제목" : ""}${guardScan ? "·커밋 가드·금액" : ""} 점검 통과 (금지어 ${terms.length}종 대조)\n`,
  );
  return 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  // realpath 실패·대소문자 불일치로 URL 비교가 어긋나도 점검이 조용히 건너뛰어지면 안 된다:
  // 실행 파일 이름이 이 파일과 같으면 main 을 돌린다.
  if (path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url))) return true;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isMain()) process.exit(await main(process.argv.slice(2)));
