import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import * as M from "../../infra/selfhost/expansion-merge.mjs";

const KEY = "a".repeat(64);
const SHA = "1".repeat(40);
const DEPLOYED = "2".repeat(40);
const MERGED = "3".repeat(40);
const NOW = Date.parse("2026-11-24T12:00:00Z");
const TIP = "5".repeat(40);
const MARKER = "4".repeat(40);
const DEPLOY_ID = `20261124-deploy-${TIP.slice(0, 8)}-${DEPLOYED.slice(0, 8)}`;
const DEPLOY_ID_RE = /^\d{8}-deploy-[0-9a-f]{8}-[0-9a-f]{8}$/;

function hmac(msg: string, key = KEY) {
  return createHmac("sha256", Buffer.from(key, "utf8")).update(msg, "utf8").digest("hex");
}
function signedDeploy(over: Record<string, unknown> = {}, key = KEY, prefix = "wag-expansion-deploy-v1") {
  const d: Record<string, unknown> = {
    date: "2026-11-24", cardId: DEPLOY_ID, decision: "deploy", at: "2026-11-24T11:00:00Z",
    from: DEPLOYED, tip: TIP, marker: MARKER, approver: "U123", channel: "C123", ts: "1732400000.000200", ...over,
  };
  d.sig = hmac([prefix, d.cardId, d.from, d.tip, d.marker, d.approver, d.channel, d.ts, d.at].join("|"), key);
  return d;
}
const cardLine = (over: Record<string, unknown> = {}) => ({
  status: "deploy-card", cardId: DEPLOY_ID, from: DEPLOYED, tip: TIP, marker: MARKER, at: "2026-11-24T10:00:00Z", ...over,
});

function signed(over: Record<string, unknown> = {}, key = KEY) {
  const d: Record<string, unknown> = {
    date: "2026-11-24", cardId: "20261124-merge-pr309", decision: "merge", at: "2026-11-24T11:00:00Z",
    pr: 309, sha: SHA, approver: "U123", channel: "C123", ts: "1732400000.000100", ...over,
  };
  const msg = ["wag-expansion-merge-v1", d.cardId, String(d.pr), d.sha, d.approver, d.channel, d.ts, d.at].join("|");
  d.sig = createHmac("sha256", Buffer.from(key, "utf8")).update(msg, "utf8").digest("hex");
  return d;
}

const REQUIRED = [
  { name: "guard", conclusion: "SUCCESS" }, { name: "preflight", conclusion: "SUCCESS" }, { name: "test", conclusion: "SUCCESS" },
];
const goodPr = (over: Record<string, unknown> = {}) => ({
  state: "OPEN", author: { login: "app/wag-expansion-bot" }, baseRefName: "main", headRefName: "exp/acq", headRefOid: SHA,
  isDraft: true, mergeStateStatus: "CLEAN", title: "#309 feat: x", statusCheckRollup: REQUIRED, ...over,
});

