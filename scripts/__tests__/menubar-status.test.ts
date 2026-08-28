import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * status.sh 는 메뉴바 앱이 표시하는 모든 판정의 SSOT 다. 두 가지를 고정한다:
 *  (1) 행위 — 스텁 도구(curl/docker/git)·픽스처 로그로 hermetic 실행해 JSON
 *      스키마와 판정을 검증한다. 실 네트워크·실 docker 를 건드리지 않아 CI 에서도
 *      결정론적이다. 스텁은 **실행 권한 없는 데이터 파일**을 STATUS_*_CMD 훅으로
 *      "bash <파일>" 형태로 주입한다 — PATH 에 새 실행파일을 만들면
 *      gh-stub-guard.contract.test.ts 계약 위반이자 macOS 첫-execve 보안 검사
 *      (400~700ms)로 부하 시 타임아웃이 재발한다(2026-08-04 실사고 계열).
 *  (2) 소스 — 읽기 전용 계약. 파괴적 docker/launchctl/rm 줄이 하나라도 생기면
 *      preview.sh 의 프로덕션 보호 가드 밖에서 시스템을 조작할 통로가 열린다.
 */
const SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "status.sh");
const SRC = readFileSync(SCRIPT, "utf8");
const RELEASE_STATUS_SCRIPT = path.resolve(
  __dirname, "..", "..", "infra", "selfhost", "release-status.sh",
);

