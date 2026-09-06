// Supabase Data API 노출 감사 — public 스키마의 두 방어겹이 살아 있는지 주기 점검한다.
//
// 배경 — **레포 안의 가드로는 이 드리프트를 볼 수 없다.**
// `rls-coverage.contract.test.ts`(#193)는 마이그레이션 파일을 대조하므로 "우리가 켜기를
// 빠뜨렸나"는 잡지만, **DB 쪽에서 방어가 벗겨지는 것**은 레포에 흔적이 없어 못 잡는다.
// `20260716130000_revoke_public_grants_from_anon` 이 스스로 경고한 그대로다:
//   "Supabase 가 플랫폼 업그레이드 시 자체 마이그레이션으로 기본권한을 재부여할 수 있다
//    (무증상 되돌림)."
// 무증상이라는 게 핵심이다 — 되돌아가도 앱은 멀쩡히 동작한다(Prisma 는 postgres 롤이라
// 그랜트·RLS 양쪽과 무관하다). 그래서 **사람이 알아차릴 계기가 존재하지 않는다.**
//
// 두 겹의 역할(2026-07-31 실측 기준선):
//   ① GRANT 회수 — anon 의 /rest/v1/<table> 이 **401**(권한 없음)에서 끊긴다.
//   ② RLS       — ①이 벗겨져도 정책 0개라 행이 안 나간다(2026-07-15 사고 당시엔 이 겹만
//                 있었고, 그래서 RLS 를 한 번 잊은 테이블이 전량 노출됐다).
// 둘 중 하나만 남아도 즉시 유출은 아니지만, **한 겹으로 버티는 상태를 모르고 지내는 것**이
// 위험이다. 이 감사는 그 상태를 시스템 레이더에 빨강으로 띄운다.
//
// 세 번째 축(2026-09-06) — **명명 계정 `wag_readonly` 의 권한 범위.** 위 두 겹이 Supabase
// 공개 경로 롤(anon·authenticated)을 보는 것과 달리, 이쪽은 외부 봇이 쓰는 읽기 전용 로그인
// 계정이 "스키마 USAGE + 컬럼 단위 SELECT" 밖으로 벗어났는지를 본다. 실패 모드는 같다 —
// psql 한 줄로 벗겨지고, 앱은 멀쩡히 돌고, 레포에는 흔적이 없다.
import { isSqliteDatabaseUrl } from "./prisma-client";

/** 감사 대상 롤 — Supabase 가 만드는 공개 경로 롤. `service_role` 은 서버 전용이라 제외한다. */
const PUBLIC_ROLES = ["anon", "authenticated"] as const;

/** 이력(SystemTaskLog.details)이 비대해지지 않게 위반 객체명 나열 상한을 둔다. */
const MAX_OFFENDERS = 20;

export type ExposureFinding = {
  /** 기계 판독용 키. */
  check: string;
  /** 오너가 레이더에서 읽을 한글 설명. */
  label: string;
  /** 위반 객체 수(상한과 무관한 실제 개수). */
  count: number;
  /** 위반 객체명 일부(최대 MAX_OFFENDERS개). */
  offenders: string[];
};

export type ExposureAuditResult =
  | { status: "skipped"; reason: string }
  | { status: "broken"; reason: string }
  | { status: "ok"; publicTables: number }
  | { status: "drift"; publicTables: number; findings: ExposureFinding[]; summary: string };

/**
 * 최소한의 Prisma 의존 — 테스트에서 가짜 클라이언트를 넣을 수 있게 좁게 받는다.
 * 제네릭을 두지 않는 이유: 목 객체가 `Promise<unknown[]>` 를 돌려주면 제네릭 시그니처와
 * 어긋나 테스트 쪽이 컴파일되지 않는다. 반환 형은 아래 호출부에서 좁힌다.
 */
export type RawQueryClient = {
  $queryRawUnsafe(query: string): Promise<unknown>;
};

type NameRow = { name: string };
type CountRow = { n: bigint | number };
type RolePresenceRow = { publicroles: bigint | number; wagrole: bigint | number };

const rolesLiteral = PUBLIC_ROLES.map((r) => `'${r}'`).join(", ");

