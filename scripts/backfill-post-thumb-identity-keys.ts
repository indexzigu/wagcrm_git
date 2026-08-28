// 셀러 게시물 썸네일 신원 키 백필 — 인덱스 키 오염 복구 (2026-07-16 실사고).
//
// 배경: 리호스팅 저장 경로가 배열 인덱스 키(sellers/{sellerId}/{idx}.{ext})였던 동안,
// 일간 수집의 인덱스 드리프트마다 같은 URL이 다른 게시물 이미지로 덮였다. 등록(홍보) 시
// Asset.thumbnailUrl로 그 URL이 영구 복사되어, 등록 카드 다수가 실제 연결 게시물과
// 다른 썸네일을 표시했다. 저장 키는 shortcode로 전환됐고(mediaRehost), 이
// 스크립트는 기존 참조를 신원 키 경로로 이관한다.
//
// 복구 소스(Graph 토큰 없이): 마지막 리호스팅 이후 순서가 안 바뀐 preview 항목 —
// 항목의 thumb 인덱스(j)가 현재 배열 위치(i)와 일치하면, 파일 j의 내용은 그 항목 자신의
// 이미지다(리호스팅은 항상 "현재 위치"에 자기 썸네일을 올리므로). 이 파일을 내려받아
// sellers/{sellerId}/{shortcode}.{ext}로 재업로드하고 preview·Asset 참조를 교체한다.
//
// 복구 불가(순서가 이미 어긋난 항목·preview 밖 게시물)는 thumbnailUrl=null로 되돌린다 —
// 잘못된 이미지보다 placeholder가 낫고, SNS_CREATIVE·14일 이내 자산은 enrich-references
// 크론이 기존 경로(Apify ~$0.001/건)로 올바른 썸네일을 재파생한다.
//
// 안전 규칙:
// - 기본 dry-run(계획 출력만). `--apply`가 있을 때만 스토리지 업로드·DB write.
// - preview 갱신은 updatedAt 조건부 update — 그 사이 재분석/수집이 덮었으면 결과 폐기.
// - 삭제 없음: 레거시 idx 파일은 방치한다(참조만 이관).
//
// 실행:
//   set -a; source .env; set +a
//   npx tsx scripts/backfill-post-thumb-identity-keys.ts          (dry-run)
//   npx tsx scripts/backfill-post-thumb-identity-keys.ts --apply  (실제 적용)

import "dotenv/config";
import { getPrisma } from "../src/lib/prisma";
import {
  isSellerMediaStorageConfigured,
  publicMediaUrl,
  sellerMediaBucket,
  uploadBytes,
} from "../src/lib/seller-analysis/seller-media-storage";
import { shortcodeFromPermalink } from "../src/lib/seller-analysis/graphScraper";
import type { PostPreview } from "../src/lib/seller-analysis/types";

type PreviewItem = PostPreview & { thumbFailed?: boolean };

/** 버킷 내 인덱스 키 썸네일 URL 파싱 → { sellerId, idx, ext }. 아니면 null. */
function parseLegacyIdxThumb(url: unknown): { sellerId: string; idx: number; ext: string } | null {
  if (typeof url !== "string") return null;
  const m = url.match(
    new RegExp(
      `/storage/v1/object/public/${sellerMediaBucket()}/sellers/([^/]+)/(\\d+)\\.([A-Za-z0-9]+)$`,
    ),
  );
  return m ? { sellerId: m[1], idx: Number(m[2]), ext: m[3].toLowerCase() } : null;
}