const tmp = mkdtempSync(path.join(tmpdir(), "menubar-status-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 실행 비트 없는 스텁 본문 — status.sh 의 STATUS_*_CMD 훅이 `bash <파일>` 로 읽는다. */
function stub(dir: string, name: string, body: string): string {
  const p = path.join(dir, `${name}.impl`);
  writeFileSync(p, `${body}\n`);
  return p;
}

/** 스탬프를 "n시간 전"으로 만든다 — 고정 날짜 픽스처 금지(P9 시한폭탄 방지). */
function stampHoursAgo(hours: number): string {
  const d = new Date(Date.now() - hours * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

interface RunOpts {
  localCode?: string;
  extCode?: string;
  /** 개발 서버(3002) 응답 코드. 기본 "000" = 꺼져 있음(정상) */
  devCode?: string;
  /** undefined = running / "" = docker inspect 실패(컨테이너 없음) / 그 외 = 그 상태 문자열 */
  dbState?: string;
  dailyAgeH?: number;
  weeklyAgeH?: number;
  plistUp?: boolean;
  fast?: boolean;
  /** crontab 픽스처에 넣을 잡. "<job>" = 매일, "<job>@weekly" = 요일 고정(매주). 기본 2개(매일). */
  cronJobs?: string[];
  /** 잡별 "마지막 SUCCESS 가 몇 시간 전인가". 목록에 없는 잡은 SUCCESS 기록이 없는 것으로 본다. */
  cronRows?: Record<string, number>;
  /** true 면 psql 조회가 실패한다(판정 불능 경로). */
  cronQueryFails?: boolean;
  /** 실행 전에 미리 심어 둘 연속 기록. firstSeenAgoH = "지금부터 몇 시간 전에 처음 관측".
   *  count 는 보통 number 지만, 손상 픽스처("089"·"abc" 등 8진수 함정·비숫자)를 그대로
   *  파일에 심기 위해 string 도 받는다. */
  unknownStreak?: Array<{ key: string; firstSeenAgoH: number; count: number | string }>;
  /** true 면 notify.sh 실패 마커를 심는다(외부 알림 발송 실패 경로, 표준 3필드 형식). */
  alertSendFailed?: boolean;
  /** 지정하면 그 내용을 그대로 마커 파일에 쓴다(형식 견고성 테스트용) — alertSendFailed 보다 우선. */
  alertSendFailedRaw?: string;
  /** Actions 이달 사용 분. 기본 200(= free 2,000 중 1,800 남음 → ok). */
  actionsUsed?: number;
  /** 계정 플랜 이름. 포함 분은 여기서 유도한다(API 가 더는 included_minutes 를 주지 않는다).
   *  기본 "free"(2,000분). "" 를 주면 플랜 조회 실패를 흉내 낸다. */
  actionsPlan?: string;
  /** 이미 청구가 붙었는가(netAmount 합 > 0). 기본 false. */
  actionsBilled?: boolean;
  /** gh 조회 실패 경로. "scope" = user 스코프 부족 / "auth" = 로그인 만료 /
   *  "moved" = 엔드포인트 이전(410) / "other" = 그 외 */
  actionsFails?: "scope" | "auth" | "other" | "moved";
  /** gh 가 형식에 안 맞는 것을 뱉는 경로(응답 해석 실패). actionsFails 보다 뒤에 평가된다. */
  actionsGarbage?: string;
  /** 레포 변수 PREFLIGHT_RUNNER 의 값(= 워크플로 runs-on 라벨). 기본 "self-hosted".
   *  "" 를 주면 「변수는 있는데 빈 값」 = 폴백이다(워크플로 조건이 != '' 이므로). */
  runnerLane?: string;
  /** true 면 변수 조회가 404 로 실패한다 — 변수를 지운 상태(= 폴백 중)의 정상 응답이다. */
  runnerVarMissing?: boolean;
  /** 변수 조회가 404 **아닌** 사유로 실패하는 경로(판정 불능). */
  runnerVarFails?: "auth" | "perm" | "other";
  /** 레포 자체가 안 보이는 경로 — 변수 404 와 **같은 stderr** 가 오지만 뜻이 다르다.
   *  true 면 변수 조회도 404 로 실패하고(현실이 그렇다) 레포 프로브도 실패한다. */
  runnerRepoInvisible?: boolean;
  /** 라벨이 맞는 등록 러너 수 / 그중 online 수. 기본 3 / 3. */
  runnerTotal?: number;
  runnerOnline?: number;
  /** 러너 목록 조회 실패 경로. */
  runnerListFails?: "auth" | "perm" | "other";
  /** 러너 목록이 형식에 안 맞는 것을 뱉는 경로. runnerListFails 보다 뒤에 평가된다. */
  runnerGarbage?: string;
}

interface StatusItem {
  key: string;
  level: string;
  title: string;
  detail: string;
  state?: string;
}

function runStatus(opts: RunOpts): { mode: string; items: StatusItem[]; home: string } {
  const home = mkdtempSync(path.join(tmp, "home-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(home, "selfhost", "logs"), { recursive: true });
  mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });

  // curl 스텁 — URL 로 내부/프리뷰/외부를 가려 코드만 출력(-w '%{http_code}' 흉내)
  const curlImpl = stub(
    bin,
    "curl",
    `URL=""
for a in "$@"; do case "$a" in http*) URL="$a";; esac; done
case "$URL" in
  *127.0.0.1:3000*) printf '%s' "${opts.localCode ?? "307"}";;
  *127.0.0.1:3001*) printf '%s' "200";;
  *127.0.0.1:3002*) printf '%s' "${opts.devCode ?? "000"}";;
  *) printf '%s' "${opts.extCode ?? "200"}";;
esac`,
  );
  const cronJobs = opts.cronJobs ?? ["job-alpha", "job-beta"];
  const cronRows = opts.cronRows ?? { "job-alpha": 1, "job-beta": 2 };
  const psqlOut = Object.entries(cronRows)
    .map(([job, agoH]) => `${job}|${Math.floor(Date.now() / 1000) - agoH * 3600}`)
    .join("\n");
  const dockerImpl = stub(
    bin,
    "docker",
    `if [ "$1" = "inspect" ]; then
  ${opts.dbState === undefined ? 'echo "running"' : opts.dbState === "" ? "exit 1" : `echo "${opts.dbState}"`}
elif [ "$1" = "exec" ]; then
  ${opts.cronQueryFails ? "exit 1" : `cat <<'PSQL_ROWS'\n${psqlOut}\nPSQL_ROWS`}
fi`,
  );
  const gitImpl = stub(
    bin,
    "git",
    `case "$*" in
  *rev-parse*) echo "main";;
esac`,
  );
  // gh 스텁 — status.sh 가 부르는 **두 호출**을 흉내 낸다: ①사용량 원장
  // (`settings/billing/usage`) ②계정 플랜(`users/<owner>`). 분기 순서가 중요하다 —
  // 사용량 URL 이 플랜 URL 을 부분문자열로 포함하므로 사용량을 먼저 잡아야 한다.
  // **기본값이 있어야 한다**: 없으면 모든 full 모드 테스트가 실 GitHub 를 때려
  // hermetic 이 깨지고 CI 에서 비결정적이 된다.
  const ghFailMsg = {
    scope: 'gh: This API operation needs the "user" scope. To request it, run:  gh auth refresh -h github.com -s user',
    auth: "gh: To get started with GitHub CLI, please run:  gh auth login",
    moved: "gh: This endpoint has been moved. (HTTP 410)",
    other: "gh: connection refused",
  };
  const usageBody = opts.actionsFails
    ? `    echo ${JSON.stringify(ghFailMsg[opts.actionsFails])} >&2\n    exit 1`
    : opts.actionsGarbage !== undefined
      ? `    printf '%s\\n' ${JSON.stringify(opts.actionsGarbage)}`
      : `    printf '%s|%s\\n' '${opts.actionsUsed ?? 200}' '${opts.actionsBilled ? "true" : "false"}'`;
  // 러너 행(preflightRunner)이 부르는 **두 호출** — ①레포 변수 PREFLIGHT_RUNNER
  // ②러너 목록. 404 는 실패가 아니라 「변수 없음 = 폴백 중」이라는 답이므로 인증 실패와
  // 갈라서 흉내 낸다(status.sh 가 그 둘을 다르게 처리하는 것이 이 행 설계의 핵심이다).
  const runnerFailMsg = {
    auth: "gh: To get started with GitHub CLI, please run:  gh auth login",
    perm: "gh: Resource not accessible by integration (HTTP 403)",
    other: "gh: connection refused",
  };
  const runnerLane = opts.runnerLane ?? "self-hosted";
  const runnerVarBody = opts.runnerVarFails
    ? `    echo ${JSON.stringify(runnerFailMsg[opts.runnerVarFails])} >&2\n    exit 1`
    : opts.runnerVarMissing || opts.runnerRepoInvisible
      ? `    echo 'gh: Not Found (HTTP 404)' >&2\n    exit 1`
      : `    printf '%s\\n' ${JSON.stringify(runnerLane)}`;
  // 레포 가시성 프로브 — 404 의 양가성(변수 없음 vs 레포 안 보임)을 가르는 유일한 통로다.
  // ⚠️ case 분기에서 **구체 패턴들 뒤에** 와야 한다(`*repos/*` 가 variables·runners 도 삼킨다).
  const repoProbeBody = opts.runnerRepoInvisible
    ? `    echo 'gh: Not Found (HTTP 404)' >&2\n    exit 1`
    : `    printf 'wagcrm\\n'`;
  // ⚠️ 라벨 필터(jq 의 env.RUNNER_LABEL)는 gh 를 통째로 스텁하므로 여기서 **실행되지
  //    않는다**. 대신 status.sh 가 라벨을 env 로 실제로 넘기는지를 이 스텁이 검사한다 —
  //    라벨이 안 넘어오면 0|0 을 주므로 배선이 끊기는 순간 아래 정상 픽스처가 빨강이 된다.
  //    jq 표현식 자체는 실 API 로 양·음성 프로브를 돌려 확인했다(2026-08-26).
  const runnersBody = opts.runnerListFails
    ? `    echo ${JSON.stringify(runnerFailMsg[opts.runnerListFails])} >&2\n    exit 1`
    : opts.runnerGarbage !== undefined
      ? `    printf '%s\\n' ${JSON.stringify(opts.runnerGarbage)}`
      : `    if [ "\${RUNNER_LABEL:-}" = ${JSON.stringify(runnerLane)} ]; then printf '%s|%s\\n' '${opts.runnerTotal ?? 3}' '${opts.runnerOnline ?? 3}'; else printf '0|0\\n'; fi`;
  const ghImpl = stub(
    bin,
    "gh",
    `case "$*" in
  *actions/variables/PREFLIGHT_RUNNER*)
${runnerVarBody}
    ;;
  *actions/runners*)
${runnersBody}
    ;;
  *repos/*)
${repoProbeBody}
    ;;
  *settings/billing/usage*)
${usageBody}
    ;;
  *users/*)
    printf '%s\n' '${opts.actionsPlan ?? "free"}'
    ;;
esac`,
  );
  const crontabFixture = path.join(home, "crontab-fixture");
  writeFileSync(
    crontabFixture,
    cronJobs
      .map((spec) => {
        const [job, weekly] = spec.split("@");
        const dow = weekly ? "1" : "*";
        return `0 0 * * ${dow} /Users/x/selfhost/wagcrm/infra/selfhost/run-cron.sh ${job} >> /dev/null 2>&1`;
      })
      .join("\n") + "\n",
  );

  if (opts.dailyAgeH !== undefined)
    writeFileSync(
      path.join(home, "selfhost", "logs", "backup.out.log"),
      `[backup] 완료: r2:wagcrm-backups/backups/${stampHoursAgo(opts.dailyAgeH)} (업로드·검증 성공)\n`,
    );
  if (opts.weeklyAgeH !== undefined)
    writeFileSync(
      path.join(home, "selfhost", "logs", "backup-weekly.out.log"),
      `[backup-weekly] 완료: gdrive:wagcrm-weekly-backups/${stampHoursAgo(opts.weeklyAgeH)} (업로드·검증 성공)\n`,
    );
  if (opts.plistUp) {
    writeFileSync(path.join(home, "Library", "LaunchAgents", "kr.ygrd.wagcrm.preview.plist"), "<plist/>");
    mkdirSync(path.join(home, "selfhost", "wagcrm-preview"), { recursive: true });
  }

  if (opts.unknownStreak) {
    const nowSec = Math.floor(Date.now() / 1000);
    writeFileSync(
      path.join(home, "selfhost", "logs", "status-unknown-streak.tsv"),
      opts.unknownStreak
        .map((s) => `${s.key}\t${nowSec - s.firstSeenAgoH * 3600}\t${s.count}`)
        .join("\n") + "\n",
    );
  }

  if (opts.alertSendFailedRaw !== undefined) {
    writeFileSync(path.join(home, "selfhost", "logs", "alert-send-failed"), opts.alertSendFailedRaw);
  } else if (opts.alertSendFailed) {
    // notify.sh 의 마커 형식(신설): <epoch><TAB><사유코드><TAB><사람이 읽는 문구>.
    writeFileSync(
      path.join(home, "selfhost", "logs", "alert-send-failed"),
      "1735689600\tsend\t2026-01-01 00:00:00 발송에 실패했습니다\n",
    );
  }

  const out = execFileSync("bash", [SCRIPT, ...(opts.fast ? ["--fast"] : [])], {
    env: {
      ...process.env,
      HOME: home,
      STATUS_CURL_CMD: `bash ${curlImpl}`,
      STATUS_DOCKER_CMD: `bash ${dockerImpl}`,
      STATUS_GIT_CMD: `bash ${gitImpl}`,
      STATUS_GH_CMD: `bash ${ghImpl}`,
      STATUS_CRONTAB_FILE: crontabFixture,
    },
    encoding: "utf8",
  });
  return { ...JSON.parse(out), home };
}

const byKey = (r: { items: StatusItem[] }, key: string): StatusItem => {
  const item = r.items.find((i) => i.key === key);
  if (!item) throw new Error(`${key} 항목이 없다`);
  return item;
};

const streakOf = (home: string, key: string): { firstSeen: number; count: number } | null => {
  const p = path.join(home, "selfhost", "logs", "status-unknown-streak.tsv");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const [k, first, count] = line.split("\t");
    if (k === key) return { firstSeen: Number(first), count: Number(count) };
  }
  return null;
};

/**
 * `docker exec ... psql -c "$VAR"` 가 참조하는 SQL 변수의 값이 "단일 읽기전용 SELECT"
 * 인지 판정한다. `supabase_admin` 은 읽기전용 DB 롤이 아니고(리뷰 실측) psql -c 는
 * 세미콜론으로 이어붙인 여러 문장을 전부 실행하므로, "select 라는 단어가 어딘가
 * 있다"만으로는 `select 1; delete from "SystemTaskLog";` 같은 페이로드를 못 막는다
 * (리뷰가 표준 재현으로 실측한 바이패스). 이 함수가 이 파일에서 유일한 안전망이다 —
 * DB 권한 쪽 백스톱이 없다.
 */
function isSingleReadOnlySelect(sqlBody: string): boolean {
  if (!/^\s*select\b/i.test(sqlBody)) return false;
  const withoutOneTrailingSemicolon = sqlBody.replace(/;\s*$/, "");
  return !withoutOneTrailingSemicolon.includes(";");
}

describe("status.sh 행위 계약", () => {
  it("정상 픽스처: 스키마 완비, 핵심 항목 전부 ok", () => {
    const r = runStatus({ dailyAgeH: 5, weeklyAgeH: 24 });
    expect(r.mode).toBe("full");
    for (const key of [
      "prodLocal",
      "prodExternal",
      "db",
      "devServer",
      "backupDaily",
      "backupWeekly",
      "disk",
      "preview",
    ])
      expect(r.items.map((i) => i.key)).toContain(key);
    expect(byKey(r, "prodLocal").level).toBe("ok");
    expect(byKey(r, "prodExternal").level).toBe("ok");
    expect(byKey(r, "db").level).toBe("ok");
    expect(byKey(r, "backupDaily").level).toBe("ok");
    expect(byKey(r, "backupWeekly").level).toBe("ok");
    expect(byKey(r, "preview").state).toBe("down");
    // disk 는 실행 머신의 실제 df 를 읽으므로 레벨을 고정하지 않는다 — 형태만 본다.
    expect(["ok", "warn", "error", "unknown"]).toContain(byKey(r, "disk").level);
  });

  it("--fast 는 경량 4종만 낸다", () => {
    const r = runStatus({ fast: true });
    expect(r.mode).toBe("fast");
    expect(r.items.map((i) => i.key).sort()).toEqual(["db", "devServer", "preview", "prodLocal"]);
  });

  it("개발 서버: 000 → down(정상 ok) / 200 → up", () => {
    const off = byKey(runStatus({ fast: true }), "devServer");
    expect(off.state).toBe("down");
    expect(off.level).toBe("ok"); // 꺼져 있음은 정상 — 빨간불 금지
    const on = byKey(runStatus({ fast: true, devCode: "200" }), "devServer");
    expect(on.state).toBe("up");
    expect(on.detail).toContain("3002");
    expect(on.detail).toContain("main"); // 개발 체크아웃 브랜치 표기(낡은 브랜치 함정 대응)
  });

  it("내부 ok + 외부 000 → 터널 문제 문구", () => {
    const r = runStatus({ extCode: "000", dailyAgeH: 5, weeklyAgeH: 24 });
    const ext = byKey(r, "prodExternal");
    expect(ext.level).toBe("error");
    expect(ext.detail).toContain("터널");
  });

  it("내부 000 → prodLocal error, 외부 실패 문구에 터널 없음", () => {
    const r = runStatus({ localCode: "000", extCode: "000", dailyAgeH: 5, weeklyAgeH: 24 });
    expect(byKey(r, "prodLocal").level).toBe("error");
    const ext = byKey(r, "prodExternal");
    expect(ext.level).toBe("error");
    expect(ext.detail).not.toContain("터널");
  });

  it("백업 나이 판정: 5h ok / 30h warn / 60h error / 기록 없음 unknown", () => {
    expect(byKey(runStatus({ dailyAgeH: 5 }), "backupDaily").level).toBe("ok");
    expect(byKey(runStatus({ dailyAgeH: 30 }), "backupDaily").level).toBe("warn");
    expect(byKey(runStatus({ dailyAgeH: 60 }), "backupDaily").level).toBe("error");
    expect(byKey(runStatus({}), "backupDaily").level).toBe("unknown");
  });

  it("DB 상태: running ok / exited error / 컨테이너 없음 error", () => {
    expect(byKey(runStatus({ fast: true }), "db").level).toBe("ok");
    expect(byKey(runStatus({ fast: true, dbState: "exited" }), "db").level).toBe("error");
    expect(byKey(runStatus({ fast: true, dbState: "" }), "db").level).toBe("error");
  });

  it("프리뷰 plist 있음 + 응답 → up/ok, 브랜치 표기", () => {
    const pv = byKey(runStatus({ fast: true, plistUp: true }), "preview");
    expect(pv.state).toBe("up");
    expect(pv.level).toBe("ok");
    expect(pv.detail).toContain("main");
  });

  it("크론 전부 최신: crons ok, 개수를 말한다", () => {
    const r = runStatus({ dailyAgeH: 5, weeklyAgeH: 24, cronJobs: ["a", "b", "c"], cronRows: { a: 1, b: 2, c: 3 } });
    const item = byKey(r, "crons");
    expect(item.level).toBe("ok");
    expect(item.detail).toContain("3개");
  });

  it("매일 잡이 문턱(30h)을 넘기면 error 이고 잡 이름을 싣는다", () => {
    const r = runStatus({ dailyAgeH: 5, weeklyAgeH: 24, cronJobs: ["a", "b"], cronRows: { a: 40, b: 2 } });
    const item = byKey(r, "crons");
    expect(item.level).toBe("error");
    expect(item.detail).toContain("a");
    expect(item.detail).toContain("1개");
  });

  it("매주 잡은 30h 로 늦었다고 하지 않는다(주기별 문턱)", () => {
    const r = runStatus({ dailyAgeH: 5, weeklyAgeH: 24, cronJobs: ["w@weekly"], cronRows: { w: 40 } });
    expect(byKey(r, "crons").level).toBe("ok");
  });

  it("성공 기록이 없는 잡은 warn 이다(새로 추가된 크론 오탐 방지)", () => {
    const r = runStatus({ dailyAgeH: 5, weeklyAgeH: 24, cronJobs: ["a", "fresh"], cronRows: { a: 1 } });
    expect(byKey(r, "crons").level).toBe("warn");
  });

  it("조회가 실패하면 unknown 이다 — ok 로 가장하지 않는다", () => {
    const r = runStatus({ dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true });
    expect(byKey(r, "crons").level).toBe("unknown");
  });

  it("crontab 파싱이 cutover.sh 와 같은 앵커 정규식을 쓴다", () => {
    // 앵커(^[0-9*])를 빼면 `run-cron.sh` 를 언급하는 **주석 줄까지** 세어 활성 잡보다 큰 수가
    // 나온다(2026-08-13 실측: 잡 15개인데 18). 개수를 세는 곳이 이미 셋(cutover.sh · README ·
    // 여기)이라 정규식이 갈리면 서로 다른 수를 말한다.
    const statusSrc = readFileSync(SCRIPT, "utf8");
    const cutover = readFileSync(
      path.resolve(__dirname, "..", "..", "infra", "selfhost", "cutover.sh"),
      "utf8",
    );
    expect(cutover, "cutover.sh 앵커 없음(공허 통과 방지)").toContain("run-cron");
    expect(statusSrc).toMatch(/\^\[0-9\*\].*run-cron/);
    expect(cutover).toMatch(/\^\[0-9\*\].*run-cron/);
  });

  it("늦은 잡이 4개 이상이면 앞 3개만 싣고 나머지는 접는다(배너 두 줄 상한)", () => {
    const r = runStatus({
      dailyAgeH: 5,
      weeklyAgeH: 24,
      cronJobs: ["a", "b", "c", "d"],
      cronRows: { a: 40, b: 41, c: 42, d: 43 },
    });
    const item = byKey(r, "crons");
    expect(item.level).toBe("error");
    expect(item.detail).toContain("외 1개");
    expect(item.detail).not.toContain("d");
  });

  it("문턱 미달(경과는 넘고 횟수 부족)이면 승격하지 않는다", () => {
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: 10, count: 3 }],
    });
    expect(byKey(r, "crons").level).toBe("unknown");
  });

  it("문턱 미달(횟수는 넘고 경과 부족)이면 승격하지 않는다", () => {
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: 1, count: 50 }],
    });
    expect(byKey(r, "crons").level).toBe("unknown");
  });

  it("경과·횟수 둘 다 넘기면 error 로 승격하고 사유를 앞에 붙인다", () => {
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: 4, count: 20 }],
    });
    const item = byKey(r, "crons");
    expect(item.level).toBe("error");
    expect(item.detail).toContain("확인 불가가");
    expect(item.detail).toContain("연속");
    // 원래 문구를 지우지 않는다 — 승격된 빨강과 진짜 장애 빨강을 구분해야 한다.
    expect(item.detail).toContain("기록을 읽지 못했습니다");
  });

  it("경계 — 정확히 문턱(3시간·직전 11회 → 이번에 12회)이면 승격한다", () => {
    // -ge 를 -gt 로 잘못 쓰면 이 건만 실패한다. 문턱을 "이상" 으로 못 박는 자리다.
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: 3, count: 11 }],
    });
    expect(byKey(r, "crons").level).toBe("error");
  });

  it("경계 — 문턱 바로 아래(2시간·직전 10회)면 승격하지 않는다", () => {
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: 2, count: 10 }],
    });
    expect(byKey(r, "crons").level).toBe("unknown");
  });

  it("unknown 이 아닌 판정을 관측하면 기록이 지워진다", () => {
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24,
      unknownStreak: [{ key: "crons", firstSeenAgoH: 4, count: 20 }],
    });
    expect(byKey(r, "crons").level).toBe("ok");
    expect(streakOf(r.home, "crons")).toBeNull();
  });

  it("연속 기록이 없으면 이번 회차에 1로 생성된다", () => {
    const r = runStatus({ dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true });
    expect(byKey(r, "crons").level).toBe("unknown");
    expect(streakOf(r.home, "crons")?.count).toBe(1);
  });

  it("기존 기록이 있으면 횟수만 늘고 최초관측 시각은 유지된다", () => {
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: 2, count: 5 }],
    });
    const s = streakOf(r.home, "crons")!;
    expect(s.count).toBe(6);
    expect(Math.round((Math.floor(Date.now() / 1000) - s.firstSeen) / 3600)).toBe(2);
  });

  it("망가진 기록(숫자 아님)은 리셋되고 승격하지 않는다", () => {
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: 4, count: 20 }],
    });
    // 위 실행으로 파일이 정상 갱신됐음을 먼저 확인한 뒤(대조군), 손상 케이스를 따로 본다.
    expect(byKey(r, "crons").level).toBe("error");
    const broken = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: NaN, count: 20 }],
    });
    expect(byKey(broken, "crons").level).toBe("unknown");
  });

  it("미래 시각(시계 역행)은 리셋되고 승격하지 않는다", () => {
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: -5, count: 99 }],
    });
    expect(byKey(r, "crons").level).toBe("unknown");
  });

  it("firstSeen 이 비현실적으로 오래됐으면(파일 손상) 리셋되고 승격하지 않는다(Minor 2)", () => {
    // firstSeen=0(1970-01-01) 이면 "확인 불가가 496424시간째입니다" 처럼 운영자 언어가
    // 아닌 수치가 나간다(리뷰 실측). 정상 경로로는 절대 나오지 않는 값이므로 50년 전으로
    // 같은 증상을 재현한다 — STREAK_FIRSTSEEN_MAX_AGE_H(1년) 를 훌쩍 넘는다.
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: 50 * 365 * 24, count: 20 }],
    });
    expect(byKey(r, "crons").level).toBe("unknown");
    expect(streakOf(r.home, "crons")?.count).toBe(1);
  });

  it("앞자리 0 이 있는 count(089)는 8진수 함정 없이 정상 십진수로 읽혀 페이로드를 안 끊는다(Minor 1)", () => {
    // bash 3.2 는 `$((count + 1))` 에서 count="089" 를 8진수로 읽다 유효하지 않은 자릿수
    // (8·9)를 만나면 set -e 없이도 그 복합 명령만 조용히 건너뛰어 스크립트가 끝까지 못
    // 돈다(리뷰 실측: crons\t<epoch>\t089 를 심으면 exit 0 인데 crons·disk 가 통째로
    // 페이로드에서 빠졌다). "089" 는 손상이 아니라 앞자리 0 이 붙은 정상 값이므로 10# 로
    // 밑을 고정하면 89 로 읽혀 정상 승격(89+1=90 ≥ 12, 4h ≥ 3h)해야 한다 — 리셋 대상이
    // 아니다.
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: 4, count: "089" }],
    });
    // 페이로드가 안 끊겼다 — disk 처럼 무관한 항목까지 사라지는 옛 증상의 반대 증명.
    expect(r.items.map((i) => i.key)).toContain("disk");
    expect(byKey(r, "crons").level).toBe("error");
    expect(streakOf(r.home, "crons")?.count).toBe(90);
  });

  it("망가진 기록(count 가 숫자 아님)도 리셋되고 승격하지 않는다 — count 전용 손상 가드(Minor 3+4)", () => {
    // 위 "망가진 기록(숫자 아님)은 리셋되고 승격하지 않는다" 테스트는 firstSeen 만
    // 깨뜨린다(firstSeenAgoH: NaN → 파일에 "NaN" 이 적힌다). count 손상 가드
    // (`case ... esac`)는 그 테스트로는 한 번도 실행되지 않는다 — 여기서 count 만 따로
    // 깨뜨려 직접 겨냥한다.
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24, cronQueryFails: true,
      unknownStreak: [{ key: "crons", firstSeenAgoH: 4, count: "abc" }],
    });
    expect(byKey(r, "crons").level).toBe("unknown");
    expect(streakOf(r.home, "crons")?.count).toBe(1);
  });

  it("disk 는 승격 대상이 아니다(오너 결정) — 연속 기록이 STREAK_NEXT 로 넘어가지 않는다", () => {
    // disk 의 level 자체는 실행 머신의 실제 df 를 읽으므로 여기서 고정하지 않는다(위
    // "정상 픽스처" 테스트의 원칙과 동일). 오너 결정인 "제외"는 level 이 아니라 연속
    // 기록의 생존 여부로 검증해야 한다 — disk 가 UNKNOWN_ESCALATABLE_KEYS 밖이므로,
    // 미리 심어 둔 기록은 이번 실행에서 STREAK_NEXT 로 옮겨지지 않고 사라져야 한다
    // (승격 대상이었다면 count 가 증가한 채로 남는다). 환경(실제 여유 공간)에 좌우되지 않는다.
    const r = runStatus({
      dailyAgeH: 5, weeklyAgeH: 24,
      unknownStreak: [{ key: "disk", firstSeenAgoH: 99, count: 999 }],
    });
    expect(streakOf(r.home, "disk")).toBeNull();
  });

  it("UNKNOWN_ESCALATABLE_KEYS 선언에 disk 가 없고 의도한 4개는 있다(소스 스캔)", () => {
    // 위 런타임 테스트("disk 는 승격 대상이 아니다")는 이 하네스에서 $HOME 이 항상 실제
    // 임시 디렉터리라 df 가 늘 성공한다 — disk 의 level 이 unknown 이 될 일이 없어
    // streak-append 분기 자체에 도달하지 못한다. 그래서 disk 를 UNKNOWN_ESCALATABLE_KEYS
    // 에 몰래 넣는 회귀가 나도 그 테스트는 계속 통과한다(재검토 실측). 여기서는 런타임을
    // 거치지 않고 선언 자체를 텍스트로 스캔해 그 회귀를 직접 잡는다.
    // 앵커가 안 걸리면 공허 통과이므로 매치 존재를 먼저 단언한다(이 저장소의 소스 스캔
    // 계약 관례 — 이 파일의 "crontab 파싱이 cutover.sh 와 같은 앵커 정규식을 쓴다" 참고).
    const m = SRC.match(/^UNKNOWN_ESCALATABLE_KEYS="([^"]*)"/m);
    expect(m, "UNKNOWN_ESCALATABLE_KEYS 선언을 찾지 못했다(앵커 불일치 — 공허 통과 방지)").toBeTruthy();
    const keys = m![1].split(/\s+/).filter(Boolean);
    // 부정: disk 는 오너 결정으로 제외돼야 한다.
    expect(keys).not.toContain("disk");
    // 긍정: 상수 전체를 지워도 위 not.toContain 은 공허하게 통과하므로, 의도한 4개가
    // 실제로 있는지도 함께 본다.
    expect(keys).toEqual(expect.arrayContaining(["db", "backupDaily", "backupWeekly", "crons"]));
  });

  it("--fast 는 상태 파일에 손대지 않는다", () => {
    // db 는 --fast 에서도 나오는 유일한 승격 대상이라 그 unknown 분기(도구 없음)가 이
    // 하네스에서 도달 불능이다(STATUS_DOCKER_CMD 가 항상 주입되므로 db 는 ok/error 로만
    // 귀결된다). "레코드가 생겼는지"만 보면 파일 쓰기 가드를 지워도 통과해 버리므로,
    // --fast 에서 아예 emit 되지 않는 crons 에 기록을 미리 심어 두고 실행 전후로 그 값이
    // (firstSeen·count 모두) 그대로인지 확인한다 — 시딩·실행 사이의 시계 오차만 허용한다.
    const seeded = { key: "crons", firstSeenAgoH: 5, count: 7 };
    const before = Math.floor(Date.now() / 1000);
    const r = runStatus({ fast: true, unknownStreak: [seeded] });
    const after = Math.floor(Date.now() / 1000);
    const s = streakOf(r.home, "crons");
    expect(s).not.toBeNull();
    expect(s!.count).toBe(seeded.count);
    expect(s!.firstSeen).toBeGreaterThanOrEqual(before - seeded.firstSeenAgoH * 3600);
    expect(s!.firstSeen).toBeLessThanOrEqual(after - seeded.firstSeenAgoH * 3600);
  });
});