/**
 * Hermes wag-db 역할 봇이 WAG CRM DB 를 읽는 데 쓰는 읽기 전용 계정.
 * 안전이 **"컬럼 단위 SELECT 만 가진다"는 모양 하나**에 걸려 있는데, 그 모양은
 * psql 한 줄(`GRANT SELECT ON "Seller" TO wag_readonly`)로 벗겨지고 레포에는 흔적이
 * 남지 않는다 — 위 anon·authenticated 와 **똑같은 실패 모드**라 같은 레이더에 얹는다.
 * 계정이 아직 없는 DB 에서는 아래 5분기가 전부 0건이라 조용하다(거짓 경보 없음).
 */
const WAG_READONLY_ROLE = "wag_readonly";

/**
 * 이 롤에게 **어떤 권한도** 가면 안 되는 테이블 — 에이전트 작업 큐(역할 봇 자신의 지시·산출물).
 * 이름이 `FORBIDDEN` 인 이유: 감사 코드에서 `EXCLUDED` 는 "감사 대상에서 뺀다(=허용)"로
 * 읽히는데 의미가 정반대라, 다음 사람이 조건을 뒤집어 읽을 자리다.
 */
const WAG_READONLY_FORBIDDEN_TABLES = ["AgentJob", "AgentJobEvent"] as const;

/**
 * 이름이 비밀값을 가리키는 컬럼 패턴(Postgres `~*` — 대소문자 무시).
 *
 * ⚠️ `token`·`key`·`email` 을 **넣지 않는다.** 2026-09-06 오너 결정으로 그 이름을 가졌지만
 * 비밀값이 아닌 21개 컬럼(LLM 사용량 정수·식별자·타임스탬프·발주 라우팅용 업무 이메일)이
 * 허용으로 되살아났다 — 넣으면 **상시 오탐 21건**이 되어 감사기가 무시당한다.
 * 허용 916개 컬럼 전체에 대해 이 패턴을 돌려 오탐 0건을 확인했다(2026-09-06).
 */
export const SECRET_COLUMN_NAME_PATTERN =
  "(password|secret|residentnumber|accountnumber|bankaccount|businessnumber|ssn|phone|contactinfo|mailingaddress)";

/**
 * 설계상 SELECT 가 가면 안 되는 컬럼 16개(계정 생성 SQL 부록 B와 같은 목록).
 *
 * ⚠️ **짝맞춤이 기계로 강제되지 않는다.** 원본인 계정 생성 SQL 은 이 레포 밖에 있어
 * 계약 테스트가 볼 수 없다 — 아래 개수 단언은 이 사본의 자기 개수만 지킨다. 원본의 제외
 * 집합이 바뀌면 여기도 같이 고쳐야 하고, 안 고치면 감사가 조용히 좁아진다.
 *
 * 왜 패턴만으로 부족한가 — 위 패턴은 이 16개 중 **9개만** 잡는다. `token`·`email` 을 뺀
 * 대가로 `Seller.portalToken`·`SystemSettings.instagramAccessToken` 같은 **진짜 비밀값
 * 7개가 이름만으로는 보이지 않는다**(2026-09-06 실측). 패턴은 앞으로 생길 컬럼을 위한
 * 그물이고, 이 목록은 지금 아는 것을 정확히 못 박는 핀이다 — 둘을 OR 로 묶어야 의도한
 * 범위가 실제로 덮인다. 제외 집합이 바뀔 때만 같이 고치면 된다(스키마가 늘 때가 아니라).
 */
export const WAG_READONLY_FORBIDDEN_COLUMNS = [
  "Partner.bankAccount",
  "Partner.businessNumber",
  "Partner.representativeEmail",
  "Partner.contactInfo",
  "Seller.accountNumber",
  "Seller.residentNumber",
  "Seller.email",
  "Seller.phoneNumber",
  "Seller.portalToken",
  "Seller.portalPasswordHash",
  "Seller.mailingAddress",
  "PartnerContact.email",
  "PartnerContact.phoneNumber",
  "StorageIntegration.accountEmail",
  "StorageIntegration.encryptedRefreshToken",
  "SystemSettings.instagramAccessToken",
] as const;

