import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * metrics.sh 는 메뉴바 앱 리소스 그래프의 계측 SSOT 다 — status.sh 의 자매
 * (설계 정본 docs/private/specs/2026-08-14-menubar-server-control-design.md
 * 개정 2). status.sh 소스 계약이 "docker 는 inspect 뿐"을 고정하므로 stats 가
 * 필요한 계측은 이 파일로 분리됐다. 두 가지를 고정한다:
 *  (1) 행위 — 스텁 도구를 METRICS_*_CMD 훅으로 "bash <파일>"(실행 비트 없는
 *      데이터 파일) 주입해 hermetic 실행. JSON 스키마·CPU 정규화 레벨·supabase
 *      합산·누적 카운터 패스스루를 검증한다.
 *  (2) 소스 — 읽기 전용 계약. docker 는 stats / system df 만, launchctl 은
 *      list 만. 파괴적 명령이 하나라도 생기면 preview.sh 의 프로덕션 보호
 *      가드 밖 통로가 열린다.
 */
const SCRIPT = path.resolve(__dirname, "..", "..", "infra", "selfhost", "metrics.sh");

const tmp = mkdtempSync(path.join(tmpdir(), "menubar-metrics-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 실행 비트 없는 스텁 본문 — metrics.sh 의 METRICS_*_CMD 훅이 `bash <파일>` 로 읽는다. */
function stub(dir: string, name: string, body: string): string {
  const p = path.join(dir, `${name}.impl`);
  writeFileSync(p, `${body}\n`);
  return p;
}

interface RunOpts {
  /** 기계 코어 수(sysctl 스텁 출력). 기본 8 */
  cores?: number;
  /** ps 가 돌려주는 CRM 프로세스 raw CPU%(코어 합산 전 정규화 안 된 값). 기본 100.0 */
  psCpuRaw?: string;
  /** ps 가 돌려주는 RSS(KB). 기본 102400 = 100MiB */
  psRssKb?: string;
  /** true 면 launchctl 이 exit 1 (프로세스 미기동) */
  crmMissing?: boolean;
  /** true 면 docker 가 exit 1 (도커 데몬 정지 등) */
  dockerFail?: boolean;
  /** true 면 du 가 exit 1 (DB 데이터 디렉터리 부재) */
  duFail?: boolean;
}

interface TargetMetrics {
  available: boolean;
  cpuPct?: number;
  cpuLevel?: string;
  memBytes?: number;
  netRxBytes?: number;
  netTxBytes?: number;
}

interface MetricsPayload {
  schemaVersion: number;
  generatedAt: string;
  cores: number;
  crm: TargetMetrics;
  db: TargetMetrics;
  dbData: { available: boolean; bytes?: number };
}

function runMetrics(opts: RunOpts = {}): MetricsPayload {
  const dir = mkdtempSync(path.join(tmp, "run-"));
  mkdirSync(dir, { recursive: true });

  const launchctlImpl = stub(
    dir,
    "launchctl",
    opts.crmMissing
      ? "exit 1"
      : `printf '%s\\n' '{' '\t"PID" = 4242;' '\t"LastExitStatus" = 0;' '};'`,
  );
  const psImpl = stub(dir, "ps", `printf ' %s %s\\n' "${opts.psCpuRaw ?? "100.0"}" "${opts.psRssKb ?? "102400"}"`);
  const nettopImpl = stub(
    dir,
    "nettop",
    `printf '%s\\n' 'time interface state bytes_in bytes_out rx_dupe'
printf '%s\\n' '10:00:00.000000 node.4242 72179 17937 0 0 0'`,
  );
  const sysctlImpl = stub(dir, "sysctl", `echo ${opts.cores ?? 8}`);
  const dockerImpl = stub(
    dir,
    "docker",
    opts.dockerFail
      ? "exit 1"
      : `cat <<'EOS'
supabase-db|3.0%|100MiB / 8GiB|200MB / 100MB
supabase-auth|1.0%|50MiB / 8GiB|75MB / 25MB
unrelated-app|99.0%|1GiB / 8GiB|9GB / 9GB
EOS`,
  );
  // du -sk 는 KB 단위 정수 + 경로를 낸다.
  const duImpl = stub(dir, "du", opts.duFail ? "exit 1" : `printf '%s\\t%s\\n' 146636 /fixture/db/data`);

  const out = execFileSync("bash", [SCRIPT], {
    env: {
      ...process.env,
      METRICS_LAUNCHCTL_CMD: `bash ${launchctlImpl}`,
      METRICS_PS_CMD: `bash ${psImpl}`,
      METRICS_NETTOP_CMD: `bash ${nettopImpl}`,
      METRICS_SYSCTL_CMD: `bash ${sysctlImpl}`,
      METRICS_DOCKER_CMD: `bash ${dockerImpl}`,
      METRICS_DU_CMD: `bash ${duImpl}`,
    },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

describe("metrics.sh 행위 계약", () => {
  it("정상 픽스처: 스키마 완비, 누적 카운터 패스스루, supabase 만 합산", () => {
    const r = runMetrics();
    expect(r.schemaVersion).toBe(1);
    expect(r.cores).toBe(8);

    // CRM: raw 100% / 8코어 = 12.5% → ok. RSS 102400KB = 100MiB.
    expect(r.crm.available).toBe(true);
    expect(r.crm.cpuPct).toBeCloseTo(12.5, 1);
    expect(r.crm.cpuLevel).toBe("ok");
    expect(r.crm.memBytes).toBe(102400 * 1024);
    // 누적 카운터는 가공 없이 그대로 — 속도 계산은 앱 링버퍼의 몫(설계).
    expect(r.crm.netRxBytes).toBe(72179);
    expect(r.crm.netTxBytes).toBe(17937);

    // DB: supabase* 두 컨테이너만 합산(unrelated-app 99% 제외).
    expect(r.db.available).toBe(true);
    expect(r.db.cpuPct).toBeCloseTo(4.0 / 8, 1);
    expect(r.db.cpuLevel).toBe("ok");
    expect(r.db.memBytes).toBeCloseTo(150 * 1024 * 1024, -2);
    expect(r.db.netRxBytes).toBeCloseTo(275e6, -3);
    expect(r.db.netTxBytes).toBeCloseTo(125e6, -3);

    // DB 데이터 크기: 바인드 마운트 du -sk(KB) → 바이트 환산.
    expect(r.dbData.available).toBe(true);
    expect(r.dbData.bytes).toBe(146636 * 1024);
  });

  it("CPU 레벨은 코어 정규화 후 70/90 경계다", () => {
    // raw 600% / 8 = 75% → warn
    expect(runMetrics({ psCpuRaw: "600.0" }).crm.cpuLevel).toBe("warn");
    // raw 760% / 8 = 95% → error
    expect(runMetrics({ psCpuRaw: "760.0" }).crm.cpuLevel).toBe("error");
    // raw 550% / 8 = 68.75% → ok (경계 미만)
    expect(runMetrics({ psCpuRaw: "550.0" }).crm.cpuLevel).toBe("ok");
    // 경계 정확값 — level_for 는 >= 라 70.0·90.0 은 각각 warn·error 쪽에 든다.
    // (근접값만 두면 경계가 > 로 바뀌어도 테스트가 조용히 통과한다)
    expect(runMetrics({ psCpuRaw: "560.0" }).crm.cpuLevel).toBe("warn"); // 70.0
    expect(runMetrics({ psCpuRaw: "720.0" }).crm.cpuLevel).toBe("error"); // 90.0
  });

  it("CRM 프로세스 미기동 → crm.available=false, 나머지는 정상 출력", () => {
    const r = runMetrics({ crmMissing: true });
    expect(r.crm.available).toBe(false);
    expect(r.db.available).toBe(true);
  });

  it("docker 실패 → db.available=false, 스크립트는 exit 0", () => {
    const r = runMetrics({ dockerFail: true });
    expect(r.db.available).toBe(false);
    expect(r.crm.available).toBe(true);
  });

  it("DB 데이터 디렉터리 부재(du 실패) → dbData.available=false", () => {
    const r = runMetrics({ duFail: true });
    expect(r.dbData.available).toBe(false);
    expect(r.db.available).toBe(true);
  });
});

describe("metrics.sh 소스 계약 — 읽기 전용", () => {
  const SRC = readFileSync(SCRIPT, "utf8");
  const active = SRC.split("\n").filter((l) => !l.trim().startsWith("#"));

  it("파괴적 명령이 없다", () => {
    const destructive = active.filter((l) =>
      /(\$DOCKER|\bdocker)\s+(rm|stop|kill|compose\s+down)|(\$LAUNCHCTL|\blaunchctl)\s+(bootout|bootstrap|unload|kickstart)|rm\s+-rf/.test(
        l,
      ),
    );
    expect(destructive).toEqual([]);
  });

  it("docker 사용은 stats 뿐이다(스캐너 고장 감지 겸)", () => {
    const dockerLines = active.filter((l) => /(\$DOCKER|\bdocker)\s+[a-z]/.test(l));
    expect(dockerLines.length).toBeGreaterThan(0);
    for (const l of dockerLines) expect(l).toMatch(/(\$DOCKER|docker)\s+stats/);
  });

  it("launchctl 사용은 list 뿐이다", () => {
    const lines = active.filter((l) => /(\$LAUNCHCTL|\blaunchctl)\s+[a-z]/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/(\$LAUNCHCTL|launchctl)\s+list/);
  });
});
