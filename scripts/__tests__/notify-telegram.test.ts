import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  GNU_STAT_IMPL_BODY,
  statStubEnv,
  writeStatStub,
} from "./helpers/gh-stub";

const execFileAsync = promisify(execFile);

/**
 * notify.sh 는 "무엇이 빨강인가"를 판정하지 않는다 — status.sh 와 앱이 이미 정한 것을
 * 밖으로 내보내고, 같은 키가 너무 자주 나가지 않게 하는 절대 하한 하나만 소유한다.
 * 그 하한이 이 파일의 핵심이다: 앱 메모리의 전환 억제는 앱이 재시작하면 리셋되므로,
 * 크래시 루프에서 300초마다 폰이 울리는 것을 막는 것은 디스크에 남는 이 기록뿐이다.
 */
const SCRIPT = path.resolve(
  __dirname,
  "..",
  "..",
  "infra",
  "selfhost",
  "notify.sh",
);
const tmp = mkdtempSync(path.join(tmpdir(), "notify-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface RunOpts {
  /** 스텁 발송이 돌려줄 HTTP 코드. 기본 200 */
  httpCode?: string;
  /** 미리 심어 둘 발송 기록: 키 → "몇 시간 전에 보냈나". 문자열도 받는다(손상 픽스처). */
  sent?: Record<string, number | string>;
  /** 자격값을 비운다(미설정 경로) */
  noCreds?: boolean;
}

function makeHome(opts: RunOpts): {
  home: string;
  calls: string;
  env: NodeJS.ProcessEnv;
} {
  const home = mkdtempSync(path.join(tmp, "home-"));
  const logs = path.join(home, "selfhost", "logs");
  mkdirSync(logs, { recursive: true });
  const calls = path.join(home, "calls.log");

  // 실행 비트 없는 데이터 파일 — NOTIFY_CURL_CMD 훅이 `bash <파일>` 로 읽는다.
  const curlImpl = path.join(home, "curl.impl");
  writeFileSync(
    curlImpl,
    `printf '%s\\n' "$*" >> "${calls}"\nprintf '%s' "${opts.httpCode ?? "200"}"\n`,
  );

  const envFile = path.join(home, "creds.env");
  writeFileSync(
    envFile,
    opts.noCreds
      ? "OTHER_KEY=x\n"
      : 'TELEGRAM_BOT_TOKEN="111:aaa"\nTELEGRAM_CHAT_ID="222"\n',
  );

  if (opts.sent) {
    const nowSec = Math.floor(Date.now() / 1000);
    writeFileSync(
      path.join(logs, "alert-sent.tsv"),
      Object.entries(opts.sent)
        .map(
          ([k, v]) => `${k}\t${typeof v === "number" ? nowSec - v * 3600 : v}`,
        )
        .join("\n") + "\n",
    );
  }

  return {
    home,
    calls,
    env: {
      ...process.env,
      HOME: home,
      NOTIFY_CURL_CMD: `bash ${curlImpl}`,
      NOTIFY_ENV_FILE: envFile,
      NOTIFY_RETRY_DELAY_S: "0", // 실패 경로의 sleep 을 없앤다(5초 타임아웃 플레이크 방지)
    },
  };
}

function run(
  args: string[],
  opts: RunOpts = {},
): { home: string; calls: string; code: number } {
  const { home, calls, env } = makeHome(opts);
  let code = 0;
  try {
    execFileSync("bash", [SCRIPT, ...args], { env, encoding: "utf8" });
  } catch (e) {
    code = (e as { status?: number }).status ?? 1;
  }
  return { home, calls, code };
}

const sentAt = (home: string, key: string): number | null => {
  const p = path.join(home, "selfhost", "logs", "alert-sent.tsv");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const [k, at] = line.split("\t");
    if (k === key) return Number(at);
  }
  return null;
};

const callCount = (calls: string): number =>
  existsSync(calls)
    ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length
    : 0;

