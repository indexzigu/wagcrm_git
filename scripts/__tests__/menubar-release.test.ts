import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * 릴리스 섹션의 판정·순서 계약.
 *  (1) release-status.sh — gh 스텁으로 hermetic 실행, 판정과 **완성 문구**를 고정한다.
 *  (2) release-deploy.sh — 순서(CRM→Worker)·조건·경로 소유를 고정한다(Task 2).
 * 스텁은 실행권한 없는 데이터 파일을 `bash <파일>` 로 주입한다(status.sh 와 동일 패턴).
 */
const STATUS_SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "release-status.sh");

const tmp = mkdtempSync(path.join(tmpdir(), "menubar-release-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function stub(dir: string, name: string, body: string): string {
  const p = path.join(dir, `${name}.impl`);
  writeFileSync(p, `${body}\n`);
  return p;
}

interface Commit {
  sha: string;
  title: string;
}
/** gh 가 실제로 주는 statusCheckRollup 원소의 모양(2026-08-27 실측). */
interface RollupEntry {
  /** ⚠️ 도는 중인 체크는 **빈 문자열**이다(null 이 아니다) — 이 사실이 결함의 출처였다. */
  conclusion?: string;
  /** CheckRun 에는 없다(null). 커밋 상태(StatusContext)에만 있다. */
  state?: string | null;
  status?: string;
}
interface Pr {
  number: number;
  title: string;
  url: string;
  draft?: boolean;
  /**
   * 편의 표기 — 체크 상태 토큰을 콤마로 이은 값("" = 체크 없음). 아래
   * `toRollup()` 이 이것을 **실측된 rollup 모양**으로 부풀린다.
   * 정확한 원형을 고정해야 하는 케이스는 `rollup` 을 직접 준다.
   */
  checks: string;
  /** 실측 원형을 그대로 박아야 할 때(회귀 고정용). 주면 `checks` 는 무시된다. */
  rollup?: RollupEntry[];
}

/** 완료 상태 토큰 — 이건 conclusion 에 실려 오고 status 는 COMPLETED 다. */
const CONCLUSION_TOKENS = new Set([
  "SUCCESS",
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "NEUTRAL",
  "SKIPPED",
]);

/**
 * 토큰 하나를 gh 의 실제 응답 모양으로 부풀린다.
 * 🪤 **도는 중인 체크의 `conclusion` 은 빈 문자열이다** — 이 한 줄이 이 하네스의
 *    핵심이다. null 로 만들면 결함이 있는 jq(`//` 사슬)도 통과해버려 계약이 공허해진다.
 */
function toRollup(token: string): RollupEntry {
  if (CONCLUSION_TOKENS.has(token)) return { conclusion: token, state: null, status: "COMPLETED" };
  return { conclusion: "", state: null, status: token };
}
interface StatusOpts {
  marker?: string;
  commits?: Commit[];
  totalCommits?: number;
  files?: string[];
  /** 마커 sha 기준 최근 커밋(commits API 응답) — 최근 반영 목록의 입력 */
  recent?: Commit[];
  prs?: Pr[];
  /** gh 를 실패시킨다 — "auth" | "other" */
  ghFail?: "auth" | "other";
  /** `--deployed-since <sha>` 로 넘길 값(앱이 직전에 관측한 마커). 미지정이면 플래그 없음. */
  deployedSince?: string;
  /** 그 sha 와 현재 마커 사이의 커밋(compare API 응답) — 배포 완료 알림 문구의 입력 */
  deployedCommits?: Commit[];
  deployedTotal?: number;
  /** 배포 구간 compare 만 실패시킨다(대기 목록·최근 반영은 정상) */
  deployedFail?: boolean;
}

function runReleaseStatus(opts: StatusOpts) {
  const home = mkdtempSync(path.join(tmp, "home-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(home, "selfhost", "logs"), { recursive: true });
  if (opts.marker !== undefined)
    writeFileSync(path.join(home, "selfhost", "logs", "deployed.sha"), `${opts.marker}\n`);

  const commits = opts.commits ?? [];
  const compareLines = [
    `COUNT\t${opts.totalCommits ?? commits.length}`,
    ...commits.map((c) => `COMMIT\t${c.sha}\t${c.title}`),
    ...(opts.files ?? []).map((f) => `FILE\t${f}`),
  ];
  // 🪤 **PR 레인은 스텁이 아니라 실제 jq 를 태운다 (실사고 2026-08-27).**
  // 종전 하네스는 jq 를 **거친 뒤의** 문자열(`checks`)을 그대로 주입했다. 그래서
  // 스크립트의 jq 표현식 자체가 계약 밖에 있었고, 그 표현식이 도는 중인 체크를
  // 통째로 지워 **아직 도는 PR 이 「체크 통과」로 초록불이 되는** 결함이 오너 눈에
  // 띌 때까지 살아남았다(판정 함수는 촘촘히 테스트돼 있었는데 그 **입력을 만드는
  // 단계**가 검사되지 않았다). 이제 픽스처는 gh 의 실제 응답 모양이고, 스크립트가
  // 넘긴 `--jq` 프로그램을 진짜 jq 로 돌린다.
  const prJson = JSON.stringify(
    (opts.prs ?? []).map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      isDraft: p.draft ?? false,
      statusCheckRollup:
        p.rollup ?? (p.checks === "" ? [] : p.checks.split(",").map(toRollup)),
    })),
  );
  const fail =
    opts.ghFail === "auth"
      ? `echo "gh: To get started with GitHub CLI, please run: gh auth login" >&2; exit 1`
      : opts.ghFail === "other"
        ? `echo "gh: connection refused" >&2; exit 1`
        : "";

  const recentLines = (opts.recent ?? []).map((c) => `RECENT\t${c.sha}\t${c.title}`);
  const deployedCommits = opts.deployedCommits ?? [];
  const deployedLines = [
    `COUNT\t${opts.deployedTotal ?? deployedCommits.length}`,
    ...deployedCommits.map((c) => `COMMIT\t${c.sha}\t${c.title}`),
  ];
  // 🪤 두 compare 호출을 갈라야 한다 — 대기 목록은 `<마커>...main`, 배포 구간은
  // `<직전 마커>...<현재 마커>` 다. 한 분기로 뭉치면 배포 알림 테스트가 대기 목록
  // 픽스처를 받아 **항상 통과하는** 공허한 계약이 된다.
  const ghImpl = stub(
    bin,
    "gh",
    `${fail}
case "$1" in
  api)
    case "$2" in
      *"/commits?"*) cat <<'EOF_RECENT'
${recentLines.join("\n")}
EOF_RECENT
      ;;
      *"...main"*) cat <<'EOF_COMPARE'
${compareLines.join("\n")}
EOF_COMPARE
      ;;
      *compare*)
        ${opts.deployedFail ? 'echo "gh: connection refused" >&2; exit 1' : ""}
        cat <<'EOF_DEPLOYED'
${deployedLines.join("\n")}
EOF_DEPLOYED
      ;;
      *) cat <<'EOF_COMPARE2'
${compareLines.join("\n")}
EOF_COMPARE2
      ;;
    esac
  ;;
  pr)
    # 스크립트가 넘긴 --jq 프로그램을 찾아 **실제 jq** 로 돌린다.
    prog=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--jq" ]; then prog="$2"; fi
      shift
    done
    if [ -z "$prog" ]; then
      echo "스텁: --jq 인자를 찾지 못했다(스크립트가 호출 형태를 바꿨는지 확인)" >&2
      exit 90
    fi
    cat <<'EOF_PRJSON' | jq -r "$prog"
${prJson}
EOF_PRJSON
  ;;
esac`,
  );

  const args = opts.deployedSince ? ["--deployed-since", opts.deployedSince] : [];
  const out = execFileSync("bash", [STATUS_SCRIPT, ...args], {
    env: { ...process.env, HOME: home, RELEASE_GH_CMD: `bash ${ghImpl}` },
    encoding: "utf8",
  });
  return JSON.parse(out) as {
    schemaVersion: number;
    /** 지금 서버에 실린 커밋(배포 마커 전문). 앱이 다음 호출에 그대로 되돌려 준다. */
    markerSha: string | null;
    /** 마커가 움직였을 때만 채워진다 — 문구까지 스크립트가 완성한다. */
    deployed: {
      from: string;
      to: string;
      count: number;
      title: string;
      body: string;
      items: Array<{ sha: string; title: string; url: string }>;
    } | null;
    deploy: {
      level: string;
      title: string;
      detail: string;
      count: number;
      canDeploy: boolean;
      note: string;
      commits: Commit[];
      more: number;
    };
    recent: {
      title: string;
      detail: string;
      items: Array<{ sha: string; title: string; url: string }>;
    };
    prs: {
      level: string;
      detail: string;
      items: Array<{
        number: number;
        title: string;
        url: string;
        checkLevel: string;
        checkText: string;
        badge: string;
      }>;
    };
  };
}

