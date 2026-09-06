/**
 * `wag_readonly_scope` 점검 SQL 을 **실제 PostgreSQL 에서 실행**하는 옵트인 테스트.
 *
 * 왜 필요한가 — 옆의 `db-exposure-audit.contract.test.ts` 는 `$queryRawUnsafe` 를 목킹하므로
 * 쿼리 문자열이 문법·타입상 틀려도 전부 초록이다. 실제로 그랬다: `default_privileges` 쿼리가
 * `"char"` 를 캐스트 없이 이어 붙여 `42725` 로 **통째로 실패**하는 동안 단위 테스트는 49건
 * 전부 green 이었다. 이 감사기의 값은 "빨강을 띄우는가" 하나인데, 쿼리가 죽으면 빨강이
 * 영원히 안 뜬다.
 *
 * 그리고 **0건은 고장과 얼굴이 같다.** 그래서 여기서는 위반 없는 상태(음성 대조군)와
 * 분기별 변이(양성 대조군)를 함께 본다 — "늘 빈 배열을 주는 고장"이면 양성 대조군이 깨진다.
 *
 * 🪤 손으로 옮겨 적은 SQL 사본을 검사하면 출고본이 깨져도 초록이다. 그래서 쿼리는
 * `runDbExposureAudit` 의 공개 API 에 캡처용 클라이언트를 넣어 **출고되는 문자열 그대로**
 * 뽑아 쓴다.
 *
 * 옵트인: `DB_EXPOSURE_AUDIT_TEST_ADMIN_URL` 에 **일회용** 로컬 PostgreSQL 의 superuser URL 을
 * 넣는다(예: 임의 루프백 포트에 띄운 throw-away `postgres:17` 컨테이너).
 * 이 테스트가 아무 데서나 돌지 않게 두 겹으로 막는다:
 *   1. `assertDisposablePostgresUrl` 이 프로덕션 엔드포인트를 거부한다(레포 `.env` 를 읽어
 *      금지 host:port 를 알아내되 접속하지 않고 값을 출력하지도 않는다 — AGENTS.md P0).
 *   2. `wag_readonly` 가 **이미 있으면 실행하지 않는다.** 이 테스트는 자기가 만든 것만
 *      지운다 — 남의 계정을 넘겨받아 고치거나 지우지 않는다.
 * 변이는 전부 롤백되는 트랜잭션 안에서 일어나므로 대상 DB 에 남는 것이 없다.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposablePostgresUrl } from "@/lib/agent-worker/__tests__/support/disposable-postgres";
import { runDbExposureAudit } from "@/lib/db-exposure-audit";

const adminUrl = process.env.DB_EXPOSURE_AUDIT_TEST_ADMIN_URL ?? "";
const enabled = adminUrl.length > 0;

/** 허용 형태 그대로 — 스키마 USAGE + 컬럼 단위 SELECT 만. 여기서 위반이 나오면 오탐이다. */
const FIXTURE: string[] = [
  `CREATE ROLE wag_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
  `CREATE ROLE wag_readonly_probe_peer`,
  `CREATE TABLE public."Seller" (id text, "realName" text, "portalToken" text, "portalPasswordHash" text, "residentNumber" text)`,
  `CREATE TABLE public."ActionProposal" (id text, "promptTokens" int)`,
  `CREATE TABLE public."SystemSettings" (id text, "instagramAccessToken" text, "instagramTokenExpiresAt" timestamptz)`,
  `CREATE TABLE public."AgentJob" (id text, payload text)`,
  `CREATE TABLE public."AgentJobEvent" (id text, note text)`,
  // 그랜트가 한 번도 없어 relacl 이 NULL 인 테이블 — 소유권 이전 분기의 대상이다.
  `CREATE TABLE public."Untouched" (id text, "residentNumber" text)`,
  `GRANT USAGE ON SCHEMA public TO wag_readonly`,
  `GRANT SELECT ("id", "realName") ON public."Seller" TO wag_readonly`,
  `GRANT SELECT ("id", "promptTokens") ON public."ActionProposal" TO wag_readonly`,
  `GRANT SELECT ("id", "instagramTokenExpiresAt") ON public."SystemSettings" TO wag_readonly`,
];

/**
 * 각 분기를 정확히 하나씩 깨뜨리는 변이. `expected` 는 그 분기가 붙이는 접두사다 —
 * 접두사가 없으면 라벨 하나에 뭉친 위반의 원인을 레이더에서 가를 수 없다.
 */
const MUTATIONS: { label: string; sql: string[]; expected: string }[] = [
  { label: "관계 단위 권한", sql: [`GRANT SELECT ON public."Seller" TO wag_readonly`], expected: "relation:Seller:SELECT" },
  { label: "컬럼 단위 비-SELECT", sql: [`GRANT UPDATE ("realName") ON public."Seller" TO wag_readonly`], expected: "column-privilege:Seller.realName:UPDATE" },
  { label: "비밀값 이름(패턴 경로)", sql: [`GRANT SELECT ("portalPasswordHash") ON public."Seller" TO wag_readonly`], expected: "secret-column:Seller.portalPasswordHash" },
  // 패턴에서 token 을 뺐으므로 이 건은 명시 목록만이 잡는다 — 목록이 사라지면 여기가 깨진다.
  { label: "패턴이 못 보는 금지 컬럼(목록 경로)", sql: [`GRANT SELECT ("portalToken") ON public."Seller" TO wag_readonly`], expected: "secret-column:Seller.portalToken" },
  { label: "금지 테이블 관계 권한", sql: [`GRANT SELECT ON public."AgentJob" TO wag_readonly`], expected: "forbidden-table:AgentJob:SELECT" },
  { label: "금지 테이블 컬럼 권한", sql: [`GRANT SELECT ("note") ON public."AgentJobEvent" TO wag_readonly`], expected: "forbidden-table:AgentJobEvent.note:SELECT" },
  { label: "롤 속성 상승", sql: [`ALTER ROLE wag_readonly BYPASSRLS`], expected: "role-attribute:rolbypassrls" },
  { label: "롤 멤버십", sql: [`GRANT wag_readonly_probe_peer TO wag_readonly`], expected: "role-membership:wag_readonly_probe_peer" },
  // ACL 을 아예 안 거치는 경로. relacl 이 NULL 이라 관계 권한 분기는 침묵한다.
  { label: "소유권 이전(relacl NULL)", sql: [`ALTER TABLE public."Untouched" OWNER TO wag_readonly`], expected: "relation-owner:Untouched" },
  { label: "기본권한(미래 테이블)", sql: [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO wag_readonly`], expected: "default-privilege:r:SELECT" },
  { label: "함수 EXECUTE", sql: [`CREATE FUNCTION public.probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`, `GRANT EXECUTE ON FUNCTION public.probe_fn() TO wag_readonly`], expected: "function-grant:probe_fn:EXECUTE" },
  { label: "스키마 USAGE 초과", sql: [`GRANT CREATE ON SCHEMA public TO wag_readonly`], expected: "schema-privilege:public:CREATE" },
];

