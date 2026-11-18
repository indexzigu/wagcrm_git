#!/usr/bin/env node
/**
 * review-hotspots — 코드 검토 전에 diff 에서 위험한 hunk 만 골라낸다.
 *
 * 왜 있나: 모든 hunk 를 상위 티어 검토자에게 보내면 비싸고, 사람이 고르면 빠진다.
 * 그래서 스키마·돈·인증·외부 부수효과·셀러 노출·트랜잭션·상태 전이·가드 약화를
 * 규칙(HOTSPOT_RULES)으로 기계 선별한다. 규칙이 고른 hunk 는 호출자가 넘기는 extra 와
 * 무관하게 항상 남는다(extra 는 더하기만 가능, 빼기 불가).
 *
 * 사용법: node scripts/review-hotspots.mjs <base-ref>   # git diff <base>...HEAD → JSON(stdout)
 * git 이 실패하면 빈 stdout·exit 0 이 아니라 stderr 사유 + 0 이 아닌 종료코드다(빈 결과를 「위험 없음」으로 읽지 않게).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OVERSIZE_LINES = 300;

/**
 * @typedef {{
 *   id: string, label: string,
 *   path?: RegExp,      // 파일 경로에 적용
 *   content?: RegExp,   // hunk 본문 전체(추가·삭제·문맥 줄)에 적용
 *   removed?: RegExp,   // 삭제된 줄(`-`)에만 적용 — guard-weaken 용
 * }} HotspotRule
 * path·content 는 어느 한쪽만 맞아도 선별(OR). removed 는 삭제 줄 전용이며 위와도 OR.
 * 규칙 id 는 배열에 정확히 한 번만 선언한다.
 * 경로·식별자 출처: docs/agents/data-contracts.md · codebase-map.md SSOT 표.
 */