describe("release-status.sh 행위 계약", () => {
  it("최신이면 ok — 배포 버튼을 열지 않는다", () => {
    const r = runReleaseStatus({ marker: "aaaaaaa", totalCommits: 0 });
    expect(r.schemaVersion).toBe(1);
    expect(r.deploy.level).toBe("ok");
    expect(r.deploy.count).toBe(0);
    expect(r.deploy.canDeploy).toBe(false);
    expect(r.deploy.detail).toContain("최신");
  });

  it("대기 3건이면 info + 최근 커밋 제목이 실린다", () => {
    const r = runReleaseStatus({
      marker: "aaaaaaa",
      totalCommits: 3,
      commits: [
        { sha: "ccccccc", title: "#397 feat(links): 세 번째" },
        { sha: "bbbbbbb", title: "#396 feat(deals): 두 번째" },
        { sha: "aaaaaab", title: "#395 fix(proxy): 첫 번째" },
      ],
    });
    expect(r.deploy.level).toBe("info");
    expect(r.deploy.count).toBe(3);
    expect(r.deploy.canDeploy).toBe(true);
    expect(r.deploy.detail).toContain("3건");
    expect(r.deploy.commits[0].title).toContain("세 번째");
    expect(r.deploy.more).toBe(0);
  });

  it("커밋이 5건을 넘으면 5건만 싣고 나머지는 more 로 센다", () => {
    const commits = Array.from({ length: 8 }, (_, i) => ({
      sha: `sha000${i}`,
      title: `커밋 ${i}`,
    }));
    const r = runReleaseStatus({ marker: "aaaaaaa", totalCommits: 8, commits });
    expect(r.deploy.commits).toHaveLength(5);
    expect(r.deploy.more).toBe(3);
  });

  it("링크 서버·마이그레이션 변경은 note 로 고지한다", () => {
    const r = runReleaseStatus({
      marker: "aaaaaaa",
      totalCommits: 1,
      commits: [{ sha: "ccccccc", title: "변경" }],
      files: ["ygrd-link/src/index.ts", "prisma/migrations/20260814_x/migration.sql"],
    });
    expect(r.deploy.note).toContain("링크 서버");
    expect(r.deploy.note).toContain("데이터베이스");
  });

  it("무관한 파일만 바뀌면 note 는 비어 있다", () => {
    const r = runReleaseStatus({
      marker: "aaaaaaa",
      totalCommits: 1,
      commits: [{ sha: "ccccccc", title: "변경" }],
      files: ["src/app/page.tsx"],
    });
    expect(r.deploy.note).toBe("");
  });

  it("배포 마커가 없으면 unknown — 초록으로 가장하지 않는다", () => {
    const r = runReleaseStatus({ totalCommits: 0 });
    expect(r.deploy.level).toBe("unknown");
    expect(r.deploy.canDeploy).toBe(false);
    expect(r.deploy.detail).toContain("확인 불가");
  });

  it("최근 반영 — 마커 sha 기준 최근 커밋을 싣고 #NN 제목은 PR 페이지로 보낸다", () => {
    const r = runReleaseStatus({
      marker: "f380856",
      totalCommits: 0,
      recent: [
        { sha: "f380856", title: "#467 fix(calendar): 조합 캠페인 팝오버" },
        { sha: "abc1234", title: "chore: 제목 규약 밖 커밋" },
      ],
    });
    expect(r.recent.title).toBe("최근 반영");
    expect(r.recent.items).toHaveLength(2);
    expect(r.recent.items[0].url).toBe("https://github.com/indexzigu/wagcrm/pull/467");
    // 규약 밖 제목은 번호를 추측하지 않고 커밋 페이지로 보낸다.
    expect(r.recent.items[1].url).toBe("https://github.com/indexzigu/wagcrm/commit/abc1234");
    // 마커 파일 mtime 에서 나온 마지막 배포 시각이 문구로 완성돼 있다.
    expect(r.recent.detail).toContain("마지막 배포");
  });

  it("최근 반영 — 마커가 없으면 빈 목록이다(추측하지 않는다)", () => {
    const r = runReleaseStatus({ totalCommits: 0 });
    expect(r.recent.items).toEqual([]);
    expect(r.recent.detail).toBe("");
  });

  it("PR 체크 4상태를 운영자 문구로 완성한다", () => {
    const r = runReleaseStatus({
      marker: "aaaaaaa",
      totalCommits: 0,
      prs: [
        { number: 401, url: "https://x/401", checks: "SUCCESS,SUCCESS", title: "통과" },
        { number: 402, url: "https://x/402", checks: "SUCCESS,FAILURE", title: "실패" },
        { number: 403, url: "https://x/403", checks: "SUCCESS,PENDING", title: "진행" },
        { number: 404, url: "https://x/404", checks: "", title: "없음", draft: true },
      ],
    });
    expect(r.prs.level).toBe("info");
    expect(r.prs.detail).toContain("4건");
    const [pass, fail, pending, none] = r.prs.items;
    expect([pass.checkLevel, pass.checkText]).toEqual(["ok", "체크 통과"]);
    expect([fail.checkLevel, fail.checkText]).toEqual(["error", "체크 실패"]);
    expect([pending.checkLevel, pending.checkText]).toEqual(["warn", "확인 중"]);
    expect([none.checkLevel, none.checkText]).toEqual(["unknown", "체크 없음"]);
    expect(none.badge).toBe("초안");
    expect(pass.badge).toBe("");
  });

  it("도는 중인 체크가 있으면 「확인 중」이다 — 끝난 체크의 SUCCESS 에 묻히지 않는다", () => {
    // 🪤 **실사고 2026-08-27(오너 신고).** 아래 rollup 은 gh 가 실제로 준 응답을 그대로
    // 옮긴 것이다 — 도는 중인 체크의 `conclusion` 은 **빈 문자열**이고 `state` 는 null 이다.
    // jq 의 `//` 는 null·false 에서만 넘어가므로 종전 `.conclusion // .state // .status`
    // 는 그 빈 문자열을 채택했고, 「도는 중」이 판정에 닿기도 전에 지워져 **아직 도는
    // PR 이 「체크 통과」로 초록불**이 됐다(실측 입력 `,SUCCESS,`).
    // ⛔ 이 케이스를 편의 표기(`checks`)로 바꾸지 말 것 — 원형을 박아 두는 것이 요점이다.
    const r = runReleaseStatus({
      marker: "aaaaaaa",
      totalCommits: 0,
      prs: [
        {
          number: 515,
          url: "https://x/515",
          title: "테스트만 남은 PR",
          checks: "",
          rollup: [
            { conclusion: "SUCCESS", state: null, status: "COMPLETED" },
            { conclusion: "SUCCESS", state: null, status: "COMPLETED" },
            { conclusion: "", state: null, status: "IN_PROGRESS" },
          ],
        },
        {
          number: 516,
          url: "https://x/516",
          title: "두 건이 줄서 있는 PR",
          checks: "",
          rollup: [
            { conclusion: "", state: null, status: "QUEUED" },
            { conclusion: "SUCCESS", state: null, status: "COMPLETED" },
            { conclusion: "", state: null, status: "QUEUED" },
          ],
        },
      ],
    });
    const [inProgress, queued] = r.prs.items;
    expect([inProgress.checkLevel, inProgress.checkText]).toEqual(["warn", "확인 중"]);
    expect([queued.checkLevel, queued.checkText]).toEqual(["warn", "확인 중"]);
  });

  it("커밋 상태(state 만 있는 항목)도 그대로 판정된다 — CheckRun 과 모양이 다르다", () => {
    // StatusContext 는 `status`·`conclusion` 이 없고 `state` 만 있다. 비어 있지 않은
    // 첫 값을 고르는 규칙이 두 모양을 함께 덮는지 고정한다.
    const r = runReleaseStatus({
      marker: "aaaaaaa",
      totalCommits: 0,
      prs: [
        { number: 601, url: "https://x/601", title: "커밋 상태 실패", checks: "", rollup: [{ state: "FAILURE" }] },
        { number: 602, url: "https://x/602", title: "커밋 상태 대기", checks: "", rollup: [{ state: "PENDING" }] },
      ],
    });
    expect(r.prs.items[0].checkLevel).toBe("error");
    expect(r.prs.items[1].checkLevel).toBe("warn");
  });

  it("열린 PR 이 없으면 ok", () => {
    const r = runReleaseStatus({ marker: "aaaaaaa", totalCommits: 0, prs: [] });
    expect(r.prs.level).toBe("ok");
  });

  it("gh 인증 실패는 사유를 구분해 unknown 으로 떨어뜨린다(exit 0 유지)", () => {
    const r = runReleaseStatus({ marker: "aaaaaaa", ghFail: "auth" });
    expect(r.deploy.level).toBe("unknown");
    expect(r.deploy.detail).toContain("로그인");
    expect(r.recent.items).toEqual([]);
    expect(r.recent.detail).toContain("로그인");
    expect(r.prs.level).toBe("unknown");
    expect(r.prs.detail).toContain("로그인");
  });

  it("그 밖의 조회 실패는 다른 사유 문구를 쓴다", () => {
    const r = runReleaseStatus({ marker: "aaaaaaa", ghFail: "other" });
    expect(r.deploy.level).toBe("unknown");
    expect(r.deploy.detail).not.toContain("로그인");
    expect(r.deploy.detail).toContain("확인 불가");
  });

  it("제목에 큰따옴표·역슬래시가 있어도 JSON 이 깨지지 않는다", () => {
    const r = runReleaseStatus({
      marker: "aaaaaaa",
      totalCommits: 1,
      commits: [{ sha: "ccccccc", title: 'fix: "따옴표" 와 \\역슬래시' }],
    });
    expect(r.deploy.commits[0].title).toBe('fix: "따옴표" 와 \\역슬래시');
  });
});

