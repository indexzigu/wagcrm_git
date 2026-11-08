// [셀러분석] 분석 스냅샷(SellerAiProfile.aiTags)에서 필요한 경로만 읽는 공용 헬퍼 — 비교표(§3-3)와
// 비슷한 셀러(§2-4)가 같이 쓴다.
//
// aiTags 는 셀러당 수백 KB 가 될 수 있다(postsPreview·Gemini 서술). 두 화면이 쓰는 건 몇 개 경로뿐이라
// Postgres 에서는 jsonb 연산자로 그 경로만 잘라 받는다. 경로는 아래 화이트리스트의 고정 SQL 조각만 쓰고
// (호출부 입력이 SQL 에 들어가지 않는다), 셀러 id 는 Prisma.sql 태그 템플릿으로만 바인딩한다.
// sqlite(dev:demo·dev:local 가공 데이터 DB)는 jsonb 연산자가 없어 aiTags 전체를 읽고 같은 투영을 JS 로 한다.

import { Prisma, type PrismaClient } from "@prisma/client";
import { isSqliteDatabaseUrl } from "./prisma-client";

type TagsRecord = Record<string, unknown>;

function asRecord(aiTags: unknown): TagsRecord {
  return aiTags && typeof aiTags === "object" && !Array.isArray(aiTags) ? (aiTags as TagsRecord) : {};
}

function metricsGroup(aiTags: unknown, key: string): unknown {
  const metrics = asRecord(aiTags).metrics;
  return metrics && typeof metrics === "object" ? ((metrics as TagsRecord)[key] ?? null) : null;
}

interface PathSpec {
  sql: Prisma.Sql;
  project: (aiTags: unknown) => unknown;
}

const AI_TAGS_PATHS = {
  category: {
    sql: Prisma.sql`"aiTags"->'category'`,
    project: (t) => asRecord(t).category ?? null,
  },
  tags: {
    sql: Prisma.sql`"aiTags"->'tags'`,
    project: (t) => asRecord(t).tags ?? null,
  },
  sub_categories: {
    sql: Prisma.sql`"aiTags"->'sub_categories'`,
    project: (t) => asRecord(t).sub_categories ?? null,
  },
  /** 구형 레코드는 aiTags 자체가 태그 문자열 배열이다 — 그때만 배열 전체, 아니면 null */
  legacyArray: {
    sql: Prisma.sql`CASE WHEN jsonb_typeof("aiTags") = 'array' THEN "aiTags" ELSE NULL END`,
    project: (t) => (Array.isArray(t) ? t : null),
  },
  metrics: {
    sql: Prisma.sql`"aiTags"->'metrics'`,
    project: (t) => asRecord(t).metrics ?? null,
  },
  engagement: {
    sql: Prisma.sql`"aiTags"->'metrics'->'engagement'`,
    project: (t) => metricsGroup(t, "engagement"),
  },
  /** 참여율 스칼라(비율) 하나만 — 셀러 목록이 전 셀러를 읽으므로 engagement 묶음 전체도 안 가져온다. */
  engagementRate: {
    sql: Prisma.sql`"aiTags"->'metrics'->'engagement'->'er'`,
    project: (t) => {
      const engagement = metricsGroup(t, "engagement");
      return engagement && typeof engagement === "object" ? ((engagement as TagsRecord).er ?? null) : null;
    },
  },
  cadence: {
    sql: Prisma.sql`"aiTags"->'metrics'->'cadence'`,
    project: (t) => metricsGroup(t, "cadence"),
  },
  profileMeta: {
    sql: Prisma.sql`"aiTags"->'profileMeta'`,
    project: (t) => asRecord(t).profileMeta ?? null,
  },
  /** 위험 신호 판정에 쓰는 게시물 두 필드(taken_at·is_gongu)만 */
  postsLite: {
    sql: Prisma.sql`CASE
        WHEN jsonb_typeof("aiTags"->'postsPreview') = 'array' THEN (
          SELECT jsonb_agg(jsonb_build_object('taken_at', p->'taken_at', 'is_gongu', p->'is_gongu'))
          FROM jsonb_array_elements("aiTags"->'postsPreview') AS p
        )
        ELSE NULL
      END`,
    project: (t) => {
      const posts = asRecord(t).postsPreview;
      return Array.isArray(posts)
        ? posts
            .filter((p): p is TagsRecord => !!p && typeof p === "object")
            .map((p) => ({ taken_at: p.taken_at ?? null, is_gongu: p.is_gongu === true }))
        : null;
    },
  },
} satisfies Record<string, PathSpec>;

export type AiTagsPathKey = keyof typeof AI_TAGS_PATHS;

export type AiTagsPathRow<K extends AiTagsPathKey> = {
  sellerId: string;
  analyzedAt: Date | string | null;
  compositeScore: number | null;
  confidence: string | null;
} & Record<K, unknown>;

export type AiTagsPathsPrisma = Pick<PrismaClient, "sellerAiProfile" | "$queryRaw">;

/** aiTags 전체 → 요청한 경로만 (sqlite 경로 · Postgres 쿼리와 같은 모양). 모양이 틀리면 null. */
export function projectAiTagsPaths<K extends AiTagsPathKey>(aiTags: unknown, keys: readonly K[]): Record<K, unknown> {
  const out = {} as Record<K, unknown>;
  for (const key of keys) out[key] = AI_TAGS_PATHS[key].project(aiTags);
  return out;
}

/**
 * 분석 스냅샷에서 지정 경로만 읽는다. `sellerIds` 가 null 이면 분석본 전체(비슷한 셀러 후보 풀),
 * 빈 배열이면 DB 를 읽지 않는다.
 */
export async function loadAiTagsPaths<K extends AiTagsPathKey>(
  prisma: AiTagsPathsPrisma,
  sellerIds: readonly string[] | null,
  keys: readonly K[],
): Promise<AiTagsPathRow<K>[]> {
  if (sellerIds !== null && sellerIds.length === 0) return [];

  if (isSqliteDatabaseUrl()) {
    const rows = await prisma.sellerAiProfile.findMany({
      ...(sellerIds !== null ? { where: { sellerId: { in: [...sellerIds] } } } : {}),
      select: { sellerId: true, analyzedAt: true, compositeScore: true, confidence: true, aiTags: true },
    });
    return rows.map((row) => ({
      sellerId: row.sellerId,
      analyzedAt: row.analyzedAt,
      compositeScore: row.compositeScore,
      confidence: row.confidence,
      ...projectAiTagsPaths(row.aiTags, keys),
    })) as AiTagsPathRow<K>[];
  }

  // 별칭은 화이트리스트 키(코드 상수)에서만 만든다 — 호출부 문자열이 SQL 에 들어가지 않는다.
  const columns = Prisma.join(
    keys.map((key) => Prisma.sql`${AI_TAGS_PATHS[key].sql} AS ${Prisma.raw(`"${key}"`)}`),
    ",\n      ",
  );
  const where =
    sellerIds !== null ? Prisma.sql`WHERE "sellerId" IN (${Prisma.join([...sellerIds])})` : Prisma.empty;

  return prisma.$queryRaw<AiTagsPathRow<K>[]>(Prisma.sql`
    SELECT
      "sellerId",
      "analyzedAt",
      "compositeScore",
      "confidence",
      ${columns}
    FROM "SellerAiProfile"
    ${where}
  `);
}