/** @type {HotspotRule[]} */
export const HOTSPOT_RULES = [
  {
    id: "schema",
    label: "DB 스키마·마이그레이션",
    path: /^prisma\/(schema\.prisma|migrations\/)/,
  },
  {
    id: "money",
    label: "정산·세금·금액·수수료",
    path: /(settlement|(^|[\/-])tax|taxable|money-|pipeline-money|payout|price-sheet|(^|\/)vat\.|commission|(^|\/)margin|hometax)/i,
    content: /(amount|fee\b|fees\b|price|vat|margin|commission|settle)/i,
  },
  {
    id: "auth",
    label: "인증·권한·세션",
    path: /(^src\/proxy\.ts$|(^|\/)auth(\/|\.|-)|api-auth|portal-auth|cron-auth|permission|session|middleware)/i,
    content: /(getServerSession|getAuthContext|requireAuth|requireRole|verifyCron\w*|verifyCronAuth|safeEqual|\bisAdmin\b|role\s*[!=]==?\s*["'](admin|operator)["'])/,
  },
  {
    id: "external-effect",
    label: "외부 부수효과(메일·네이버 쓰기·슬랙)",
    path: /(order-converter\/naver-|purchase-order-mail|tax-invoice-mail|mail-config)/,
    content:
      /(\bsendMail\s*\(|\bsendEmail\s*\(|chat\.postMessage|slack\.com\/api|\bfetch\s*\([\s\S]{0,400}?method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]|\bmethod\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`])/i,
  },
  {
    id: "seller-facing",
    label: "셀러가 보는 표면",
    path: /^src\/(lib\/seller-portal\.ts|app\/\[slug\]\/|app\/p\/|components\/portal\/)/,
  },
  {
    id: "tx",
    label: "트랜잭션·행 잠금",
    content: /(\$transaction|FOR UPDATE)/,
  },
  {
    id: "state-transition",
    label: "상태 전이",
    content: /(\bTRANSITIONS\b|\bcanTransition\b|\bstatus\s*[:=]\s*["'][A-Za-z_]+["'])/,
  },
  {
    id: "guard-weaken",
    label: "삭제된 가드(throw·assert·if (!)",
    removed: /(\bthrow\b|\bassert\w*\b|\bif\s*\(\s*!)/,
  },
];

/** unified diff → [{file, hunk}] (hunk 는 `@@` 줄부터). */
export function parseDiff(diffText) {
  const out = [];
  let file = null;
  let cur = null;
  let header = [];
  let hadHunk = false;
  const flush = () => {
    if (cur) out.push({ file: cur.file, hunk: cur.lines.join("\n") });
    cur = null;
  };
  // `@@` 가 없는 블록(순수 이름 변경·모드 변경·바이너리)은 헤더 블록을 합성 hunk 로 낸다.
  const flushBlock = () => {
    flush();
    if (header.length && !hadHunk && file) out.push({ file, hunk: header.join("\n") });
    header = [];
    hadHunk = false;
  };
  for (const line of String(diffText).split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushBlock();
      header = [line];
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      file = m ? m[2] : null;
      continue;
    }
    if (cur === null && header.length && !line.startsWith("@@")) {
      header.push(line);
      const rt = /^rename to (.*)$/.exec(line);
      if (rt) file = rt[1];
    }
    if (cur === null && line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      if (p !== "/dev/null") file = p.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("@@")) {
      flush();
      hadHunk = true;
      cur = { file, lines: [line] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  flushBlock();
  return out;
}

function countLines(hunk) {
  const lines = hunk.split("\n").slice(1); // `@@` 헤더 제외
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function matchRules(file, hunk) {
  const lines = hunk.split("\n").slice(1);
  const text = lines.join("\n");
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
  const ids = [];
  for (const rule of HOTSPOT_RULES) {
    const hit =
      (rule.path && rule.path.test(file)) ||
      (rule.content && rule.content.test(text)) ||
      (rule.removed && removed.some((l) => rule.removed.test(l)));
    if (hit) ids.push(rule.id);
  }
  return ids;
}

/**
 * @param {string} diffText unified diff
 * @param {Array<{file: string, hunk: string}>} [extra] 호출자가 더하는 hunk(규칙 무관 포함)
 */
export function selectHotspots(diffText, extra = []) {
  const hotspots = [];
  const seen = new Map();
  const add = (file, hunk, ruleIds) => {
    const key = `${file}\u0000${hunk}`;
    const prev = seen.get(key);
    if (prev) {
      for (const id of ruleIds) if (!prev.ruleIds.includes(id)) prev.ruleIds.push(id);
      return;
    }
    const h = { file, hunk, ruleIds: [...ruleIds], lines: countLines(hunk) };
    seen.set(key, h);
    hotspots.push(h);
  };
  for (const { file, hunk } of parseDiff(diffText)) {
    const ruleIds = matchRules(file, hunk);
    if (ruleIds.length) add(file, hunk, ruleIds);
  }
  for (const { file, hunk } of extra) add(file, hunk, []);
  const totalLines = hotspots.reduce((n, h) => n + h.lines, 0);
  return { hotspots, totalLines, oversize: totalLines > OVERSIZE_LINES };
}

/**
 * 상속된 git 설정이 diff 모양을 바꿔 규칙을 비껴가지 못하게 고정한다:
 * quotePath(한글 경로가 `"b/\354…"` 로 감싸져 경로 규칙 불일치) · diff.relative(하위 폴더에서 돌면 그 밖 변경 누락) ·
 * mnemonicPrefix·noprefix(접두 a/·b/ 가정 붕괴) · 외부 diff·textconv(본문이 원문이 아니게 됨).
 */
const GIT_DIFF_PINS = [
  "-c", "core.quotePath=false",
  "-c", "diff.relative=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.noprefix=false",
  "diff", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--no-color", "-U3",
];

function main(argv) {
  const base = argv[0];
  if (!base) {
    process.stderr.write("usage: node scripts/review-hotspots.mjs <base-ref>\n");
    return 2;
  }
  let diff;
  try {
    diff = execFileSync("git", [...GIT_DIFF_PINS, `${base}...HEAD`], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr).trim() : "";
    process.stderr.write(`git diff failed: ${stderr || (err instanceof Error ? err.message : String(err))}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(selectHotspots(diff), null, 2)}\n`);
  return 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  // realpath 실패·불일치(예: --preserve-symlinks-main 으로 같은 이름의 심볼릭 링크 실행)로 main 이 조용히 건너뛰어지면
  // 빈 stdout·exit 0 = 「위험 hunk 없음」으로 읽힌다. 실행 파일 이름이 이 파일과 같으면 main 을 돌린다(점검기와 같은 규칙).
  if (path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url))) return true;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isMain()) process.exit(main(process.argv.slice(2)));
