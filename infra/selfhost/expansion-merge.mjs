// Expansion-bot PR merge executor — merges and deploys a bot PR (exp/* → main) only after the owner clicked the
// Slack 「머지·배포」 button for that exact head SHA. Deterministic: no LLM. Runs from crontab every 10 min via
// expansion-merge.sh, under the owner's gh identity, from the production checkout (~/selfhost/wagcrm).
//
// Why: deployment.md clause ⑥ keeps exp/* PRs out of agent self-merge so the expansion loop cannot integrate
// its own output. The owner's click (HMAC-signed by the hermes Slack handler) is the owner's merge decision;
// this file re-checks gates and carries it out. Rule text: deployment.md 「확장 봇 PR 오너 버튼 머지」.
// Contract (field names, HMAC message, key file): docs/private/specs/2026-11-24-expansion-pr-merge-button.md
// §「구현 계약 v1」 (local, untracked). Signer: ~/.hermes/hermes-agent plugins/wag-operator/expansion_cards.py
// `merge_message` — change both together.
//
// Known limit: the expansion loop runs as the same macOS user and could read the key file. The signature makes
// forging a deliberate secret-extraction step instead of a one-line append; it is not a hard boundary.
//
// Safety shape:
// - One decision per run. Signature/approver/card binding are checked before anything else, so an unsigned or
//   forged line can never consume (void) a real owner approval.
// - File lists come from git (-z, --no-renames, case-folded match) — `gh --json files` truncates at 100 and the
//   host filesystem is case-insensitive (`Prisma/x` lands in `prisma/`).
// - An in-progress marker is written before the merge and removed only after a verified deploy (or a clean
//   merge failure), so a crash or kill in between leaves the executor halted. The STOP file is owner-only: the
//   executor creates it to halt but never deletes it.

import { createHmac, timingSafeEqual } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SIG_PREFIX = "wag-expansion-merge-v1";
export const BOT_AUTHOR = "app/wag-expansion-bot";
export const BASE_BRANCH = "main";
export const REQUIRED_CHECKS = ["guard", "preflight", "test"];
export const MAX_AGE_MS = 72 * 3600 * 1000;
const OK_CHECK = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
const PENDING_CHECK = new Set(["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"]);
const SHA_RE = /^[0-9a-f]{40}$/;
const SIG_RE = /^[0-9a-f]{64}$/;
const SLACK_ID_RE = /^[A-Z0-9]{2,32}$/;
const TS_RE = /^\d{6,12}\.\d{1,9}$/;
const ROLLBACK_NOTE =
  "되돌리기(사람 세션): 릴리스 연결 교체 → 서비스 재시작 → 반영 기록 갱신. rollback.sh 는 이 절차가 아님.";

// Statuses that close one signed click (by its sig). Once a PR+SHA is merged, every later click on it is moot.
// "range-wait" is a notice marker only.
export const TERMINAL = new Set(["rejected", "expired", "failed", "merged", "deployed", "deploy-failed"]);
const MERGED_STATES = new Set(["merged", "deployed", "deploy-failed"]);

export function signatureMessage(d) {
  return [SIG_PREFIX, d.cardId, String(d.pr), d.sha, d.approver, d.channel, d.ts, d.at].join("|");
}

export function verifySignature(d, key) {
  if (typeof d?.sig !== "string" || !SIG_RE.test(d.sig) || !key) return false;
  const want = createHmac("sha256", Buffer.from(key, "utf8")).update(signatureMessage(d), "utf8").digest();
  return timingSafeEqual(want, Buffer.from(d.sig, "hex"));
}

