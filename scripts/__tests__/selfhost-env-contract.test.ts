// 셀프호스트 `.env` 처분 선언 표의 판정 계약 (T-067).
//
// 이 테스트가 지키는 것은 두 가지다.
// ① **판정이 설계대로인가** — required 만 배포를 막고, degrades·미분류는 경고에 그친다.
//    (일괄 필수화로 되돌아가면 CI required 체크가 막혀 전 PR 이 머지 불가가 된다.)
// ② **표 자체가 썩지 않는가** — 사유 없는 optional, 중복 키, 존재하지 않는 대체 키.
//
// ⛔ **실제 프로덕션 `.env` 를 읽지 않는다.** 그 파일은 git 미추적이라 CI·fresh clone 에
// 없고(있으면 시크릿이 레포에 있다는 뜻이다), 무엇보다 값에 손대는 순간 P0 다. 전부
// 인라인 픽스처로 판정한다.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SELFHOST_ENV_CONTRACT,
  evaluateSelfhostEnv,
  type EnvContractEntry,
} from "../selfhost-env-contract";
import { parseEnvFile } from "../check-selfhost-env";

const CONTRACT: readonly EnvContractEntry[] = [
  { envName: "MUST", disposition: "required", reason: "없으면 조용히 멈춘다" },
  { envName: "PAIR_A", disposition: "required", reason: "둘 중 하나면 된다", satisfiedBy: ["PAIR_B"] },
  { envName: "PAIR_B", disposition: "required", reason: "둘 중 하나면 된다", satisfiedBy: ["PAIR_A"] },
  { envName: "NICE", disposition: "degrades", reason: "이 기능이 꺼진다" },
  { envName: "FINE", disposition: "optional", reason: "코드가 기본값으로 폴백한다" },
  { envName: "ELSEWHERE", disposition: "unused-here", reason: "레포 밖 러너가 자기 값을 쓴다" },
];

describe("처분 선언 표 — 판정", () => {
  it("required 가 비면 오류이고 배포를 막는다", () => {
    const r = evaluateSelfhostEnv({ MUST: "", PAIR_A: "x" }, CONTRACT);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.key)).toContain("MUST");
  });

  it("키가 아예 없는 것과 빈 문자열을 같게 본다", () => {
    // 컷오버가 남긴 상태가 정확히 "이름은 있는데 값이 없는" 줄이라, 둘을 가르면
    // 같은 사고를 절반만 잡는다.
    const missing = evaluateSelfhostEnv({ PAIR_A: "x" }, CONTRACT);
    const blank = evaluateSelfhostEnv({ MUST: "   ", PAIR_A: "x" }, CONTRACT);
    expect(missing.errors.map((e) => e.key)).toEqual(blank.errors.map((e) => e.key));
  });

  it("짝 중 하나만 채워져 있으면 둘 다 통과한다", () => {
    const r = evaluateSelfhostEnv({ MUST: "x", PAIR_B: "y" }, CONTRACT);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("짝이 둘 다 비면 둘 다 오류이고 사유에 대체 키를 밝힌다", () => {
    const r = evaluateSelfhostEnv({ MUST: "x" }, CONTRACT);
    expect(r.errors.map((e) => e.key).sort()).toEqual(["PAIR_A", "PAIR_B"]);
    expect(r.errors[0].message).toContain("PAIR_B");
  });

  it("degrades 가 비면 경고일 뿐 배포를 막지 않는다", () => {
    const r = evaluateSelfhostEnv({ MUST: "x", PAIR_A: "y" }, CONTRACT);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.key)).toContain("NICE");
  });

  it("optional 은 비어도 조용하다", () => {
    const r = evaluateSelfhostEnv({ MUST: "x", PAIR_A: "y", NICE: "z" }, CONTRACT);
    expect(r.warnings.map((w) => w.key)).not.toContain("FINE");
  });

  it("unused-here 는 **값이 있을 때** 경고한다(반대 방향)", () => {
    const empty = evaluateSelfhostEnv({ MUST: "x", PAIR_A: "y" }, CONTRACT);
    expect(empty.warnings.map((w) => w.key)).not.toContain("ELSEWHERE");
    const filled = evaluateSelfhostEnv({ MUST: "x", PAIR_A: "y", ELSEWHERE: "v" }, CONTRACT);
    expect(filled.warnings.map((w) => w.key)).toContain("ELSEWHERE");
  });

  it("미분류 키는 경고이고 오류가 아니다", () => {
    // ⛔ 오류로 올리지 말 것 — 도입 시점 백로그로 즉시 실패가 뜨면 점검기가 통째로
    // 무시당한다(board:check 의 「좌표 없는 항목」과 같은 판단).
    const r = evaluateSelfhostEnv({ MUST: "x", PAIR_A: "y", BRAND_NEW: "v" }, CONTRACT);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.key)).toContain("BRAND_NEW");
  });
});