const MARKER_REL = ["selfhost", "logs", "alert-send-failed"];
const PROBE_LAST_REL = ["selfhost", "logs", "alert-probe-last"];
const HISTORY_REL = ["selfhost", "logs", "alert-history.tsv"];

/**
 * 발송 이력(append-only). alert-sent.tsv 는 회복 시 지워지는 **억제 상태**라
 * "무엇이 언제 나갔나"를 사후에 되짚을 수 없다 — 이 파일이 그 흔적을 소유한다.
 */
const historyLines = (
  home: string,
): { epoch: number; key: string; title: string; detail: string }[] => {
  const p = path.join(home, ...HISTORY_REL);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [epoch, key, title, detail] = line.split("\t");
      return { epoch: Number(epoch), key, title, detail };
    });
};

/** 마커를 새 3필드 형식(<epoch><TAB><사유><TAB><문구>)으로 읽는다. */
const readMarker = (
  home: string,
): { epoch: number; reason: string; msg: string } | null => {
  const p = path.join(home, ...MARKER_REL);
  if (!existsSync(p)) return null;
  const [epoch, reason, msg] = readFileSync(p, "utf8")
    .split("\n")[0]
    .split("\t");
  return { epoch: Number(epoch), reason, msg };
};

const markerExists = (home: string): boolean =>
  existsSync(path.join(home, ...MARKER_REL));

/** 마커를 지정한 사유·경과시간으로 미리 심는다(probe 의 24시간 유예 판정 테스트용). */
const seedMarker = (
  home: string,
  reason: string,
  agoHours: number,
  msg = "본문",
) => {
  mkdirSync(path.dirname(path.join(home, ...MARKER_REL)), { recursive: true });
  const epoch = Math.floor(Date.now() / 1000) - agoHours * 3600;
  writeFileSync(
    path.join(home, ...MARKER_REL),
    `${epoch}\t${reason}\t${msg}\n`,
  );
};

const seedProbeLast = (home: string, agoSeconds: number) => {
  const p = path.join(home, ...PROBE_LAST_REL);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, String(Math.floor(Date.now() / 1000) - agoSeconds));
};