// Paths that must never ship without a human session (deployment.md exception ③, stricter: no
// expansion-loop.sh carve-out). Case-folded: the host filesystem is case-insensitive. Any path outside printable
// ASCII is guarded outright — Unicode case folding (e.g. U+017F «ſ» → s) lets `priſma/…` land in `prisma/`.
export function isForbiddenPath(p) {
  const raw = String(p);
  if (/[^\x20-\x7e]/.test(raw)) return true;
  const s = raw.toLowerCase();
  return (
    s.startsWith("prisma/") ||
    /(^|\/)\.env/.test(s) ||
    s.includes("settlement") ||
    s.startsWith("ygrd-link/") ||
    s.startsWith("infra/")
  );
}

export function isWellFormedMerge(d) {
  return (
    !!d &&
    typeof d === "object" &&
    d.decision === "merge" &&
    Number.isInteger(d.pr) &&
    d.pr > 0 &&
    typeof d.cardId === "string" &&
    new RegExp(`^\\d{8}-merge-pr${d.pr}$`).test(d.cardId) &&
    typeof d.sha === "string" &&
    SHA_RE.test(d.sha) &&
    typeof d.at === "string" &&
    Number.isFinite(Date.parse(d.at)) &&
    typeof d.approver === "string" &&
    SLACK_ID_RE.test(d.approver) &&
    typeof d.channel === "string" &&
    SLACK_ID_RE.test(d.channel) &&
    typeof d.ts === "string" &&
    TS_RE.test(d.ts)
  );
}

export function parseJsonl(text) {
  const out = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") out.push(v);
    } catch {
      // A torn line is skipped; the hermes writer appends whole lines.
    }
  }
  return out;
}

// Classify every merge line. Returns { queue, invalid }:
//   queue   — signed, approver-matching, well-formed clicks not closed yet, oldest first
//   invalid — merge lines failing shape/signature/approver not reported yet (each identified by sig or raw text)
export function selectWork(decisions, doneLines, key, approver) {
  const closedSig = new Set(doneLines.filter((x) => TERMINAL.has(x.status) && x.sig).map((x) => x.sig));
  const mergedPrSha = new Set(doneLines.filter((x) => MERGED_STATES.has(x.status)).map((x) => `${x.pr}:${x.sha}`));
  const reported = new Set(doneLines.filter((x) => x.status === "invalid").map((x) => x.mark));
  const invalid = [];
  const queue = [];
  const seen = new Set();
  for (const d of decisions) {
    if (d.decision !== "merge") continue;
    const ok = isWellFormedMerge(d) && verifySignature(d, key) && (!approver || d.approver === approver);
    if (!ok) {
      const mark = typeof d.sig === "string" && d.sig ? `sig:${d.sig}` : `raw:${JSON.stringify(d).slice(0, 200)}`;
      if (!reported.has(mark) && !seen.has(mark)) invalid.push({ d, mark });
      seen.add(mark);
      continue;
    }
    if (closedSig.has(d.sig) || mergedPrSha.has(`${d.pr}:${d.sha}`) || seen.has(d.sig)) continue;
    seen.add(d.sig);
    queue.push(d);
  }
  queue.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { queue, invalid };
}

// Static PR gates. Returns a rejection reason (Korean, owner-facing) or null.
export function prGateReason(pr, d) {
  if (pr.state !== "OPEN") return `PR 이 열려 있지 않음(${pr.state})`;
  if (pr.author?.login !== BOT_AUTHOR) return "확장 봇이 만든 PR 이 아님";
  if (pr.baseRefName !== BASE_BRANCH) return `대상 브랜치가 main 이 아님(${pr.baseRefName})`;
  if (!String(pr.headRefName ?? "").startsWith("exp/")) return "exp/ 브랜치가 아님";
  if (pr.headRefOid !== d.sha) return "승인 뒤 커밋이 바뀜 — 새 카드로 다시 승인 필요";
  const mergeable = pr.mergeStateStatus === "CLEAN" || (pr.isDraft && pr.mergeStateStatus === "DRAFT");
  if (!mergeable) return `머지 불가 상태(${pr.mergeStateStatus})`;
  return null;
}