/**
 * 배포 완료 알림의 판정·문구 계약 (개정 5).
 *
 * 앱은 직전에 관측한 배포 마커를 `--deployed-since` 로 되돌려 주고, 스크립트가
 * "그 사이에 무엇이 올라갔나"를 계산해 **알림 문구까지 완성**한다. 앱은 띄우기만
 * 한다 — 이 레포의 기존 분담(문구는 스크립트가 소유)을 그대로 따른다.
 *
 * ⛔ 판정을 앱으로 올리지 말 것: 앱은 계약상 `gh` 를 직접 부를 수 없고
 *    (menubar-app-delegation.test.ts), PR 번호 파싱 규약은 이미 이 파일이 소유한다.
 */
describe("release-status.sh 배포 완료 판정 계약", () => {
  it("마커 sha 를 항상 싣는다 — 앱이 다음 호출에 되돌려 줄 값이다", () => {
    const r = runReleaseStatus({ marker: "a".repeat(40) });
    expect(r.markerSha).toBe("a".repeat(40));
  });

  it("마커가 없으면 markerSha 는 null 이고 배포 판정도 없다(추측하지 않는다)", () => {
    const r = runReleaseStatus({});
    expect(r.markerSha).toBeNull();
    expect(r.deployed).toBeNull();
  });

  it("플래그가 없으면 deployed 는 null 이다 — 기동 직후 첫 관측이 이 경우다", () => {
    const r = runReleaseStatus({ marker: "a".repeat(40) });
    expect(r.deployed).toBeNull();
  });

  it("넘긴 sha 가 지금 마커와 같으면 deployed 는 null 이다(마커가 안 움직였다 = 무발화)", () => {
    const same = "a".repeat(40);
    const r = runReleaseStatus({ marker: same, deployedSince: same });
    expect(r.deployed).toBeNull();
  });

  it("마커가 움직였으면 그 사이 PR 번호·제목으로 문구를 완성한다", () => {
    const r = runReleaseStatus({
      marker: "b".repeat(40),
      deployedSince: "a".repeat(40),
      deployedCommits: [
        { sha: "1111111", title: "#509 feat(settlement): 정산 착수 지연 신호" },
        { sha: "2222222", title: "#510 test(contract): 로그 싱크 우회 차단" },
      ],
    });
    expect(r.deployed).not.toBeNull();
    expect(r.deployed!.count).toBe(2);
    expect(r.deployed!.title).toContain("배포");
    expect(r.deployed!.body).toContain("#509");
    expect(r.deployed!.body).toContain("#510");
    // 앱이 다시 조립하지 않도록 구조화 항목도 함께 준다(PR 페이지 링크 포함).
    expect(r.deployed!.items[0].url).toContain("/pull/509");
    expect(r.deployed!.from).toBe("a".repeat(40));
    expect(r.deployed!.to).toBe("b".repeat(40));
  });

  it("여러 건이면 앞 3건만 싣고 나머지는 「외 N건」으로 접는다(알림 본문 길이 상한)", () => {
    const r = runReleaseStatus({
      marker: "b".repeat(40),
      deployedSince: "a".repeat(40),
      deployedTotal: 6,
      deployedCommits: [
        { sha: "1111111", title: "#501 첫째" },
        { sha: "2222222", title: "#502 둘째" },
        { sha: "3333333", title: "#503 셋째" },
        { sha: "4444444", title: "#504 넷째" },
      ],
    });
    expect(r.deployed!.count).toBe(6);
    expect(r.deployed!.body).toContain("#503");
    expect(r.deployed!.body).not.toContain("#504");
    // ⚠️ 총 건수가 **맨 앞**이어야 한다 — 뒤에 붙이면 알림 본문이 잘릴 때 그것부터
    //    사라져 "몇 건이 나갔나"를 잃는다.
    expect(r.deployed!.body.startsWith("6건 — ")).toBe(true);
  });

  it("본문에서 PR 번호가 두 번 나오지 않는다(GitHub 이 붙인 꼬리 제거)", () => {
    // squash 제목은 앞에 `#NN `(P6 규약), 뒤에 GitHub 의 `(#NN)` 이 함께 붙는다.
    // 알림 본문은 폭이 좁아 그 중복이 그대로 자리를 먹는다.
    const r = runReleaseStatus({
      marker: "b".repeat(40),
      deployedSince: "a".repeat(40),
      deployedCommits: [{ sha: "1111111", title: "#510 test(contract): 무언가를 막는다 (#510)" }],
    });
    expect(r.deployed!.body).toBe("1건 — #510 test(contract): 무언가를 막는다");
    // ⚠️ items 의 원문은 손대지 않는다 — 「최근 반영」과 같은 문자열이어야 한다.
    expect(r.deployed!.items[0].title).toBe("#510 test(contract): 무언가를 막는다 (#510)");
  });

  it("items 는 5건까지만 싣는다 — 본문 3건 상한과 카운터를 공유하지 않는다", () => {
    // compare 는 최대 250건을 돌려준다. 두 상한이 카운터를 공유하면 items 가 3건에서
    // 멈춘다(구현 중 실제로 밟은 지점) — 총계는 count 가 들고 있다.
    const many = Array.from({ length: 7 }, (_, i) => ({
      sha: `${i}`.repeat(7),
      title: `#${600 + i} 제목 ${i}`,
    }));
    const r = runReleaseStatus({
      marker: "b".repeat(40),
      deployedSince: "a".repeat(40),
      deployedTotal: 7,
      deployedCommits: many,
    });
    expect(r.deployed!.count).toBe(7);
    expect(r.deployed!.items).toHaveLength(5);
    expect(r.deployed!.body.split(" · ")).toHaveLength(3);
    expect(r.deployed!.body.startsWith("7건 — ")).toBe(true);
  });

  it("되돌림(사이 커밋 0건)은 「올라갔다」고 말하지 않는다", () => {
    const r = runReleaseStatus({
      marker: "b".repeat(40),
      deployedSince: "a".repeat(40),
      deployedTotal: 0,
      deployedCommits: [],
    });
    expect(r.deployed).not.toBeNull();
    expect(r.deployed!.count).toBe(0);
    expect(r.deployed!.body).toContain("되돌");
  });

  it("구간 조회에 실패해도 배포됐다는 사실은 알린다 — 내용 불명을 명시한다", () => {
    // ⛔ 조용히 삼키지 말 것: 마커가 움직였다는 것은 deploy.sh 가 헬스체크까지
    //    통과했다는 뜻이라 배포는 확실히 일어났다. 목록을 못 읽은 것과 배포가
    //    없었던 것은 다른 사실이다.
    const r = runReleaseStatus({
      marker: "b".repeat(40),
      deployedSince: "a".repeat(40),
      deployedFail: true,
    });
    expect(r.deployed).not.toBeNull();
    expect(r.deployed!.title).toContain("배포");
    expect(r.deployed!.body).toContain("확인하지 못했습니다");
    expect(r.deployed!.items).toEqual([]);
    // -1 = 「세지 못했다」. 0(되돌림 = 앞으로 간 커밋이 없다)과 다른 사실이라
    // 같은 숫자로 접지 않는다 — 판정 불능을 정상으로 접는 이 레포의 반복 결함.
    expect(r.deployed!.count).toBe(-1);
  });

  it("알 수 없는 인자는 거부한다(오타가 조용히 무시되지 않게)", () => {
    expect(() =>
      execFileSync("bash", [STATUS_SCRIPT, "--deployed-sinse", "abc"], { encoding: "utf8" }),
    ).toThrow();
  });
});

