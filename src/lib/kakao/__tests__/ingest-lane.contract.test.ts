import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  INGEST_LANE_HEADER,
  assertServerLane,
  classifyIngestLane,
  ingestLaneEnvelope,
  ingestLaneGuard,
  isLoopbackTarget,
  normalizeLaneOrigin,
  resolveDeclaredLane,
  resolveIngestLane,
} from "../ingest-lane";

/**
 * 카카오 인제스트 **레인 정합** 계약 (실사고 2026-08-26).
 *
 * 컷오버 후 13일간 카톡 업무기록이 **은퇴한 구 배포 → 은퇴 DB** 로 쌓였다. 인증도 검증도
 * 멱등도 전부 통과했고, 러너는 `uploaded=N / ingest OK` + 종료코드 0 으로 끝났다.
 * **틀린 것은 요청이 아니라 상대였고**, 그것을 묻는 장치가 어디에도 없었다.
 *
 * 이 파일이 고정하는 것은 다섯 겹이다:
 *
 * - **C1** 서버 게이트의 행위 — 선언이 어긋나면 409, 그 외는 통과, 응답엔 항상 신원이 실린다
 * - **C2** 인제스트 계열 라우트가 **전부** 게이트를 부르는가(소스 전수 스캔 — 미래의 새 라우트까지)
 * - **C3** 성공 응답에 신원 봉투가 실리는가(스캔) — 안 실리면 러너 단언이 원리적으로 무력해진다
 * - **C4** 러너 단언 — **`lane` 필드의 부재가 곧 낡은 배포의 지문**이다(이 사고를 잡는 유일한 겹)
 * - **C5** 오리진 정규화를 양쪽이 공유하는가(각자 자르면 정상 레인이 mismatch 로 뜬다)
 *
 * 🪤 **양성 대조군을 먼저 둔다.** 소스 스캔은 경로가 틀리거나 스캔 결과가 0건이면
 * "위반 없음"으로 **공허 통과**한다 — 이 레포가 반복해서 밟은 함정이라 각 스캔 앞에
 * 하한 개수·앵커 존재를 먼저 단언한다.
 */

const ROOT = process.cwd();
const API_DIR = join(ROOT, "src", "app", "api");
const LANE_SSOT = join("src", "lib", "kakao", "ingest-lane.ts");

const read = (p: string) => readFileSync(p, "utf-8");

function walkRouteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkRouteFiles(full, acc);
    else if (entry === "route.ts" || entry === "route.tsx") acc.push(full);
  }
  return acc;
}