const wagRoleLiteral = `'${WAG_READONLY_ROLE}'`;
const wagForbiddenTablesLiteral = WAG_READONLY_FORBIDDEN_TABLES.map((t) => `'${t}'`).join(", ");
const wagForbiddenColumnsLiteral = WAG_READONLY_FORBIDDEN_COLUMNS.map((c) => `'${c}'`).join(", ");

/**
 * 점검 쿼리 7종. 전부 카탈로그 **읽기**다(`$queryRawUnsafe` — 파라미터 없음, 문자열 보간도
 * 상수뿐이라 주입면이 없다). 쓰기 경로를 타지 않으므로 `DB_READ_ONLY=1` 레인에서도 돈다.
 */
/**
 * 어느 축의 롤이 있을 때 이 점검을 도는가.
 * ⚠️ `always` 는 **PUBLIC 의사롤(grantee = 0)** 을 보는 점검을 위한 것이다. PUBLIC 부여는
 * 이름 있는 롤과 무관하게 **로그인하는 모두**에게 적용되므로 어느 축이든 하나라도 있으면
 * 봐야 한다. 실측: anon·authenticated 가 없는 DB 에서 `GRANT SELECT (residentNumber) ...
 * TO PUBLIC` 한 줄을 치면 `has_column_privilege('wag_readonly', ...)` 가 참인데
 * (= 실제로 읽힌다) 이 점검들이 꺼져 있으면 감사는 `ok` 를 찍는다.
 */
type CheckScope = "public" | "wag" | "always";

