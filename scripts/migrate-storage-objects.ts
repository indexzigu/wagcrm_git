/**
 * Storage 객체를 원본 Supabase 에서 대상 Supabase 로 이관한다 (자체 호스팅 전환용).
 *
 * ## 왜 API 경유인가
 *
 * `storage.objects` 행을 SQL 로 복사하는 방법도 있지만 쓰지 않는다. 그 테이블의
 * 컬럼 집합과 메타데이터 형식은 Storage API 버전에 묶여 있어, 원본과 대상의 이미지
 * 버전이 다르면 조용히 깨진다(복원은 성공하는데 객체를 못 읽는 형태). 다운로드 →
 * 업로드로 옮기면 대상 Storage 가 자기 버전에 맞는 행을 스스로 만든다.
 *
 * ## 멱등성
 *
 * 업로드는 `upsert: true` 다. 같은 경로를 다시 올리면 덮어쓴다 — 컷오버 시점의
 * 증분 재실행(원본에 그동안 쌓인 것만 따라잡기)을 같은 스크립트로 할 수 있다.
 *
 * ## 사용법
 *
 *   SRC_URL=... SRC_SERVICE_KEY=... DST_URL=... DST_SERVICE_KEY=... \
 *     npx tsx scripts/migrate-storage-objects.ts [--dry-run] [--bucket <name>]
 *
 * 원본은 **읽기만** 한다. 쓰기는 대상에만 일어난다.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const DRY_RUN = process.argv.includes("--dry-run");
const BUCKET_FILTER = (() => {
  const i = process.argv.indexOf("--bucket");
  return i >= 0 ? process.argv[i + 1] : null;
})();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경 변수가 필요합니다.`);
  return value;
}

const src = createClient(required("SRC_URL"), required("SRC_SERVICE_KEY"), {
  auth: { persistSession: false },
});
const dst = createClient(required("DST_URL"), required("DST_SERVICE_KEY"), {
  auth: { persistSession: false },
});

type Stats = { moved: number; skipped: number; failed: number };

/**
 * `list` 는 한 단계(prefix 직속)만 돌려준다 — 폴더는 `id === null` 로 오고, 그 안을
 * 보려면 재귀해야 한다. 이걸 빠뜨리면 최상위 파일만 옮기고 "완료"로 보인다.
 */
async function* walk(
  client: SupabaseClient,
  bucket: string,
  prefix = "",
): AsyncGenerator<string> {
  const LIMIT = 100;
  for (let offset = 0; ; offset += LIMIT) {
    const { data, error } = await client.storage
      .from(bucket)
      .list(prefix, { limit: LIMIT, offset });
    if (error) throw new Error(`${bucket}/${prefix} 목록 조회 실패: ${error.message}`);
    if (!data || data.length === 0) return;
    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        yield* walk(client, bucket, path); // 폴더
      } else {
        yield path;
      }
    }
    if (data.length < LIMIT) return;
  }
}

async function ensureBucket(name: string, isPublic: boolean, fileSizeLimit: number | null, allowedMimeTypes: string[] | null) {
  const { data: existing } = await dst.storage.getBucket(name);
  if (existing) {
    if (existing.public !== isPublic) {
      // 공개 여부가 다르면 셀러 대면 URL 이 깨지거나 반대로 비공개 자산이 열린다.
      const { error } = await dst.storage.updateBucket(name, { public: isPublic });
      if (error) throw new Error(`버킷 ${name} 공개설정 교정 실패: ${error.message}`);
      console.log(`  [${name}] 공개설정 교정: ${existing.public} → ${isPublic}`);
    }
    return;
  }
  const { error } = await dst.storage.createBucket(name, {
    public: isPublic,
    fileSizeLimit: fileSizeLimit ?? undefined,
    allowedMimeTypes: allowedMimeTypes ?? undefined,
  });
  if (error) throw new Error(`버킷 ${name} 생성 실패: ${error.message}`);
  console.log(`  [${name}] 버킷 생성 (public=${isPublic})`);
}

async function migrateBucket(name: string): Promise<Stats> {
  const stats: Stats = { moved: 0, skipped: 0, failed: 0 };
  for await (const path of walk(src, name)) {
    if (DRY_RUN) {
      stats.skipped++;
      continue;
    }
    try {
      const { data: blob, error: dlErr } = await src.storage.from(name).download(path);
      if (dlErr || !blob) throw new Error(`다운로드: ${dlErr?.message ?? "빈 응답"}`);
      const { error: upErr } = await dst.storage.from(name).upload(path, blob, {
        upsert: true,
        contentType: blob.type || undefined,
      });
      if (upErr) throw new Error(`업로드: ${upErr.message}`);
      stats.moved++;
      if (stats.moved % 100 === 0) console.log(`  [${name}] ${stats.moved}건 이관`);
    } catch (e) {
      stats.failed++;
      // 실패를 삼키지 않는다 — 경로를 남겨 재시도 대상을 특정할 수 있게 한다.
      console.error(`  [${name}] 실패 ${path}: ${(e as Error).message}`);
    }
  }
  return stats;
}

async function main() {
  const { data: buckets, error } = await src.storage.listBuckets();
  if (error) throw new Error(`원본 버킷 목록 조회 실패: ${error.message}`);
  if (!buckets?.length) throw new Error("원본에 버킷이 없습니다 — 연결 대상을 확인하세요.");

  const targets = BUCKET_FILTER ? buckets.filter((b) => b.name === BUCKET_FILTER) : buckets;
  if (!targets.length) throw new Error(`버킷 ${BUCKET_FILTER} 을(를) 원본에서 찾지 못했습니다.`);

  console.log(`대상 버킷 ${targets.length}개${DRY_RUN ? " (dry-run — 쓰기 없음)" : ""}`);
  const total: Stats = { moved: 0, skipped: 0, failed: 0 };
  for (const bucket of targets) {
    if (!DRY_RUN) {
      await ensureBucket(
        bucket.name,
        bucket.public,
        bucket.file_size_limit ?? null,
        bucket.allowed_mime_types ?? null,
      );
    }
    const s = await migrateBucket(bucket.name);
    console.log(`  [${bucket.name}] 이관 ${s.moved} · 건너뜀 ${s.skipped} · 실패 ${s.failed}`);
    total.moved += s.moved;
    total.skipped += s.skipped;
    total.failed += s.failed;
  }
  console.log(JSON.stringify({ 이관: total.moved, 건너뜀: total.skipped, 실패: total.failed }, null, 2));
  // 실패가 하나라도 있으면 종료코드로 알린다 — 호출자가 "성공"으로 오인하면 안 된다.
  if (total.failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("ERROR:", (e as Error).message);
  process.exit(1);
});