// Check rollup → "ok" | "pending" | rejection reason string.
export function checksVerdict(rollup) {
  const checks = (rollup ?? []).map((c) => ({
    name: String(c.name || c.context || ""),
    st: String(c.conclusion || c.state || "").toUpperCase(),
  }));
  const bad = checks.filter((c) => !OK_CHECK.has(c.st) && !PENDING_CHECK.has(c.st));
  if (bad.length) return `검사 미통과: ${bad.map((c) => c.name).join(", ")}`;
  if (checks.some((c) => PENDING_CHECK.has(c.st))) return "pending";
  for (const req of REQUIRED_CHECKS) {
    const hit = checks.filter((c) => c.name === req);
    if (!hit.length) return "pending";
    if (!hit.every((c) => c.st === "SUCCESS")) return `필수 검사 ${req} 가 성공이 아님`;
  }
  return "ok";
}

const zList = (out) => String(out ?? "").split("\0").filter(Boolean);

// deps: { now, readText, appendLine, exists, touch, remove, gh(args)->{rc,out}, git(args)->{rc,out},
//         deploy()->rc, post(card)->bool, log(label, body), paths }
// paths.stop is owner-only (the executor creates it to halt, never deletes it). paths.inprogress marks a merge
// in flight; a leftover one (crash/kill) also halts until a human removes it.
export async function run(deps) {
  const { paths } = deps;
  const decisions = parseJsonl(deps.readText(paths.decisions));
  if (!decisions.some((d) => d.decision === "merge")) return "idle";
  const doneLines = parseJsonl(deps.readText(paths.done));
  const key = (deps.readText(paths.key) ?? "").trim();
  if (!key) {
    deps.log("FAIL", "signing key missing — nothing processed");
    return "no-key";
  }
  const { queue, invalid } = selectWork(decisions, doneLines, key, paths.approver);
  const nowIso = () => new Date(deps.now()).toISOString();
  const notify = (pr, title, body) => {
    if (!deps.post({ id: `note-merge-pr${pr}`, kind: "backlog", title, body })) deps.log("FAIL", `pr=${pr} card post failed`);
  };

  if (deps.exists(paths.stop) || deps.exists(paths.inprogress)) {
    if (queue.length) deps.log("SKIP", `halted (stop or in-progress marker present), ${queue.length} approval(s) waiting`);
    return "stopped";
  }
  if (invalid.length) {
    for (const x of invalid) deps.appendLine(paths.done, { status: "invalid", mark: x.mark, pr: x.d.pr ?? null, at: nowIso() });
    const prs = [...new Set(invalid.map((x) => x.d.pr).filter((n) => Number.isInteger(n)))];
    deps.log("FAIL", `ignored ${invalid.length} malformed/unsigned/mis-signed merge line(s) pr=${prs.join(",") || "?"}`);
    notify(prs[0] ?? 0, "머지 거부 — 승인 기록 서명 불일치",
      `서명이 맞지 않는 머지 승인 기록 ${invalid.length}건을 처리하지 않았습니다(PR ${prs.map((n) => `#${n}`).join(", ") || "알 수 없음"}). 버튼을 누른 적이 없다면 확장 회차 점검이 필요합니다.`);
  }
  let sawTransient = false;
  for (const d of queue) {
    const r = await tryOne(deps, d, doneLines, nowIso, notify);
    if (r === "transient") sawTransient = true;
    else if (r !== "waiting") return r;
  }
  if (sawTransient) return "transient";
  return queue.length ? "waiting" : invalid.length ? "invalid" : "idle";
}

async function tryOne(deps, d, doneLines, nowIso, notify) {
  const { paths } = deps;
  const finish = (status, reason) =>
    deps.appendLine(paths.done, { pr: d.pr, sha: d.sha, sig: d.sig, cardId: d.cardId, status, reason, at: nowIso() });
  const reject = (reason) => {
    finish("rejected", reason);
    deps.log("SKIP", `pr=${d.pr} gate: ${reason}`);
    notify(d.pr, `머지 보류 — PR #${d.pr}`, `머지하지 않았습니다: ${reason}.`);
    return "rejected";
  };

  const age = deps.now() - Date.parse(d.at);
  if (!(age >= 0 && age <= MAX_AGE_MS)) {
    finish("expired", "승인 후 72시간 경과");
    deps.log("SKIP", `pr=${d.pr} approval expired`);
    return "expired";
  }

  const view = deps.gh([
    "pr", "view", String(d.pr), "--json",
    "state,author,baseRefName,headRefName,headRefOid,isDraft,mergeStateStatus,statusCheckRollup,title",
  ]);
  let pr = null;
  try { pr = view.rc === 0 ? JSON.parse(view.out) : null; } catch { pr = null; }
  if (!pr) {
    deps.log("FAIL", `pr=${d.pr} gh view failed (rc=${view.rc}) — will retry`);
    return "transient";
  }
  const gate = prGateReason(pr, d);
  if (gate) return reject(gate);
  const checks = checksVerdict(pr.statusCheckRollup);
  if (checks === "pending") return "waiting";
  if (checks !== "ok") return reject(checks);

  // Authoritative file lists from git. Fetch main and the PR head, and confirm the head is the approved SHA.
  const prRef = `refs/remotes/expansion-merge/pr${d.pr}`;
  const fetched = deps.git(["fetch", "-q", "origin", `+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}`, `+refs/pull/${d.pr}/head:${prRef}`]);
  const head = deps.git(["rev-parse", prRef]);
  if (fetched.rc !== 0 || head.rc !== 0) {
    deps.log("FAIL", `pr=${d.pr} git fetch failed — will retry`);
    return "transient";
  }
  if (head.out.trim() !== d.sha) return reject("승인 뒤 커밋이 바뀜 — 새 카드로 다시 승인 필요");
  const prFiles = deps.git(["diff", "-z", "--no-renames", "--name-only", `origin/${BASE_BRANCH}...${d.sha}`]);
  if (prFiles.rc !== 0) {
    deps.log("FAIL", `pr=${d.pr} PR file list failed — will retry`);
    return "transient";
  }
  const prHit = zList(prFiles.out).filter(isForbiddenPath);
  if (prHit.length) return reject(`사람 세션이 필요한 경로 변경: ${prHit.slice(0, 5).join(", ")}`);

  // Guarded paths between what runs in production and `tip`. A missing link-server marker counts as a hit:
  // release-deploy.sh would then deploy ygrd-link/ unconditionally.
  const rangeHits = (from, tip) => {
    if (!SHA_RE.test(from)) return null;
    const crm = deps.git(["diff", "-z", "--no-renames", "--name-only", from, tip]);
    if (crm.rc !== 0) return null;
    const hits = zList(crm.out).filter(isForbiddenPath);
    const marker = (deps.readText(paths.workerMarker) ?? "").trim();
    if (!SHA_RE.test(marker)) return [...hits, "(ygrd-link 배포 기록 없음)"];
    const w = deps.git(["diff", "-z", "--no-renames", "--name-only", marker, tip, "--", "ygrd-link/"]);
    if (w.rc !== 0) return null;
    return [...hits, ...zList(w.out)];
  };
  const deployedBefore = (deps.readText(paths.deployedSha) ?? "").trim();
  const preHits = rangeHits(deployedBefore, `origin/${BASE_BRANCH}`);
  if (preHits === null) {
    deps.log("FAIL", `pr=${d.pr} cannot read deploy range — will retry`);
    return "transient";
  }
  if (preHits.length) {
    deps.log("SKIP", `pr=${d.pr} deploy range has guarded paths; waiting for a human deploy`);
    if (!doneLines.some((x) => x.status === "range-wait" && x.sig === d.sig)) {
      finish("range-wait", preHits.slice(0, 5).join(", "));
      notify(d.pr, `머지 대기 — PR #${d.pr}`, `함께 배포될 앞선 머지분에 사람 확인이 필요한 경로가 있습니다(${preHits.slice(0, 5).join(", ")}). 메뉴바 「배포하기」로 먼저 반영하시면 이어서 처리합니다.`);
    }
    return "range-guarded";
  }

  // Point of no return: the in-progress marker first, so a crash anywhere below leaves the executor halted.
  deps.touch(paths.inprogress, `pr=${d.pr} sha=${d.sha} at=${nowIso()}\n`);
  if (pr.isDraft && deps.gh(["pr", "ready", String(d.pr)]).rc !== 0) {
    deps.remove(paths.inprogress);
    deps.log("FAIL", `pr=${d.pr} ready failed — will retry`);
    return "transient";
  }
  const merge = deps.gh(["pr", "merge", String(d.pr), "--squash", "--match-head-commit", d.sha]);
  const after = deps.gh(["pr", "view", String(d.pr), "--json", "state,mergeCommit"]);
  let merged = null;
  try { merged = after.rc === 0 ? JSON.parse(after.out) : null; } catch { merged = null; }
  const mergeOid = merged?.mergeCommit?.oid ?? "";
  if (merged?.state !== "MERGED" || !SHA_RE.test(mergeOid)) {
    if (merged?.state === "OPEN") {
      deps.remove(paths.inprogress);
      finish("failed", `머지 실패(rc=${merge.rc})`);
      deps.log("FAIL", `pr=${d.pr} merge failed rc=${merge.rc}`);
      notify(d.pr, `머지 실패 — PR #${d.pr}`, "머지 명령이 실패했습니다. 운영은 바뀌지 않았습니다. 사람 세션에서 확인이 필요합니다.");
      return "merge-failed";
    }
    deps.touch(paths.stop, `pr=${d.pr} merge state unknown\n`);
    deps.log("FAIL", `pr=${d.pr} merge state unknown (rc=${merge.rc}); halted`);
    notify(d.pr, `머지 상태 확인 불가 — PR #${d.pr}`, "머지 결과를 확인하지 못해 실행기를 멈췄습니다. 사람 세션에서 PR 상태를 확인하고 정지·진행 중 표지를 지워야 다시 돕니다.");
    return "merge-unknown";
  }
  finish("merged", "");

  const halt = (why, title, body) => {
    deps.touch(paths.stop, `pr=${d.pr} merge=${mergeOid} ${why}\n`);
    deps.remove(paths.inprogress);
    finish("deploy-failed", why);
    deps.log("FAIL", `pr=${d.pr} merged ${mergeOid.slice(0, 8)} but ${why}; halted`);
    notify(d.pr, title, `${body} 실행기를 멈췄습니다 — 사람 세션에서 확인 후 정지 표지를 지워야 다시 돕니다. ${ROLLBACK_NOTE}`);
    return "deploy-failed";
  };
  const refetch = deps.git(["fetch", "-q", "origin", `+refs/heads/${BASE_BRANCH}:refs/remotes/origin/${BASE_BRANCH}`]);
  const onMain = refetch.rc === 0 && deps.git(["merge-base", "--is-ancestor", mergeOid, `origin/${BASE_BRANCH}`]).rc === 0;
  if (!onMain) return halt("merge commit not on origin/main", `배포 보류 — PR #${d.pr} 은 머지됨`, "머지 커밋이 main 에 있는지 확인하지 못했습니다.");
  const postHits = rangeHits(deployedBefore, `origin/${BASE_BRANCH}`);
  if (postHits === null || postHits.length)
    return halt(`guarded paths in range after merge (${(postHits ?? ["unreadable"]).slice(0, 3).join(", ")})`,
      `배포 보류 — PR #${d.pr} 은 머지됨`, "머지 사이에 사람 확인이 필요한 경로가 함께 배포될 구간에 들어왔습니다.");

  const deployRc = deps.deploy();
  deps.git(["fetch", "-q", "origin"]);
  const deployedAfter = (deps.readText(paths.deployedSha) ?? "").trim();
  const contains = SHA_RE.test(deployedAfter) && deps.git(["merge-base", "--is-ancestor", mergeOid, deployedAfter]).rc === 0;
  if (deployRc !== 0 || !contains)
    return halt(`deploy rc=${deployRc} contains=${contains}`, `배포 실패 — PR #${d.pr} 은 머지됨`,
      `머지는 됐지만 운영 반영이 확인되지 않았습니다(배포 종료코드 ${deployRc}).`);
  // main may have moved between our check and the deploy's own fetch: re-check what actually shipped.
  const shipped = rangeHits(deployedBefore, deployedAfter);
  if (shipped === null || shipped.length)
    return halt(`shipped range has guarded paths (${(shipped ?? ["unreadable"]).slice(0, 3).join(", ")})`,
      `배포 확인 필요 — PR #${d.pr}`, "배포는 끝났지만, 확인 뒤 main 에 들어온 변경 중 사람 확인이 필요한 경로가 함께 나갔습니다.");

  deps.remove(paths.inprogress);
  finish("deployed", "");
  deps.log("OK", `pr=${d.pr} merged ${mergeOid.slice(0, 8)} and deployed`);
  notify(d.pr, `머지·배포 완료 — PR #${d.pr}`, `${pr.title ?? ""}\n운영에 반영됐습니다. 머지 뒤 따로 할 일이 카드에 적혀 있었다면 그것은 아직 남아 있습니다. ${ROLLBACK_NOTE}`);
  return "deployed";
}

// ── real wiring ─────────────────────────────────────────────────────────────

const BASE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function readEnvValue(file, name) {
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && m[1] === name) return m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch { /* missing file → empty */ }
  return "";
}