/** 픽스처가 만든 것 전부. 부분 실패한 실행도 여기까지 오면 흔적을 남기지 않는다. */
const CLEANUP: string[] = [
  `DROP FUNCTION IF EXISTS public.probe_fn()`,
  `DROP TABLE IF EXISTS public."Seller", public."ActionProposal", public."SystemSettings", public."AgentJob", public."AgentJobEvent", public."Untouched" CASCADE`,
  // 롤을 지우기 전에 그 롤에 달린 권한·소유물을 먼저 떼야 DROP ROLE 이 거부되지 않는다.
  `DROP OWNED BY wag_readonly`,
  `DROP OWNED BY wag_readonly_probe_peer`,
  `DROP ROLE IF EXISTS wag_readonly`,
  `DROP ROLE IF EXISTS wag_readonly_probe_peer`,
];

describe.skipIf(!enabled)("wag_readonly 범위 점검 SQL (일회용 PostgreSQL)", () => {
  let admin: PrismaClient | undefined;
  let checkSql = "";
  let created = false;

  beforeAll(async () => {
    await assertDisposablePostgresUrl(adminUrl);
    admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });

    const existing = (await admin.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'wag_readonly'`,
    )) as { n: number }[];
    if ((existing[0]?.n ?? 0) > 0) {
      throw new Error("wag_readonly 가 이미 있는 DB 다. 이 테스트는 남의 롤을 건드리지 않는다.");
    }
    // ⚠️ 정리 플래그를 픽스처 **앞에** 세운다. 뒤에 세웠더니 픽스처가 중간에 실패한
    // 실행이 정리를 통째로 건너뛰어, 만들다 만 롤·테이블이 그대로 남았다. 그 잔여물은
    // 다음 실행의 `CREATE TABLE` 을 깨뜨리고, 그 실행도 같은 이유로 정리를 안 해서
    // 잔여가 눈덩이가 된다(실측: 그 뒤 실행 3회가 전부 beforeAll 에서 죽었다).
    created = true;
    for (const statement of FIXTURE) await admin.$executeRawUnsafe(statement);

    checkSql = await captureShippedScopeSql();
  }, 60_000);

  afterAll(async () => {
    if (admin && created) {
      // 만든 것을 전부, 실패에 견디게 지운다. 하나가 죽어도 나머지는 계속 지우고,
      // 무엇이 남았는지는 끝에서 한 번에 알린다 — 조용히 남으면 다음 실행이 죽는다.
      const failures: string[] = [];
      for (const statement of CLEANUP) {
        try {
          await admin.$executeRawUnsafe(statement);
        } catch (caught) {
          failures.push(`${statement}: ${caught instanceof Error ? caught.message : String(caught)}`);
        }
      }
      await admin.$disconnect();
      if (failures.length > 0) {
        throw new Error(`정리 실패 — 대상 DB 에 잔여가 남았다:\n${failures.join("\n")}`);
      }
      return;
    }
    await admin?.$disconnect();
  }, 60_000);

  /** 롤백되는 트랜잭션 안에서 변이를 적용하고 점검 결과를 읽는다 — DB 에 남는 것이 없다. */
  async function violationsAfter(mutations: string[]): Promise<string[]> {
    const rollback = new Error("rollback");
    let rows: { name: string }[] = [];
    try {
      await admin!.$transaction(
        async (tx) => {
          for (const statement of mutations) await tx.$executeRawUnsafe(statement);
          rows = (await tx.$queryRawUnsafe(checkSql)) as { name: string }[];
          throw rollback;
        },
        { timeout: 30_000 },
      );
    } catch (caught) {
      if (caught !== rollback) throw caught;
    }
    return rows.map((row) => row.name);
  }

  it("허용 형태 그대로면 위반 0건이다 (음성 대조군)", async () => {
    // 여기서 무엇이든 나오면 상시 오탐이고, 상시 빨강인 감사기는 곧 안 보게 된다.
    expect(await violationsAfter([])).toEqual([]);
  });

  it.each(MUTATIONS)("$label 변이를 잡는다", async ({ sql, expected }) => {
    expect(await violationsAfter(sql)).toContain(expected);
  });

  it("오너가 허용으로 되살린 이름을 더 부여해도 조용하다 (오탐 대조군)", async () => {
    // token·key·email 을 패턴에 넣었다면 이 계열 21개가 매일 빨강이 됐을 자리다.
    expect(
      await violationsAfter([
        `GRANT SELECT ("promptTokens") ON public."ActionProposal" TO wag_readonly`,
        `GRANT SELECT ("instagramTokenExpiresAt") ON public."SystemSettings" TO wag_readonly`,
      ]),
    ).toEqual([]);
  });
});

/**
 * 출고되는 점검 SQL 을 공개 API 로 뽑아낸다. 손으로 옮겨 적은 사본을 검사하면 출고본이
 * 깨져도 이 테스트가 초록이다 — 프로브는 진짜 스캐너를 타야 한다.
 */
async function captureShippedScopeSql(): Promise<string> {
  const seen: string[] = [];
  let call = 0;
  await runDbExposureAudit(
    {
      $queryRawUnsafe: async (query: string) => {
        seen.push(query);
        call += 1;
        // 앞 두 번은 롤 수·테이블 수 질의다. 0 을 주면 감사가 조기 종료해 CHECKS 를 안 돈다.
        return call <= 2 ? [{ n: BigInt(2) }] : [];
      },
    },
    "postgresql://localhost:5432/app",
  );
  const sql = seen.find((query) => query.includes("role-membership:"));
  if (!sql) throw new Error("wag_readonly_scope 점검 SQL 을 출고본에서 못 찾았다.");
  return sql;
}
