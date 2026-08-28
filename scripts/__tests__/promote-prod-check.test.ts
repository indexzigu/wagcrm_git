import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * promote-prod.sh --check 의 승격 권장 문턱을 고정한다.
 *
 * 왜 필요한가(실사고 2026-08-04): `--check` 가 "문턱: ≥5건 또는 ≥24h" 라고 답했는데
 * 실제 자동 승격(.github/workflows/promote-auto.yml)은 4h cron 에 미승격이 1건만
 * 있어도 발화한다(건수 문턱은 push 이벤트 전용). 24h 는 2026-07-24 자동 승격 도입
 * 이전, 승격이 수동이던 시절의 값이 남은 것이다. `--check` 는 사람이 "지금 승격할까
 * 기다릴까"를 판단하려고 읽는 창구라(P6: 세션 보고·사람 확인용) 이 어긋남은 곧
 * 불필요한 수동 승격 판단으로 이어진다.
 *
 * 이 드리프트가 오래 살아남은 구조적 이유는 **두 판정기가 서로를 호출하지 않기**
 * 때문이다 — 워크플로는 자체 판정 후 `--yes` 만 부르고 `--check` 는 쓰지 않아서,
 * 한쪽이 낡아도 아무 테스트도 깨지지 않는다. 그래서 여기서 두 가지를 함께 묶는다:
 *   (A) 상수 드리프트: 워크플로(정본)의 COUNT_THRESHOLD·cron 케이던스 == 스크립트 기본값
 *   (B) 실제 판정: 그 상수가 종료코드(0/2/3)와 안내 문구에 그대로 반영되는가
 *
 * 선례: await-promotion.test.ts 가 promote-prod.sh 와 await-promotion.sh 를 같은
 * 픽스처로 묶어 드리프트를 잡는 것과 같은 수법이다.
 */

const SCRIPT = path.resolve(__dirname, "..", "promote-prod.sh");
const WORKFLOW = path.resolve(__dirname, "..", "..", ".github", "workflows", "promote-auto.yml");

// ── (A) 상수 드리프트 — 정본은 워크플로다.

function scriptDefault(name: string): number {
  const src = readFileSync(SCRIPT, "utf8");
  const m = src.match(new RegExp(`^${name}="\\$\\{[A-Z_]+:-(\\d+)\\}"`, "m"));
  if (!m) throw new Error(`promote-prod.sh 에서 ${name} 기본값을 찾지 못했다`);
  return Number(m[1]);
}

/**
 * ⛔ 종전의 두 드리프트 검사(건수 문턱 == COUNT_THRESHOLD, 시간 문턱 == schedule cron)는
 * **SUPERSEDED**(2026-08-13 자체호스팅 컷오버). 그 워크플로의 자동 트리거를 제거해
 * **비출 대상 자체가 사라졌다** — 이제 `MAX_PENDING`/`MAX_AGE_HOURS` 는 "곧 자동 승격이
 * 발화할 나이인가"가 아니라 "구 플랫폼 롤백 창구가 얼마나 낡았는가"를 뜻한다.
 *
 * 대신 **더 중요해진 불변식**을 고정한다: 자동 트리거가 조용히 되살아나지 않을 것.
 * 되살아나면 이관 후에도 4시간마다 구 플랫폼 빌드를 태우고(오너가 명시적으로 끈 것),
 * `--check` 안내 문구와도 다시 어긋난다. 트리거는 한 줄이면 복구되는 데다 되살아나도
 * **아무 것도 실패하지 않아** 사람이 알아차릴 계기가 없다 — 그래서 테스트가 본다.
 */
