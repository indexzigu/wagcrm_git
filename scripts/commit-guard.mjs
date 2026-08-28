#!/usr/bin/env node
/**
 * commit-guard.mjs — 커밋 게이트 스캐너 (pre-commit · commit-msg 공용)
 *
 * 레포가 PUBLIC이므로 커밋에 들어간 것은 즉시 공개된다(P0 Public Repo Data
 * Guard). 소스 리터럴은 hardcoded-secret-literals.contract.test.ts 가 잡지만,
 * 커밋 메시지·문서·주석·스크립트를 커밋 시점에 막는 장치가 없어 실사고가
 * 있었다(2026-07-21 공개 전환 시 시크릿 미스크럽 — RapidAPI 실키 등 2건).
 * 이 스크립트가 그 구멍을 닫는다.
 *
 * 설계 원칙:
 * - 기존 레포 소급 적용이므로 파일 전체가 아니라 **스테이징 diff의 추가 줄만**
 *   검사한다(기존 코드에 대한 소음 없음).
 * - 셀러 실명·실측치처럼 public 레포에 패턴 자체를 못 넣는 항목은
 *   `.git/info/commit-guard-denylist`(git 공유 디렉터리 — 미추적, 전 워크트리
 *   공용)에서 읽는다. 한 줄 = 대소문자 무시 부분일치 금지어, `#` 주석.
 * - 허용목록은 줄 단위가 아니라 **매치된 토큰 단위**로만 면제한다
 *   ("placeholder"라는 단어가 같은 줄에 있다고 실키를 통과시키지 않는다).
 *
 * 사용:
 *   node scripts/commit-guard.mjs --staged          # 스테이징 diff 추가 줄 검사
 *   node scripts/commit-guard.mjs --message <file>  # 커밋 메시지 파일 검사
 *   node scripts/commit-guard.mjs <path...>         # 파일 전체 검사(수동 감사)
 *
 * 종료코드: 0 = 통과 · 1 = 검출 · 2 = 사용법/내부 오류(fail-closed).
 * 의도적 예외는 `git commit --no-verify`(사유를 PR 본문에 남길 것).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 검출 패턴 — 고신뢰(형태가 특정되는) 시크릿 + 국내 PII.
// 범용 고엔트로피 추정은 오탐이 많아 넣지 않는다(그건 push 분류기 몫).
// ---------------------------------------------------------------------------
const PATTERNS = [
  { name: "OpenAI형 키", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub 토큰", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: "GitHub fine-grained PAT", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "AWS Access Key ID", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Google API 키", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: "Slack 토큰", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "Bearer 토큰", re: /\bBearer\s+[A-Za-z0-9._-]{25,}\b/gi },
  {
    name: "개인키 블록",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
  },
  {
    // DATABASE_URL 등 접속 문자열의 자격증명 내장 형태를 잡는다.
    name: "URL 내장 자격증명",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:[^/\s:@'"]+@/gi,
  },
  {
    // Supabase service_role 등 장기 JWT. 픽스처용 짧은 토큰은 통과하도록
    // 실키 길이(100자+)만 잡는다.
    name: "장기 JWT(서비스 키 의심)",
    re: /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\b/g,
    minLen: 100,
  },
  {
    // 알려진 시크릿 env 이름에 16자+ 리터럴을 직접 대입하는 형태.
    name: "시크릿 env 리터럴 대입",
    re: /\b(?:CRON_SECRET|ENCRYPTION_KEY(?:_PREVIOUS)?|ASSET_TOKEN_ENCRYPTION_KEY|NAVER_CLIENT_(?:SECRET|ID)|APIFY_TOKEN|RAPIDAPI_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|SUPABASE_SERVICE_ROLE_KEY)\s*[:=]\s*["'`][A-Za-z0-9+/_.-]{16,}["'`]/g,
  },
  {
    // 주민등록번호 형태(뒤 7자리 첫 숫자 1~4). 셀러 주민번호는 암호화
    // 대상(P6 키 교체 런북)이지 평문 커밋 대상이 아니다.
    name: "주민등록번호 의심",
    re: /\b\d{6}-[1-4]\d{6}\b/g,
  },
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// 이메일 허용은 앵커드(전체 local-part 또는 전체 도메인) — 부분일치가 아니다.
const EMAIL_LOCAL_ALLOW = new Set([
  "user", "name", "test", "you", "noreply", "no-reply", "example", "email",
  "admin", "hello", "foo", "bar",
]);
const EMAIL_DOMAIN_ALLOW = [
  "example.com", "example.org", "example.net",
  "users.noreply.github.com", // 커밋 identity 별칭
  "anthropic.com",
  "ygrd.kr", // 자사 공개 도메인
];

// 매치된 토큰 자체에 아래 조각이 있으면 자리표시자로 보고 면제한다.
// 줄 전체가 아니라 토큰에만 적용 — 실키가 "example" 옆에 있어도 잡힌다.
const TOKEN_PLACEHOLDER = [
  "xxxx", "redacted", "placeholder", "example", "your-", "dummy", "sample",
  "fake", "test-key", "user:pass", "username:password", "id:password",
];

function tokenExonerated(token) {
  const lowered = token.toLowerCase();
  return TOKEN_PLACEHOLDER.some((frag) => lowered.includes(frag));
}

function emailAllowed(email) {
  const lowered = email.toLowerCase();
  const [local, domain] = lowered.split("@");
  if (EMAIL_LOCAL_ALLOW.has(local)) return true;
  return EMAIL_DOMAIN_ALLOW.some(
    (d) => domain === d || domain.endsWith(`.${d}`),
  );
}

function mask(token) {
  const head = token.slice(0, 4);
  return `${head}…(${token.length}자)`;
}

function git(args, cwd) {
  // maxBuffer 기본값(1MB)으로는 Prisma 생성물처럼 큰 파일이 스테이징되면
  // diff 를 읽다가 ENOBUFS 로 죽는다 — 그러면 **가드가 통째로 건너뛰어져**
  // 공개 레포 보호가 무력화된다(실제로 5MB 생성물에서 밟았다).
  // 검사를 포기하는 것보다 메모리를 쓰는 편이 낫다.
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

// 로컬 전용 금지어 — `.git/info/commit-guard-denylist` (미추적, 워크트리 공용).
function loadLocalDenylist(cwd) {
  try {
    const commonDir = git(["rev-parse", "--git-common-dir"], cwd).trim();
    const file = path.resolve(cwd, commonDir, "info", "commit-guard-denylist");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.toLowerCase());
  } catch {
    return []; // 레포 밖 수동 실행 등 — 금지어 없음으로 진행
  }
}

/** 한 줄을 검사해 검출 목록을 반환한다(파일/줄 정보는 호출부가 붙인다). */
export function scanLine(line, denylist = []) {
  const findings = [];
  for (const { name, re, minLen } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      const token = m[0];
      if (minLen && token.length < minLen) continue;
      if (tokenExonerated(token)) continue;
      findings.push({ name, token: mask(token) });
    }
  }
  EMAIL_RE.lastIndex = 0;
  for (const m of line.matchAll(EMAIL_RE)) {
    if (!emailAllowed(m[0])) {
      findings.push({ name: "비허용 이메일", token: mask(m[0]) });
    }
  }
  const lowered = line.toLowerCase();
  for (const word of denylist) {
    if (lowered.includes(word)) {
      findings.push({ name: "로컬 금지어(denylist)", token: mask(word) });
    }
  }
  return findings;
}

