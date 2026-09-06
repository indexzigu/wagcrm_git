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
 *   2. 픽스처가 쓰는 **이름이 하나라도 이미 있으면 실행하지 않는다**(롤·테이블·스키마 전부).
 *      그리고 정리는 **이번 실행이 실제로 만든 것만** 지운다.
 *      🪤 이 두 줄은 실사고에서 나왔다. 초판은 롤 이름만 확인하고 정리는 목록을 통째로
 *      `DROP ... CASCADE` 했는데, 대상 DB 에 이미 `Seller` 가 있으면 `CREATE TABLE` 이 실패한
 *      뒤 정리가 돌아 **남의 테이블을 데이터째 삭제했다**(실측: 미리 넣어 둔 1행이 사라졌다).
 *      "일회용 DB 를 가리켰다"는 전제만으로는 부족하다 — 그 DB 에도 남의 것이 있을 수 있다.
 * 변이는 전부 롤백되는 트랜잭션 안에서 일어나므로 대상 DB 에 남는 것이 없다.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposablePostgresUrl } from "@/lib/agent-worker/__tests__/support/disposable-postgres";
import { runDbExposureAudit } from "@/lib/db-exposure-audit";

const adminUrl = process.env.DB_EXPOSURE_AUDIT_TEST_ADMIN_URL ?? "";
const enabled = adminUrl.length > 0;

/** 픽스처가 점유하는 이름. 하나라도 이미 있으면 실행하지 않는다(남의 것을 지우지 않기 위해). */
const FIXTURE_ROLES = ["wag_readonly", "wag_readonly_probe_peer"] as const;
const FIXTURE_TABLES = [
  "Seller",
  "ActionProposal",
  "SystemSettings",
  "AgentJob",
  "AgentJobEvent",
  "Untouched",
] as const;
const FIXTURE_SCHEMAS = ["wag_probe_schema"] as const;
/** 변이가 만드는 함수. 롤백되므로 남지 않지만, 미리 있으면 변이가 원인 불명으로 실패한다. */
const FIXTURE_FUNCTIONS = ["probe_fn"] as const;

/**
 * 허용 형태 그대로. **계정 생성 SQL 이 실제로 하는 구문 종류를 빠짐없이 재현한다** —
 * 세션 가드레일(`ALTER ROLE ... SET`), 스키마 USAGE, 컬럼 단위 SELECT, RLS 활성화,
 * 그리고 이 롤을 대상으로 하는 SELECT 정책까지. 음성 대조군이 "배포 직후 상태"를
 * 대표하지 못하면 **계정을 만들자마자 감사가 빨강이 되는 것**을 여기서 못 잡는다.
 */
const FIXTURE_GRANTS: string[] = [
  `ALTER ROLE wag_readonly SET statement_timeout = '15s'`,
  `ALTER ROLE wag_readonly SET default_transaction_read_only = on`,
  `ALTER ROLE wag_readonly SET idle_in_transaction_session_timeout = '30s'`,
  `GRANT USAGE ON SCHEMA public TO wag_readonly`,
  `GRANT SELECT ("id", "realName") ON public."Seller" TO wag_readonly`,
  `GRANT SELECT ("id", "promptTokens") ON public."ActionProposal" TO wag_readonly`,
  `GRANT SELECT ("id", "instagramTokenExpiresAt") ON public."SystemSettings" TO wag_readonly`,
  // 프로덕션은 model 테이블 전부에 RLS 가 켜져 있다. 일부만 켜면 `rls_disabled` 점검이
  // 픽스처 때문에 울려서, 아래 "점검 7종 전부 0건" 대조군을 세울 수 없다.
  ...FIXTURE_TABLES.map((table) => `ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`),
  `CREATE POLICY wag_readonly_select_seller ON public."Seller" FOR SELECT TO wag_readonly USING (true)`,
];