describe("notify.sh 발송 계약", () => {
  it("첫 발송은 나가고 기록이 남는다", () => {
    const r = run(["send", "crons", "자동 작업", "3개가 예정보다 늦었습니다"]);
    expect(r.code).toBe(0);
    expect(callCount(r.calls)).toBe(1);
    expect(sentAt(r.home, "crons")).not.toBeNull();
  });

  it("본문에 status.sh 가 준 제목·상세가 그대로 실린다", () => {
    const r = run(["send", "crons", "자동 작업", "3개가 예정보다 늦었습니다"]);
    const body = readFileSync(r.calls, "utf8");
    expect(body).toContain("자동 작업");
    expect(body).toContain("3개가 예정보다 늦었습니다");
  });

  it("하한 안(5시간 전 발송)이면 조용히 건너뛴다", () => {
    const r = run(["send", "crons", "자동 작업", "본문"], {
      sent: { crons: 5 },
    });
    expect(r.code).toBe(0);
    expect(callCount(r.calls)).toBe(0);
  });

  it("하한 밖(7시간 전 발송)이면 다시 나간다", () => {
    const r = run(["send", "crons", "자동 작업", "본문"], {
      sent: { crons: 7 },
    });
    expect(callCount(r.calls)).toBe(1);
  });

  it("다른 키는 서로의 하한에 걸리지 않는다", () => {
    const r = run(["send", "db", "데이터베이스", "본문"], {
      sent: { crons: 1 },
    });
    expect(callCount(r.calls)).toBe(1);
  });

  it("clear 는 그 키의 기록만 지운다(회복 후 즉시 재발송 가능)", () => {
    const { home, env } = makeHome({ sent: { crons: 1, db: 1 } });
    execFileSync("bash", [SCRIPT, "clear", "crons"], { env, encoding: "utf8" });
    expect(sentAt(home, "crons")).toBeNull();
    expect(sentAt(home, "db")).not.toBeNull();
  });

  it("앞자리 0 기록(089)에 산술 오류로 죽지 않는다", () => {
    // bash 는 089 를 8진수로 읽어 산술 오류를 내고, 3.2 는 set -e 아래서도 그것을
    // 삼켜 복합 명령을 통째로 건너뛴다(이 레포 실측). 10# 고정이 없으면 여기서 깨진다.
    const r = run(["send", "crons", "자동 작업", "본문"], {
      sent: { crons: "089" },
    });
    expect(r.code).toBe(0);
    expect(callCount(r.calls)).toBe(1); // 손상 기록은 리셋 → 발송된다
  });

  it("미래 시각 기록(시계 역행)은 리셋되어 발송을 막지 않는다", () => {
    const future = String(Math.floor(Date.now() / 1000) + 86400);
    const r = run(["send", "crons", "자동 작업", "본문"], {
      sent: { crons: future },
    });
    expect(callCount(r.calls)).toBe(1);
  });

  it("발송 실패(500)면 실패 마커(사유 send)가 남고 기록은 안 남는다", () => {
    const r = run(["send", "crons", "자동 작업", "본문"], { httpCode: "500" });
    expect(r.code).toBe(0); // 실패해도 앱을 죽이지 않는다
    expect(readMarker(r.home)?.reason).toBe("send");
    expect(sentAt(r.home, "crons")).toBeNull(); // 다음 회차에 다시 시도할 수 있어야 한다
  });

  it("발송 성공은 이전 실패 마커를 지운다(형식이 낡아도)", () => {
    const { home, env } = makeHome({});
    // 구 형식(1필드) 마커도 정리 대상이다 — 파싱 실패를 이유로 남겨두지 않는다.
    writeFileSync(
      path.join(home, "selfhost", "logs", "alert-send-failed"),
      "예전 실패\n",
    );
    execFileSync("bash", [SCRIPT, "send", "crons", "자동 작업", "본문"], {
      env,
      encoding: "utf8",
    });
    expect(markerExists(home)).toBe(false);
  });

  it("자격값이 없으면 조용히 사라지지 않는다 — unconfigured 마커를 남긴다(C1)", () => {
    // 예전에는 여기서 아무 흔적 없이 exit 0 했다 — .env 부재·오타로 알림이 통째로
    // 사라지는데 status.sh 는 마커가 없으니 "정상"을 주장했다.
    const r = run(["send", "crons", "자동 작업", "본문"], { noCreds: true });
    expect(r.code).toBe(0);
    expect(callCount(r.calls)).toBe(0); // 텔레그램에 요청 자체를 안 보낸다
    const marker = readMarker(r.home);
    expect(marker?.reason).toBe("unconfigured");
    expect(marker?.msg.length).toBeGreaterThan(0);
  });
});