/** 텍스트 전체(커밋 메시지·수동 파일 검사)를 줄 단위로 검사한다. */
export function scanText(text, source, denylist = []) {
  const findings = [];
  text.split("\n").forEach((line, i) => {
    for (const f of scanLine(line, denylist)) {
      findings.push({ ...f, where: `${source}:${i + 1}` });
    }
  });
  return findings;
}

/** 스테이징 diff에서 추가 줄만 뽑아 검사한다. */
function scanStaged(cwd, denylist) {
  const findings = [];

  // .env 계열 파일 스테이징 자체를 차단(example 계열 제외).
  const names = git(
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    cwd,
  )
    .split("\0")
    .filter(Boolean);
  for (const name of names) {
    const base = path.basename(name);
    if (/^\.env(\..+)?$/.test(base) && !base.includes("example")) {
      findings.push({
        name: ".env 파일 스테이징",
        token: base,
        where: name,
      });
    }
  }

  const diff = git(
    ["diff", "--cached", "-U0", "--no-color", "--diff-filter=ACMR"],
    cwd,
  );
  let file = "";
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      // 공백 포함 경로는 diff 헤더에 트레일링 탭이 붙는다 — 표시용 제거.
      file = raw.slice(6).replace(/\t$/, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const content = raw.slice(1);
      for (const f of scanLine(content, denylist)) {
        findings.push({ ...f, where: `${file}:${newLine}` });
      }
      newLine += 1;
    }
  }
  return findings;
}

function report(findings) {
  if (findings.length === 0) return 0;
  console.error("✖ commit-guard: 커밋에 넣으면 안 되는 내용이 검출됐습니다.\n");
  for (const f of findings) {
    console.error(`  - [${f.name}] ${f.where} → ${f.token}`);
  }
  console.error(
    "\n레포는 PUBLIC입니다(P0). 값을 제거하거나 자리표시자로 바꾸십시오." +
      "\n오탐이 확실한 의도적 예외만 `git commit --no-verify`로 우회하고," +
      " 사유를 PR 본문에 남기십시오." +
      "\n셀러 실명·실측치 차단어 추가: .git/info/commit-guard-denylist (미추적)",
  );
  return 1;
}

function main() {
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const denylist = loadLocalDenylist(cwd);
  try {
    if (args[0] === "--staged") {
      return report(scanStaged(cwd, denylist));
    }
    if (args[0] === "--message") {
      if (!args[1]) {
        console.error("사용법: commit-guard.mjs --message <파일>");
        return 2;
      }
      const text = readFileSync(args[1], "utf8");
      // 주석 줄(#)은 커밋에 실리지 않으므로 제외한다.
      const effective = text
        .split("\n")
        .filter((l) => !l.startsWith("#"))
        .join("\n");
      return report(scanText(effective, "커밋 메시지", denylist));
    }
    if (args.length > 0) {
      const findings = args.flatMap((p) =>
        scanText(readFileSync(p, "utf8"), p, denylist),
      );
      return report(findings);
    }
    console.error(
      "사용법: commit-guard.mjs --staged | --message <파일> | <경로...>",
    );
    return 2;
  } catch (err) {
    // fail-closed: 스캐너가 깨진 채 통과시키지 않는다. 탈출구는 --no-verify.
    console.error(`✖ commit-guard 내부 오류: ${err?.message ?? err}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  process.exit(main());
}