describe("emit() 의 승격 오버라이드 — read-only 적용과 full-only 증가의 분리(Important 1 회귀 고정)", () => {
  // db 는 --fast 에도 나오는 유일한 승격 대상인데, DB_STATE 판정 코드는 이 하네스에서
  // "unknown" 에 도달할 방법이 없다(위 "--fast 는 상태 파일에 손대지 않는다" 테스트
  // 주석과 같은 제약 — STATUS_DOCKER_CMD 가 항상 주입되므로 db 는 ok/error 로만
  // 귀결된다. PATH 조작으로 "도구 없음"을 흉내 내는 것도 이 개발 머신에 실 docker 가
  // /usr/local/bin/docker 로 실재해 비결정적이라 위험하다 — 다른 머신에선 통과하고 이
  // 머신에선 실패하는 식의 환경 의존 테스트가 된다). 그래서 emit() 함수 자체를
  // 분리해서 부른다 — status.sh 맨 앞부터 emit() 정의가 끝나는 지점(다음 섹션 헤더
  // "# ── 경량 검사" 직전)까지를 그대로 잘라 새 스크립트로 만들고 `emit db unknown ...`
  // 을 직접 호출한다. 실 파일을 재구현하지 않고 그대로 잘라 쓰므로 로직 중복이 없다.
  // 잘라내는 지점은 줄 번호가 아니라 이미 파일에 있는 섹션 헤더 주석을 앵커로 삼는다 —
  // 그 위 코드가 늘어나도 안 깨진다(앵커가 없으면 곧바로 실패해 공허 통과를 막는다).
  const SECTION_MARKER = "# ── 경량 검사";
  const markerIdx = SRC.indexOf(SECTION_MARKER);
  if (markerIdx < 0) {
    throw new Error(`emit() 추출 앵커("${SECTION_MARKER}")를 status.sh 에서 찾지 못했다 — 구조가 바뀌었다`);
  }
  const emitPrelude = SRC.slice(0, markerIdx);

  /** full/fast 모드로 emit() 을 1회 호출하고 이번 회차의 렌더 결과(ITEMS)와 이 회차가
   *  만든 STREAK_NEXT 를 함께 받는다. full 모드에서는 실제 status.sh 꼬리(파일 맨 끝
   *  "상태 저장은 full 모드에서만" 블록)와 같은 조건으로 STREAK_NEXT 를 상태 파일에
   *  실제로 써서, 뒤이은 호출이 "방금 full 이 써 놓은 값"을 읽게 만든다 — 리뷰가 실측한
   *  재현 시나리오(같은 상태 파일을 FULL 이 쓰고 곧바로 FAST 가 읽는다)와 같은 순서다. */
  function runEmitOnce(mode: "full" | "fast", home: string): { items: string; streakNext: string } {
    const driver = path.join(home, "emit-driver.sh");
    const tail = [
      `emit db unknown "데이터베이스" "확인 불가(도구 없음)"`,
      `if [ "$MODE" = "full" ]; then printf '%s' "$STREAK_NEXT" > "$STREAK_FILE" 2>/dev/null || true; fi`,
      `printf '%s\\n<<<SPLIT>>>\\n%s' "$ITEMS" "$STREAK_NEXT"`,
    ].join("\n");
    writeFileSync(driver, `${emitPrelude}\n${tail}\n`);
    const out = execFileSync("bash", [driver, ...(mode === "fast" ? ["--fast"] : [])], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    const [items = "", streakNext = ""] = out.split("\n<<<SPLIT>>>\n");
    return { items, streakNext };
  }

  it("이미 승격 문턱을 넘긴 db 는 fast 폴링에서도 직전 full 과 동일하게 렌더되고 횟수는 늘지 않는다", () => {
    const home = mkdtempSync(path.join(tmp, "emit-home-"));
    mkdirSync(path.join(home, "selfhost", "logs"), { recursive: true });
    const nowSec = Math.floor(Date.now() / 1000);
    const firstSeen = nowSec - 4 * 3600; // 4h 전 — 경과 문턱(3h) 이미 통과
    writeFileSync(path.join(home, "selfhost", "logs", "status-unknown-streak.tsv"), `db\t${firstSeen}\t20\n`);

    const full = runEmitOnce("full", home);
    expect(full.items).toContain('"level":"error"');
    expect(full.items).toContain("확인 불가가");
    expect(full.streakNext.split("\t")[2]?.trim()).toBe("21"); // 20 + 1 — full 은 증가시킨다

    // full 이 상태 파일을 21 로 갱신한 직후, 같은 파일을 fast 가 읽는다(리뷰 재현 순서).
    const fast = runEmitOnce("fast", home);
    // 리뷰가 요구한 불변식: fast 는 직전 full 과 동일하게 렌더돼야 한다(깜빡임 금지).
    expect(fast.items).toBe(full.items);
    // fast 는 읽기만 한다 — STREAK_NEXT 에 아무것도 적지 않는다(증가 없음).
    expect(fast.streakNext).toBe("");
  });
});

/**
 * GitHub Actions 잔여 분 — 2026-08-26 레포 비공개 전환으로 계량이 시작됐다.
 * 한도를 넘기면 preflight 가 안 돈다(⚠️ 2026-08-27 정정 — T-069: 종전 「required
 * 체크라 모든 PR 머지 불가」는 보호 정지로 SUPERSEDED. 지금은 검사 없는 머지가 되고
 * 배포 직전 게이트(deploy.sh ⑦)가 배포 시점에 막는다 — 이 행은 그 조기 신호다).
 * 그 사실을 알 방법이 웹 UI 를 직접 열어 보는 것뿐이라는 공백은 그대로다.
 *
 * ⛔ 알림은 보내지 않는다(오너 결정 2026-08-26 — disk 와 같은 부류로 화면 색만).
 *    그 결정은 menubar-app-delegation.test.ts 의 NOTIFY_EXEMPT 가 고정한다.
 */
describe("GitHub Actions 잔여 분", () => {
  it("여유가 있으면 정상 — 잔여·한도·비율을 운영자 언어로 싣는다", () => {
    const item = byKey(runStatus({ actionsUsed: 200 }), "actionsQuota");
    expect(item.level).toBe("ok");
    expect(item.title).toBe("GitHub Actions");
    // 천 단위 구분자는 운영자가 읽는 숫자라 계약이다 — 로케일에 맡기면 CI 에서 사라진다.
    expect(item.detail).toContain("1,800 / 2,000분 남음(90%)");
  });

  it("한도는 실 플랜에서 유도한다 — 2000 을 상수로 박지 않는다", () => {
    // API 가 included_minutes 를 더는 주지 않으므로(엔드포인트 은퇴) plan.name 으로
    // 고른다. 상수로 박으면 플랜이 바뀌었을 때 조용히 틀린 비율을 보여주고, 그 오차는
    // 실제로 바닥날 때까지 드러나지 않는다.
    const item = byKey(runStatus({ actionsUsed: 300, actionsPlan: "pro" }), "actionsQuota");
    expect(item.detail).toContain("2,700 / 3,000분 남음(90%)");
    expect(item.level).toBe("ok");
  });

  it("모르는 플랜은 비율을 지어내지 않는다 — 아는 것(사용 분)만 말한다", () => {
    const item = byKey(runStatus({ actionsUsed: 500, actionsPlan: "enterprise_cloud" }), "actionsQuota");
    expect(item.level).toBe("unknown");
    expect(item.detail).toContain("한도를 확인하지 못했습니다");
    expect(item.detail).toContain("500분 사용");
    expect(item.detail).not.toContain("%");
  });

  it("플랜 조회가 실패해도 사용량은 보여준다", () => {
    const item = byKey(runStatus({ actionsUsed: 500, actionsPlan: "" }), "actionsQuota");
    expect(item.level).toBe("unknown");
    expect(item.detail).toContain("500분 사용");
  });

  it("20% 미만이면 주의 — 패널에서 접히지 않고 저절로 드러난다", () => {
    // PanelView 는 ok 만 접는다(#470). warn 으로 올리는 것이 곧 "화면에 뜬다"는 뜻이다.
    const item = byKey(runStatus({ actionsUsed: 1700 }), "actionsQuota");
    expect(item.level).toBe("warn");
    expect(item.detail).toContain("300 / 2,000분 남음(15%)");
  });

  it("5% 미만이면 빨강", () => {
    const item = byKey(runStatus({ actionsUsed: 1950 }), "actionsQuota");
    expect(item.level).toBe("error");
    expect(item.detail).toContain("50 / 2,000분 남음(2%)");
  });

  it("경계값 — 정확히 20%·5% 는 한 단계 위다(부등호 방향 고정)", () => {
    // 문턱을 `-lt` 로 쓴 것이 의도다. `-le` 로 바뀌면 20% 정확히에서 노랑이 되어
    // 위 "20% 미만" 테스트만으로는 안 잡힌다.
    expect(byKey(runStatus({ actionsUsed: 1600 }), "actionsQuota").level).toBe("ok");
    expect(byKey(runStatus({ actionsUsed: 1900 }), "actionsQuota").level).toBe("warn");
  });

  it("청구가 붙었으면 빨강 — 유료 구간임을 말한다", () => {
    const item = byKey(runStatus({ actionsUsed: 2400, actionsBilled: true }), "actionsQuota");
    expect(item.level).toBe("error");
    expect(item.detail).toContain("2,400 / 2,000분 사용");
  });

  it("🪤 계산상 초과인데 청구가 0 이면 빨강이 아니라 노랑이다", () => {
    // 「쓴 분」과 「한도를 갉은 분」은 다르다 — 공개 레포 실행은 계량은 되지만 한도를
    // 소비하지 않는다(2026-08 실측: 6,591분 전부 netAmount 0). 여기서 빨강을 내면
    // 막히지도 않은 상태로 거짓 경보가 되고, 그 학습이 진짜 빨강까지 무시하게 만든다.
    const item = byKey(runStatus({ actionsUsed: 6591, actionsBilled: false }), "actionsQuota");
    expect(item.level).toBe("warn");
    expect(item.detail).toContain("6,591 / 2,000분 사용");
    // 문구는 청구 분기와 같다(청구 표기 제거, 2026-08-27) — 두 분기를 가르는 것은
    // level 뿐이므로, 이 테스트의 실질 단언은 위 `level === "warn"` 이다.
  });

  it("스코프가 없으면 확인 불가 — 초록으로 가장하지 않고 조치 명령을 싣는다", () => {
    // "권한이 없습니다"만 쓰면 오너가 무엇을 해야 하는지 알 수 없어 행이 영영
    // 회색으로 남는다.
    const item = byKey(runStatus({ actionsFails: "scope" }), "actionsQuota");
    expect(item.level).toBe("unknown");
    expect(item.detail).toContain("gh auth refresh -h github.com -s user");
  });

  it("🪤 엔드포인트 이전(410)은 따로 가른다 — 이 기능이 실제로 밟은 함정이다", () => {
    // 구 `settings/billing/actions` 는 410 으로 은퇴했다. 이 버킷이 없으면 "조회에
    // 실패했습니다"로 뭉개져, 다음에 또 이전됐을 때 원인을 찾는 데 시간이 든다.
    // 조치가 다르다는 것이 분리 근거다 — 스코프는 오너가 1회 조작으로 풀지만
    // 이전은 스크립트를 고쳐야 한다.
    const item = byKey(runStatus({ actionsFails: "moved" }), "actionsQuota");
    expect(item.level).toBe("unknown");
    expect(item.detail).toContain("이전됐습니다");
    expect(item.detail).toContain("status.sh");
  });

  it("로그인 만료와 그 외 실패를 구분한다", () => {
    expect(byKey(runStatus({ actionsFails: "auth" }), "actionsQuota").detail).toContain("로그인이 필요합니다");
    const other = byKey(runStatus({ actionsFails: "other" }), "actionsQuota");
    expect(other.level).toBe("unknown");
    expect(other.detail).toContain("조회에 실패했습니다");
    // 원시 stderr 를 상시 표시 행에 흘리지 않는다(release-status.sh fail_reason 규약).
    expect(other.detail).not.toContain("connection refused");
  });

  it("응답이 형식에 안 맞으면 확인 불가", () => {
    expect(byKey(runStatus({ actionsGarbage: "null|null" }), "actionsQuota").detail).toContain(
      "해석하지 못했습니다",
    );
  });

  it("구분자가 없는 응답이 숫자 분기로 새지 않는다", () => {
    // `${VAR%%|*}` 와 `${VAR##*|}` 는 구분자가 없으면 **같은 문자열**을 준다 — 검사가
    // 없으면 통짜 응답이 사용 분으로 읽힌다.
    expect(byKey(runStatus({ actionsGarbage: "1234" }), "actionsQuota").level).toBe("unknown");
  });

  it("fast 폴링(30초)에는 싣지 않는다 — gh 왕복은 full 전용이다", () => {
    expect(runStatus({ fast: true }).items.find((i) => i.key === "actionsQuota")).toBeUndefined();
  });

  it("조회가 실패해도 다른 항목은 멀쩡하다(한 행의 실패가 패널을 죽이지 않는다)", () => {
    const r = runStatus({ actionsFails: "other" });
    expect(byKey(r, "prodLocal").level).toBe("ok");
    expect(byKey(r, "disk").level).not.toBe("");
  });

  it("은퇴한 엔드포인트로 되돌아가지 않는다(소스 계약)", () => {
    // 구 요약 경로는 410 이다. 되살리면 이 행이 영영 회색으로만 뜨는데, 화면상으로는
    // "조회 실패"라 원인이 안 보인다.
    //
    // 🪤 **주석을 먼저 걷어낸다.** status.sh 는 그 은퇴 사실을 주석으로 경고하는데,
    //    걷어내지 않으면 그 경고문 자체가 위반으로 잡힌다(첫 작성에서 실제로 실패했다).
    //    그리고 부정 단언만 두면 앵커가 어긋났을 때 조용히 통과하므로, 살아 있는
    //    경로의 **긍정 단언**과 양성 프로브를 함께 둔다.
    const active = SRC.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    const RETIRED = ["settings", "billing", "actions"].join("/");
    const LIVE = ["settings", "billing", "usage"].join("/");
    expect(active).toContain(LIVE); // 긍정 — 스캐너·앵커가 살아 있다는 증거
    expect(active).not.toContain(RETIRED);
    // 양성 프로브 — 이 검사가 실제로 잡는다(공허 통과 방지).
    expect(`$GH api "users/x/${RETIRED}"`).toContain(RETIRED);
  });

  it("지속 unknown 승격 대상이 아니다(소스 계약)", () => {
    // unknown 은 패널에서 이미 접히지 않는다(#470) — 승격은 소음만 늘린다. 게다가
    // 승격은 error 를 만드는 세 번째 경로라, 여기 넣으면 전달 계약의 의미가 흐려진다.
    const m = SRC.match(/^UNKNOWN_ESCALATABLE_KEYS="([^"]*)"/m);
    expect(m, "UNKNOWN_ESCALATABLE_KEYS 선언을 찾지 못했다(앵커 함정)").toBeTruthy();
    expect(m![1].split(/\s+/)).not.toContain("actionsQuota");
  });
});