describe("notify.sh probe (도달성 확인, 메시지 없음)", () => {
  it("자격값이 없으면 unconfigured 마커를 남기고 텔레그램에 요청하지 않는다", () => {
    const { home, calls, env } = makeHome({ noCreds: true });
    execFileSync("bash", [SCRIPT, "probe"], { env, encoding: "utf8" });
    expect(callCount(calls)).toBe(0);
    expect(readMarker(home)?.reason).toBe("unconfigured");
  });

  it("도달 실패(getMe 가 200 이 아님)면 probe 마커를 남긴다", () => {
    const { home, env } = makeHome({ httpCode: "401" });
    execFileSync("bash", [SCRIPT, "probe"], { env, encoding: "utf8" });
    expect(readMarker(home)?.reason).toBe("probe");
  });

  it("도달 성공이고 마커가 아예 없어도 죽지 않는다(TOCTOU 방지 회귀)", () => {
    // marker_field 가 "파일 없으면 return 1" 로 짜여 있으면, 이 함수를 맨
    // 대입문 우변으로 쓰는 clear_marker_unless_recent_send 가 set -e 아래서
    // 스크립트를 통째로 죽인다(2026-08-19 리뷰 실측: 동시에 도는 send 성공
    // 분기의 rm -f 가 확인-사용 사이에 마커를 지우는 경쟁도 같은 경로를 밟는다).
    const { home, code } = run(["probe"]);
    expect(code).toBe(0);
    expect(markerExists(home)).toBe(false);
  });

  it("도달 성공이면 unconfigured 마커를 지운다", () => {
    const { home, env } = makeHome({});
    seedMarker(home, "unconfigured", 1);
    execFileSync("bash", [SCRIPT, "probe"], { env, encoding: "utf8" });
    expect(markerExists(home)).toBe(false);
  });

  it("도달 성공이면 probe 마커를 지운다", () => {
    const { home, env } = makeHome({});
    seedMarker(home, "probe", 1);
    execFileSync("bash", [SCRIPT, "probe"], { env, encoding: "utf8" });
    expect(markerExists(home)).toBe(false);
  });

  it("도달 성공이어도 send 마커가 24시간 안이면 유지한다(실제 유실 사실이라 남긴다)", () => {
    const { home, env } = makeHome({});
    seedMarker(home, "send", 23);
    execFileSync("bash", [SCRIPT, "probe"], { env, encoding: "utf8" });
    expect(readMarker(home)?.reason).toBe("send");
  });

  it("send 마커가 24시간을 넘겼으면 도달 성공 시 지운다", () => {
    const { home, env } = makeHome({});
    seedMarker(home, "send", 25);
    execFileSync("bash", [SCRIPT, "probe"], { env, encoding: "utf8" });
    expect(markerExists(home)).toBe(false);
  });

  it("직전 probe 로부터 1시간 안이면 아무 일도 하지 않는다(자기 빈도 상한)", () => {
    const { home, calls, env } = makeHome({ httpCode: "500" }); // 실패 코드를 줘도
    seedProbeLast(home, 30 * 60); // 30분 전
    execFileSync("bash", [SCRIPT, "probe"], { env, encoding: "utf8" });
    expect(callCount(calls)).toBe(0); // 텔레그램에 요청 자체가 안 나간다
    expect(markerExists(home)).toBe(false); // 마커도 새로 생기지 않는다
  });

  it("직전 probe 로부터 1시간이 지났으면 다시 확인한다", () => {
    const { home, calls, env } = makeHome({ httpCode: "500" });
    seedProbeLast(home, 61 * 60);
    execFileSync("bash", [SCRIPT, "probe"], { env, encoding: "utf8" });
    expect(callCount(calls)).toBe(1);
  });
});

describe("notify.sh 동시 실행 (I4 — alert-sent.tsv 경쟁)", () => {
  it("두 프로세스가 서로 다른 키를 동시에 보내도 서로의 기록을 지우지 않는다", async () => {
    const { home, env } = makeHome({});
    // curl 스텁에 짧은 지연을 둬서 두 프로세스의 파일 쓰기 구간이 겹치도록 만든다 —
    // 잠금이 없으면 나중에 끝난 쪽의 mv 가 먼저 쓴 쪽의 기록을 통째로 덮는다.
    const curlImpl = path.join(home, "curl-slow.impl");
    writeFileSync(
      curlImpl,
      `printf '%s\\n' "$*" >> "${path.join(home, "calls.log")}"\nperl -e 'select(undef,undef,undef,0.15)'\nprintf '200'\n`,
    );
    const slowEnv = { ...env, NOTIFY_CURL_CMD: `bash ${curlImpl}` };
    await Promise.all([
      execFileAsync("bash", [SCRIPT, "send", "keyA", "제목A", "본문A"], {
        env: slowEnv,
        encoding: "utf8",
      }),
      execFileAsync("bash", [SCRIPT, "send", "keyB", "제목B", "본문B"], {
        env: slowEnv,
        encoding: "utf8",
      }),
    ]);
    expect(sentAt(home, "keyA")).not.toBeNull();
    expect(sentAt(home, "keyB")).not.toBeNull();
  });
});