const CHECKS: { check: string; scope: CheckScope; label: string; sql: string }[] = [
  {
    check: "relation_grants",
    scope: "public",
    label: "public 테이블·뷰·시퀀스에 anon/authenticated GRANT 가 살아 있음",
    // relacl 이 NULL 이면 명시 그랜트가 없다는 뜻 = LATERAL 이 행을 만들지 않는다(정상).
    sql: `SELECT c.relname::text AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) a
          JOIN pg_roles r ON r.oid = a.grantee
          WHERE n.nspname = 'public' AND r.rolname IN (${rolesLiteral})
          GROUP BY 1 ORDER BY 1`,
  },
  {
    check: "function_grants",
    scope: "public",
    label: "public 함수에 anon/authenticated EXECUTE 가 살아 있음",
    sql: `SELECT p.proname::text AS name
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(p.proacl) a
          JOIN pg_roles r ON r.oid = a.grantee
          WHERE n.nspname = 'public' AND r.rolname IN (${rolesLiteral})
          GROUP BY 1 ORDER BY 1`,
  },
  {
    check: "default_privileges",
    scope: "public",
    label: "미래 객체 자동 부여가 되살아남 (pg_default_acl 에 public 항목 재등장)",
    // 이게 가장 위험한 항목이다 — 지금 객체는 깨끗해도 **다음 마이그레이션이 만드는 테이블부터**
    // 다시 anon 에 열린다. 회수 마이그레이션의 핵심이 정확히 이 항목이었다.
    // `defaclobjtype` 은 `"char"` 타입이라 캐스트 없이 `||` 로 이으면
    // `operator is not unique: text || "char"` (42725)로 쿼리가 통째로 실패한다.
    // 목킹된 단위 테스트는 이 오류를 볼 수 없어 실 DB 실행으로 잡았다.
    sql: `SELECT (n.nspname || '/' || d.defaclobjtype::text) AS name
          FROM pg_default_acl d
          JOIN pg_namespace n ON n.oid = d.defaclnamespace
          CROSS JOIN LATERAL aclexplode(d.defaclacl) a
          JOIN pg_roles r ON r.oid = a.grantee
          WHERE n.nspname = 'public' AND r.rolname IN (${rolesLiteral})
          GROUP BY 1 ORDER BY 1`,
  },
  {
    check: "public_pseudo_role_grants",
    scope: "always",
    label: "public 테이블이 PUBLIC 의사롤에 열려 있음 (= anon 포함 전원)",
    // ⚠️ 위의 GRANT 점검들은 `pg_roles` 를 조인하므로 **PUBLIC 을 절대 보지 못한다** —
    // aclexplode 가 PUBLIC 을 grantee=0(실재하지 않는 롤 OID)으로 돌려주기 때문이다.
    // `GRANT SELECT ON "Seller" TO PUBLIC` 한 줄이면 anon 도 읽는데 감사는 조용하다.
    // 교차검증(2026-07-31)에서 지적된 사각이라 별도 항목으로 닫는다.
    // 함수는 대상에서 뺀다 — Postgres 는 함수 EXECUTE 를 PUBLIC 에 **기본 부여**하므로
    // 넣으면 상시 오탐이 된다(테이블은 기본이 소유자 전용이라 부여가 곧 이상 신호다).
    sql: `SELECT c.relname::text AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(c.relacl) a
          WHERE n.nspname = 'public' AND a.grantee = 0
          GROUP BY 1 ORDER BY 1`,
  },
  {
    check: "column_grants",
    scope: "always",
    label: "public 테이블의 컬럼 단위 GRANT 가 anon/authenticated/PUBLIC 에 열려 있음",
    // 컬럼 단위 부여(`GRANT SELECT (email) ON "Seller" TO anon`)는 `pg_class.relacl` 이
    // 아니라 `pg_attribute.attacl` 에 저장돼, 위 관계 GRANT 점검이 통째로 놓친다.
    // 노출 폭은 좁지만 **정확히 민감한 컬럼만 골라 여는** 모양이라 위험도는 낮지 않다.
    sql: `SELECT (c.relname || '.' || att.attname) AS name
          FROM pg_attribute att
          JOIN pg_class c ON c.oid = att.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(att.attacl) a
          LEFT JOIN pg_roles r ON r.oid = a.grantee
          WHERE n.nspname = 'public'
            AND (r.rolname IN (${rolesLiteral}) OR a.grantee = 0)
          GROUP BY 1 ORDER BY 1`,
  },
  {
    check: "rls_disabled",
    scope: "public",
    label: "public 테이블에 RLS 가 꺼져 있음",
    sql: `SELECT c.relname::text AS name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
          ORDER BY 1`,
  },
  {
    check: "wag_readonly_scope",
    scope: "wag",
    label: "wag_readonly 가 정해진 범위(public 스키마 USAGE + 컬럼 단위 SELECT)를 넘어선 권한을 가짐",
    // ⚠️ **분기가 발주 제안서의 5종이 아니라 13개인 이유.** 5종만으로는 라벨이 약속한
    // "정해진 범위를 넘어선 권한"의 절반만 본다. 교차 검증이 같은 축을 짚었고 일회용
    // PostgreSQL 실측이 결론을 냈다 — **소유권 이전**은 `relacl` 이 NULL 인 테이블에서
    // `has_column_privilege` 가 참인데(= 실제로 읽힌다) 5종이 전부 0건이었다. ACL 에 이 롤이
    // grantee 로 등장하지 않는 경로(소유권·멤버십·기본권한)가 남아 있으면 이 감사는
    // "있다고 믿게 만드는" 쪽이 되므로, 범위 정의의 여집합을 그대로 열거해 닫는다.
    //
    // ⚠️ 이 항목은 `pg_roles` 를 조인하므로 **PUBLIC 의사롤(grantee = 0)을 보지 못한다** —
    // `GRANT SELECT ON "Seller" TO PUBLIC` 은 wag_readonly 도 읽게 만든다. 여기서 중복
    // 구현하지 않는 이유는 위 `public_pseudo_role_grants`(관계)와 `column_grants`(컬럼)가
    // 롤·컬럼명 무관하게 그 형태를 이미 전수로 잡기 때문이다. 그래서 그 두 항목만 `scope`
    // 가 `always` 다 — 공개 롤 축에 묶어 두면 wag_readonly 만 있는 DB 에서 함께 꺼지고,
    // 여기 적은 "저쪽이 덮는다"가 그 순간 거짓이 된다(실측으로 확인한 사각이다).
    //
    // ⚠️ `||` 에 붙는 카탈로그 컬럼은 전부 `::text` 로 캐스트한다. 위 `default_privileges`
    // 가 `"char"` 를 캐스트 없이 이어 붙여 42725 로 통째로 실패했던 것과 같은 함정이다.
    // ⚠️ 정렬은 **심각도 우선**이다. `offenders` 는 MAX_OFFENDERS 개에서 잘리는데, 이름순으로
    // 두면 `column-privilege:` 가 20건 넘게 나는 사고에서 정작 슈퍼유저 승격이 목록 밖으로
    // 밀려난다 — 원인을 가르라고 붙인 접두사가 무용해진다.
    sql: `WITH wag AS (
            SELECT oid FROM pg_roles WHERE rolname = ${wagRoleLiteral}
          ), relation_grant AS (
            SELECT c.relname::text AS relname, a.privilege_type AS priv
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN LATERAL aclexplode(c.relacl) a
            JOIN wag ON wag.oid = a.grantee
            WHERE n.nspname = 'public'
          ), column_grant AS (
            SELECT c.relname::text AS relname, att.attname::text AS attname, a.privilege_type AS priv
            FROM pg_attribute att
            JOIN pg_class c ON c.oid = att.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            CROSS JOIN LATERAL aclexplode(att.attacl) a
            JOIN wag ON wag.oid = a.grantee
            WHERE n.nspname = 'public'
          )
          SELECT name FROM (
            SELECT ('role-attribute:' || v.attr) AS name
            FROM pg_roles r
            CROSS JOIN LATERAL (VALUES
                ('rolsuper', r.rolsuper),
                ('rolcreatedb', r.rolcreatedb),
                ('rolcreaterole', r.rolcreaterole),
                ('rolbypassrls', r.rolbypassrls),
                ('rolreplication', r.rolreplication)
              ) AS v(attr, enabled)
            WHERE r.rolname = ${wagRoleLiteral} AND v.enabled
            UNION
            SELECT ('role-membership:' || g.rolname::text)
            FROM pg_auth_members m
            JOIN wag ON wag.oid = m.member
            JOIN pg_roles g ON g.oid = m.roleid
            UNION
            -- 소유자는 ACL 에 등장하지 않아도 전권을 갖는다. 테이블을 소유하면 제외 컬럼까지
            -- 읽고, 스키마를 소유하면 그 안에 객체를 만들고 지우며, 함수를 소유하면 정의를
            -- 바꿔 실행 경로를 쥔다. 셋 다 \`relacl\` 이 NULL 인 채로 성립한다.
            SELECT ('relation-owner:' || c.relname::text)
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            JOIN wag ON wag.oid = c.relowner
            WHERE n.nspname = 'public'
            UNION
            -- 스키마 소유만 전 스키마를 본다. 테이블·함수 소유는 public 으로 좁히는데,
            -- public 밖 객체는 그 스키마의 USAGE 가 없으면 실효 접근이 안 되고 그 USAGE 는
            -- schema-privilege 분기가 잡기 때문이다. 스키마 소유는 그 자체로 USAGE 를 준다.
            SELECT ('namespace-owner:' || n.nspname::text)
            FROM pg_namespace n JOIN wag ON wag.oid = n.nspowner
            UNION
            SELECT ('function-owner:' || p.proname::text)
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            JOIN wag ON wag.oid = p.proowner
            WHERE n.nspname = 'public'
            UNION
            SELECT ('secret-column:' || relname || '.' || attname)
            FROM column_grant
            WHERE attname ~* '${SECRET_COLUMN_NAME_PATTERN}'
               OR (relname || '.' || attname) IN (${wagForbiddenColumnsLiteral})
            UNION
            -- 스키마로 좁히지 않는다. \`ALTER DEFAULT PRIVILEGES GRANT ... TO wag_readonly\` 를
            -- \`IN SCHEMA\` 없이 치면 \`defaclnamespace = 0\` 이라 pg_namespace 조인이 그 행을
            -- 떨군다 . **가장 넓게 여는 형태가 필터에 걸려 사라지는** 셈이다.
            SELECT ('default-privilege:' || COALESCE(n.nspname::text, '*') || '/'
                    || d.defaclobjtype::text || ':' || a.privilege_type)
            FROM pg_default_acl d
            LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
            CROSS JOIN LATERAL aclexplode(d.defaclacl) a
            JOIN wag ON wag.oid = a.grantee
            UNION
            -- SECURITY DEFINER 함수 하나면 소유자 권한으로 무엇이든 읽을 수 있다.
            SELECT ('function-grant:' || p.proname::text || ':' || a.privilege_type)
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            CROSS JOIN LATERAL aclexplode(p.proacl) a
            JOIN wag ON wag.oid = a.grantee
            WHERE n.nspname = 'public'
            UNION
            SELECT ('forbidden-table:' || relname || ':' || priv)
            FROM relation_grant WHERE relname IN (${wagForbiddenTablesLiteral})
            UNION
            SELECT ('forbidden-column:' || relname || '.' || attname || ':' || priv)
            FROM column_grant WHERE relname IN (${wagForbiddenTablesLiteral})
            UNION
            SELECT ('relation:' || relname || ':' || priv)
            FROM relation_grant WHERE relname NOT IN (${wagForbiddenTablesLiteral})
            UNION
            -- 허용은 **public 스키마의 USAGE 하나뿐**이다. 다른 스키마의 USAGE 도 위반이다
            -- (\`GRANT USAGE ON SCHEMA auth\` 한 줄이면 인증 테이블이 사정권에 든다).
            SELECT ('schema-privilege:' || n.nspname::text || ':' || a.privilege_type)
            FROM pg_namespace n
            CROSS JOIN LATERAL aclexplode(n.nspacl) a
            JOIN wag ON wag.oid = a.grantee
            WHERE NOT (n.nspname = 'public' AND a.privilege_type = 'USAGE')
            UNION
            SELECT ('column-privilege:' || relname || '.' || attname || ':' || priv)
            FROM column_grant
            WHERE priv <> 'SELECT' AND relname NOT IN (${wagForbiddenTablesLiteral})
          ) q
          ORDER BY CASE
              WHEN name LIKE 'role-attribute:%' THEN 0
              WHEN name LIKE 'role-membership:%' THEN 1
              WHEN name LIKE 'namespace-owner:%' THEN 2
              WHEN name LIKE 'relation-owner:%' THEN 3
              WHEN name LIKE 'function-owner:%' THEN 4
              WHEN name LIKE 'secret-column:%' THEN 5
              WHEN name LIKE 'default-privilege:%' THEN 6
              WHEN name LIKE 'function-grant:%' THEN 7
              WHEN name LIKE 'forbidden-table:%' THEN 8
              WHEN name LIKE 'forbidden-column:%' THEN 9
              WHEN name LIKE 'relation:%' THEN 10
              WHEN name LIKE 'schema-privilege:%' THEN 11
              WHEN name LIKE 'column-privilege:%' THEN 12
              ELSE 13
            END, name`,
  },
];

