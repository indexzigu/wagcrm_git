-- Revoke public-schema Data API grants from anon/authenticated (RLS 잠금의 구조적 마무리).
--
-- 배경 — 앞선 두 마이그레이션은 "이미 난 구멍"만 닫은 스냅샷이었다:
--  · 20260715120000_enable_rls_public_tables : 앱 테이블 57개 RLS
--  · 20260716000000_enable_rls_prisma_migrations : 잔여 1개 RLS
-- 구멍을 만들어내는 경로는 그대로 남아 있어서, 테이블을 추가할 때마다 같은 구멍이 다시 난다.
--
-- 구멍을 만드는 경로 (prod 실측):
--  1. Prisma 는 postgres 롤로 public 스키마에 테이블을 만든다(public 테이블 전부 소유자 postgres).
--  2. pg_default_acl 에 FOR ROLE postgres / IN SCHEMA public / TABLES 기본권한이 걸려 있어, 새 테이블은
--     생성 즉시 anon·authenticated 에 arwdDxtm(SELECT/INSERT/UPDATE/DELETE/TRUNCATE 등)이 자동 부여된다.
--  3. Postgres 는 RLS 를 끈 채로 테이블을 만든다 — "새 테이블 RLS 기본 켜기" 설정은 존재하지 않는다.
--  4. 이벤트 트리거 pgrst_ddl_watch 가 DDL 마다 PostgREST 스키마 캐시를 리로드해 즉시 노출한다.
--  => `prisma migrate` 로 테이블을 추가하면, 사람 손 하나 없이 공개 anon 키로 읽기·쓰기가 열린다.
--     _prisma_migrations 가 정확히 이 경로로 태어났다(앞 마이그레이션의 대상).
--
-- 위험의 성격 — 위험은 자동 상속되는데 방어는 수동이라는 비대칭:
--  현재 방어선은 RLS 한 겹뿐이다. 실측상 anon 의 /rest/v1/<table> 호출은 401 이 아니라 200 [] 을
--  반환한다 = 그랜트 검사는 통과했고 RLS 가 행을 걸러냈다는 뜻이다. RLS 켜기를 한 번 잊는 순간
--  그 테이블은 전량 노출된다. 그랜트를 회수하면 그 경우에도 401 로 막힌다.
--
-- 조치: 그랜트 자체를 회수한다. RLS 는 유지한다 — 이 마이그레이션은 RLS 의 대체가 아니라 덧겹이다.
--  · 기존 객체: REVOKE ALL
--  · 미래 객체: ALTER DEFAULT PRIVILEGES 로 자동 부여를 끈다 (이게 재발을 막는 핵심)
--
-- 앱 무영향 근거 (실측):
--  · public 테이블을 PostgREST(.from/.rpc)로 읽는 코드 0건 — anon·authenticated 그랜트는 아무도 안 쓴다.
--  · Prisma 는 postgres 롤(소유자·BYPASSRLS) → 그랜트·RLS 양쪽 모두 무관, migrate deploy 도 무관.
--  · Supabase Auth 는 auth 스키마, Storage 는 storage 스키마의 별도 서비스라 이 회수와 무관하다.
--  · service_role 은 회수 대상이 아니다 — 서버 전용 시크릿 키 경로(Storage·Auth admin)를 보존한다.
--  · public 스키마에는 테이블과 인덱스뿐이다(함수·뷰·시퀀스 0개, 확장은 extensions/vault 로 격리).
--    아래 SEQUENCES/FUNCTIONS 회수는 오늘 기준 no-op 이며, 미래 객체를 위한 선언이다.
--
-- 롤 존재 방어 (DO 블록인 이유):
--  anon·authenticated·postgres 는 Supabase 가 만든 롤이지 Postgres 기본값이 아니다. migration-guard 의
--  shadow DB 는 순정 postgres:16 에 POSTGRES_USER=prisma 라 이 셋이 전부 없다 — 이름을 그대로 참조하면
--  `role "anon" does not exist` 로 guard 가 깨진다(prod 에서는 통과하고 CI 에서만 터지는 종류다).
--  그래서 존재하는 롤에 대해서만 실행한다. 로컬·신규 환경에도 같은 이유로 안전하다. 멱등하다.
--
-- 주의: Supabase 가 플랫폼 업그레이드 시 자체 마이그레이션으로 기본권한을 재부여할 수 있다(무증상
-- 되돌림). 그래서 RLS 를 걷어내면 안 된다.

DO $$
DECLARE
  target_role text;
  has_postgres_role boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres');
BEGIN
  FOREACH target_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
      CONTINUE;
    END IF;

    -- 기존 객체의 그랜트 회수
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', target_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', target_role);

    -- 미래 객체에 대한 자동 부여 차단 (Prisma 가 테이블을 만드는 롤 = postgres 기준)
    IF has_postgres_role THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I', target_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', target_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', target_role);
    END IF;
  END LOOP;
END $$;