describe("PR 검사 러너(preflightRunner)", () => {
  const runner = (opts: RunOpts = {}) => byKey(runStatus(opts), "preflightRunner");

  it("전부 연결돼 있으면 정상 — 대수를 응답에서 센다(고정 숫자 금지)", () => {
    const item = runner({ runnerTotal: 3, runnerOnline: 3 });
    expect(item.level).toBe("ok");
    expect(item.detail).toContain("3대");
    // 🪤 online 은 「지금 붙어 있다」 이상을 뜻하지 않는다 — 문구가 「정상 작동」·
    //    「이상 없음」 같은 더 센 주장을 하기 시작하면 이 단언이 잡는다.
    expect(item.detail).toContain("연결");
  });

  it("대수가 바뀌면 문구도 따라간다(2대 픽스처)", () => {
    expect(runner({ runnerTotal: 2, runnerOnline: 2 }).detail).toContain("2대");
  });

  it("일부만 연결돼 있어도 정상 — 예비 러너를 고장으로 단정하지 않는다", () => {
    // 🪤 종전에는 이 경우를 노랑 「끊긴 N대를 확인하세요」로 냈는데, 2026-08-27 운영 형상이
    //    **활성 2대 + 예비 1대(등록 유지·서비스 정지)** 로 바뀌면서 그 예비가 offline 으로
    //    잡혀 **평상시 상시 노랑**이 됐다(실측). 늘 켜진 경고는 곧 무시당하고 그 학습이 진짜
    //    빨강까지 삼킨다 — 이 행이 막으려던 바로 그 실패다.
    //    ⛔ API 로는 「의도한 예비」와 「죽은 러너」를 가를 수 없다(status·busy 뿐). 그러니
    //    「끊겼다」는 단정을 되살리지 말 것 — 모르는 것을 안다고 말하는 것이다.
    const item = runner({ runnerTotal: 3, runnerOnline: 2 });
    expect(item.level).toBe("ok");
    expect(item.detail).toContain("2대");
    expect(item.detail).toContain("등록 3대"); // 두 숫자를 다 보여 사람이 판단하게 한다
    expect(item.detail).not.toContain("확인하세요"); // 고장이라고 단정하지 않는다
  });

  it("전부 연결된 경우엔 등록 대수를 덧붙이지 않는다(같은 수를 두 번 말하지 않는다)", () => {
    expect(runner({ runnerTotal: 2, runnerOnline: 2 }).detail).not.toContain("등록");
  });

  it("전부 끊기면 빨강 — 머지가 막힌다는 결과와 우회 명령을 함께 싣는다", () => {
    const item = runner({ runnerTotal: 3, runnerOnline: 0 });
    expect(item.level).toBe("error");
    expect(item.detail).toContain("머지");
    expect(item.detail).toContain("PREFLIGHT_RUNNER");
  });

  it("등록된 러너가 0대여도 빨강 — 큐에 걸려 영영 안 끝난다", () => {
    const item = runner({ runnerTotal: 0, runnerOnline: 0 });
    expect(item.level).toBe("error");
    expect(item.detail).toContain("등록된 러너가 없습니다");
    expect(item.detail).toContain("PREFLIGHT_RUNNER");
  });

  it("변수가 없으면(404) GitHub 러너 레인 — 이 레포의 **정규 상태**라 초록이다", () => {
    // ⛔ 이 경로를 인증 실패와 합치면 회색 「확인 불가」가 상시로 뜬다(아래 404 양가성 참고).
    // ⛔ 종전 계약(노랑 + "우회")은 SUPERSEDED — 2026-08-28 공개 레포 이전과 함께
    //    자가호스트 러너가 **의도적으로 은퇴**했다(P6 「Self-Hosted Preflight Runner 는
    //    이 레포에서 은퇴했다」). 같은 절이 **다시 붙이지 말라**고 ⛔ 로 못박는데 이 행은
    //    「되돌리세요」라고 권하고 있었다 — 정본과 정반대를 말하는 상시 노랑이었다.
    //    ⚠️ 되살리려면 P6 의 그 절부터 고쳐야 한다(이 계약만 되돌리면 다시 어긋난다).
    const item = runner({ runnerVarMissing: true });
    expect(item.level).toBe("ok");
    expect(item.detail).toContain("GitHub 러너");
    expect(item.detail, "은퇴한 레인으로 되돌리라고 권하지 않는다").not.toContain("되돌리세요");
  });

  it("레포가 안 보이면 폴백이 아니라 확인 불가다(404 양가성)", () => {
    // 🪤 GitHub 은 접근 불가 레포에 403 이 아니라 404 를 준다(존재 자체를 숨긴다) —
    //    그래서 「변수 없음」과 「레포 안 보임」의 stderr 가 **글자까지 같다**
    //    (2026-08-26 실측: 양쪽 다 `gh: Not Found (HTTP 404)`). 문자열만으로 가르면
    //    인증을 잃은 상태가 「폴백 중」이라는 노랑으로 단정돼, 오너에게 「러너만 고치면
    //    된다」는 엉뚱한 조치를 시킨다. 레포 프로브가 그 둘을 가르는 유일한 통로다.
    const item = runner({ runnerRepoInvisible: true });
    expect(item.level).toBe("unknown");
    expect(item.detail).not.toContain("우회");
  });

  it("대조군 — 같은 404 라도 레포가 보이면 GitHub 러너 레인이 맞다", () => {
    // 위 테스트와 stderr 가 동일한데 결과가 갈려야 한다. 이 짝이 없으면 프로브가
    // 통째로 죽어도(항상 unknown) 위 테스트만으로는 초록으로 통과한다.
    expect(runner({ runnerVarMissing: true }).level).toBe("ok");
  });

  it("변수가 빈 값이어도 GitHub 러너 레인 — 워크플로 조건이 != '' 이기 때문이다", () => {
    expect(runner({ runnerLane: "" }).level).toBe("ok");
  });

  it("GitHub 러너 레인이면 러너 목록을 아예 묻지 않는다", () => {
    // 러너 조회가 실패하도록 심어 두고도 이 행이 그대로면, 그 호출이 일어나지
    // 않았다는 증거다(일어났다면 unknown 이 됐을 것이다). 왕복 1회를 아끼는 것이자,
    // 「이 레인에서 자가호스트 러너 상태는 판정과 무관」이라는 설계를 고정하는 단언이다.
    const item = runner({ runnerVarMissing: true, runnerListFails: "other" });
    expect(item.level).toBe("ok");
    expect(item.detail).toContain("GitHub 러너");
  });

  it("없어진 비용을 있는 것처럼 말하지 않는다 — 상시 노랑을 만드는 형태다", () => {
    // ⛔ 종전 계약 「폴백 노랑은 초록이 아니다 — GitHub 사용 시간을 쓴다는 사실을 말한다」는
    //    SUPERSEDED. 그 전제(자가호스트로 아끼던 유료 시간을 폴백이 도로 쓴다)는 2026-08-28
    //    공개 레포 이전으로 사라졌다 — 공개 레포는 GitHub 러너가 무제한 무료이고, 그래서
    //    자가호스트 러너 자체가 은퇴했다(P6 「Self-Hosted Preflight Runner 는 이 레포에서
    //    은퇴했다」). 🪤 그 이전 커밋이 이 파일의 actionsQuota 문구까지 손보면서 **이 행만
    //    좌표(wagcrm→wagcrm_git)만 바꾸고 의미를 안 고쳐** 상시 노랑으로 남았다.
    // 지금 지킬 불변식은 반대다: 들지 않는 비용을 근거로 노랑을 내지 말 것. 늘 켜진
    // 경고는 곧 무시당하고 그 학습이 진짜 빨강까지 삼킨다(이 파일의 예비 러너 사고와 같다).
    const detail = runner({ runnerVarMissing: true }).detail;
    expect(detail).not.toContain("시간");
    expect(detail).not.toContain("우회");
  });

  it("라벨을 러너 조회에 실제로 넘긴다(배선 계약)", () => {
    // 스텁은 RUNNER_LABEL 이 변수 값과 같을 때만 대수를 준다 — 배선이 끊기면 0|0 이
    // 와서 빨강이 된다. 실 API 의 jq 필터(env.RUNNER_LABEL)는 2026-08-26 양·음성
    // 프로브로 따로 확인했다(스텁은 jq 를 실행하지 않으므로 여기서 검증할 수 없다).
    expect(runner({ runnerLane: "imac-colima" }).level).toBe("ok");
  });

  it("로그인 만료와 권한 부족은 조치가 달라 따로 가른다", () => {
    expect(runner({ runnerVarFails: "auth" }).detail).toContain("로그인");
    expect(runner({ runnerVarFails: "perm" }).detail).toContain("권한");
    expect(runner({ runnerVarFails: "auth" }).level).toBe("unknown");
  });

  it("러너 목록 조회가 실패하면 확인 불가 — 초록으로 접지 않는다", () => {
    const item = runner({ runnerListFails: "other" });
    expect(item.level).toBe("unknown");
    expect(item.detail).toContain("확인 불가");
  });

  it("응답이 형식에 안 맞으면 확인 불가", () => {
    expect(runner({ runnerGarbage: "null|null" }).level).toBe("unknown");
  });

  it("구분자가 없는 응답이 숫자 분기로 새지 않는다", () => {
    // 🪤 actionsQuota 보다 위험한 형태다 — 저쪽은 두 번째 필드가 true/false 라 통짜
    //    응답이 저절로 걸리지만, 여기는 양쪽이 다 숫자라 `3` 하나가 "3대 전부 연결"이라는
    //    **초록**이 된다(첫 구현에서 이 테스트가 실제로 잡았다). 해석 실패는 초록이 아니다.
    expect(runner({ runnerGarbage: "3" }).level).toBe("unknown");
  });

  it("있을 수 없는 조합(online > 등록)도 초록으로 떨어지지 않는다", () => {
    expect(runner({ runnerGarbage: "1|5" }).level).toBe("unknown");
  });

  it("fast 폴링(30초)에는 싣지 않는다 — gh 왕복은 full 전용이다", () => {
    expect(runStatus({ fast: true }).items.find((i) => i.key === "preflightRunner")).toBeUndefined();
  });

  it("조회가 실패해도 다른 항목은 멀쩡하다(한 행의 실패가 패널을 죽이지 않는다)", () => {
    const r = runStatus({ runnerVarFails: "other" });
    expect(byKey(r, "prodLocal").level).toBe("ok");
    expect(byKey(r, "actionsQuota").level).toBe("ok");
  });

  it("busy 를 판정에 쓰지 않는다(소스 계약)", () => {
    // 전부 busy 인 것은 큐가 도는 정상이다 — 그것으로 색을 바꾸면 바쁜 날마다 오탐이 된다.
    const active = SRC.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(active).not.toContain(".busy");
    expect(active).toContain("select(.status==");  // 긍정 — 앵커가 살아 있다는 증거
  });

  it("지속 unknown 승격 대상이 아니다(소스 계약)", () => {
    const m = SRC.match(/^UNKNOWN_ESCALATABLE_KEYS="([^"]*)"/m);
    expect(m, "UNKNOWN_ESCALATABLE_KEYS 선언을 찾지 못했다(앵커 함정)").toBeTruthy();
    expect(m![1].split(/\s+/)).not.toContain("preflightRunner");
  });
});