describe("release-status.sh 소스 계약 — 읽기 전용", () => {
  const src = readFileSync(STATUS_SCRIPT, "utf8");
  const active = src.split("\n").filter((l) => !l.trim().startsWith("#"));

  it("PATH 보강이 있다(앱 컨텍스트에서 gh 가 안 보인다)", () => {
    expect(active.join("\n")).toMatch(/export PATH=.*\/usr\/local\/bin/);
  });

  it("로컬 git 상태를 바꾸지 않는다", () => {
    const mutating = active.filter((l) =>
      /\bgit\s+(fetch|pull|reset|checkout|clean|push)\b/.test(l),
    );
    expect(mutating).toEqual([]);
  });

  it("양성 프로브 — 스캐너가 실제로 잡는다", () => {
    expect(/\bgit\s+(fetch|pull|reset|checkout|clean|push)\b/.test("  git fetch origin main")).toBe(
      true,
    );
  });
});

const DEPLOY_SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "release-deploy.sh");

interface DeployOpts {
  branch?: string;
  head?: string;
  /** Worker 마커 내용. undefined = 마커 없음 */
  workerMarker?: string;
  /** git diff --quiet 결과: true = 변경 없음 */
  workerUnchanged?: boolean;
  /** 마커 sha 를 git 이 아는가 */
  markerKnown?: boolean;
  deployFails?: boolean;
  wranglerFails?: boolean;
  dryRun?: boolean;
  /** 살아 있는 PID 로 잠금을 미리 잡아 둔다 */
  lockHeldBy?: number;
}