function realDeps() {
  const home = homedir();
  const expDir = process.env.WAG_EXPANSION_DIR || join(home, ".hermes/expansion");
  const repo = process.env.EXPANSION_MERGE_REPO || join(home, "selfhost/wagcrm");
  const hermes = process.env.EXPANSION_HERMES_DIR || join(home, ".hermes/hermes-agent");
  const logs = join(home, "selfhost/logs");
  const logPath = process.env.EXPANSION_LOG || join(logs, "cron.log");
  const ghUser = process.env.EXPANSION_MERGE_GH_USER || "indexzigu";
  // Minimal environments: never hand the loop's secrets (expansion.env) to gh, git, deploy or npm.
  const baseEnv = { PATH: BASE_PATH, HOME: home, USER: process.env.USER ?? "", LANG: "en_US.UTF-8" };
  let ghToken = null;
  const token = () => {
    if (ghToken) return ghToken;
    const r = spawnSync("gh", ["auth", "token", "--user", ghUser], { encoding: "utf8", env: baseEnv });
    const t = (r.stdout ?? "").trim();
    if (r.status !== 0 || !t) throw new Error(`gh token for ${ghUser} unavailable`); // fail closed
    ghToken = t;
    return t;
  };
  const sh = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, env: baseEnv, ...opts });
    return { rc: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
  };
  const stamp = () => {
    const s = new Date();
    return `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")} ${s.toTimeString().slice(0, 8)}`;
  };
  return {
    now: () => Date.now(),
    readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } },
    exists: (p) => existsSync(p),
    appendLine: (p, obj) => { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, JSON.stringify(obj) + "\n"); },
    touch: (p, text) => writeFileSync(p, text),
    remove: (p) => rmSync(p, { force: true }),
    gh: (args) => sh("gh", [...args, "--repo", "indexzigu/wagcrm_git"], { cwd: repo, env: { ...baseEnv, GH_TOKEN: token() } }),
    git: (args) => sh("git", ["-C", repo, ...args]),
    deploy: () => {
      const r = sh("bash", [join(repo, "infra/selfhost/release-deploy.sh")], { timeout: 45 * 60 * 1000 });
      mkdirSync(logs, { recursive: true });
      appendFileSync(join(logs, "expansion-merge-deploy.log"), `[${stamp()}] rc=${r.rc}\n${r.out}${r.err}\n`);
      return r.rc;
    },
    post: (card) => {
      const channel = readEnvValue(join(home, "selfhost/expansion.env"), "WAG_EXPANSION_CHANNEL_ID");
      if (!channel) return false;
      const dir = mkdtempSync(join(tmpdir(), "exp-merge-card-"));
      try {
        const n = new Date();
        const date = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
        const file = join(dir, "cards.json");
        writeFileSync(file, JSON.stringify({ date, cards: [{ ...card, id: `${date.replaceAll("-", "")}-${card.id}` }] }));
        const r = sh(join(hermes, ".venv/bin/python"), [join(hermes, "plugins/wag-operator/expansion_cards.py"), "post", file],
          { timeout: 120 * 1000, env: { ...baseEnv, WAG_EXPANSION_CHANNEL_ID: channel } });
        return r.rc === 0;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    log: (label, body) => {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `[${stamp()}] ${label} expansion-merge ${String(body).replace(/[\x00-\x1f]/g, " ").slice(0, 400)}\n`);
    },
    paths: {
      decisions: join(expDir, "decisions.jsonl"),
      done: join(expDir, "merge-done.jsonl"),
      key: process.env.WAG_EXPANSION_MERGE_KEY_FILE || join(home, "selfhost/expansion-merge.key"),
      stop: process.env.EXPANSION_MERGE_STOP || join(home, "selfhost/expansion-merge.STOP"),
      inprogress: join(home, "selfhost/expansion-merge.INPROGRESS"),
      deployedSha: join(logs, "deployed.sha"),
      workerMarker: join(logs, "deployed.ygrd-link.sha"),
      // Read only this one value from the hermes env file (it holds other secrets we must not load).
      approver: process.env.WAG_SLACK_APPROVER_USER_ID || readEnvValue(join(home, ".hermes/.env"), "WAG_SLACK_APPROVER_USER_ID"),
    },
  };
}