/**
 * 회귀: `mtime_of` 는 **숫자만** 반환해야 한다 (2026-08-21 CI 실측).
 *
 * BSD 와 GNU 의 `stat -f` 는 정반대다 — BSD 는 포맷 플래그지만 GNU 는 `--file-system`
 * (불리언)이다. 그래서 GNU 호스트에서 `stat -f %m X` 는 `%m` 과 `X` 를 두 개의 파일
 * 인자로 읽고, 없는 `%m` 때문에 실패하면서도 **stdout 에는 X 의 파일시스템 블록
 * (`  File: "..."`)을 이미 뱉는다.** 그 텍스트가 호출부의 `$(( ))` 에 들어가
 * `set -u` 아래에서 `File: unbound variable` 로 스크립트가 통째로 죽었다.
 *
 * 🪤 이 결함은 **macOS 에서는 구조적으로 재현되지 않는다** — 첫 분기가 성공해 GNU
 *    분기를 아예 안 타기 때문이다. 게다가 호출부는 잠금 경쟁 때만 도달해, CI 에서도
 *    간헐적으로만 터졌다(로컬 초록 + CI 빨강). 그래서 테스트가 **GNU 를 흉내 내고**,
 *    아래 양성 대조군으로 그 흉내가 실제로 GNU 처럼 구는지 먼저 확인한다.
 */
describe("notify.sh 잠금 나이 판정 (GNU coreutils 호스트)", () => {
  const bin = mkdtempSync(path.join(tmp, "gnustat-"));
  writeStatStub(bin, GNU_STAT_IMPL_BODY);
  const gnuEnv = statStubEnv(bin);

  it("양성 대조군 — 스텁이 실제로 GNU 처럼 군다(아니면 아래 테스트는 공허하다)", () => {
    const out = execFileSync(
      "bash",
      ["-c", `stat -f %m "${tmp}" 2>/dev/null || true`],
      {
        env: { ...process.env, ...gnuEnv },
        encoding: "utf8",
      },
    );
    // BSD 라면 순수 숫자다. 여기서 숫자가 나오면 스텁이 PATH 를 못 먹은 것이다.
    expect(out).toContain("File:");
    expect(Number.isNaN(Number(out.trim()))).toBe(true);
  });

  it("GNU 호스트에서도 스테일 락을 회수하고 발송한다", () => {
    const { home, env } = makeHome({});
    const lock = path.join(home, "selfhost", "logs", "alert-sent.lock");
    mkdirSync(lock, { recursive: true });
    // LOCK_STALE_S(30s)보다 확실히 오래된 락 — 회수 경로가 mtime_of 를 호출한다.
    const old = Math.floor(Date.now() / 1000) - 600;
    utimesSync(lock, old, old);

    // 고치기 전에는 여기서 `File: unbound variable` 로 죽어 execFileSync 가 throw 했다.
    execFileSync("bash", [SCRIPT, "send", "keyGnu", "제목", "본문"], {
      env: { ...env, ...gnuEnv },
      encoding: "utf8",
    });

    expect(sentAt(home, "keyGnu")).not.toBeNull();
    // 스테일 락이 회수됐는가 — 나이를 잘못 읽으면 영영 안 풀린다.
    expect(existsSync(lock)).toBe(false);
  });
});