type Opts = {
  decisions?: unknown[]; done?: unknown[]; pr?: unknown; prRc?: number; prFiles?: string[]; range?: string[];
  rangeAfter?: string[]; worker?: string[]; workerMarker?: string; deployRc?: number; mergedState?: string;
  stop?: boolean; inprogress?: boolean; key?: string; containsRc?: number; head?: string; onMainRc?: number;
  shippedExtra?: string[]; prSeq?: unknown[]; tip?: string; deployedSha?: string; deployTo?: string; commits?: string[]; tipAfterDeploy?: string;
};
function harness(o: Opts) {
  const files: Record<string, string> = {
    dec: (o.decisions ?? []).map((x) => JSON.stringify(x)).join("\n"),
    done: (o.done ?? []).map((x) => JSON.stringify(x)).join("\n"),
    key: o.key ?? KEY,
    dsha: o.deployedSha ?? DEPLOYED,
    wmark: o.workerMarker ?? MARKER,
  };
  const gh: string[][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const posts: any[] = [];
  const logs: string[] = [];
  let deployed = 0;
  let stop = !!o.stop;
  let inprogress = !!o.inprogress;
  let viewN = 0;
  let tipNow = o.tip ?? TIP;
  const deployOpts: unknown[] = [];
  let merged = false;
  const z = (xs: string[]) => xs.join("\0") + (xs.length ? "\0" : "");
  const deps = {
    now: () => NOW,
    readText: (p: string) => files[p] ?? "",
    exists: (p: string) => (p === "stop" && stop) || (p === "inprogress" && inprogress),
    appendLine: (p: string, obj: unknown) => { files[p] = (files[p] ? files[p] + "\n" : "") + JSON.stringify(obj); },
    touch: (p: string) => { if (p === "stop") stop = true; if (p === "inprogress") inprogress = true; },
    claim: (p: string) => {
      if (p !== "inprogress") return true;
      if (inprogress) return false;
      inprogress = true;
      return true;
    },
    remove: (p: string) => { if (p === "stop") stop = false; if (p === "inprogress") inprogress = false; },
    gh: (args: string[]) => {
      gh.push(args);
      if (args[1] === "view" && args.includes("state,mergeCommit"))
        return { rc: 0, out: JSON.stringify(o.mergedState ? { state: o.mergedState, mergeCommit: null } : { state: "MERGED", mergeCommit: { oid: MERGED } }) };
      if (args[1] === "view") {
        const seq = o.prSeq ? o.prSeq[Math.min(viewN++, o.prSeq.length - 1)] : (o.pr ?? goodPr());
        return { rc: o.prRc ?? 0, out: JSON.stringify(seq) };
      }
      if (args[1] === "merge") merged = true;
      return { rc: 0, out: "" };
    },
    git: (args: string[]) => {
      if (args[0] === "rev-parse") return { rc: 0, out: `${args[1] === "origin/main" ? tipNow : (o.head ?? SHA)}\n` };
      if (args[0] === "log") return { rc: 0, out: (o.commits ?? ["abc1234 feat: earlier merge"]).join("\n") + "\n" };
      if (args[0] === "diff") {
        if (args.includes("ygrd-link/")) return { rc: 0, out: z(o.worker ?? []) };
        if (String(args[4]).includes("...")) return { rc: 0, out: z(o.prFiles ?? ["src/app/outreach/page.tsx"]) };
        if (args[5] === MERGED) return { rc: 0, out: z(["src/app/page.tsx", ...(o.shippedExtra ?? [])]) };
        return { rc: 0, out: z(merged ? (o.rangeAfter ?? o.range ?? ["src/app/page.tsx"]) : (o.range ?? ["src/app/page.tsx"])) };
      }
      if (args[0] === "merge-base") {
        if (args[3] === "origin/main") return { rc: o.onMainRc ?? 0, out: "" };
        return { rc: o.containsRc ?? 0, out: "" };
      }
      return { rc: 0, out: "" };
    },
    deploy: (opts?: unknown) => {
      deployed++; deployOpts.push(opts); files.dsha = o.deployTo ?? MERGED;
      if (o.tipAfterDeploy) tipNow = o.tipAfterDeploy;
      return o.deployRc ?? 0;
    },
    post: (c: unknown) => { posts.push(c); return true; },
    log: (label: string, body: string) => logs.push(`${label} ${body}`),
    paths: { decisions: "dec", done: "done", key: "key", stop: "stop", inprogress: "inprogress", deployedSha: "dsha", workerMarker: "wmark", approver: "U123" },
  };
  return {
    deps, gh, posts, logs, files, deployOpts,
    get deployed() { return deployed; }, get stop() { return stop; }, get inprogress() { return inprogress; }, get merged() { return merged; },
  };
}

describe("expansion-merge signature", () => {
  it("matches the hermes signer's known-answer vector", () => {
    const d = {
      cardId: "20261124-merge-pr42", pr: 42, sha: "0123456789abcdef0123456789abcdef01234567", approver: "UAPPROVER01",
      channel: "C0EXPANSION", ts: "1710000001.000100", at: "2027-01-15T08:00:10Z",
      sig: "2a53df5092d00c90a29727e8d217cf2bf8f7c565f820180d285244d701ef58b1",
    };
    expect(M.verifySignature(d, "ab".repeat(32))).toBe(true);
  });
  it("rejects any tampered field or wrong key", () => {
    const d = signed();
    expect(M.verifySignature(d, KEY)).toBe(true);
    for (const k of ["cardId", "sha", "approver", "channel", "ts", "at"])
      expect(M.verifySignature({ ...d, [k]: `${d[k]}x` }, KEY)).toBe(false);
    expect(M.verifySignature({ ...d, pr: 310 }, KEY)).toBe(false);
    expect(M.verifySignature(d, "b".repeat(64))).toBe(false);
  });
});

describe("expansion-merge forbidden paths", () => {
  it.each(["prisma/schema.prisma", "Prisma/migrations/x/migration.sql", ".env", "apps/.ENV.local",
    "src/lib/Settlement/x.ts", "ygrd-link/a.ts", "Infra/selfhost/expansion-merge.mjs", "pri\u017fma/migrations/x.sql", "src/\uD55C.ts"])("%s is guarded", (p) =>
    expect(M.isForbiddenPath(p)).toBe(true));
  it("ordinary app code is not", () => expect(M.isForbiddenPath("src/app/outreach/page.tsx")).toBe(false));
});

describe("expansion-merge checks verdict", () => {
  it("requires guard, preflight and test to succeed", () => {
    expect(M.checksVerdict(REQUIRED)).toBe("ok");
    expect(M.checksVerdict(REQUIRED.slice(0, 2))).toBe("pending");
    expect(M.checksVerdict([...REQUIRED.slice(0, 2), { name: "test", conclusion: "SKIPPED" }])).toMatch(/test/);
    expect(M.checksVerdict([...REQUIRED, { name: "x", state: "PENDING" }])).toBe("pending");
    expect(M.checksVerdict([...REQUIRED, { name: "x", conclusion: "FAILURE" }])).toMatch(/미통과/);
  });
});

describe("expansion-merge run", () => {
  it("is silent when there are no merge decisions", async () => {
    const h = harness({ decisions: [{ cardId: "20261124-x", decision: "adopt" }] });
    expect(await M.run(h.deps)).toBe("idle");
    expect(h.logs).toEqual([]);
    expect(h.gh).toEqual([]);
  });

  it("happy path: ready, merge bound to the approved SHA, deploy, clear STOP, record, notify", async () => {
    const h = harness({ decisions: [signed()] });
    expect(await M.run(h.deps)).toBe("deployed");
    expect(h.gh.some((a) => a[1] === "ready")).toBe(true);
    expect(h.gh.find((a) => a[1] === "merge")).toEqual(["pr", "merge", "309", "--squash", "--match-head-commit", SHA]);
    expect(h.deployed).toBe(1);
    expect(h.stop).toBe(false);
    expect(h.files.done).toContain('"status":"deployed"');
    expect(h.posts.at(-1)!.title).toContain("머지·배포 완료");
  });

  it("a forged line neither touches GitHub nor voids the real approval for the same PR+SHA", async () => {
    const forged = { ...signed(), sig: "0".repeat(64) };
    const h = harness({ decisions: [forged, signed()] });
    expect(await M.run(h.deps)).toBe("deployed");
    expect(h.deployed).toBe(1);
    expect(await M.run(h.deps)).toBe("idle");
    expect(h.posts).toHaveLength(2);
  });

  it("refuses everything when the key is missing", async () => {
    const h = harness({ decisions: [signed()], key: "" });
    expect(await M.run(h.deps)).toBe("no-key");
    expect(h.gh).toEqual([]);
  });

  it("refuses everything when the approver id is missing (fail closed, not 'any approver')", async () => {
    const h = harness({ decisions: [signed()] });
    h.deps.paths.approver = "";
    expect(await M.run(h.deps)).toBe("no-approver");
    expect(h.gh).toEqual([]);
    expect(h.deployed).toBe(0);
    expect(M.selectWork([signed()], [], KEY, "").queue).toEqual([]);
  });

  it.each([
    ["approver mismatch", { approver: "U999" }],
    ["cardId not bound to pr", { cardId: "20261124-merge-pr1" }],
    ["unsigned key", null],
  ])("invalid: %s", async (_n, over) => {
    const d = over ? signed(over) : signed({}, "b".repeat(64));
    const h = harness({ decisions: [d] });
    expect(await M.run(h.deps)).toBe("invalid");
    expect(h.gh).toEqual([]);
    expect(await M.run(h.deps)).toBe("idle");
  });

  it("expires approvals older than 72h", async () => {
    const h = harness({ decisions: [signed({ at: "2026-11-20T00:00:00Z" })] });
    expect(await M.run(h.deps)).toBe("expired");
    expect(h.gh).toEqual([]);
  });

  it.each([
    ["head moved after approval", { headRefOid: "9".repeat(40) }],
    ["not the bot", { author: { login: "someone" } }],
    ["base is not main", { baseRefName: "release" }],
    ["not exp/", { headRefName: "feature/x" }],
    ["failing check", { statusCheckRollup: [...REQUIRED, { name: "lint", conclusion: "FAILURE" }] }],
    ["conflict", { mergeStateStatus: "DIRTY" }],
    ["closed", { state: "CLOSED" }],
  ])("gate: %s → rejected, no merge, no deploy", async (_n, over) => {
    const h = harness({ decisions: [signed()], pr: goodPr(over) });
    expect(await M.run(h.deps)).toBe("rejected");
    expect(h.merged).toBe(false);
    expect(h.deployed).toBe(0);
  });

  it("pending checks wait without closing the decision", async () => {
    const h = harness({ decisions: [signed()], pr: goodPr({ statusCheckRollup: [{ name: "guard", state: "PENDING" }] }) });
    expect(await M.run(h.deps)).toBe("waiting");
    expect(h.files.done).toBe("");
    expect(h.posts).toEqual([]);
  });

  it("gh outage is transient (decision stays pending)", async () => {
    const h = harness({ decisions: [signed()], prRc: 1 });
    expect(await M.run(h.deps)).toBe("transient");
    expect(h.files.done).toBe("");
  });

  it("guarded path found by git (beyond gh's 100-file cap, any case) rejects", async () => {
    const many = Array.from({ length: 150 }, (_, i) => `src/f${i}.ts`);
    const h = harness({ decisions: [signed()], prFiles: [...many, "Prisma/schema.prisma"] });
    expect(await M.run(h.deps)).toBe("rejected");
    expect(h.merged).toBe(false);
  });

  it("fetched PR head differing from the approved SHA rejects", async () => {
    const h = harness({ decisions: [signed()], head: "8".repeat(40) });
    expect(await M.run(h.deps)).toBe("rejected");
    expect(h.merged).toBe(false);
  });

  it("guarded paths already in the deploy range: wait, notify once", async () => {
    const h = harness({ decisions: [signed()], range: ["src/a.ts", "prisma/migrations/x/migration.sql"] });
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(h.merged).toBe(false);
    expect(h.posts).toHaveLength(1);
  });

  it("undeployed link-server changes since its own marker also block", async () => {
    const h = harness({ decisions: [signed()], workerMarker: "4".repeat(40), worker: ["ygrd-link/src/index.ts"] });
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(h.merged).toBe(false);
  });

  it("guarded paths entering the range between check and merge: merged but halted before deploy", async () => {
    const h = harness({ decisions: [signed()], rangeAfter: ["prisma/x.sql"] });
    expect(await M.run(h.deps)).toBe("deploy-failed");
    expect(h.deployed).toBe(0);
    expect(h.stop).toBe(true);
  });

  it("merge commit not on origin/main halts before deploy", async () => {
    const h = harness({ decisions: [signed()], onMainRc: 1 });
    expect(await M.run(h.deps)).toBe("deploy-failed");
    expect(h.deployed).toBe(0);
    expect(h.stop).toBe(true);
  });

  it("deploy failure keeps STOP; the next run does nothing", async () => {
    const h = harness({ decisions: [signed(), signed({ pr: 313, cardId: "20261124-merge-pr313" })], deployRc: 1 });
    expect(await M.run(h.deps)).toBe("deploy-failed");
    expect(h.stop).toBe(true);
    const n = h.gh.length;
    expect(await M.run(h.deps)).toBe("stopped");
    expect(h.gh.length).toBe(n);
  });

  it("deploy that does not contain the merge commit also halts", async () => {
    const h = harness({ decisions: [signed()], containsRc: 1 });
    expect(await M.run(h.deps)).toBe("deploy-failed");
    expect(h.stop).toBe(true);
  });

  it("clean merge failure (still OPEN) clears STOP and records failed", async () => {
    const h = harness({ decisions: [signed()], mergedState: "OPEN" });
    expect(await M.run(h.deps)).toBe("merge-failed");
    expect(h.stop).toBe(false);
    expect(h.deployed).toBe(0);
  });

  it("unknown merge state keeps STOP", async () => {
    const h = harness({ decisions: [signed()], mergedState: "WEIRD" });
    expect(await M.run(h.deps)).toBe("merge-unknown");
    expect(h.stop).toBe(true);
  });

  it("processes one decision per run and never the same PR+SHA twice", async () => {
    const h = harness({ decisions: [signed(), signed({ pr: 313, cardId: "20261124-merge-pr313" }), signed()] });
    expect(await M.run(h.deps)).toBe("deployed");
    expect(h.deployed).toBe(1);
    expect(await M.run(h.deps)).toBe("deployed");
    expect(await M.run(h.deps)).toBe("idle");
    expect(h.deployed).toBe(2);
  });

  it("tolerates junk ledger lines", async () => {
    const h = harness({ decisions: [signed()] });
    h.files.done = "null\n42\n{bad json";
    expect(await M.run(h.deps)).toBe("deployed");
  });

  it("happy path leaves no in-progress marker and never deletes an owner STOP made later", async () => {
    const h = harness({ decisions: [signed()] });
    expect(await M.run(h.deps)).toBe("deployed");
    expect(h.inprogress).toBe(false);
  });

  it("a leftover in-progress marker (crash) halts", async () => {
    const h = harness({ decisions: [signed()], inprogress: true });
    expect(await M.run(h.deps)).toBe("stopped");
    expect(h.gh).toEqual([]);
  });

  it("missing link-server marker counts as a guarded range", async () => {
    const h = harness({ decisions: [signed()], workerMarker: "" });
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(h.merged).toBe(false);
  });

  it("a PR waiting on checks does not block a newer ready approval", async () => {
    const waiting = goodPr({ statusCheckRollup: [{ name: "guard", state: "PENDING" }] });
    const h = harness({
      decisions: [signed(), signed({ pr: 313, cardId: "20261124-merge-pr313", at: "2026-11-24T11:30:00Z" })],
      prSeq: [waiting, goodPr()],
    });
    expect(await M.run(h.deps)).toBe("deployed");
    expect(h.gh.find((a) => a[1] === "merge")![2]).toBe("313");
  });

  it("a new click on the same SHA after a rejection is processed", async () => {
    const first = signed();
    const h = harness({
      decisions: [first, signed({ ts: "1732400999.000100", at: "2026-11-24T11:50:00Z" })],
      prSeq: [goodPr({ mergeStateStatus: "BLOCKED" }), goodPr()],
    });
    expect(await M.run(h.deps)).toBe("rejected");
    expect(await M.run(h.deps)).toBe("deployed");
  });

  it("draft PRs reporting DRAFT merge state are allowed (made ready first)", async () => {
    const h = harness({ decisions: [signed()], pr: goodPr({ mergeStateStatus: "DRAFT" }) });
    expect(await M.run(h.deps)).toBe("deployed");
    expect(h.gh.some((a) => a[1] === "ready")).toBe(true);
  });

  it("guarded paths that shipped because main moved before the deploy halt afterwards", async () => {
    const h = harness({ decisions: [signed()], shippedExtra: ["prisma/x.sql"] });
    expect(await M.run(h.deps)).toBe("deploy-failed");
    expect(h.deployed).toBe(1);
    expect(h.stop).toBe(true);
  });
});

describe("expansion-merge deploy signature", () => {
  it("matches an independently computed known-answer vector (hermes signer must produce the same)", () => {
    const d = {
      cardId: "20270115-deploy-89abcdef-01234567", from: "0123456789abcdef0123456789abcdef01234567",
      tip: "89abcdef0123456789abcdef0123456789abcdef", marker: "fedcba9876543210fedcba9876543210fedcba98",
      approver: "UAPPROVER01", channel: "C0EXPANSION", ts: "1710000001.000100", at: "2027-01-15T08:00:10Z",
      sig: "1f71eed042129d94b747d98b9750288a524f88fd9a0f7e730a6ebb16f968f108",
    };
    expect(M.deploySignatureMessage(d)).toBe(
      "wag-expansion-deploy-v1|20270115-deploy-89abcdef-01234567|0123456789abcdef0123456789abcdef01234567|89abcdef0123456789abcdef0123456789abcdef|fedcba9876543210fedcba9876543210fedcba98|UAPPROVER01|C0EXPANSION|1710000001.000100|2027-01-15T08:00:10Z");
    expect(M.verifyDeploySignature(d, "ab".repeat(32))).toBe(true);
  });
  it("rejects any tampered field", () => {
    const d = signedDeploy();
    expect(M.verifyDeploySignature(d, KEY)).toBe(true);
    for (const k of ["cardId", "from", "tip", "marker", "approver", "channel", "ts", "at"])
      expect(M.verifyDeploySignature({ ...d, [k]: `${d[k]}x` }, KEY)).toBe(false);
  });
  it("domain separation: a merge-prefix MAC never verifies as deploy, nor a deploy MAC as merge", () => {
    expect(M.verifyDeploySignature(signedDeploy({}, KEY, "wag-expansion-merge-v1"), KEY)).toBe(false);
    const merge = signed();
    expect(M.verifyDeploySignature({ ...merge, decision: "deploy", from: DEPLOYED, tip: TIP, marker: MARKER }, KEY)).toBe(false);
    const dep = signedDeploy();
    expect(M.verifySignature({ ...dep, decision: "merge", pr: 309, sha: SHA }, KEY)).toBe(false);
  });
  it("card id must embed tip[:8] and from[:8]", () => {
    expect(M.isWellFormedDeploy(signedDeploy())).toBe(true);
    expect(M.isWellFormedDeploy(signedDeploy({ cardId: `20261124-deploy-${"6".repeat(8)}-${DEPLOYED.slice(0, 8)}` }))).toBe(false);
    expect(M.isWellFormedDeploy(signedDeploy({ at: "2026-11-24T11:00:00.000Z" }))).toBe(false);
  });
});

describe("expansion-merge deploy card payload", () => {
  it("deploy card keeps its own date and full id; notes get the date prefix", () => {
    const built = M.buildDeployCard({ date: "2026-11-24", from: DEPLOYED, tip: TIP, marker: MARKER, hits: ["prisma/x.sql"], commits: [] });
    const p = M.cardsPayload(built.card, NOW);
    expect(p.date).toBe("2026-11-24");
    expect(p.cards).toHaveLength(1);
    expect(p.cards[0]).toMatchObject({ id: DEPLOY_ID, kind: "deploy", from: DEPLOYED, tip: TIP, marker: MARKER });
    expect(p.cards[0].id).toMatch(DEPLOY_ID_RE);
    expect(Object.keys(p.cards[0]).sort()).toEqual(["body", "from", "id", "kind", "marker", "tip", "title"]);
    const n = M.cardsPayload({ id: "note-merge-pr1", kind: "backlog", title: "t", body: "b" }, NOW);
    expect(n.cards[0].id).toBe(`${M.localDate(NOW).replaceAll("-", "")}-note-merge-pr1`);
  });
});

describe("expansion-merge deploy card (merge path)", () => {
  const prisma = ["src/a.ts", "prisma/migrations/x/migration.sql"];
  const deployCards = (h: ReturnType<typeof harness>) => h.posts.filter((c) => c.kind === "deploy");

  it("posts one deploy card per (from, tip, marker) triple and keeps the merge waiting", async () => {
    const h = harness({ decisions: [signed()], range: prisma, commits: ["abc1234 feat: earlier", "def5678 fix: migration"] });
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(h.merged).toBe(false);
    expect(h.deployed).toBe(0);
    expect(h.posts).toHaveLength(1);
    const [card] = deployCards(h);
    const id = `${M.localDate(NOW).replaceAll("-", "")}-deploy-${TIP.slice(0, 8)}-${DEPLOYED.slice(0, 8)}`;
    expect(card).toMatchObject({ id, kind: "deploy", from: DEPLOYED, tip: TIP, marker: MARKER });
    expect(card.id).toMatch(DEPLOY_ID_RE);
    expect(card.body).toContain("prisma/migrations/x/migration.sql");
    expect(card.body).toContain("운영 DB 에 자동 적용, 되돌릴 수 없음");
    expect(card.body).toContain("def5678 fix: migration");
    expect(card.body).toContain(DEPLOYED);
    expect(card.body).toContain(TIP);
    expect(card.body).toContain(MARKER);
    const lines = h.files.done.split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((x) => x.status === "deploy-card")).toEqual([
      expect.objectContaining({ cardId: id, from: DEPLOYED, tip: TIP, marker: MARKER }),
    ]);
    expect(lines.filter((x) => x.status === "range-wait")).toHaveLength(1);
  });

  it("a new tip under the same waiting approval gets a fresh card", async () => {
    const d = signed();
    const old = "6".repeat(40);
    const h = harness({
      decisions: [d], range: prisma,
      done: [{ status: "range-wait", sig: d.sig, pr: 309 }, cardLine({ tip: old, cardId: `20261124-deploy-${old.slice(0, 8)}-${DEPLOYED.slice(0, 8)}` })],
    });
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(deployCards(h)).toHaveLength(1);
    expect(deployCards(h)[0].tip).toBe(TIP);
  });

  it("a failed post is retried next run and not recorded", async () => {
    const h = harness({ decisions: [signed()], range: prisma });
    h.deps.post = () => false;
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(h.files.done).not.toContain("deploy-card");
  });

  it("caps commits at 20 with a remainder line and escapes non-ASCII paths", async () => {
    const commits = Array.from({ length: 25 }, (_, i) => `c${String(i).padStart(6, "0")} feat: ${i}`);
    const h = harness({ decisions: [signed()], range: ["src/\uD55C.ts", "infra/selfhost/release-deploy.sh"], commits });
    expect(await M.run(h.deps)).toBe("range-guarded");
    const [card] = deployCards(h);
    expect(card.body).toContain("src/\\ud55c.ts");
    expect(card.body).not.toContain("src/\uD55C.ts");
    expect(card.body).toContain("c000019 feat: 19");
    expect(card.body).not.toContain("c000020 feat: 20");
    expect(card.body).toContain("외 5건");
    expect(card.body).toContain("새 동작은 다음 배포부터");
  });

  it("fits the body under MAX_BODY measured after &<> escaping by trimming commits, never paths", async () => {
    const commits = Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(6, "0")} ${"&<>".repeat(30)}`);
    const h = harness({ decisions: [signed()], range: ["prisma/a&b.sql", "prisma/<x>.sql"], commits });
    expect(await M.run(h.deps)).toBe("range-guarded");
    const [card] = deployCards(h);
    const escaped = card.body.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    expect(escaped.length).toBeLessThanOrEqual(M.MAX_BODY);
    expect(card.body).toContain("prisma/a&b.sql");
    expect(card.body).toContain("prisma/<x>.sql");
    expect(card.body).toMatch(/… 외 \d+건/);
    expect(card.title.length).toBeLessThanOrEqual(120);
  });

  it("strips control and bidi-override characters from commit subjects", async () => {
    const h = harness({ decisions: [signed()], range: prisma, commits: ["abc1234 feat: a\u202Eb\u0007c"] });
    expect(await M.run(h.deps)).toBe("range-guarded");
    const [card] = deployCards(h);
    expect(card.body).toContain("abc1234 feat: a b c");
    expect(card.body).not.toContain("\u202E");
  });

  it.each([
    ["ygrd-link hit", { worker: ["ygrd-link/src/index.ts"] }],
    ["ygrd-link look-alike (Kelvin sign)", { range: ["ygrd-lin\u212A/src/index.ts"] }],
    ["missing link-server marker", { workerMarker: "" }],
    ["executor itself changed", { range: ["infra/selfhost/expansion-merge.mjs"] }],
    ["executor itself changed (case)", { range: ["Infra/Selfhost/Expansion-Merge.mjs"] }],
    ["more than 30 guarded paths", { range: Array.from({ length: 31 }, (_, i) => `prisma/m${i}.sql`) }],
    ["paths do not fit the card body", { range: Array.from({ length: 30 }, (_, i) => `prisma/${"a".repeat(80)}${i}.sql`) }],
  ])("menubar only: %s → note without a button, no deploy-card line", async (_n, over) => {
    const h = harness({ decisions: [signed()], ...over });
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(deployCards(h)).toEqual([]);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].id).toBe("note-merge-pr309");
    expect(h.posts[0].body).toContain("메뉴바 「배포하기」");
    expect(h.files.done).not.toContain("deploy-card");
    expect(h.merged).toBe(false);
  });

  it("a range turning menubar-only after a card was posted still gets one menubar notice", async () => {
    const d = signed();
    const old = "6".repeat(40);
    const h = harness({
      decisions: [d], range: ["infra/selfhost/expansion-merge.mjs"],
      done: [{ status: "range-wait", sig: d.sig, pr: 309 }, cardLine({ tip: old, cardId: `20261124-deploy-${old.slice(0, 8)}-${DEPLOYED.slice(0, 8)}` })],
    });
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(deployCards(h)).toEqual([]);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].body).toContain("메뉴바 「배포하기」");
    expect(h.files.done).toContain('"status":"menubar-notice"');
  });

  it("a failed menubar notice is retried next run", async () => {
    const h = harness({ decisions: [signed()], range: ["infra/selfhost/expansion-merge.mjs"] });
    let n = 0;
    h.deps.post = (c: unknown) => { n++; if (n === 1) return false; h.posts.push(c); return true; };
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(h.files.done).not.toContain("menubar-notice");
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(h.posts).toHaveLength(1);
    expect(h.files.done).toContain("menubar-notice");
  });

  it("commit subjects are capped by code points (no split surrogate pair)", async () => {
    const subject = `abc1234 ${"x".repeat(91)}\u{1F600}tail`;
    const h = harness({ decisions: [signed()], range: prisma, commits: [subject] });
    expect(await M.run(h.deps)).toBe("range-guarded");
    const [card] = deployCards(h);
    expect(card.body).toContain(`${"x".repeat(91)}\u{1F600}`);
    expect(card.body).not.toContain("tail");
    expect(card.body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("exactly 30 short guarded paths still get a card", async () => {
    const h = harness({ decisions: [signed()], range: Array.from({ length: 30 }, (_, i) => `prisma/m${i}.sql`) });
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(deployCards(h)).toHaveLength(1);
    for (let i = 0; i < 30; i++) expect(deployCards(h)[0].body).toContain(`prisma/m${i}.sql`);
  });
});

describe("expansion-merge deploy decision", () => {
  const range = ["prisma/x.sql"];

  it("accepted: signed, owner, latest card, ≤24h, unchanged SHAs → release deploy → deployed", async () => {
    const h = harness({ decisions: [signedDeploy()], done: [cardLine()], range, deployTo: TIP });
    const r = await M.run(h.deps);
    expect(r).not.toBe("idle");
    expect(r).toBe("deployed");
    expect(h.deployed).toBe(1);
    expect(h.inprogress).toBe(false);
    expect(h.stop).toBe(false);
    expect(h.gh).toEqual([]);
    expect(h.files.done).toContain('"status":"deployed"');
    expect(h.posts.at(-1).title).toContain("배포 완료");
    expect(await M.run(h.deps)).toBe("idle");
    expect(h.deployed).toBe(1);
  });

  it("a deploy click goes before merge work and is the only decision that run", async () => {
    const h = harness({ decisions: [signed(), signedDeploy()], done: [cardLine()], range, deployTo: TIP });
    expect(await M.run(h.deps)).toBe("deployed");
    expect(h.merged).toBe(false);
    expect(h.gh).toEqual([]);
  });

  it.each([
    ["no card posted", { done: [] }],
    ["not the latest card", { done: [cardLine(), cardLine({ tip: "6".repeat(40), cardId: `20261124-deploy-66666666-${DEPLOYED.slice(0, 8)}` })] }],
    ["card triple differs from the click", { done: [cardLine({ marker: "7".repeat(40) })] }],
    ["production moved (from)", { deployedSha: "8".repeat(40) }],
    ["main moved (tip)", { tip: "6".repeat(40) }],
    ["link-server marker changed", { workerMarker: "7".repeat(40) }],
    ["range now menubar-only", { range: ["infra/selfhost/expansion-merge.mjs"] }],
    ["card already deployed", { done: [cardLine(), { kind: "deploy", cardId: DEPLOY_ID, status: "deployed", sig: "f".repeat(64) }] }],
  ])("mismatch: %s → rejected, nothing deployed", async (_n, over) => {
    const h = harness({ decisions: [signedDeploy()], done: [cardLine()], range, deployTo: TIP, ...over });
    expect(await M.run(h.deps)).toBe("rejected");
    expect(h.deployed).toBe(0);
    expect(h.inprogress).toBe(false);
    expect(h.stop).toBe(false);
    expect(h.files.done).toContain('"status":"rejected"');
    expect(h.posts.at(-1).id).toBe(`note-deploy-${TIP.slice(0, 8)}`);
    expect(await M.run(h.deps)).not.toBe("rejected");
  });

  it("rejection when the new range is menubar-only says 메뉴바 and counts as that range's notice", async () => {
    const h = harness({ decisions: [signedDeploy(), signed()], done: [cardLine()], tip: "6".repeat(40), range: ["infra/selfhost/expansion-merge.mjs"], deployTo: TIP });
    expect(await M.run(h.deps)).toBe("rejected");
    expect(h.posts.at(-1).body).toContain("메뉴바 「배포하기」");
    expect(h.posts.at(-1).body).not.toContain("새 「배포 승인」 카드");
    expect(h.files.done).toContain('"status":"menubar-notice"');
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(h.posts).toHaveLength(1);
  });

  it("rejection when the new range can take a card promises a fresh card, which the merge path then posts", async () => {
    const tip = "6".repeat(40);
    const h = harness({ decisions: [signedDeploy(), signed()], done: [cardLine()], tip, range, deployTo: TIP });
    expect(await M.run(h.deps)).toBe("rejected");
    expect(h.posts.at(-1).body).toContain("새 「배포 승인」 카드");
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(h.posts.filter((c) => c.kind === "deploy").map((c) => c.tip)).toEqual([tip]);
  });

  it("rejection when the new range has no guarded paths says the merge continues", async () => {
    const h = harness({ decisions: [signedDeploy()], done: [cardLine()], tip: "6".repeat(40), range: ["src/a.ts"], deployTo: TIP });
    expect(await M.run(h.deps)).toBe("rejected");
    expect(h.posts.at(-1).body).toContain("그대로 이어집니다");
  });

  it("STOP appearing after the fetch blocks the deploy and keeps the click open", async () => {
    const h = harness({ decisions: [signedDeploy()], done: [cardLine()], range, deployTo: TIP });
    const git = h.deps.git;
    let armed = true;
    h.deps.git = (args: string[]) => {
      if (armed && args[0] === "fetch") { armed = false; h.deps.touch("stop"); }
      return git(args);
    };
    expect(await M.run(h.deps)).toBe("stopped");
    expect(h.deployed).toBe(0);
    expect(h.inprogress).toBe(false);
    expect(h.files.done).not.toMatch(/"status":"(rejected|deployed|deploy-failed)"/);
    h.deps.remove("stop");
    expect(await M.run(h.deps)).toBe("deployed");
  });

  it("the deploy is pinned to the approved tip; the merge path is not pinned", async () => {
    const h = harness({ decisions: [signedDeploy()], done: [cardLine()], range, deployTo: TIP });
    expect(await M.run(h.deps)).toBe("deployed");
    expect(h.deployOpts).toEqual([{ expectSha: TIP }]);
    const m = harness({ decisions: [signed()] });
    expect(await M.run(m.deps)).toBe("deployed");
    expect(m.deployOpts).toEqual([undefined]);
  });

  it("pin mismatch (75) with production unchanged: no STOP, rejected, and the next merge attempt posts a fresh card", async () => {
    const moved = "6".repeat(40);
    const h = harness({ decisions: [signedDeploy(), signed()], done: [cardLine()], range, deployTo: DEPLOYED, deployRc: 75, tipAfterDeploy: moved });
    expect(await M.run(h.deps)).toBe("rejected");
    expect(h.stop).toBe(false);
    expect(h.inprogress).toBe(false);
    expect(h.files.done).toContain("배포 직전 main 이 움직임 — 범위가 바뀌어 배포하지 않음");
    expect(h.files.done).not.toContain('"status":"deploy-failed"');
    expect(h.posts.at(-1).body).toContain("새 「배포 승인」 카드");
    expect(await M.run(h.deps)).toBe("range-guarded");
    expect(h.posts.filter((c) => c.kind === "deploy").map((c) => c.tip)).toEqual([moved]);
  });

  it("75 with production unchanged but main NOT moved (stray 75) → STOP + deploy-failed", async () => {
    const h = harness({ decisions: [signedDeploy()], done: [cardLine()], range, deployTo: DEPLOYED, deployRc: 75 });
    expect(await M.run(h.deps)).toBe("deploy-failed");
    expect(h.stop).toBe(true);
    expect(h.files.done).not.toContain("배포 직전 main 이 움직임");
  });

  it("75 but production changed anyway → STOP + deploy-failed", async () => {
    const h = harness({ decisions: [signedDeploy()], done: [cardLine()], range, deployTo: "9".repeat(40), deployRc: 75 });
    expect(await M.run(h.deps)).toBe("deploy-failed");
    expect(h.stop).toBe(true);
  });

  it("in-progress claimed by someone else at the point of no return → stopped, click stays open", async () => {
    const h = harness({ decisions: [signedDeploy()], done: [cardLine()], range, deployTo: TIP });
    h.deps.claim = () => false;
    expect(await M.run(h.deps)).toBe("stopped");
    expect(h.deployed).toBe(0);
    expect(h.files.done).not.toMatch(/"status":"(rejected|deployed|deploy-failed)"/);
  });

  it("STOP created just as in-progress is claimed → in-progress removed, stopped, nothing deployed", async () => {
    const h = harness({ decisions: [signedDeploy()], done: [cardLine()], range, deployTo: TIP });
    const claim = h.deps.claim;
    h.deps.claim = (p: string) => { h.deps.touch("stop"); return claim(p); };
    expect(await M.run(h.deps)).toBe("stopped");
    expect(h.deployed).toBe(0);
    expect(h.inprogress).toBe(false);
    expect(h.stop).toBe(true);
  });

  it("merge path also claims in-progress exclusively and re-checks STOP", async () => {
    const a = harness({ decisions: [signed()] });
    a.deps.claim = () => false;
    expect(await M.run(a.deps)).toBe("stopped");
    expect(a.merged).toBe(false);
    const b = harness({ decisions: [signed()] });
    const claim = b.deps.claim;
    b.deps.claim = (p: string) => { b.deps.touch("stop"); return claim(p); };
    expect(await M.run(b.deps)).toBe("stopped");
    expect(b.merged).toBe(false);
    expect(b.inprogress).toBe(false);
  });

  it("expires clicks older than 24h", async () => {
    const h = harness({ decisions: [signedDeploy({ at: "2026-11-23T11:59:00Z" })], done: [cardLine()], range, deployTo: TIP });
    expect(await M.run(h.deps)).toBe("expired");
    expect(h.deployed).toBe(0);
  });

  it.each([
    ["approver is not the owner", signedDeploy({ approver: "U999" })],
    ["wrong key", signedDeploy({}, "b".repeat(64))],
    ["merge-prefix MAC over deploy fields", signedDeploy({}, KEY, "wag-expansion-merge-v1")],
    ["merge row replayed as deploy", { ...signed(), decision: "deploy", cardId: DEPLOY_ID, from: DEPLOYED, tip: TIP, marker: MARKER }],
  ])("invalid: %s → not deployed and does not void the real click", async (_n, bad) => {
    const h = harness({ decisions: [bad], done: [cardLine()], range, deployTo: TIP });
    expect(await M.run(h.deps)).toBe("invalid");
    expect(h.deployed).toBe(0);
    expect(h.files.done).not.toContain('"status":"rejected"');
    const h2 = harness({ decisions: [bad, signedDeploy()], done: [cardLine()], range, deployTo: TIP });
    expect(await M.run(h2.deps)).toBe("deployed");
  });

  it("a deploy row replayed as a merge is an invalid merge line", async () => {
    const h = harness({ decisions: [{ ...signedDeploy(), decision: "merge", pr: 309, sha: SHA, cardId: "20261124-merge-pr309" }] });
    expect(await M.run(h.deps)).toBe("invalid");
    expect(h.merged).toBe(false);
    expect(h.deployed).toBe(0);
  });

  it("deployed.sha ≠ tip after the deploy → STOP + deploy-failed", async () => {
    const h = harness({ decisions: [signedDeploy()], done: [cardLine()], range, deployTo: "9".repeat(40) });
    expect(await M.run(h.deps)).toBe("deploy-failed");
    expect(h.deployed).toBe(1);
    expect(h.stop).toBe(true);
    expect(h.inprogress).toBe(false);
    expect(h.files.done).toContain('"status":"deploy-failed"');
    expect(h.posts.at(-1).body).toContain("되돌리기");
    expect(await M.run(h.deps)).toBe("stopped");
  });

  it("deploy exit code ≠ 0 → STOP + deploy-failed", async () => {
    const h = harness({ decisions: [signedDeploy()], done: [cardLine()], range, deployTo: TIP, deployRc: 1 });
    expect(await M.run(h.deps)).toBe("deploy-failed");
    expect(h.stop).toBe(true);
  });

  it("STOP or in-progress marker blocks deploy clicks too", async () => {
    for (const over of [{ stop: true }, { inprogress: true }]) {
      const h = harness({ decisions: [signedDeploy()], done: [cardLine()], range, deployTo: TIP, ...over });
      expect(await M.run(h.deps)).toBe("stopped");
      expect(h.deployed).toBe(0);
    }
  });
});
