import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import * as M from "../../infra/selfhost/expansion-merge.mjs";

const KEY = "a".repeat(64);
const SHA = "1".repeat(40);
const DEPLOYED = "2".repeat(40);
const MERGED = "3".repeat(40);
const NOW = Date.parse("2026-11-24T12:00:00Z");

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
  shippedExtra?: string[]; prSeq?: unknown[];
};
function harness(o: Opts) {
  const files: Record<string, string> = {
    dec: (o.decisions ?? []).map((x) => JSON.stringify(x)).join("\n"),
    done: (o.done ?? []).map((x) => JSON.stringify(x)).join("\n"),
    key: o.key ?? KEY,
    dsha: DEPLOYED,
    wmark: o.workerMarker ?? "4".repeat(40),
  };
  const gh: string[][] = [];
  const posts: { title: string; body: string }[] = [];
  const logs: string[] = [];
  let deployed = 0;
  let stop = !!o.stop;
  let inprogress = !!o.inprogress;
  let viewN = 0;
  let merged = false;
  const z = (xs: string[]) => xs.join("\0") + (xs.length ? "\0" : "");
  const deps = {
    now: () => NOW,
    readText: (p: string) => files[p] ?? "",
    exists: (p: string) => (p === "stop" && stop) || (p === "inprogress" && inprogress),
    appendLine: (p: string, obj: unknown) => { files[p] = (files[p] ? files[p] + "\n" : "") + JSON.stringify(obj); },
    touch: (p: string) => { if (p === "stop") stop = true; if (p === "inprogress") inprogress = true; },
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
      if (args[0] === "rev-parse") return { rc: 0, out: `${o.head ?? SHA}\n` };
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
    deploy: () => { deployed++; files.dsha = MERGED; return o.deployRc ?? 0; },
    post: (c: { title: string; body: string }) => { posts.push(c); return true; },
    log: (label: string, body: string) => logs.push(`${label} ${body}`),
    paths: { decisions: "dec", done: "done", key: "key", stop: "stop", inprogress: "inprogress", deployedSha: "dsha", workerMarker: "wmark", approver: "U123" },
  };
  return {
    deps, gh, posts, logs, files,
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