describe("notify.sh 요약(digest) 하한 — 항목 알림과 다른 상한을 쓴다", () => {
  // 하루 1회 요약은 항목 전환 알림과 성격이 다르다. 6시간 하한을 그대로 쓰면 지속
  // 실패 중 하루 4통이 되어 「같은 항목이 빨강인 채 유지 = 0회」로 잡아 둔 소음 예산이
  // 무너진다. 그래서 digest 키만 별도의 긴 하한을 쓴다 — 앱의 하루 표식이 재시작으로
  // 리셋돼도(메모리다) 이 디스크 하한이 하루 1통을 지킨다.
  it("19시간 전에 보냈으면 아직 안 나간다", () => {
    const r = run(["send", "digest", "아직 빨강입니다", "자동 작업: 1개가 늦었습니다"], {
      sent: { digest: 19 },
    });
    expect(callCount(r.calls)).toBe(0);
  });

  it("21시간 전에 보냈으면 다시 나간다", () => {
    const r = run(["send", "digest", "아직 빨강입니다", "자동 작업: 1개가 늦었습니다"], {
      sent: { digest: 21 },
    });
    expect(callCount(r.calls)).toBe(1);
    expect(sentAt(r.home, "digest")).toBeGreaterThan(0);
  });

  it("항목 키의 6시간 하한은 그대로다(회귀) — digest 하한이 전파되지 않는다", () => {
    const r = run(["send", "crons", "자동 작업", "1개가 늦었습니다"], {
      sent: { crons: 7 },
    });
    expect(callCount(r.calls)).toBe(1);
  });

  it("항목 키의 clear 는 digest 기록을 지우지 않는다", () => {
    const r = run(["clear", "crons"], { sent: { crons: 1, digest: 1 } });
    expect(sentAt(r.home, "crons")).toBeNull();
    expect(sentAt(r.home, "digest")).toBeGreaterThan(0);
  });
});

