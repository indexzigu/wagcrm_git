import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `incident-notify.sh` 행위 계약 — 크론 자가 복구 2단계의 호스트 쪽 발송기.
 *
 * 앱(`/api/cron/incident-outbox`)이 보낼 알림 목록을 정하고, 이 스크립트는 그 목록을
 * notify.sh 로 텔레그램에 내보낸 뒤 보낸 것만 POST 로 「보냈음」을 찍는다.
 *
 * 🪤 네트워크·자격값을 쓰지 않는다 — curl 과 notify.sh 를 `bash <데이터 파일>` 훅으로 갈아끼운다
 * (실행파일을 새로 만들지 않는다: gh-stub-guard.contract.test.ts 규약).
 */
const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "infra", "selfhost", "incident-notify.sh");
const CRONTAB = path.join(ROOT, "infra", "selfhost", "crontab");

const FS = "\x1f"; // 인자 구분
const RS = "\x1e"; // 호출 구분

let root = "";
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "incident-notify-"));
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

type Msg = {
  key: string;
  icon: string;
  title: string;
  detail: string;
  ackField: "alertedAt" | "recoveryAlertedAt" | "digestedAt";
  incidentIds: string[];
};

interface RunOpts {
  mode?: string;
  /** GET 응답 본문. 기본은 messages 로 만든 정상 응답 */
  body?: string;
  messages?: Msg[];
  getExit?: number;
  postExit?: number;
  notifyExit?: number;
  /** 이 키들만 notify.sh 가 1 로 끝난다(엄격 모드의 「끝내 못 보냄」) */
  notifyFailKeys?: string[];
  /** 실행 전에 심어 둘 실행 잠금의 나이(초). 모드별 잠금 이름은 lockMode(기본 immediate) */
  lockAgeS?: number;
  lockMode?: string;
  /** .env 내용. 기본은 스텁 값 */
  envFile?: string;
  /** 지금(초). 기본은 실제 현재 */
  now?: number;
  /** 미리 심을 상한 파일 내용 */
  countFile?: string;
  /** 같은 LOGS_DIR 를 이어 쓸 때 */
  logsDir?: string;
  /** 가짜 python 이 실패할 호출: "all" = 전부, "ack" = 확인 본문 만들기만 */
  pythonFails?: "all" | "ack";
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** KST 날짜(YYYY-MM-DD) — 스크립트와 같은 기준(고정 +9h, KST 는 서머타임이 없다). */
const kstDate = (epoch: number) => new Date((epoch + 9 * 3600) * 1000).toISOString().slice(0, 10);

function run(opts: RunOpts = {}) {
  const dir = mkdtempSync(path.join(root, "run-"));
  const logs = opts.logsDir ?? path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const curlCalls = path.join(dir, "curl.calls");
  const notifyCalls = path.join(dir, "notify.calls");
  const bodyFile = path.join(dir, "get.body");
  writeFileSync(
    bodyFile,
    opts.body ?? JSON.stringify({ ok: true, messages: opts.messages ?? [] }),
  );
  const record = (file: string) =>
    `for a in "$@"; do printf '%s${FS}' "$a"; done >> "${file}"; printf '${RS}' >> "${file}"\n`;
  const curlImpl = path.join(dir, "curl.impl");
  writeFileSync(
    curlImpl,
    record(curlCalls) +
      `case " $* " in *" POST "*) [ ${opts.postExit ?? 0} -eq 0 ] && printf '{"ok":true}' || echo "curl: (22) 500" >&2; exit ${opts.postExit ?? 0};; esac\n` +
      `[ ${opts.getExit ?? 0} -eq 0 ] || { echo "curl: (7) Failed to connect" >&2; exit ${opts.getExit}; }\n` +
      `cat "${bodyFile}"\n`,
  );
  const notifyImpl = path.join(dir, "notify.impl");
  const notifyStrict = path.join(dir, "notify.strict");
  writeFileSync(
    notifyImpl,
    record(notifyCalls) +
      `printf '%s\\n' "\${NOTIFY_STRICT_EXIT:-unset}" >> "${notifyStrict}"\n` +
      (opts.notifyFailKeys?.length ? `case "$2" in ${opts.notifyFailKeys.join("|")}) exit 1;; esac\n` : "") +
      `exit ${opts.notifyExit ?? 0}\n`,
  );
  if (opts.lockAgeS !== undefined) {
    const lock = path.join(logs, `incident-notify-${opts.lockMode ?? "immediate"}.lock`);
    mkdirSync(lock);
    const at = (opts.now ?? nowSec()) - opts.lockAgeS;
    utimesSync(lock, at, at);
  }
  const envFile = path.join(dir, "selfhost.env");
  // 실제 시크릿을 쓰지 않는다 — 스텁 curl 은 값을 기록만 한다(P0).
  writeFileSync(envFile, opts.envFile ?? "CRON_SECRET=stub-value-not-a-secret\n");
  if (opts.countFile !== undefined) writeFileSync(path.join(logs, "incident-notify-count.tsv"), opts.countFile);

  const pyImpl = path.join(dir, "python.impl");
  writeFileSync(
    pyImpl,
    opts.pythonFails === "all"
      ? "exit 1\n"
      : opts.pythonFails === "ack"
        ? `case "$*" in *'"acks"'*) exit 1;; esac\nexec /usr/bin/python3 "$@"\n`
        : 'exec /usr/bin/python3 "$@"\n',
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CRON_SECRET;
  const result = spawnSync("bash", [SCRIPT, ...(opts.mode === undefined ? ["immediate"] : opts.mode ? [opts.mode] : [])], {
    env: {
      ...env,
      INCIDENT_CURL_CMD: `bash ${curlImpl}`,
      INCIDENT_NOTIFY_CMD: `bash ${notifyImpl}`,
      INCIDENT_LOGS_DIR: logs,
      INCIDENT_ENV_FILE: envFile,
      INCIDENT_NOW: String(opts.now ?? nowSec()),
      INCIDENT_PYTHON: `bash ${pyImpl}`,
    },
    encoding: "utf8",
  });
  const calls = (file: string): string[][] =>
    existsSync(file)
      ? readFileSync(file, "utf8")
          .split(RS)
          .filter(Boolean)
          .map((c) => c.split(FS).slice(0, -1))
      : [];
  const curl = calls(curlCalls);
  const posts = curl.filter((c) => c.includes("POST"));
  const gets = curl.filter((c) => !c.includes("POST"));
  const logFile = path.join(logs, "cron.log");
  const lines = existsSync(logFile) ? readFileSync(logFile, "utf8").trimEnd().split("\n") : [];
  const ackBody = (post: string[]) => JSON.parse(post[post.indexOf("--data-binary") + 1]) as { acks: { incidentIds: string[]; ackField: string }[] };
  const strict = existsSync(notifyStrict) ? readFileSync(notifyStrict, "utf8").trimEnd().split("\n") : [];
  return { status: result.status, stderr: result.stderr, logs, gets, posts, notify: calls(notifyCalls), strict, lines, ackBody };
}

const alert = (n: number): Msg => ({
  key: `incident-i${n}`,
  icon: "🙋",
  title: `작업 ${n} 확인 필요`,
  detail: `무엇이 멈췄는지\n오너가 할 일 ${n}`,
  ackField: "alertedAt",
  incidentIds: [`i${n}`],
});
const recovery = (n: number): Msg => ({
  key: `incident-r${n}-ok`,
  icon: "✅",
  title: `작업 ${n} 정상화`,
  detail: "다시 정상으로 돌았습니다",
  ackField: "recoveryAlertedAt",
  incidentIds: [`r${n}`],
});

describe("incident-notify.sh 발송", () => {
  it("메시지 2건 → notify.sh send 2회(키·제목·상세·아이콘 순) + 확인 POST 1회", () => {
    const r = run({ messages: [alert(1), recovery(1)] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.notify).toEqual([
      ["send", "incident-i1", "작업 1 확인 필요", "무엇이 멈췄는지\n오너가 할 일 1", "🙋"],
      ["send", "incident-r1-ok", "작업 1 정상화", "다시 정상으로 돌았습니다", "✅"],
    ]);
    expect(r.gets).toHaveLength(1);
    expect(r.gets[0]).toContain("http://127.0.0.1:3000/api/cron/incident-outbox?mode=immediate");
    expect(r.gets[0]).toContain("Authorization: Bearer stub-value-not-a-secret");
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toContain("http://127.0.0.1:3000/api/cron/incident-outbox");
    expect(r.ackBody(r.posts[0]).acks).toEqual([
      { incidentIds: ["i1"], ackField: "alertedAt" },
      { incidentIds: ["r1"], ackField: "recoveryAlertedAt" },
    ]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^\[[0-9-]+ [0-9:]+\] OK {3}incident-notify immediate sent=2 acked=2 capped=0$/);
  });

  it("cron.log 에 알림 본문을 남기지 않는다", () => {
    const r = run({ messages: [alert(1)] });
    expect(r.lines.join("\n")).not.toContain("확인 필요");
    expect(r.lines.join("\n")).not.toContain("오너가 할 일");
  });

  it("보낼 것이 없으면 notify·POST 없이 OK 한 줄", () => {
    const r = run({ messages: [] });
    expect(r.status).toBe(0);
    expect(r.notify).toHaveLength(0);
    expect(r.posts).toHaveLength(0);
    expect(r.lines[0]).toMatch(/\] OK {3}incident-notify immediate sent=0 acked=0 capped=0$/);
  });

  it("목록 조회(curl) 실패 → notify 0회 · FAIL 한 줄 · exit 1 (앱 다운 알림은 메뉴바 몫)", () => {
    const r = run({ messages: [alert(1)], getExit: 7 });
    expect(r.status).toBe(1);
    expect(r.notify).toHaveLength(0);
    expect(r.posts).toHaveLength(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/\] FAIL incident-notify /);
  });

  it("CRON_SECRET 이 없으면 호출하지 않고 exit 1 (fail-closed)", () => {
    const r = run({ messages: [alert(1)], envFile: "OTHER=x\n" });
    expect(r.status).toBe(1);
    expect(r.gets).toHaveLength(0);
    expect(r.notify).toHaveLength(0);
    expect(r.lines[0]).toMatch(/\] FAIL incident-notify .*CRON_SECRET/);
  });

  it("응답이 형식에 어긋나면 보내지 않고 FAIL · exit 1", () => {
    for (const body of ["not json", JSON.stringify({ ok: false, error: "x" }), JSON.stringify({ ok: true, messages: [{ key: 1 }] })]) {
      const r = run({ body });
      expect(r.status, body).toBe(1);
      expect(r.notify, body).toHaveLength(0);
      expect(r.posts, body).toHaveLength(0);
      expect(r.lines[0], body).toMatch(/\] FAIL incident-notify /);
    }
  });