describe("status.sh 소스 계약 — 읽기 전용", () => {
  const active = SRC.split("\n").filter((l) => !l.trim().startsWith("#"));

  it("파괴적 명령이 없다(status.sh · release-status.sh 공통)", () => {
    // docker 호출은 테스트 훅 때문에 `$DOCKER <서브커맨드>` 형태다 — 변수 형태를
    // 안 잡으면 `$DOCKER stop …` 이 추가돼도 이 계약이 조용히 통과한다(리뷰 검출).
    for (const file of [SCRIPT, RELEASE_STATUS_SCRIPT]) {
      const lines = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"));
      const destructive = lines.filter((l) =>
        /(\$DOCKER|\bdocker)\s+(rm|stop|kill|compose\s+down)|launchctl\s+(bootout|bootstrap|unload)|rm\s+-rf/.test(l),
      );
      expect(destructive, path.basename(file)).toEqual([]);
    }
  });

  it("docker 사용은 inspect·읽기전용 exec 뿐이다(스캐너 고장 감지 겸)", () => {
    // docker 는 테스트 훅 때문에 `$DOCKER <서브커맨드>` 로 호출된다 — 그 형태와
    // 혹시 남을 직접 호출(`docker <서브커맨드>`) 둘 다 잡는다. exec 는 크론 SUCCESS 기록을
    // 읽는 단일 SELECT 전용 psql 호출 하나만 허용한다 — write/delete 문 추가는 위
    // "파괴적 명령이 없다" 계약과 별개로, 여기서 exec 줄이 참조하는 SQL 변수 값이
    // isSingleReadOnlySelect() 를 통과하는지로 잡는다(세미콜론 체인 바이패스 차단 —
    // 리뷰 라운드 1 실측: `select` 라는 단어가 있기만 하면 통과하던 종전 검사는
    // `select 1; delete from "SystemTaskLog";` 를 못 막았다).
    const dockerLines = active.filter((l) => /(\$DOCKER|\bdocker)\s+[a-z]/.test(l));
    expect(dockerLines.length).toBeGreaterThan(0);
    for (const l of dockerLines) expect(l).toMatch(/(\$DOCKER|docker)\s+(inspect|exec)/);

    const execLines = dockerLines.filter((l) => /(\$DOCKER|docker)\s+exec/.test(l));
    for (const l of execLines) {
      const sqlVar = l.match(/-c\s+"\$(\w+)"/)?.[1];
      expect(sqlVar, `exec 줄이 -c "$VAR" 형태가 아니다: ${l}`).toBeTruthy();
      const sqlDecl = active.find((s) => new RegExp(`^\\s*${sqlVar}=`).test(s));
      expect(sqlDecl, `${sqlVar} 선언을 찾지 못했다`).toBeTruthy();
      const sqlBody = sqlDecl!.match(/^\s*\w+="(.*)"\s*$/)?.[1];
      expect(sqlBody, `${sqlVar} 선언이 \`VAR="..."\` 형태가 아니다: ${sqlDecl}`).toBeTruthy();
      expect(
        isSingleReadOnlySelect(sqlBody!),
        `${sqlVar} 가 단일 read-only SELECT 가 아니다(세미콜론 체인 의심): ${sqlBody}`,
      ).toBe(true);
    }
  });

  it("SQL 텍스트 검사가 select;delete 바이패스를 막는다(리뷰 라운드 1 실측 재현)", () => {
    // 리뷰가 표준 재현으로 실측한 바이패스: "select 라는 단어가 어딘가 있다"만 보던
    // 종전 검사는 이 페이로드를 통과시켰다. psql -c 는 세미콜론으로 이어붙인 문장을
    // 전부 실행하고, supabase_admin 은 읽기전용 롤이 아니므로(리뷰 실측) 이 문자열
    // 검사가 이 파일의 유일한 안전망이다 — 통과시키면 그대로 프로덕션 데이터 삭제로
    // 이어진다. 이 테스트가 그 바이패스가 다시는 통과하지 않음을 고정한다.
    expect(isSingleReadOnlySelect('select 1; delete from "SystemTaskLog";')).toBe(false);
    // 다른 형태의 다중 문장도 함께 막히는지(세미콜론이 여러 개, 후행 세미콜론 없음).
    expect(isSingleReadOnlySelect('select 1; delete from "SystemTaskLog"')).toBe(false);
    expect(isSingleReadOnlySelect("delete from \"SystemTaskLog\"; select 1;")).toBe(false);
    // select 로 시작하지 않으면 그 자체로 거부(공허 통과 방지).
    expect(isSingleReadOnlySelect('delete from "SystemTaskLog"')).toBe(false);
    // 대조군 — 실제 status.sh 가 쓰는 단일 SELECT(후행 세미콜론 1개)는 통과해야 한다
    // (검사 자체가 죽어서 전부 거부하는 공허 실패가 아님을 증명).
    expect(
      isSingleReadOnlySelect(
        'select \\"jobKey\\", floor(extract(epoch from max(\\"createdAt\\")))::bigint from \\"SystemTaskLog\\" where status = \'SUCCESS\' group by 1;',
      ),
    ).toBe(true);
  });
});