function extToContentType(ext: string): string {
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/jpeg";
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!isSellerMediaStorageConfigured()) {
    console.error("Supabase 스토리지 미설정(SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) — .env 로드를 확인하세요.");
    process.exit(1);
  }
  const prisma = getPrisma();

  // 1) 대상 수집 — 인덱스 키 썸네일을 문 캠페인 게시물 Asset + 캠페인→셀러 매핑.
  const assets = await prisma.asset.findMany({
    where: { entityType: "CAMPAIGN", externalUrl: { not: null }, archivedAt: null },
    select: { id: true, entityId: true, externalUrl: true, thumbnailUrl: true },
  });
  const legacyAssets = assets.filter((a) => parseLegacyIdxThumb(a.thumbnailUrl));
  const campaigns = await prisma.salesCampaign.findMany({
    where: { id: { in: [...new Set(legacyAssets.map((a) => a.entityId))] } },
    select: { id: true, sellerId: true },
  });
  const sellerByCampaign = new Map(campaigns.map((c) => [c.id, c.sellerId]));
  const affectedSellerIds = new Set<string>();
  for (const a of legacyAssets) {
    const sid = sellerByCampaign.get(a.entityId);
    if (sid) affectedSellerIds.add(sid);
  }
  // preview 쪽 레거시 참조 보유 셀러도 대상(자산이 없어도 preview는 이관).
  const profiles = await prisma.sellerAiProfile.findMany({
    select: { sellerId: true, aiTags: true, updatedAt: true },
  });
  for (const p of profiles) {
    const tags = p.aiTags as Record<string, unknown> | null;
    const preview = tags && Array.isArray(tags.postsPreview) ? (tags.postsPreview as PreviewItem[]) : [];
    if (preview.some((it) => parseLegacyIdxThumb(it?.thumb))) affectedSellerIds.add(p.sellerId);
  }

  console.log(
    `대상: 레거시 썸네일 Asset ${legacyAssets.length}건 · 셀러 ${affectedSellerIds.size}명 ${apply ? "(APPLY)" : "(dry-run)"}`,
  );

  let copied = 0;
  let assetFixed = 0;
  let assetNulled = 0;
  let previewFixed = 0;
  let previewNulled = 0;

  for (const sellerId of affectedSellerIds) {
    const profile = profiles.find((p) => p.sellerId === sellerId);
    const tags = (profile?.aiTags ?? {}) as Record<string, unknown>;
    const preview: PreviewItem[] = Array.isArray(tags.postsPreview)
      ? [...(tags.postsPreview as PreviewItem[])]
      : [];

    // 2) 신뢰 소스 확정 + 스토리지 복사: thumb 인덱스 == 현재 위치인 항목만
    //    (마지막 리호스팅 이후 순서 불변 = 파일 내용이 자기 이미지임이 보장됨).
    const stableUrlBySc = new Map<string, string>();
    let previewDirty = false;
    for (let i = 0; i < preview.length; i++) {
      const item = preview[i];
      const legacy = parseLegacyIdxThumb(item?.thumb);
      if (!legacy || legacy.sellerId !== sellerId) continue;
      const sc = shortcodeFromPermalink(item?.permalink);
      const trusted = legacy.idx === i && sc;
      if (trusted) {
        const destPath = `sellers/${sellerId}/${sc}.${legacy.ext}`;
        const destUrl = publicMediaUrl(destPath);
        if (apply) {
          const res = await fetch(item.thumb as string);
          if (!res.ok) {
            console.warn(`  ⚠️ ${sellerId} idx${legacy.idx} 다운로드 ${res.status} — null 처리`);
            preview[i] = { ...item, thumb: null };
            previewDirty = true;
            previewNulled++;
            continue;
          }
          const bytes = await res.arrayBuffer();
          await uploadBytes(destPath, bytes, extToContentType(legacy.ext));
        }
        stableUrlBySc.set(sc, destUrl);
        preview[i] = { ...item, thumb: destUrl };
        previewDirty = true;
        previewFixed++;
        copied++;
        console.log(`  복사: ${sellerId} idx${legacy.idx} → ${sc}.${legacy.ext}`);
      } else {
        // 순서가 어긋난 참조 — 파일 내용이 다른 게시물일 수 있어 폐기(오염보다 placeholder).
        preview[i] = { ...item, thumb: null };
        previewDirty = true;
        previewNulled++;
        console.log(`  폐기(불일치): ${sellerId} thumb idx${legacy.idx} @위치 ${i} (sc=${sc ?? "?"})`);
      }
    }

    if (apply && previewDirty && profile) {
      const nextTags = { ...tags, postsPreview: preview };
      const updated = await prisma.sellerAiProfile.updateMany({
        where: { sellerId, updatedAt: profile.updatedAt },
        data: { aiTags: nextTags as object },
      });
      if (updated.count === 0) {
        console.warn(`  ⚠️ ${sellerId} preview 갱신 경합 — 폐기(다음 수집이 자연 갱신)`);
      }
    }

    // 3) Asset 참조 이관 — 복사된 shortcode면 안정 URL, 아니면 null(enrich 크론 재파생).
    for (const a of legacyAssets) {
      if (sellerByCampaign.get(a.entityId) !== sellerId) continue;
      const sc = a.externalUrl ? shortcodeFromPermalink(a.externalUrl) : null;
      const stable = sc ? stableUrlBySc.get(sc) : undefined;
      if (apply) {
        await prisma.asset.update({
          where: { id: a.id },
          data: { thumbnailUrl: stable ?? null },
        });
      }
      if (stable) {
        assetFixed++;
        console.log(`  Asset ${a.id.slice(0, 8)} (${sc}) → 안정 URL`);
      } else {
        assetNulled++;
        console.log(`  Asset ${a.id.slice(0, 8)} (${sc ?? "?"}) → null (enrich 재파생 대기)`);
      }
    }
  }

  console.log(
    `\n결과${apply ? "" : "(dry-run — 실제 write 없음)"}: 스토리지 복사 ${copied} · Asset 복구 ${assetFixed} · Asset null ${assetNulled} · preview 이관 ${previewFixed} · preview 폐기 ${previewNulled}`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