  it("확인 POST 실패 → FAIL · exit 1 (보낸 알림은 다음 회차에 다시 오지만 notify.sh 키 하한이 거른다)", () => {
    const r = run({ messages: [alert(1)], postExit: 22 });
    expect(r.status).toBe(1);
    expect(r.notify).toHaveLength(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/\] FAIL incident-notify /);
  });

  it("notify 실행 자체가 실패한 메시지는 확인 표시하지 않는다", () => {
    const r = run({ messages: [alert(1)], notifyExit: 127 });
    expect(r.status).toBe(1);
    expect(r.posts).toHaveLength(0);
    expect(r.lines[0]).toMatch(/\] FAIL incident-notify /);
  });

  it("python 이 실패하면(날짜 계산) 아무것도 보내지 않고 FAIL · exit 1", () => {
    const r = run({ messages: [alert(1)], pythonFails: "all" });
    expect(r.status).toBe(1);
    expect(r.notify).toHaveLength(0);
    expect(r.posts).toHaveLength(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/\] FAIL incident-notify /);
  });

  it("확인 본문 만들기가 실패하면 POST 없이 FAIL · exit 1", () => {
    const r = run({ messages: [alert(1)], pythonFails: "ack" });
    expect(r.status).toBe(1);
    expect(r.posts).toHaveLength(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/\] FAIL incident-notify /);
  });

  it("digest 모드는 mode=digest 로 묻고 📋 은 상한에 세지 않는다", () => {
    const digest: Msg = { key: "digest-incident", icon: "📋", title: "자동화 작업 요약", detail: "줄1\n줄2", ackField: "digestedAt", incidentIds: ["a", "b"] };
    const now = nowSec();
    // 오늘 줄을 맨 끝이 아닌 자리에 둔다 — 다시 쓰면 오늘 줄이 끝으로 옮겨지므로 「안 썼다」를 내용으로 판정할 수 있다.
    const seeded = `since\t${now - 3600}\n${kstDate(now)}\t5\t1\n${kstDate(now - 86400)}\t3\t0\n`;
    const r = run({ mode: "digest", messages: [digest], now, countFile: seeded });
    expect(r.status, r.stderr).toBe(0);
    expect(r.gets[0]).toContain("http://127.0.0.1:3000/api/cron/incident-outbox?mode=digest");
    expect(r.notify).toEqual([["send", "digest-incident", "자동화 작업 요약", "줄1\n줄2", "📋"]]);
    expect(r.ackBody(r.posts[0]).acks).toEqual([{ incidentIds: ["a", "b"], ackField: "digestedAt" }]);
    // 08:00 에는 immediate 와 동시에 돈다 — digest 가 상한 파일을 덮으면 immediate 의 개수가 지워진다.
    expect(readFileSync(path.join(r.logs, "incident-notify-count.tsv"), "utf8")).toBe(seeded);
  });

  it("모드가 immediate·digest·approval 이 아니면 호출하지 않고 exit 1", () => {
    for (const mode of ["", "all"]) {
      const r = run({ mode, messages: [alert(1)] });
      expect(r.status, mode).toBe(1);
      expect(r.gets, mode).toHaveLength(0);
    }
  });
});