const TABLE_COLUMNS: Record<(typeof FIXTURE_TABLES)[number], string> = {
  Seller: `id text, "realName" text, "portalToken" text, "portalPasswordHash" text, "residentNumber" text`,
  ActionProposal: `id text, "promptTokens" int`,
  SystemSettings: `id text, "instagramAccessToken" text, "instagramTokenExpiresAt" timestamptz`,
  AgentJob: `id text, payload text`,
  AgentJobEvent: `id text, note text`,
  // 그랜트가 한 번도 없어 relacl 이 NULL 인 테이블 — 소유권 이전 분기의 대상이다.
  Untouched: `id text, "residentNumber" text`,
};

/**
 * 각 분기를 정확히 하나씩 깨뜨리는 변이. `expected` 는 그 분기가 붙이는 접두사다 —
 * 접두사가 없으면 라벨 하나에 뭉친 위반의 원인을 레이더에서 가를 수 없다.
 */
const MUTATIONS: { label: string; sql: string[]; expected: string }[] = [
  { label: "롤 속성 상승", sql: [`ALTER ROLE wag_readonly BYPASSRLS`], expected: "role-attribute:rolbypassrls" },
  { label: "롤 멤버십", sql: [`GRANT wag_readonly_probe_peer TO wag_readonly`], expected: "role-membership:wag_readonly_probe_peer" },
  // ACL 을 아예 안 거치는 세 경로. relacl 이 NULL 이라 관계 권한 분기는 침묵한다.
  { label: "테이블 소유권(relacl NULL)", sql: [`ALTER TABLE public."Untouched" OWNER TO wag_readonly`], expected: "relation-owner:Untouched" },
  { label: "스키마 소유권", sql: [`ALTER SCHEMA wag_probe_schema OWNER TO wag_readonly`], expected: "namespace-owner:wag_probe_schema" },
  { label: "함수 소유권", sql: [`CREATE FUNCTION public.probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`, `ALTER FUNCTION public.probe_fn() OWNER TO wag_readonly`], expected: "function-owner:probe_fn" },
  { label: "비밀값 이름(패턴 경로)", sql: [`GRANT SELECT ("portalPasswordHash") ON public."Seller" TO wag_readonly`], expected: "secret-column:Seller.portalPasswordHash" },
  // 패턴에서 token 을 뺐으므로 이 건은 명시 목록만이 잡는다 — 목록이 사라지면 여기가 깨진다.
  { label: "패턴이 못 보는 금지 컬럼(목록 경로)", sql: [`GRANT SELECT ("portalToken") ON public."Seller" TO wag_readonly`], expected: "secret-column:Seller.portalToken" },
  { label: "기본권한(스키마 지정)", sql: [`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO wag_readonly`], expected: "default-privilege:public/r:SELECT" },
  // IN SCHEMA 를 생략하면 defaclnamespace = 0 이다. 가장 넓게 여는 형태가 스키마 필터에
  // 걸려 사라지던 경로라 별도 변이로 둔다.
  { label: "기본권한(스키마 생략)", sql: [`ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO wag_readonly`], expected: "default-privilege:*/r:SELECT" },
  { label: "함수 EXECUTE", sql: [`CREATE FUNCTION public.probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`, `GRANT EXECUTE ON FUNCTION public.probe_fn() TO wag_readonly`], expected: "function-grant:probe_fn:EXECUTE" },
  { label: "금지 테이블 관계 권한", sql: [`GRANT SELECT ON public."AgentJob" TO wag_readonly`], expected: "forbidden-table:AgentJob:SELECT" },
  { label: "금지 테이블 컬럼 권한", sql: [`GRANT SELECT ("note") ON public."AgentJobEvent" TO wag_readonly`], expected: "forbidden-column:AgentJobEvent.note:SELECT" },
  { label: "관계 단위 권한", sql: [`GRANT SELECT ON public."Seller" TO wag_readonly`], expected: "relation:Seller:SELECT" },
  { label: "public 밖 스키마 USAGE", sql: [`GRANT USAGE ON SCHEMA wag_probe_schema TO wag_readonly`], expected: "schema-privilege:wag_probe_schema:USAGE" },
  { label: "public 스키마 USAGE 초과", sql: [`GRANT CREATE ON SCHEMA public TO wag_readonly`], expected: "schema-privilege:public:CREATE" },
  { label: "컬럼 단위 비-SELECT", sql: [`GRANT UPDATE ("realName") ON public."Seller" TO wag_readonly`], expected: "column-privilege:Seller.realName:UPDATE" },
];