/** public 스키마의 일반 테이블 수 — 아래 양성 대조군의 근거. */
const PUBLIC_TABLE_COUNT_SQL = `SELECT count(*)::bigint AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`;

/**
 * 두 감사 축의 롤이 각각 이 DB 에 실재하는가.
 *
 * ⚠️ 두 축을 **따로** 센다. 종전에는 anon·authenticated 가 없으면 감사 전체가 `skipped` 였는데,
 * 그러면 그 둘이 없고 `wag_readonly` 만 있는 Postgres 에서 **권한 상승이 통째로 무시된다** —
 * 이 파일이 내내 경계해 온 "조용히 초록"의 또 다른 얼굴이다. 축이 셋이 된 이상 존재 판정도
 * 축별로 해야 한다.
 */
const ROLE_PRESENCE_SQL = `SELECT
    count(*) FILTER (WHERE rolname IN (${rolesLiteral}))::bigint AS publicroles,
    count(*) FILTER (WHERE rolname = ${wagRoleLiteral})::bigint AS wagrole
  FROM pg_roles`;

function toNumber(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * 위반 목록 → 최종 판정. 순수 함수라 계약 테스트가 DB 없이 고정한다.
 *
 * ⚠️ `publicTables === 0` 을 "깨끗함"으로 읽지 않는다 — 그건 **하네스가 고장난 것**이다
 * (권한 부족으로 카탈로그가 안 보이거나, 엉뚱한 DB 를 보고 있거나). 위반 0건과 구분하지
 * 않으면 감사기가 조용히 죽은 채로 매일 초록을 찍는다. `capture-stories` 가 11일간
 * SUCCESS 로 무음 실패했던 것과 같은 실패 모드다.
 */
export function evaluateExposureAudit(
  publicTables: number,
  findings: ExposureFinding[],
): ExposureAuditResult {
  if (publicTables === 0) {
    return {
      status: "broken",
      reason:
        "public 스키마에서 테이블을 하나도 못 봤다. 위반 0건이 아니라 감사기가 대상을 못 보는 상태다(권한·연결 대상 확인 필요).",
    };
  }
  const hit = findings.filter((f) => f.count > 0);
  if (hit.length === 0) return { status: "ok", publicTables };
  return {
    status: "drift",
    publicTables,
    findings: hit,
    summary: hit.map((f) => `${f.label} (${f.count}건)`).join(" · "),
  };
}

/**
 * 실제 감사 실행. sqlite 레인(dev:local·데모)에서는 카탈로그가 없으므로 조용히 건너뛴다 —
 * 이 불변식은 프로덕션 Postgres 에만 존재하는 것이라 sqlite 에서 실패로 찍으면 거짓 경보다.
 */
export async function runDbExposureAudit(
  client: RawQueryClient,
  databaseUrl = process.env.DATABASE_URL,
): Promise<ExposureAuditResult> {
  if (isSqliteDatabaseUrl(databaseUrl)) {
    return { status: "skipped", reason: "sqlite 레인: public 스키마 노출 개념이 없다." };
  }

  const roleRows = (await client.$queryRawUnsafe(ROLE_PRESENCE_SQL)) as RolePresenceRow[];
  const presence = roleRows[0];
  if (presence?.publicroles === undefined || presence?.wagrole === undefined) {
    // ⚠️ 여기서 `?? 0` 으로 넘어가면 **모든 환경에서 감사가 skip 으로 조용히 통과한다.**
    // 위 질의의 별칭 하나만 어긋나도(예: 인용부호를 붙여 대소문자가 보존되면) 두 축이 다
    // "롤 없음"으로 읽히는데, 그 고장은 위반 0건과 결과가 똑같이 생겼다. 이 파일이 내내
    // 경계해 온 실패 형태라, 기본값으로 덮지 않고 빨강으로 띄운다.
    return {
      status: "broken",
      reason:
        "롤 존재 질의가 예상한 컬럼(publicroles·wagrole)을 돌려주지 않았다. 위반 0건이 아니라 감사기가 판정 근거를 못 읽는 상태다.",
    };
  }
  const publicRolesPresent = toNumber(presence.publicroles) > 0;
  const wagRolePresent = toNumber(presence.wagrole) > 0;
  if (!publicRolesPresent && !wagRolePresent) {
    // shadow DB(순정 postgres)·로컬 Postgres 에는 이 롤들이 없다. 감사 대상이 아니라는
    // 뜻이므로 조용히 건너뛴다 — 회수 마이그레이션의 DO 블록과 같은 방어다.
    return {
      status: "skipped",
      reason: "anon·authenticated·wag_readonly 중 아무 롤도 없다. 감사 대상 DB 가 아니다.",
    };
  }
  const activeChecks = CHECKS.filter((c) => {
    if (c.scope === "always") return true;
    return c.scope === "wag" ? wagRolePresent : publicRolesPresent;
  });

  const tableRows = (await client.$queryRawUnsafe(PUBLIC_TABLE_COUNT_SQL)) as CountRow[];
  const publicTables = toNumber(tableRows[0]?.n ?? 0);

  const findings: ExposureFinding[] = [];
  for (const { check, label, sql } of activeChecks) {
    const rows = (await client.$queryRawUnsafe(sql)) as NameRow[];
    findings.push({
      check,
      label,
      count: rows.length,
      offenders: rows.slice(0, MAX_OFFENDERS).map((r) => r.name),
    });
  }

  return evaluateExposureAudit(publicTables, findings);
}