/**
 * 주석을 걷어낸 소스. 🪤 이 레포에서 두 번 재발한 함정이다 — 금지·필수 문자열을 **설명하는
 * 주석**이 스캔에 걸려 자기 자신을 위반(또는 준수)으로 판정한다. 이 파일의 SSOT 헤더 주석에도
 * `verifyIngestAuth`·`ingestLaneGuard` 가 등장하므로 반드시 걷어내고 센다.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function laneRequest(declared?: string): Request {
  return new Request("https://example.test/api/work-records/ingest", {
    headers: declared ? { [INGEST_LANE_HEADER]: declared } : {},
  });
}

const PROD_LANE = "https://crm.ygrd.kr";
const RETIRED_LANE = "https://wag-crm.vercel.app";

let savedAppUrl: string | undefined;

beforeEach(() => {
  savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;
});

afterEach(() => {
  if (savedAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
  vi.restoreAllMocks();
});

describe("C1 서버 게이트 — 선언된 레인이 이 배포가 아니면 아무것도 쓰지 않는다", () => {
  it("선언이 어긋나면 409 이고 양쪽 오리진을 함께 싣는다", async () => {
    process.env.NEXT_PUBLIC_APP_URL = PROD_LANE;

    const { rejection } = ingestLaneGuard(laneRequest(RETIRED_LANE));

    expect(rejection).not.toBeNull();
    expect(rejection!.status).toBe(409);

    const body = await rejection!.json();
    // 한쪽만 실으면 러너 로그에서 "무엇을 무엇으로 착각했는가"를 재구성할 수 없다.
    expect(body.declaredLane).toBe(RETIRED_LANE);
    expect(body.lane).toBe(PROD_LANE);
  });

  it("선언이 일치하면 통과하고 신원을 응답에 싣는다", () => {
    process.env.NEXT_PUBLIC_APP_URL = PROD_LANE;

    const { rejection, envelope } = ingestLaneGuard(laneRequest(PROD_LANE));

    expect(rejection).toBeNull();
    expect(envelope).toEqual({ lane: PROD_LANE });
  });

  it("선언이 없으면(레거시·수동 호출자) 통과한다 — 이 게이트는 인증이 아니다", () => {
    process.env.NEXT_PUBLIC_APP_URL = PROD_LANE;

    expect(ingestLaneGuard(laneRequest()).rejection).toBeNull();
  });

  it("⛔ 서버는 자기 레인을 몰라도 거부하지 않는다 — 대신 모른다고 밝힌다", () => {
    // fail-closed 로 뒤집지 말 것: `NEXT_PUBLIC_APP_URL` 한 줄이 비는 순간 프로덕션 수집이
    // 통째로 막힌다. 같은 날 `INGEST_TOKEN` 공란으로 이미 그 사고를 겪었다.
    delete process.env.NEXT_PUBLIC_APP_URL;

    const { rejection, envelope } = ingestLaneGuard(laneRequest(RETIRED_LANE));

    expect(rejection).toBeNull();
    expect(envelope).toEqual({ lane: null, laneUnknown: true });
  });

  it("서버가 모를 때도 `lane` 키 자체는 실린다 — 키의 부재가 낡은 배포의 지문이기 때문", () => {
    // 키를 빼면 러너가 "구 배포"와 "설정 누락"을 구분할 수 없어 C4 판정이 통째로 무너진다.
    expect("lane" in ingestLaneEnvelope(null)).toBe(true);
    expect("lane" in ingestLaneEnvelope(PROD_LANE)).toBe(true);
  });

  it("⛔ 요청 Host 로 판정하지 않는다 — 그러면 구 배포도 항상 통과한다", () => {
    // 서버 신원의 출처는 요청과 **무관해야** 대조가 성립한다. 이 단언은 그 불변식을
    // 행위로 고정한다: 같은 Host 로 들어와도 env 가 다르면 결과가 갈린다.
    process.env.NEXT_PUBLIC_APP_URL = RETIRED_LANE;
    expect(ingestLaneGuard(laneRequest(PROD_LANE)).rejection).not.toBeNull();

    process.env.NEXT_PUBLIC_APP_URL = PROD_LANE;
    expect(ingestLaneGuard(laneRequest(PROD_LANE)).rejection).toBeNull();
  });

  it("resolveIngestLane 은 NEXT_PUBLIC_APP_URL 을 오리진으로 정규화한다", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://CRM.ygrd.kr/some/path/";
    expect(resolveIngestLane()).toBe(PROD_LANE);
  });
});

describe("C2 소스 스캔 — 인제스트 계열 라우트는 전부 게이트를 부른다", () => {
  const routeFiles = walkRouteFiles(API_DIR);
  const ingestFamily = routeFiles.filter((f) =>
    /verifyIngestAuth\s*\(/.test(stripComments(read(f))),
  );

  it("양성 대조군 — 인제스트 계열 라우트가 실제로 발견된다", () => {
    // 스캔이 0건이면 아래 전수 단언이 공허 통과한다.
    expect(routeFiles.length).toBeGreaterThan(20);
    expect(ingestFamily.length).toBeGreaterThanOrEqual(4);
  });

  it("verifyIngestAuth 를 쓰는 모든 라우트가 ingestLaneGuard 도 호출한다", () => {
    const missing = ingestFamily
      .filter((f) => !/ingestLaneGuard\s*\(/.test(stripComments(read(f))))
      .map((f) => relative(ROOT, f));

    // 새 인제스트 라우트가 게이트를 빠뜨리면 여기서 실패한다 — 단위 테스트로는 **미래의
    // 새 호출부**를 막을 수 없기 때문에 전수 스캔이다.
    expect(missing).toEqual([]);
  });

  it("게이트는 SSOT 를 import 한다 — 라우트가 판정을 손으로 다시 쓰지 않는다", () => {
    const handRolled = ingestFamily
      .filter((f) => !/from\s+["']@\/lib\/kakao\/ingest-lane["']/.test(read(f)))
      .map((f) => relative(ROOT, f));

    // 같은 계약을 다시 구현하는 호출부는 반드시 갈라진다(이 레포의 반복 결함).
    expect(handRolled).toEqual([]);
  });

  it("게이트 호출이 인증 직후에 온다 — 조회·쓰기보다 먼저여야 한다", () => {
    for (const file of ingestFamily) {
      const src = stripComments(read(file));
      const authAt = src.indexOf("verifyIngestAuth");
      const guardAt = src.indexOf("ingestLaneGuard");
      // 리포지토리든 Prisma 직접 접근이든 "DB 를 만지기 시작하는 첫 지점"을 찾는다.
      const repoAt = src.search(/(?:[A-Za-z]+Repository\.|getPrisma\s*\()/);

      expect(authAt).toBeGreaterThanOrEqual(0);
      expect(guardAt).toBeGreaterThan(authAt);
      // 리포지토리 접근이 게이트보다 앞서면 "거부했는데 이미 썼다"가 된다.
      if (repoAt >= 0) expect(guardAt).toBeLessThan(repoAt);
    }
  });
});

describe("C3 소스 스캔 — 성공 응답에 신원 봉투가 실린다", () => {
  const ingestFamily = walkRouteFiles(API_DIR).filter((f) =>
    /verifyIngestAuth\s*\(/.test(stripComments(read(f))),
  );

  it("모든 인제스트 라우트의 성공 응답이 lane.envelope 를 펼친다", () => {
    const missing = ingestFamily
      .filter((f) => !/\.\.\.lane\.envelope/.test(stripComments(read(f))))
      .map((f) => relative(ROOT, f));

    // 봉투가 빠지면 러너의 C4 단언이 **정상 배포를 낡은 배포로 오판**해 수집이 멈춘다.
    expect(missing).toEqual([]);
  });
});

describe("C4 러너 단언 — 이 사고를 잡는 유일한 겹", () => {
  it("`lane` 필드가 없으면 던진다 (= 레인 게이트가 없는 낡은 배포)", () => {
    // 2026-08-26 실사고의 정확한 지문이다. 서버 쪽 검사는 그 배포에 존재하지 않으므로
    // 원리적으로 도달하지 못한다 — 그래서 판정이 클라이언트에 있다.
    expect(() => assertServerLane(PROD_LANE, {})).toThrow(/낡은 배포/);
  });

  it("`lane: null`(현행 코드인데 설정 누락)이어도 던진다 — 모르면 쓰지 않는다", () => {
    // 오너 확정 2026-08-26. ⛔ 경고 후 진행으로 완화하지 말 것.
    expect(() => assertServerLane(PROD_LANE, { lane: null, laneUnknown: true })).toThrow(
      /NEXT_PUBLIC_APP_URL/,
    );
  });

  it("상대가 다른 오리진을 밝히면 던진다", () => {
    expect(() => assertServerLane(PROD_LANE, { lane: RETIRED_LANE })).toThrow(/불일치/);
  });

  it("일치하면 통과한다", () => {
    expect(() => assertServerLane(PROD_LANE, { lane: PROD_LANE })).not.toThrow();
  });

  it("루프백 대상은 체계 밖이라 단언하지 않는다", () => {
    // dev 서버의 NEXT_PUBLIC_APP_URL 은 프로덕션 오리진을 가리키는 것이 정상이라,
    // 여기에 단언을 걸면 로컬 예행이 전부 실패한다.
    expect(resolveDeclaredLane("http://localhost:3002")).toBeNull();
    expect(resolveDeclaredLane("http://127.0.0.1:3000")).toBeNull();
    expect(() => assertServerLane(null, {})).not.toThrow();
  });

  it("원격 대상은 baseUrl 오리진을 그대로 선언한다", () => {
    expect(resolveDeclaredLane("https://crm.ygrd.kr/")).toBe(PROD_LANE);
    expect(resolveDeclaredLane(RETIRED_LANE)).toBe(RETIRED_LANE);
  });

  it("루프백 판정 — 음성 대조군(원격 호스트는 루프백이 아니다)", () => {
    expect(isLoopbackTarget("http://localhost:3000")).toBe(true);
    expect(isLoopbackTarget("http://app.localhost:3000")).toBe(true);
    expect(isLoopbackTarget("http://127.0.0.2:3000")).toBe(true);
    expect(isLoopbackTarget(PROD_LANE)).toBe(false);
    expect(isLoopbackTarget(RETIRED_LANE)).toBe(false);
  });
});

describe("C5 오리진 정규화 — 서버와 러너가 같은 함수를 쓴다", () => {
  it("후행 슬래시·경로·대소문자·기본 포트에서 갈리지 않는다", () => {
    // 각자 손으로 자르면 정상 레인이 mismatch 로 떠서 수집이 멈춘다.
    for (const variant of [
      "https://crm.ygrd.kr",
      "https://crm.ygrd.kr/",
      "https://CRM.YGRD.KR",
      "https://crm.ygrd.kr/portal?x=1",
      "  https://crm.ygrd.kr  ",
    ]) {
      expect(normalizeLaneOrigin(variant)).toBe(PROD_LANE);
    }
  });

  it("판정 불가는 빈 문자열이 아니라 null 이다", () => {
    // 빈 문자열로 접으면 "모름"과 "빈 레인"이 같아져 판정이 무너진다.
    for (const bad of [null, undefined, "", "   ", "not a url", "crm.ygrd.kr"]) {
      expect(normalizeLaneOrigin(bad)).toBeNull();
    }
  });

  it("classifyIngestLane 의 네 갈래가 서로 구분된다", () => {
    expect(classifyIngestLane(PROD_LANE, PROD_LANE)).toBe("match");
    expect(classifyIngestLane(RETIRED_LANE, PROD_LANE)).toBe("mismatch");
    expect(classifyIngestLane(PROD_LANE, null)).toBe("unknown-server");
    expect(classifyIngestLane(null, PROD_LANE)).toBe("undeclared");
  });

  it("SSOT 파일이 서버·러너 양쪽 진입점을 모두 export 한다", () => {
    // 러너 쪽 헬퍼를 scripts/ 로 복사해 나가면 두 정규화가 갈린다 — 같은 파일에 두는 것이 계약.
    const src = read(join(ROOT, LANE_SSOT));
    for (const symbol of ["ingestLaneGuard", "assertServerLane", "resolveDeclaredLane"]) {
      expect(src).toMatch(new RegExp(`export function ${symbol}\\b`));
    }
  });
});