describe.skipIf(!enabled)("wag_readonly 범위 점검 SQL (일회용 PostgreSQL)", () => {
  let admin: PrismaClient | undefined;
  let scopeSql = "";
  let shippedQueries: string[] = [];
  let checkQueries: string[] = [];
  /** 이번 실행이 **실제로 만든** 것만 담는다. 정리는 오직 여기 있는 것만 지운다. */
  const cleanup: string[] = [];

  beforeAll(async () => {
    await assertDisposablePostgresUrl(adminUrl);
    admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });

    const clashes = await findNameClashes(admin);
    if (clashes.length > 0) {
      throw new Error(
        `대상 DB 에 픽스처와 같은 이름이 이미 있다: ${clashes.join(", ")}. ` +
          "이 테스트는 남의 객체를 넘겨받아 고치거나 지우지 않는다.",
      );
    }

    // 만들자마자 되돌릴 문장을 쌓는다(역순). 중간에 실패해도 여기까지 만든 것은 정리된다.
    // ⚠️ **스키마를 맨 먼저 만든다.** 같은 DB 를 두 실행이 동시에 겨누면 위 이름 검사와
    // 생성 사이에 틈이 있는데(TOCTOU), 스키마 생성이 먼저면 진 쪽이 여기서 즉시 죽고 그
    // 시점의 cleanup 은 비어 있어 이긴 쪽 객체를 건드리지 않는다. 순서를 바꾸면 그 보호가
    // 조용히 사라진다.
    for (const schema of FIXTURE_SCHEMAS) {
      await admin.$executeRawUnsafe(`CREATE SCHEMA ${schema}`);
      cleanup.unshift(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
    for (const table of FIXTURE_TABLES) {
      await admin.$executeRawUnsafe(`CREATE TABLE public."${table}" (${TABLE_COLUMNS[table]})`);
      cleanup.unshift(`DROP TABLE IF EXISTS public."${table}" CASCADE`);
    }
    for (const role of FIXTURE_ROLES) {
      const attributes = role === "wag_readonly" ? "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT" : "";
      await admin.$executeRawUnsafe(`CREATE ROLE ${role} ${attributes}`.trim());
      // 롤에 달린 권한·소유물을 먼저 떼야 DROP ROLE 이 거부되지 않는다.
      cleanup.unshift(`DROP ROLE ${role}`);
      cleanup.unshift(`DROP OWNED BY ${role}`);
    }
    for (const grant of FIXTURE_GRANTS) await admin.$executeRawUnsafe(grant);

    shippedQueries = await captureShippedQueries();
    scopeSql = shippedQueries.find((query) => query.includes("role-membership:")) ?? "";
    if (!scopeSql) throw new Error("wag_readonly_scope 점검 SQL 을 출고본에서 못 찾았다.");
    // 앞 두 개는 롤 존재·테이블 수 질의다. 나머지가 점검 본체다.
    checkQueries = shippedQueries.slice(2);
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    const failures: string[] = [];
    for (const statement of cleanup) {
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
  }, 60_000);

  /** 롤백되는 트랜잭션 안에서 변이를 적용하고 점검 결과를 읽는다 — DB 에 남는 것이 없다. */
  async function violationsAfter(mutations: string[]): Promise<string[]> {
    const rollback = new Error("rollback");
    let rows: { name: string }[] = [];
    try {
      await admin!.$transaction(
        async (tx) => {
          for (const statement of mutations) await tx.$executeRawUnsafe(statement);
          rows = (await tx.$queryRawUnsafe(scopeSql)) as { name: string }[];
          throw rollback;
        },
        { timeout: 30_000 },
      );
    } catch (caught) {
      if (caught !== rollback) throw caught;
    }
    return rows.map((row) => row.name);
  }

  it("배포 직후 형태에서는 점검 전체가 0건이다 (음성 대조군)", async () => {
    // 여기서 무엇이든 나오면 상시 오탐이고, 상시 빨강인 감사기는 곧 안 보게 된다.
    // ⚠️ `wag_readonly_scope` 하나만 보면 안 된다. PUBLIC 의사롤 점검 2종은 이 브랜치에서
    // `scope: "always"` 가 되어 wag 롤만 있는 DB 에서도 돌기 시작했는데, 그 둘이 배포 직후
    // 형태를 통과하는지는 아무도 확인한 적이 없었다.
    const violations: string[] = [];
    for (const query of checkQueries) {
      const rows = (await admin!.$queryRawUnsafe(query)) as { name: string }[];
      violations.push(...rows.map((row) => row.name));
    }
    expect(violations).toEqual([]);
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

  it("롤 존재 질의가 코드가 읽는 컬럼 이름 그대로 돌려준다", async () => {
    // 🪤 별칭 하나만 어긋나도(예: `AS "publicRoles"` 로 대소문자가 보존되면) 코드는 두 축을
    // 다 "롤 없음"으로 읽어 **모든 환경에서 감사가 조용히 통과한다.** 목킹 테스트는 목이
    // TS 타입과 같은 키를 손으로 적으므로 이 어긋남을 영원히 못 본다 — 실 DB 가 돌려주는
    // 키 이름을 여기서 직접 본다.
    const rows = (await admin!.$queryRawUnsafe(shippedQueries[0])) as Record<string, unknown>[];
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["publicroles", "wagrole"]);
    // 픽스처는 wag_readonly 만 만든다. 이름뿐 아니라 값의 의미도 함께 고정한다.
    expect(Number(rows[0].wagrole)).toBe(1);
    expect(Number(rows[0].publicroles)).toBe(0);
  });

  it("출고되는 질의가 전부 실 PostgreSQL 에서 실행된다", async () => {
    // 이 레인을 만든 계기인 42725 는 `wag_readonly_scope` 가 아니라 `default_privileges`
    // 에서 났다. 한 항목만 태우면 나머지 6종은 여전히 목킹만 거친 채 나간다.
    expect(shippedQueries.length).toBeGreaterThanOrEqual(9);
    for (const query of shippedQueries) {
      await expect(admin!.$queryRawUnsafe(query)).resolves.toBeDefined();
    }
  }, 60_000);
});

/** 픽스처 이름과 충돌하는 기존 객체를 모은다. 하나라도 있으면 이 테스트는 돌지 않는다. */
async function findNameClashes(admin: PrismaClient): Promise<string[]> {
  const list = (names: readonly string[]): string => names.map((name) => `'${name}'`).join(", ");
  const rows = (await admin.$queryRawUnsafe(
    `SELECT ('role ' || rolname) AS name FROM pg_roles WHERE rolname IN (${list(FIXTURE_ROLES)})
     UNION ALL
     SELECT ('schema ' || nspname) FROM pg_namespace WHERE nspname IN (${list(FIXTURE_SCHEMAS)})
     UNION ALL
     SELECT ('table ' || c.relname) FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname IN (${list(FIXTURE_TABLES)})
     UNION ALL
     SELECT ('function ' || p.proname) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN (${list(FIXTURE_FUNCTIONS)})`,
  )) as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * 출고되는 점검 SQL 을 공개 API 로 뽑아낸다. 손으로 옮겨 적은 사본을 검사하면 출고본이
 * 깨져도 이 테스트가 초록이다 — 프로브는 진짜 스캐너를 타야 한다.
 */
async function captureShippedQueries(): Promise<string[]> {
  const seen: string[] = [];
  let call = 0;
  await runDbExposureAudit(
    {
      $queryRawUnsafe: async (query: string) => {
        seen.push(query);
        call += 1;
        // 첫 질의는 롤 존재, 둘째는 테이블 수다. 0 을 주면 감사가 조기 종료해 CHECKS 를 안 돈다.
        if (call === 1) return [{ publicroles: BigInt(2), wagrole: BigInt(1) }];
        return call === 2 ? [{ n: BigInt(2) }] : [];
      },
    },
    "postgresql://localhost:5432/app",
  );
  return seen;
}