describe("promote-auto.yml 자동 트리거 (컷오버 후 수동 전용 유지)", () => {
  /** `on:` 블록만 잘라낸다 — 주석·job 본문의 'push'/'schedule' 문자열에 오탐하지 않게. */
  function onBlock(src: string): string {
    const start = src.search(/^on:$/m);
    expect(start, "promote-auto.yml 에서 `on:` 블록을 찾지 못했다").toBeGreaterThanOrEqual(0);
    const rest = src.slice(start + 3);
    const end = rest.search(/^\S/m); // 다음 최상위 키(permissions: 등)
    return end === -1 ? rest : rest.slice(0, end);
  }

  it("`on:` 에 자동 트리거(push·schedule)가 없다", () => {
    const block = onBlock(readFileSync(WORKFLOW, "utf8"));
    expect(block, "push 트리거가 되살아났다 — 이관 후 구 플랫폼 빌드를 다시 태운다").not.toMatch(
      /^\s+push:/m,
    );
    expect(
      block,
      "schedule 트리거가 되살아났다 — 이관 후 4시간마다 구 플랫폼 빌드를 태운다",
    ).not.toMatch(/^\s+schedule:/m);
  });

  it("수동 트리거(workflow_dispatch)는 남아 있다 — 롤백 시 승격 경로", () => {
    const block = onBlock(readFileSync(WORKFLOW, "utf8"));
    expect(block, "workflow_dispatch 까지 사라지면 롤백 때 승격할 방법이 없다").toMatch(
      /^\s+workflow_dispatch:/m,
    );
  });

  it("--check 가 '자동 승격이 받쳐준다'고 안내하지 않는다", () => {
    // 문구가 실제 발화 주체와 어긋나면 사람이 헛판단한다(2026-08-04 실사고의 교훈).
    // 자동 승격이 없는데 "기다려도 나간다"고 하면 미승격이 영원히 방치된다.
    const src = readFileSync(SCRIPT, "utf8");
    expect(src, "--check 가 아직 자동 승격을 약속하고 있다").not.toContain("기다려도 나간다");
  });

  it("문턱 기본값은 스크립트 안에서 그대로 읽힌다 (파싱 계약 유지)", () => {
    // 값 자체는 이제 워크플로와 묶이지 않지만, 아래 (B) 판정 테스트가 이 파싱에
    // 의존하므로 형태는 고정해 둔다.
    expect(scriptDefault("MAX_PENDING")).toBeGreaterThan(0);
    expect(scriptDefault("MAX_AGE_HOURS")).toBeGreaterThan(0);
  });
});

/**
 * 여러 줄에 걸친 파이프라인을 **논리 명령 1개**로 합친다(주석 줄 제외).
 * 줄 단위로 스캔하면 `\` 로 이어진 파이프라인의 `|| true` 를 놓쳐 오탐이 난다.
 */