describe("notify.sh 발송 이력 (alert-history.tsv — 사후 조사용 흔적)", () => {
  it("발송이 나가면 이력에 한 줄이 쌓인다 — 에포크·키·제목·상세", () => {
    const r = run(["send", "crons", "자동 작업", "3개가 예정보다 늦었습니다"]);
    const lines = historyLines(r.home);
    expect(lines).toHaveLength(1);
    expect(lines[0].key).toBe("crons");
    expect(lines[0].title).toBe("자동 작업");
    expect(lines[0].detail).toBe("3개가 예정보다 늦었습니다");
    expect(lines[0].epoch).toBeGreaterThan(1_700_000_000);
  });

  it("clear 는 이력을 지우지 않는다 — 억제 기록만 지운다", () => {
    // 이 기능의 존재 이유다. 회복하면 alert-sent.tsv 의 행은 사라지지만(의도된
    // 동작 — 6시간 하한을 회복 후에 우회하기 위한 것), 그때 발송 흔적까지 함께
    // 사라져 사후 조사가 불가능해지던 것이 2026-08-25 에 실제로 문제가 됐다.
    const { home, env } = makeHome({});
    execFileSync("bash", [SCRIPT, "send", "crons", "자동 작업", "본문"], {
      env,
      encoding: "utf8",
    });
    execFileSync("bash", [SCRIPT, "clear", "crons"], { env, encoding: "utf8" });
    expect(sentAt(home, "crons")).toBeNull();
    expect(historyLines(home)).toHaveLength(1);
  });

  it("회복 후 다시 나쁜 상태가 되면 이력은 덮이지 않고 쌓인다", () => {
    const { home, env } = makeHome({});
    const send = () =>
      execFileSync("bash", [SCRIPT, "send", "crons", "자동 작업", "본문"], {
        env,
        encoding: "utf8",
      });
    send();
    execFileSync("bash", [SCRIPT, "clear", "crons"], { env, encoding: "utf8" });
    send();
    expect(historyLines(home)).toHaveLength(2);
  });

  it("하한에 막혀 안 나간 발송은 이력에 남지 않는다", () => {
    const r = run(["send", "crons", "자동 작업", "본문"], {
      sent: { crons: 5 },
    });
    expect(callCount(r.calls)).toBe(0);
    expect(historyLines(r.home)).toHaveLength(0);
  });

  it("발송 실패(500)는 이력에 남지 않는다 — 실제로 나간 것만 적는다", () => {
    const r = run(["send", "crons", "자동 작업", "본문"], { httpCode: "500" });
    expect(readMarker(r.home)?.reason).toBe("send");
    expect(historyLines(r.home)).toHaveLength(0);
  });

  it("자격값이 없어 아예 못 보낸 것도 이력에 남지 않는다", () => {
    const r = run(["send", "crons", "자동 작업", "본문"], { noCreds: true });
    expect(readMarker(r.home)?.reason).toBe("unconfigured");
    expect(historyLines(r.home)).toHaveLength(0);
  });

  it("제목·상세에 탭이나 개행이 있어도 한 줄 4필드가 유지된다", () => {
    // status.sh 의 현행 문구에는 탭이 없지만, 그 파일이 문구를 소유하므로 나중에
    // 들어올 수 있다. 필드 구분자가 본문에 섞이면 이력 전체가 파싱 불능이 된다.
    const r = run(["send", "crons", "자동\t작업", "첫 줄\n둘째 줄"]);
    const raw = readFileSync(path.join(r.home, ...HISTORY_REL), "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
    const lines = historyLines(r.home);
    expect(lines).toHaveLength(1);
    expect(lines[0].key).toBe("crons");
    expect(lines[0].detail).toContain("둘째 줄");
  });

  it("요약(digest)도 같은 이력에 남는다 — 채널이 하나이므로 장부도 하나다", () => {
    const r = run(["send", "digest", "지금 빨강", "자동 작업 · 데이터베이스"]);
    expect(historyLines(r.home)[0].key).toBe("digest");
  });
});

describe("notify.sh 소스 계약", () => {
  const SRC = readFileSync(SCRIPT, "utf8");

  it("재발송 하한이 이름 붙은 상수로 존재하고 값이 6이다", () => {
    const m = /^RESEND_MIN_INTERVAL_H=(\d+)/m.exec(SRC);
    expect(
      m,
      "RESEND_MIN_INTERVAL_H 선언을 찾지 못했다(앵커 함정)",
    ).not.toBeNull();
    expect(Number(m![1])).toBe(6);
  });

  it("요약 하한이 이름 붙은 상수로 존재하고 하루 1통을 보장한다(20 이상)", () => {
    const m = /^DIGEST_MIN_INTERVAL_H=(\d+)/m.exec(SRC);
    expect(
      m,
      "DIGEST_MIN_INTERVAL_H 선언을 찾지 못했다(앵커 함정)",
    ).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(20);
  });

  it("파괴적 명령이 없다", () => {
    const active = SRC.split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(active).not.toMatch(/\bdocker\s+(rm|stop|kill)\b/);
    expect(active).not.toMatch(/\blaunchctl\s+(bootout|bootstrap)\b/);
    expect(active).not.toMatch(/\brm\s+-rf\b/);
  });
});

describe("셸 스크립트 시크릿 리터럴 계약", () => {
  // hardcoded-secret-literals.contract.test.ts 의 SCAN_DIRS 는 ["src","scripts"] 뿐이라
  // infra/selfhost/*.sh 를 **원래부터 보지 않는다**(실측). 새 스크립트가 그 사각에
  // 얹히지 않도록 여기서 셸만 따로 스캔한다.
  const DIR = path.resolve(__dirname, "..", "..", "infra", "selfhost");
  const TELEGRAM_TOKEN_RE = /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/;

  function shellSources(): Array<[string, string]> {
    // ⛔ require() 를 쓰지 말 것 — 이 스위트는 ESM 이라 CJS require 가 없다.
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".sh"))
      .map(
        (f) => [f, readFileSync(path.join(DIR, f), "utf8")] as [string, string],
      );
  }

  it("스캐너가 실제로 파일을 찾는다(공허 통과 방지)", () => {
    expect(shellSources().length).toBeGreaterThanOrEqual(5);
  });

  it("텔레그램 토큰 형태의 리터럴이 없다", () => {
    for (const [name, src] of shellSources())
      expect(src, name).not.toMatch(TELEGRAM_TOKEN_RE);
  });

  it("양성 프로브 — 스캐너가 실제로 잡는다", () => {
    expect('TOKEN="1234567890:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr"').toMatch(
      TELEGRAM_TOKEN_RE,
    );
  });
});