describe("incident-notify.sh 발송 실패는 확인하지 않는다(엄격 종료)", () => {
  it("notify.sh 를 엄격 모드(NOTIFY_STRICT_EXIT=1)로 부른다 — 기본 모드는 실패에도 0 이라 못 보낸 것을 보낸 것으로 찍는다", () => {
    const r = run({ messages: [alert(1), recovery(1)] });
    expect(r.strict).toEqual(["1", "1"]);
  });

  it("못 보낸 메시지만 확인에서 빠지고, 보낸 것은 확인 POST 로 찍힌다 · 실패 개수를 로그에 남긴다", () => {
    const r = run({ messages: [alert(1), recovery(1), alert(2)], notifyFailKeys: ["incident-r1-ok"] });
    expect(r.notify.map((c) => c[1])).toEqual(["incident-i1", "incident-r1-ok", "incident-i2"]);
    expect(r.posts).toHaveLength(1);
    expect(r.ackBody(r.posts[0]).acks).toEqual([
      { incidentIds: ["i1"], ackField: "alertedAt" },
      { incidentIds: ["i2"], ackField: "alertedAt" },
    ]);
    expect(r.status).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/\] FAIL incident-notify immediate .*sent=2 acked=2 capped=0 failed=1/);
  });

  it("못 보낸 조치 알림은 하루 상한에 세지 않는다", () => {
    const now = nowSec();
    const r = run({
      messages: [alert(1), alert(2), alert(3)],
      notifyFailKeys: ["incident-i1"],
      now,
      countFile: `since\t${now - 3600}\n${kstDate(now)}\t4\t0\n`,
    });
    // i1 실패(4 그대로) → i2 발송(5) → i3 는 상한
    expect(r.notify.map((c) => c[1])).toEqual(["incident-i1", "incident-i2", "incident-cap"]);
    expect(r.ackBody(r.posts[0]).acks.flatMap((a) => a.incidentIds)).toEqual(["i2", "i3"]);
    expect(readFileSync(path.join(r.logs, "incident-notify-count.tsv"), "utf8")).toContain(`${kstDate(now)}\t5\t1`);
    expect(r.lines[0]).toMatch(/sent=1 acked=2 capped=1 failed=1/); // 상한 안내는 sent 에 세지 않는다(기존 규약)
  });

  it("상한 안내를 못 보내면 보냄으로 적지 않는다 — 다음 회차가 다시 보낸다", () => {
    const now = nowSec();
    const r = run({
      messages: [alert(6)],
      notifyFailKeys: ["incident-cap"],
      now,
      countFile: `since\t${now - 3600}\n${kstDate(now)}\t5\t0\n`,
    });
    expect(readFileSync(path.join(r.logs, "incident-notify-count.tsv"), "utf8")).toContain(`${kstDate(now)}\t5\t0`);
    expect(r.lines[0]).toMatch(/failed=1/);
  });

  it("전부 실패하면 확인 POST 를 하지 않는다", () => {
    const r = run({ messages: [alert(1)], notifyFailKeys: ["incident-i1"] });
    expect(r.posts).toHaveLength(0);
    expect(r.status).toBe(1);
    expect(r.lines[0]).toMatch(/sent=0 acked=0 capped=0 failed=1/);
  });
});

