/**
 * 읽기 전용 dev 레인(`DB_READ_ONLY=1`) — Prisma 경유 쓰기를 차단한다.
 *
 * 왜 있는가: 이 레포 `.env` 의 `DATABASE_URL` 은 프로덕션 Supabase 다(AGENTS.md P0).
 * 즉 `npm run dev` 로 띄운 로컬 서버에서 저장 버튼을 한 번 잘못 누르면 그대로
 * 프로덕션이 바뀐다. 화면 렌더 경로(page.tsx·layout.tsx)에는 Prisma 쓰기가 없으므로
 * "화면만 훑는" 점검은 원래 읽기뿐인데, 그 사실을 **강제하는 장치가 없어서** 지금까지
 * 100% 의 세션이 쓰기 가능 레인에 있었다.
 *
 * 무엇을 바꾸는가: `npm run dev` 는 그대로 두고(쓰기 기능 테스트에 필요하다)
 * `npm run dev:ro` 를 더한다. 바뀌는 것은 **어느 쪽이 기본 습관인가**뿐이다 —
 * 읽기 목적 작업은 안전한 레인에서 하고, 쓰기가 필요하면 의식적으로 레인을 바꾼다.
 * 이 레포가 `*_COLLECT_MODE`(`collect-mode.ts`)에서 이미 쓰는 "명시 opt-in" 패턴과
 * 같은 모양이다.
 *
 * ⚠️ 이것은 **오조작 방지선이지 권한 경계가 아니다.** 앱이 공유 Prisma 클라이언트를
 * 탈 때만 유효하므로, 자체 `new PrismaClient()` 를 만드는 스크립트나 psql 직접 접속은
 * 막지 못한다. 신뢰할 수 없는 코드까지 막아야 하면 Postgres 레벨 읽기 전용 role 이
 * 필요하다(그 경우 이 가드는 1차 방어선으로 남긴다).
 */

export const READ_ONLY_ENV_KEY = "DB_READ_ONLY";

/**
 * 읽기 전용 레인인가. **미설정은 "꺼짐"이다** — `collect-mode` 의 fail-closed 와
 * 방향이 반대인데, 여기서 fail-closed 로 가면 프로덕션 런타임과 모든 크론이
 * 쓰기를 잃는다. 위험의 비대칭이 반대라 기본값도 반대다.
 */
export function isReadOnlyMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[READ_ONLY_ENV_KEY] === "1";
}

/**
 * 읽기로 통과시킬 오퍼레이션 목록.
 *
 * **화이트리스트(읽기 허용)이지 블랙리스트(쓰기 차단)가 아니다** — Prisma 가 새 쓰기
 * 오퍼레이션을 추가하면(6.x 에서도 `createManyAndReturn`·`updateManyAndReturn` 이
 * 이렇게 늘었다) 블랙리스트는 **조용히 통과시킨다**. 모르는 오퍼레이션은 막고 여기에
 * 추가하는 쪽이, 모르는 쓰기가 프로덕션에 닿는 쪽보다 낫다.
 *
 * raw 의 판정 기준은 **이름이 아니라 이 레포에서의 용도**다:
 *  - `$queryRaw`  = 통과. 결과를 돌려받는 조회용이다. 원리상 raw 로 UPDATE 를 쓸 수도
 *    있지만 이 가드가 막으려는 것은 **오조작**이지 우회 의도가 아니다(위 ⚠️ 참조).
 *  - `$executeRaw` = 차단. 이 레포의 두 사용처(`campaignRounds`·`campaignGroupService`)는
 *    `pg_advisory_xact_lock` 이라 실제로는 쓰기가 아니지만, 둘 다 캠페인 생성 트랜잭션
 *    안에 있어 어차피 뒤따르는 write 에서 막힌다. 락 단계에서 먼저 막히는 편이
 *    "쓰기 트랜잭션에 들어가려 했다"는 사실을 더 이르게 드러낸다.
 */
const READ_OPERATIONS: ReadonlySet<string> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "aggregate",
  "count",
  "groupBy",
  "queryRaw",
  "queryRawUnsafe",
  // mongo 전용이지만 읽기라 함께 둔다(이 레포는 postgres/sqlite — 방어적 등재).
  "findRaw",
  "aggregateRaw",
]);

/**
 * Prisma 가 넘기는 오퍼레이션명은 모델 op(`findMany`)와 raw op(`$queryRaw`)의 접두사
 * 규약이 다르다. 판정 전에 `$` 를 떼어 한 형태로 맞춘다 — 그러지 않으면 화이트리스트에
 * 두 형태를 모두 적어야 하고, 한쪽을 빠뜨리면 조용히 차단되거나 조용히 통과한다.
 */
function normalizeOperation(operation: string): string {
  return operation.startsWith("$") ? operation.slice(1) : operation;
}

/** 이 오퍼레이션이 읽기인가. */
export function isReadOperation(operation: string): boolean {
  return READ_OPERATIONS.has(normalizeOperation(operation));
}

/** 차단 시 사용자에게 보일 문구 — 레인을 바꾸는 방법까지 말한다. */
export function readOnlyBlockMessage(operation: string, model?: string): string {
  const target = model ? `${model}.${operation}` : operation;
  return (
    `[읽기 전용 모드] ${target} 이(가) 차단됐습니다. ${READ_ONLY_ENV_KEY}=1 로 실행 중입니다.\n` +
    `  쓰기가 필요한 작업이면 읽기 전용이 아닌 레인으로 다시 띄우세요: npm run dev`
  );
}

/**
 * `PrismaClient.$extends` 에 넘길 확장 정의.
 *
 * 최상위 `query.$allOperations` 는 모델 오퍼레이션과 raw 오퍼레이션을 **모두** 통과하므로
 * (Prisma 6.19 `DynamicQueryExtensionArgs`), 모델별로 훅을 다는 것보다 구멍이 적다.
 * `$transaction` 내부 호출도 각각 이 훅을 거치므로 별도 처리가 필요 없다.
 */
export const readOnlyExtension = {
  name: "wag-crm-read-only-guard",
  query: {
    $allOperations({
      model,
      operation,
      args,
      query,
    }: {
      model?: string;
      operation: string;
      args: unknown;
      query: (args: unknown) => Promise<unknown>;
    }): Promise<unknown> {
      if (!isReadOperation(operation)) {
        return Promise.reject(new Error(readOnlyBlockMessage(operation, model)));
      }
      return query(args);
    },
  },
} as const;