function logicalCommands(src: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const raw of src.split("\n")) {
    if (raw.trimStart().startsWith("#")) continue;
    const line = raw.trimEnd();
    // YAML 블록 스칼라(`run: |`)의 `|` 는 파이프가 아니다 — 이어붙이면 run 블록 전체가
    // 한 논리 명령이 되어 블록 어딘가의 `|| true` 가 전부를 면제해 버린다.
    const isYamlBlockScalar = /:\s*\|-?\s*$/.test(line);
    const continues = line.endsWith("\\") || (line.endsWith("|") && !isYamlBlockScalar);
    const body = line.endsWith("\\") ? line.slice(0, -1).trimEnd() : line;
    buf = buf ? `${buf} ${body.trimStart()}` : body;
    if (!continues) {
      if (buf.trim()) out.push(buf);
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

describe("promote-prod.sh — 종료코드를 SIGPIPE 로 잃지 않는다", () => {
  // 위 (B) 의 "5건" 케이스가 CI 에서 exit 3 대신 **141**(=128+SIGPIPE)로 실패해 드러난
  // 선재 결함이다: `set -euo pipefail` 아래에서 파이프의 소비자가 먼저 끝나면(head 의
  // 줄 수 제한, awk 의 조기 exit) 생산자 git 이 SIGPIPE 로 죽고, 그 141 이 스크립트를
  // 넘어뜨려 --check 의 0/2/3 종료코드 계약을 깬다. 생산자의 쓰기와 소비자의 종료가
  // 겹치는 타이밍 의존이라 실행 테스트로는 못 잡는다(로컬 통과·CI 실패) — 패턴을 고정한다.
  //
  // `|| true` 로 감싼 파이프라인은 예외다: 종료코드를 애초에 판정에 쓰지 않겠다고 선언한
  // 것이라 SIGPIPE 가 무해하다(배포 확인 폴링이 그 형태 — 상태 문자열이 비면 계속 대기).
  // ⚠️ **알려진 조기 종료 소비자의 열거이지 완전한 판별이 아니다**(교차 검증 지적).
  // 아래 4종만 본다 — 다른 조기 종료 수단(예: `| python -c '…sys.exit()'`)은 못 잡는다.
  // 새로운 형태를 쓰게 되면 여기 목록에 함께 추가할 것.
  // 반대로 `sed -n '1p'` 나 `grep -o` 처럼 **입력을 끝까지 읽는** 소비자는 위반이 아니다 —
  // 조기 종료 여부가 기준이지 "출력을 자르는가"가 기준이 아니다.
  //
  // 대상 3개는 **종료코드가 곧 판정인 승격 경로 전체**다. 한 곳만 고치면 갈라진다 —
  // 실제로 promote-prod.sh 만 고쳤을 때 await-promotion.sh 에 같은 형태가 남아 있었고
  // (P6 가 "동일 계약"으로 묶은 짝인데도), promote-auto.yml 에는 `grep -q` 형태로 있었다.
  const PIPEFAIL_SOURCES: Array<[string, string]> = [
    ["promote-prod.sh", SCRIPT],
    ["await-promotion.sh", path.resolve(__dirname, "..", "await-promotion.sh")],
    ["promote-auto.yml", WORKFLOW],
  ];

  it.each(PIPEFAIL_SOURCES)("%s — 판정 파이프라인에 조기 종료 소비자가 없다", (_name, file) => {
    const offenders = logicalCommands(readFileSync(file, "utf8")).filter((cmd) => {
      if (/\|\|\s*true/.test(cmd)) return false;
      const cutsWithHead = /\|\s*head\b/.test(cmd);
      const awkExitsEarly = /\|\s*awk\b/.test(cmd) && /;\s*exit\s*\}/.test(cmd);
      // -q/--quiet(첫 매치에서 종료) · -m/--max-count. `-o`·`-c` 는 전량 읽으므로 제외된다.
      const grepStopsEarly = /\|\s*grep\b[^|]*\s--?\w*[qm]/.test(cmd);
      const sedQuitsEarly = /\|\s*sed\b[^|]*(;|')\s*q\b/.test(cmd);
      return cutsWithHead || awkExitsEarly || grepStopsEarly || sedQuitsEarly;
    });
    expect(
      offenders,
      "입력을 끝까지 읽도록 바꿀 것(head→tail · awk 는 플래그로 첫 매치만 · grep -q 는 프로세스 치환)",
    ).toEqual([]);
  });
});

// ── (B) 실제 판정 — 오프라인 임시 git 저장소로 --check 를 그대로 태운다.

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 실패: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * main 에 `pending` 건이 쌓이고 그중 최고령이 `oldestHoursAgo` 시간 전인 상태를 만든다.
 * 스크립트의 REMOTE 탐지는 URL 이 `indexzigu/wagcrm` 으로 끝나는지만 보므로, 그 이름의
 * 로컬 bare 저장소를 리모트로 붙여 네트워크 없이 실제 `git fetch` 까지 태운다.
 */
function setupRepo({ pending, oldestHoursAgo = 0 }: { pending: number; oldestHoursAgo?: number }) {
  const base = mkdtempSync(path.join(tmpdir(), "promote-check-"));
  const upstream = path.join(base, "indexzigu", "wagcrm");
  mkdirSync(upstream, { recursive: true });
  git(base, ["init", "-q", "--bare", upstream]);

  const work = path.join(base, "work");
  mkdirSync(work);
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "test@example.local"]);
  git(work, ["config", "user.name", "test"]);
  git(work, ["config", "commit.gpgsign", "false"]);

  // 시각은 전부 "지금 기준 상대값"이다 — 고정 날짜 픽스처는 시한폭탄이다(P9).
  const commit = (msg: string, msAgo: number) => {
    writeFileSync(path.join(work, "f.txt"), msg);
    git(work, ["add", "f.txt"]);
    const when = new Date(Date.now() - msAgo).toISOString();
    git(work, ["commit", "-q", "-m", msg], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
    return git(work, ["rev-parse", "HEAD"]);
  };

  const hour = 3_600_000;
  const baseSha = commit("base", (oldestHoursAgo + 1) * hour);
  git(work, ["remote", "add", "origin", upstream]);
  git(work, ["push", "-q", "origin", `${baseSha}:refs/heads/main`, `${baseSha}:refs/heads/release`]);

  for (let i = 0; i < pending; i += 1) {
    commit(`#${i + 1} pending`, oldestHoursAgo * hour - i * 1000); // 뒤로 갈수록 최신
  }
  if (pending > 0) git(work, ["push", "-q", "origin", "main:refs/heads/main"]);
  return work;
}

function runCheck(work: string, env: NodeJS.ProcessEnv = {}) {
  const clean = { ...process.env };
  delete clean.PROMOTE_MAX_PENDING; // 셸 환경이 판정을 흔들지 않게
  delete clean.PROMOTE_MAX_AGE_HOURS;
  const r = spawnSync("bash", [SCRIPT, "--check"], {
    cwd: work,
    encoding: "utf8",
    env: { ...clean, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("promote-prod.sh --check (승격 권장 판정)", () => {
  it("미승격 0건이면 배포 불필요(exit 0)", () => {
    const r = runCheck(setupRepo({ pending: 0 }));
    expect(r.status).toBe(0);
    expect(r.out).toContain("승격할 것이 없다");
  });

  it("갓 머지된 1건은 문턱 미달(exit 2) — 자동 승격 대기가 정상이다", () => {
    const r = runCheck(setupRepo({ pending: 1 }));
    expect(r.status).toBe(2);
    expect(r.out).toContain("문턱 미달");
    expect(r.out).toContain("≥5건 또는 ≥4h");
    // 낡은 값이 문구로 되살아나는 회귀를 직접 막는다(실사고의 관측 지점).
    expect(r.out).not.toContain("24h");
  });

  it("최고령이 자동 승격 케이던스(4h)를 넘으면 승격 권장(exit 3)", () => {
    const r = runCheck(setupRepo({ pending: 1, oldestHoursAgo: 5 }));
    expect(r.status).toBe(3);
    expect(r.out).toContain("승격 권장");
  });

  it("케이던스 안(3h)이면 아직 권장하지 않는다(exit 2)", () => {
    const r = runCheck(setupRepo({ pending: 1, oldestHoursAgo: 3 }));
    expect(r.status).toBe(2);
  });

  it("건수 문턱(5건)을 채우면 나이와 무관하게 승격 권장(exit 3)", () => {
    const r = runCheck(setupRepo({ pending: 5 }));
    expect(r.status).toBe(3);
    expect(r.out).toContain("미승격 5건");
  });

  it("정본을 가리키는 리모트가 둘이어도 하나만 골라 정상 판정한다", () => {
    // 리모트 탐지의 awk 가 조기 `exit` 대신 플래그로 첫 매치만 뽑도록 바뀌었다(SIGPIPE
    // 회피). 플래그를 빠뜨리면 두 줄이 나와 `git fetch "$REMOTE"` 가 깨지므로 여기서 고정한다.
    const work = setupRepo({ pending: 1 });
    const url = git(work, ["remote", "get-url", "origin"]);
    git(work, ["remote", "add", "mirror", url]);
    const r = runCheck(work);
    expect(r.status).toBe(2);
    expect(r.out).toContain("문턱 미달");
  });

  it("문턱은 문구가 아니라 상수다 — env 로 올리면 같은 저장소가 문턱 미달이 된다", () => {
    const work = setupRepo({ pending: 1, oldestHoursAgo: 5 });
    expect(runCheck(work).status).toBe(3);
    expect(runCheck(work, { PROMOTE_MAX_AGE_HOURS: "24" }).status).toBe(2);
  });
});