function runReleaseDeploy(opts: DeployOpts) {
  const home = mkdtempSync(path.join(tmp, "dhome-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const logs = path.join(home, "selfhost", "logs");
  mkdirSync(logs, { recursive: true });
  mkdirSync(path.join(home, "selfhost", "wagcrm", "ygrd-link"), { recursive: true });
  if (opts.workerMarker !== undefined)
    writeFileSync(path.join(logs, "deployed.ygrd-link.sha"), `${opts.workerMarker}\n`);
  if (opts.lockHeldBy !== undefined) {
    mkdirSync(path.join(logs, "release-deploy.lock"));
    writeFileSync(path.join(logs, "release-deploy.lock", "pid"), `${opts.lockHeldBy}\n`);
  }

  const trace = path.join(home, "trace.log");
  const gitImpl = stub(
    bin,
    "git",
    `case "$*" in
  *"rev-parse --abbrev-ref HEAD"*) echo "${opts.branch ?? "main"}";;
  *"rev-parse HEAD"*) echo "${opts.head ?? "headsha1"}";;
  *cat-file*) exit ${opts.markerKnown === false ? 1 : 0};;
  *"diff --quiet"*) exit ${opts.workerUnchanged ? 0 : 1};;
esac`,
  );
  const deployImpl = stub(
    bin,
    "deploy",
    `echo "deploy.sh 실행됨" >> "${trace}"\nexit ${opts.deployFails ? 1 : 0}`,
  );
  const npmImpl = stub(bin, "npm", `echo "npm $*" >> "${trace}"`);
  const npxImpl = stub(
    bin,
    "npx",
    `echo "npx $*" >> "${trace}"\nexit ${opts.wranglerFails ? 1 : 0}`,
  );

  let status = 0;
  let stdout = "";
  try {
    stdout = execFileSync("bash", [DEPLOY_SCRIPT, ...(opts.dryRun ? ["--dry-run"] : [])], {
      env: {
        ...process.env,
        HOME: home,
        RELEASE_GIT_CMD: `bash ${gitImpl}`,
        RELEASE_DEPLOY_SH: deployImpl,
        RELEASE_NPM_CMD: `bash ${npmImpl}`,
        RELEASE_NPX_CMD: `bash ${npxImpl}`,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    status = err.status ?? 1;
    stdout = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  let traceText = "";
  try {
    traceText = readFileSync(trace, "utf8");
  } catch {
    traceText = "";
  }
  const markerPath = path.join(logs, "deployed.ygrd-link.sha");
  let workerMarkerAfter: string | null = null;
  try {
    workerMarkerAfter = readFileSync(markerPath, "utf8").trim();
  } catch {
    workerMarkerAfter = null;
  }
  return { status, stdout, trace: traceText, workerMarkerAfter };
}

describe("release-deploy.sh 행위 계약", () => {
  it("CRM → Worker 순서로 돈다(마커 없으면 Worker 배포)", () => {
    const r = runReleaseDeploy({});
    expect(r.status).toBe(0);
    expect(r.trace.indexOf("deploy.sh 실행됨")).toBeLessThan(r.trace.indexOf("npx"));
    expect(r.trace).toContain("wrangler deploy");
    expect(r.trace).toContain("--no-install");
    expect(r.workerMarkerAfter).toBe("headsha1");
  });

  it("CRM 이 실패하면 Worker 는 손대지 않는다", () => {
    const r = runReleaseDeploy({ deployFails: true });
    expect(r.status).not.toBe(0);
    expect(r.trace).not.toContain("npx");
    expect(r.workerMarkerAfter).toBeNull();
    expect(r.stdout).toContain("링크 서버는 손대지 않았습니다");
  });

  it("ygrd-link/ 변경이 없으면 Worker 를 건너뛴다", () => {
    const r = runReleaseDeploy({ workerMarker: "oldsha1", workerUnchanged: true });
    expect(r.status).toBe(0);
    expect(r.trace).toContain("deploy.sh 실행됨");
    expect(r.trace).not.toContain("npx");
    expect(r.workerMarkerAfter).toBe("oldsha1");
  });

  it("마커 sha 를 git 이 모르면 배포 쪽으로 넘어진다", () => {
    const r = runReleaseDeploy({ workerMarker: "gonesha", markerKnown: false });
    expect(r.trace).toContain("wrangler deploy");
  });

  it("wrangler 가 실패하면 CRM 이 이미 반영됐음을 알린다", () => {
    const r = runReleaseDeploy({ wranglerFails: true });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("CRM 은 이미 반영");
    expect(r.workerMarkerAfter).toBeNull();
  });

  it("프로덕션 체크아웃이 main 이 아니면 아무 것도 하지 않는다", () => {
    const r = runReleaseDeploy({ branch: "main-local" });
    expect(r.status).not.toBe(0);
    expect(r.trace).toBe("");
    expect(r.stdout).toContain("main");
  });

  it("잠금을 잡고 있는 프로세스가 살아 있으면 중단한다", () => {
    const r = runReleaseDeploy({ lockHeldBy: process.pid });
    expect(r.status).not.toBe(0);
    expect(r.trace).toBe("");
    expect(r.stdout).toContain("이미 진행 중");
  });

  it("--dry-run 은 아무 것도 실행하지 않는다", () => {
    const r = runReleaseDeploy({ dryRun: true });
    expect(r.status).toBe(0);
    expect(r.trace).toBe("");
    expect(r.stdout).toContain("예행");
  });

  it("알 수 없는 인자(오타 포함)는 거부하고 아무 것도 실행하지 않는다", () => {
    for (const bad of ["--dryrun", "--dry", "-n"]) {
      const home = mkdtempSync(path.join(tmp, "dhome-"));
      const bin = path.join(home, "bin");
      mkdirSync(bin, { recursive: true });
      const logs = path.join(home, "selfhost", "logs");
      mkdirSync(logs, { recursive: true });
      mkdirSync(path.join(home, "selfhost", "wagcrm", "ygrd-link"), { recursive: true });
      const trace = path.join(home, "trace.log");
      const gitImpl = stub(
        bin,
        "git",
        `case "$*" in
  *"rev-parse --abbrev-ref HEAD"*) echo "main";;
  *"rev-parse HEAD"*) echo "headsha1";;
esac`,
      );
      const deployImpl = stub(bin, "deploy", `echo "deploy.sh 실행됨" >> "${trace}"`);
      let status = 0;
      let stdout = "";
      try {
        stdout = execFileSync("bash", [DEPLOY_SCRIPT, bad], {
          env: {
            ...process.env,
            HOME: home,
            RELEASE_GIT_CMD: `bash ${gitImpl}`,
            RELEASE_DEPLOY_SH: deployImpl,
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        status = err.status ?? 1;
        stdout = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      }
      let traceText = "";
      try {
        traceText = readFileSync(trace, "utf8");
      } catch {
        traceText = "";
      }
      expect(status).not.toBe(0);
      expect(traceText).toBe("");
      expect(stdout).toContain("--dry-run");
    }
  });
});

describe("release-deploy.sh 소스 계약", () => {
  const src = readFileSync(DEPLOY_SCRIPT, "utf8");
  const active = src.split("\n").filter((l) => !l.trim().startsWith("#"));
  const body = active.join("\n");

  it("체크아웃 경로를 하드코딩해 소유한다(상대 경로 해석 금지)", () => {
    expect(body).toContain('PROD_CHECKOUT="$HOME/selfhost/wagcrm"');
    expect(body).not.toMatch(/cd\s+"?\$\(dirname/);
  });

  it("PATH 보강이 있다(앱 PATH 에는 npm 이 없다)", () => {
    expect(body).toMatch(/export PATH=.*\/usr\/local\/bin/);
  });

  // 🪤 `mktemp -t <접두사>` 는 BSD(macOS) 전용이라 GNU coreutils(CI ubuntu)에서
  // `too few X's in template` 로 즉사한다 — 실제로 CI 만 빨간불이 됐다(2026-08-14).
  // 작성자는 macOS 에서 일하므로 이 계약이 없으면 로컬에서 영원히 안 보인다.
  it("두 스크립트 모두 BSD 전용 `mktemp -t <접두사>` 를 쓰지 않는다", () => {
    for (const file of [DEPLOY_SCRIPT, STATUS_SCRIPT]) {
      const lines = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"));
      for (const line of lines) {
        expect(line, path.basename(file)).not.toMatch(/mktemp\s+(-d\s+)?-t\b/);
      }
    }
    // 양성 프로브 — 스캐너가 실제로 잡는다
    expect('SNAP="$(mktemp -t release-deploy)"').toMatch(/mktemp\s+(-d\s+)?-t\b/);
  });

  it("deploy.sh 의 P0 가드를 재구현하지 않는다", () => {
    expect(body).not.toContain("VERCEL_ENV");
    expect(body).not.toContain("DATABASE_URL");
    expect(body).not.toContain("launchctl");
  });

  it("APP_TRACK_BRANCH 를 건드리지 않는다(가드가 말하게 둔다)", () => {
    expect(body).not.toContain("APP_TRACK_BRANCH");
  });

  it("파괴적 명령이 없다", () => {
    const destructive = active.filter((l) =>
      /(\$DOCKER|\bdocker)\s+(rm|stop|kill)|rm\s+-rf\s+(?!"\$LOCK_DIR")/.test(l),
    );
    expect(destructive).toEqual([]);
  });
});