describe("incident-notify.sh 실행 잠금", () => {
  it("15분 안의 잠금이 있으면 조회·발송 없이 SKIP 한 줄 · exit 0 이고 남의 잠금을 지우지 않는다", () => {
    const r = run({ messages: [alert(1)], lockAgeS: 60 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.gets).toHaveLength(0);
    expect(r.notify).toHaveLength(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^\[[0-9-]+ [0-9:]+\] SKIP incident-notify immediate /);
    expect(existsSync(path.join(r.logs, "incident-notify-immediate.lock"))).toBe(true);
  });

  it("15분이 지난 잠금은 죽은 실행이 남긴 것으로 보고 넘겨받아 돈다 · 끝나면 잠금을 푼다", () => {
    const r = run({ messages: [alert(1)], lockAgeS: 16 * 60 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.notify).toHaveLength(1);
    expect(r.posts).toHaveLength(1);
    expect(r.lines.at(-1)).toMatch(/\] OK {3}incident-notify immediate sent=1 acked=1 capped=0$/);
    expect(existsSync(path.join(r.logs, "incident-notify-immediate.lock"))).toBe(false);
  });

  it("실패로 끝나도 잠금을 푼다", () => {
    const r = run({ messages: [alert(1)], getExit: 7 });
    expect(r.status).toBe(1);
    expect(existsSync(path.join(r.logs, "incident-notify-immediate.lock"))).toBe(false);
  });

  it("잠금은 모드별이다 — 08:00 에 동시에 도는 digest 가 immediate 의 잠금에 막히지 않는다", () => {
    const digest: Msg = { key: "digest-incident", icon: "📋", title: "요약", detail: "줄", ackField: "digestedAt", incidentIds: ["a"] };
    const r = run({ mode: "digest", messages: [digest], lockAgeS: 5, lockMode: "immediate" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.notify).toHaveLength(1);
  });
});

describe("incident-notify.sh 하루 즉시 알림 상한(배포 후 7일)", () => {
  it("첫 실행이 상한 파일을 만든다 — 그날이 7일 창의 시작이다", () => {
    const now = nowSec();
    const r = run({ messages: [], now });
    const file = readFileSync(path.join(r.logs, "incident-notify-count.tsv"), "utf8");
    expect(file.split("\n")[0]).toBe(`since\t${now}`);
  });

  it("창 안에서는 하루 5건까지만 보내고, 넘친 것은 보내지 않은 채 보냄(alertedAt)으로 표시하고 상한 안내를 한 번 보낸다", () => {
    const now = nowSec();
    const messages = [1, 2, 3, 4, 5, 6, 7].map(alert).concat([recovery(1)]);
    const r = run({ messages, now });
    expect(r.status, r.stderr).toBe(0);
    const sentKeys = r.notify.map((c) => c[1]);
    expect(sentKeys).toEqual([
      "incident-i1", "incident-i2", "incident-i3", "incident-i4", "incident-i5",
      "incident-r1-ok",
      "incident-cap",
    ]);
    expect(r.notify[6]).toEqual(["send", "incident-cap", "자동화 작업 알림 상한", "오늘 알림 2건은 다음 08:00 요약으로 넘깁니다.", "🙋"]);
    // 넘친 i6·i7 도 alertedAt 으로 확인한다 — 자정이 지나 개별 알림으로 나가지 않게. 08:00 요약은 조치대기 전부를 싣는다.
    const acks = r.ackBody(r.posts[0]).acks;
    expect(acks.flatMap((a) => a.incidentIds)).toEqual(["i1", "i2", "i3", "i4", "i5", "i6", "i7", "r1"]);
    expect(acks.filter((a) => ["i6", "i7"].includes(a.incidentIds[0])).map((a) => a.ackField)).toEqual(["alertedAt", "alertedAt"]);
    expect(r.lines[0]).toMatch(/sent=6 acked=8 capped=2$/);
    // 넘친 것은 보낸 개수에 넣지 않는다.
    expect(readFileSync(path.join(r.logs, "incident-notify-count.tsv"), "utf8")).toContain(`${kstDate(now)}\t5\t1`);

    // 같은 날 다음 회차: 상한이 이미 찼으니 즉시 알림은 0건, 상한 안내도 다시 보내지 않는다. 정상화(✅)는 세지 않는다.
    const again = run({ messages: [alert(6), alert(7), recovery(2)], now: now + 1, logsDir: r.logs });
    expect(again.notify.map((c) => c[1])).toEqual(["incident-r2-ok"]);
    expect(again.ackBody(again.posts[0]).acks).toEqual([
      { incidentIds: ["i6"], ackField: "alertedAt" },
      { incidentIds: ["i7"], ackField: "alertedAt" },
      { incidentIds: ["r2"], ackField: "recoveryAlertedAt" },
    ]);
    expect(again.lines.at(-1)).toMatch(/sent=1 acked=3 capped=2$/);
  });

  it("날이 바뀌면 개수가 새로 시작한다", () => {
    const now = nowSec();
    const yesterday = kstDate(now - 86400);
    const r = run({ messages: [alert(1)], now, countFile: `since\t${now - 2 * 86400}\n${yesterday}\t5\t1\n` });
    expect(r.notify.map((c) => c[1])).toEqual(["incident-i1"]);
  });

  it("7일이 지나면 상한이 없다", () => {
    const now = nowSec();
    const messages = [1, 2, 3, 4, 5, 6, 7].map(alert);
    const r = run({ messages, now, countFile: `since\t${now - 8 * 86400}\n` });
    expect(r.notify).toHaveLength(7);
    expect(r.lines[0]).toMatch(/sent=7 acked=7 capped=0$/);
  });

  it("손상된 상한 파일에 죽지 않는다 — 다시 만들어 창을 지금부터 센다", () => {
    const now = nowSec();
    const r = run({ messages: [alert(1)], now, countFile: "garbage\n089\tx\n" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.notify).toHaveLength(1);
  });
});

describe("incident-notify.sh approval 모드(결재 대기 알림)", () => {
  const approval = (id: string, over: Record<string, unknown> = {}) => ({
    key: `approval-${id}`,
    icon: "📝",
    title: `결재 대기: 기안 ${id}`,
    detail: `메모 추가\n올린 곳: 슬랙봇 · 10-27 10:05\n\n기안 ${id} 내용`,
    ackField: "ownerNotifiedAt",
    proposalIds: [id],
    ...over,
  });
  const body = (messages: unknown[]) => JSON.stringify({ ok: true, messages });
  const acksOf = (post: string[]) =>
    JSON.parse(post[post.indexOf("--data-binary") + 1]) as { acks: { proposalIds: string[]; ackField: string }[] };

  it("approval-outbox 를 묻고(쿼리 없음) 보낸 기안을 proposalIds 로 확인한다", () => {
    const r = run({ mode: "approval", body: body([approval("a"), approval("b")]) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.gets).toHaveLength(1);
    expect(r.gets[0]).toContain("http://127.0.0.1:3000/api/cron/approval-outbox");
    expect(r.gets[0].some((a) => a.includes("?mode="))).toBe(false);
    expect(r.notify).toEqual([
      ["send", "approval-a", "결재 대기: 기안 a", "메모 추가\n올린 곳: 슬랙봇 · 10-27 10:05\n\n기안 a 내용", "📝"],
      ["send", "approval-b", "결재 대기: 기안 b", "메모 추가\n올린 곳: 슬랙봇 · 10-27 10:05\n\n기안 b 내용", "📝"],
    ]);
    expect(r.strict).toEqual(["1", "1"]);
    expect(r.posts[0]).toContain("http://127.0.0.1:3000/api/cron/approval-outbox");
    expect(acksOf(r.posts[0]).acks).toEqual([
      { proposalIds: ["a"], ackField: "ownerNotifiedAt" },
      { proposalIds: ["b"], ackField: "ownerNotifiedAt" },
    ]);
    expect(r.lines[0]).toMatch(/\] OK {3}incident-notify approval sent=2 acked=2 capped=0$/);
    expect(r.lines.join("\n")).not.toContain("기안 a 내용");
  });

  it("묶음 1통의 여러 id 를 한 줄로 확인한다", () => {
    const r = run({ mode: "approval", body: body([approval("x", { key: "approval-batch-x", proposalIds: ["x", "y", "z", "w"] })]) });
    expect(r.status, r.stderr).toBe(0);
    expect(acksOf(r.posts[0]).acks).toEqual([{ proposalIds: ["x", "y", "z", "w"], ackField: "ownerNotifiedAt" }]);
  });

  it("사고 알림 하루 상한에 걸리지 않는다", () => {
    const now = nowSec();
    const r = run({ mode: "approval", body: body([approval("a")]), now, countFile: `since\t${now - 3600}\n${kstDate(now)}\t5\t1\n` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.notify.map((c) => c[1])).toEqual(["approval-a"]);
  });

  it("못 보낸 기안은 확인하지 않는다 — 다음 회차에 다시 온다", () => {
    const r = run({ mode: "approval", body: body([approval("a"), approval("b")]), notifyFailKeys: ["approval-a"] });
    expect(r.status).toBe(1);
    expect(acksOf(r.posts[0]).acks).toEqual([{ proposalIds: ["b"], ackField: "ownerNotifiedAt" }]);
  });

  it("사고 칸·사고 id 칸 이름이 오면 형식 오류로 아무것도 보내지 않는다", () => {
    for (const bad of [approval("a", { ackField: "alertedAt" }), { ...approval("a"), proposalIds: undefined, incidentIds: ["a"] }]) {
      const r = run({ mode: "approval", body: body([bad]) });
      expect(r.status).toBe(1);
      expect(r.notify).toHaveLength(0);
      expect(r.lines[0]).toContain("응답 형식 오류");
    }
  });

  it("사고 모드는 결재 칸(ownerNotifiedAt)을 받지 않는다", () => {
    const r = run({ body: body([approval("a", { incidentIds: ["a"] })]) });
    expect(r.status).toBe(1);
    expect(r.notify).toHaveLength(0);
  });

  it("잠금은 사고 알림과 따로다 — immediate 잠금이 있어도 돈다", () => {
    const r = run({ mode: "approval", body: body([approval("a")]), lockAgeS: 10, lockMode: "immediate" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.notify).toHaveLength(1);
  });
});

describe("crontab 일정", () => {
  const src = readFileSync(CRONTAB, "utf8");
  const lines = src.split("\n");
  const expected = [
    "*/10 * * * * /Users/z9/selfhost/wagcrm/infra/selfhost/incident-notify.sh immediate >> /Users/z9/selfhost/logs/cron-launchd.log 2>&1",
    "0 8 * * * /Users/z9/selfhost/wagcrm/infra/selfhost/incident-notify.sh digest >> /Users/z9/selfhost/logs/cron-launchd.log 2>&1",
    "*/5 * * * * /Users/z9/selfhost/wagcrm/infra/selfhost/incident-notify.sh approval >> /Users/z9/selfhost/logs/cron-launchd.log 2>&1",
  ];
  it.each(expected)("%s 가 활성 줄로 한 번 있고 바로 위가 주석이다", (line) => {
    const idx = lines.indexOf(line);
    expect(idx, "줄이 없다").toBeGreaterThan(0);
    expect(lines.filter((l) => l === line)).toHaveLength(1);
    expect(lines[idx - 1]).toMatch(/^# /);
  });

  it("run-cron.sh 잡 개수 앵커가 새 줄을 세지 않는다(cutover.sh·status.sh 와 같은 정규식)", () => {
    const anchored = lines.filter((l) => /^[0-9*].*run-cron\.sh/.test(l));
    expect(anchored.some((l) => l.includes("incident-notify"))).toBe(false);
  });
});