// Single-instance lock (a deploy can outlast the 10-minute cadence). A dead holder's lock is reclaimed.
function withLock(lockDir, fn) {
  try {
    mkdirSync(lockDir);
  } catch {
    let pid = 0;
    try { pid = Number(readFileSync(join(lockDir, "pid"), "utf8")); } catch { /* holder has not written pid yet */ }
    if (!(pid > 0)) {
      // A pid-less lock older than an hour is a crashed holder, not one about to write its pid.
      let age = 0;
      try { age = Date.now() - statSync(lockDir).mtimeMs; } catch { /* vanished */ }
      if (age < 3600 * 1000) return Promise.resolve("locked");
    } else {
      try { process.kill(pid, 0); return Promise.resolve("locked"); } catch { /* holder is gone */ }
    }
    rmSync(lockDir, { recursive: true, force: true });
    try { mkdirSync(lockDir); } catch { return Promise.resolve("locked"); }
  }
  writeFileSync(join(lockDir, "pid"), String(process.pid));
  return Promise.resolve().then(fn).finally(() => rmSync(lockDir, { recursive: true, force: true }));
}

const FAILING = new Set(["deploy-failed", "merge-failed", "merge-unknown", "no-key", "transient", "invalid"]);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const deps = realDeps();
  const lock = process.env.EXPANSION_MERGE_LOCK || join(homedir(), "selfhost/expansion-merge.lock");
  withLock(lock, () => run(deps))
    .then((r) => process.exit(FAILING.has(r) ? 1 : 0))
    .catch((e) => {
      deps.log("FAIL", `crash: ${e?.message ?? e}`);
      process.exit(1);
    });
}