describe("처분 선언 표 — 표 자체의 위생", () => {
  it("키가 중복되지 않는다", () => {
    const keys = SELFHOST_ENV_CONTRACT.map((e) => e.envName);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("모든 행에 사유가 있다", () => {
    // 사유 없는 처분은 분류가 아니라 침묵이다 — 특히 optional 이 그렇다.
    const blank = SELFHOST_ENV_CONTRACT.filter((e) => e.reason.trim().length === 0).map((e) => e.envName);
    expect(blank).toEqual([]);
  });

  it("대체 키는 표 안에 실재하고 자기 자신을 가리키지 않는다", () => {
    const declared = new Set(SELFHOST_ENV_CONTRACT.map((e) => e.envName));
    const broken: string[] = [];
    for (const e of SELFHOST_ENV_CONTRACT) {
      for (const alt of e.satisfiedBy ?? []) {
        if (alt === e.envName || !declared.has(alt)) broken.push(`${e.envName}→${alt}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("사고의 직접 원인이던 INGEST_TOKEN 이 required 로 선언돼 있다", () => {
    // 이 한 줄이 T-067 의 존재 이유다 — 없어지면 카카오 사고의 두 번째 원인이 다시
    // 무방비가 된다. ⛔ 완화는 오너 승인 사안.
    const entry = SELFHOST_ENV_CONTRACT.find((e) => e.envName === "INGEST_TOKEN");
    expect(entry?.disposition).toBe("required");
  });

  it("오너가 확정한 두 건의 처분이 유지된다", () => {
    // 2026-08-26 오너 확정: 인스타 토큰은 DB 가 정본이라 `.env` 공란이 **정상**이고
    // (코드 수정으로 꺼지는 기능이 없어졌으므로 degrades 가 아니라 optional 이다),
    // 유튜브 키는 비워 두고 **경고만** 낸다. ⛔ 어느 쪽도 required 로 올리지 말 것 —
    // 지금 둘 다 공란이라 그 순간 프로덕션 배포가 막힌다.
    const byKey = (k: string) => SELFHOST_ENV_CONTRACT.find((e) => e.envName === k)?.disposition;
    expect(byKey("INSTAGRAM_ACCESS_TOKEN")).toBe("optional");
    expect(byKey("YOUTUBE_API_KEY")).toBe("degrades");
  });
});

describe("`.env` 파서", () => {
  it("주석·빈 줄·export 접두·감싼 따옴표를 처리한다", () => {
    const parsed = parseEnvFile(
      ['# 주석', '', 'A=1', 'export B=2', 'C="3"', "D='4'", '  E = 5 ', 'not a pair'].join("\n"),
    );
    expect(parsed).toEqual({ A: "1", B: "2", C: "3", D: "4", E: "5" });
  });

  it("값이 빈 줄도 **키로는 인식**한다", () => {
    // 이 파서가 빈 값 줄을 흘리면 「없는 키」가 되어 미분류·required 판정이 전부 어긋난다.
    expect(parseEnvFile("EMPTY=\nSET=x")).toEqual({ EMPTY: "", SET: "x" });
  });

  it("값 안의 `=` 를 자르지 않는다", () => {
    // base64·URL 값에 `=` 가 흔하다. 첫 `=` 에서만 갈라야 한다.
    expect(parseEnvFile("K=a=b==")).toEqual({ K: "a=b==" });
  });
});

describe("배포 가드 배선 — `deploy.sh`", () => {
  const deploy = readFileSync(join(process.cwd(), "infra/selfhost/deploy.sh"), "utf8");

  /**
   * **실행되는 줄만** 센다 — 이 레포가 반복해 밟은 함정이다. 초판은 `indexOf` 로 훑었는데
   * 파일 머리말 주석의 `npm run build` 언급이 먼저 잡혀, 배선이 멀쩡한데도 "순서가
   * 뒤집혔다"는 거짓 실패가 났다(같은 부류: settlement-statement-surface-parity 의
   * 경고 주석이 자기 자신을 위반으로 잡은 건). 셸에서 `#` 로 시작하는 줄은 명령이 아니다.
   */
  const commandLine = (needle: string): number =>
    deploy
      .split("\n")
      .findIndex((line) => !line.trim().startsWith("#") && line.includes(needle));

  it("점검기를 부른다", () => {
    expect(commandLine("scripts/check-selfhost-env.ts")).toBeGreaterThan(-1);
  });

  it("빌드·재기동보다 **먼저** 부른다", () => {
    // 순서가 뒤집히면 공란인 채로 빌드가 돌고 서비스가 재기동된 뒤에야 걸린다 —
    // 가드가 막으려던 상태를 이미 만든 뒤다. 존재만 세면 이 뒤집힘을 못 잡는다
    // (같은 함정을 instagram-graph-token-applied 계약이 교차 검증에서 먼저 밟았다).
    const guard = commandLine("scripts/check-selfhost-env.ts");
    const build = commandLine("npm run build");
    const restart = commandLine("launchctl kickstart");
    expect(build).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(build);
    expect(guard).toBeLessThan(restart);
  });

  it("실패를 삼키지 않는다 — 점검기 실패가 exit 1 로 이어진다", () => {
    // `|| true` 로 감싸거나 경고만 찍고 진행하면 가드가 장식이 된다.
    const guard = commandLine("scripts/check-selfhost-env.ts");
    const after = deploy.split("\n").slice(guard, guard + 5).join("\n");
    expect(after).toContain("exit 1");
    expect(after).not.toContain("|| true");
  });

  it("스캐너가 주석에 속지 않는다(양성 프로브)", () => {
    // 이 파일 머리말(6행)이 실제로 `npm run build` 를 언급한다 — 주석을 세면 그 줄이
    // 잡혀 가드보다 앞선 것처럼 보인다. 그 오독이 초판의 거짓 실패였다.
    const firstMention = deploy.indexOf("npm run build");
    const firstCommand = deploy.split("\n").slice(0, commandLine("npm run build")).join("\n").length;
    expect(firstMention).toBeLessThan(firstCommand);
  });
});