describe("외부 알림 전달 상태(alertDelivery)", () => {
  it("마커가 없으면 ok — 문구는 '정상'이 아니라 관측 사실을 말한다", () => {
    // "정상"은 관측 없이 단언하는 말이다(2026-08-19 리뷰 지적 C1) — 마커가 없다는
    // 것은 "실패를 관측하지 못했다"는 뜻이지 "성공을 관측했다"는 뜻이 아니다.
    const item = byKey(runStatus({}), "alertDelivery");
    expect(item.level).toBe("ok");
    expect(item.detail).not.toBe("정상");
    expect(item.detail).toContain("발송 실패");
  });

  it("마커가 있으면 warn 이고, 마커의 문구(3번째 필드)를 그대로 싣는다", () => {
    const item = byKey(runStatus({ alertSendFailed: true }), "alertDelivery");
    expect(item.level).toBe("warn");
    expect(item.detail).toContain("2026-01-01 00:00:00");
  });

  it("마커가 구 형식(탭 없는 1필드)이어도 죽지 않고 warn 을 낸다", () => {
    const item = byKey(runStatus({ alertSendFailedRaw: "예전 형식\n" }), "alertDelivery");
    expect(item.level).toBe("warn");
    expect(item.detail.length).toBeGreaterThan(0); // 빈 문자열로 깨지지 않는다(폴백 문구)
  });

  it("절대 error 가 되지 않는다(자기참조 금지)", () => {
    // error 로 올리면 전달 계약이 이 키를 watched 에 요구하고, 그러면 발송 실패를
    // 발송으로 알리려는 고리가 생긴다.
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/emit\s+alertDelivery\s+error/);
  });

  it("항상 emit 된다 — 항목이 사라지면 앱이 낡은 값을 계속 보여준다", () => {
    // 앱의 items 는 병합 갱신이라(for item in payload.items { items[key] = item })
    // 빠진 키는 지워지지 않고 직전 값이 남는다.
    expect(runStatus({}).items.map((i) => i.key)).toContain("alertDelivery");
    expect(runStatus({ alertSendFailed: true }).items.map((i) => i.key)).toContain("alertDelivery");
  });

  it("--fast 에는 나오지 않는다", () => {
    expect(runStatus({ fast: true }).items.map((i) => i.key)).not.toContain("alertDelivery");
  });
});
