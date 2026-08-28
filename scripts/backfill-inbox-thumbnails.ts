import { PrismaClient } from "@prisma/client";
import { classifyReferenceUrl, deriveYoutubeThumbnailUrl } from "../src/lib/reference-enrich";
import { fetchInstagramPostMeta } from "../src/lib/reference-enrich-proxy";

const prisma = new PrismaClient();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const items = await prisma.referenceInboxItem.findMany({
    where: {
      status: "PENDING",
      thumbnailUrl: null,
    },
    orderBy: { createdAt: "desc" },
  });

  console.log(`Found ${items.length} PENDING items missing thumbnails.`);

  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  let instagramTouched = false;

  for (const item of items) {
    try {
      const url = item.normalizedUrl;
      const source = classifyReferenceUrl(url);

      if (source === "UNSUPPORTED") {
        skipped++;
        continue;
      }

      if (source === "YOUTUBE") {
        const thumb = deriveYoutubeThumbnailUrl(url);
        if (thumb) {
          await prisma.referenceInboxItem.update({
            where: { id: item.id },
            data: { thumbnailUrl: thumb },
          });
          enriched++;
          console.log(`[YOUTUBE] Enriched ${item.id}`);
        } else {
          skipped++;
        }
        continue;
      }

      if (source === "INSTAGRAM") {
        if (instagramTouched) await sleep(2500 + Math.floor(Math.random() * 2000));
        instagramTouched = true;

        const meta = await fetchInstagramPostMeta(url);
        if (!meta || !meta.thumbnailUrl) {
          throw new Error("Apify 응답에 썸네일 없음");
        }

        // We don't strictly *need* to rehost for inbox items since they are temporary,
        // but let's just use the Apify URL directly for now. If it expires, it's just the inbox.
        // Wait, the client might block external images if domains aren't in next.config.ts?
        // If the Apify URL is valid, we can save it.
        // igUsername/igProfilePicUrl은 InstagramPostMeta(reference-enrich.ts)에 없는
        // 필드다 — 개명이 아니라 애초에 이 스크래핑 경로가 채우지 않는 값이다(그 두 컬럼은
        // /api/reference-inbox POST의 수동/카카오 extra로만 채워진다). 타입체크 이전에는
        // meta.igUsername이 매 항목 undefined라 `undefined || null` => null이 항상 쓰였으므로,
        // 여기서 리터럴 null로 고정해도 런타임 동작은 그대로다.
        await prisma.referenceInboxItem.update({
          where: { id: item.id },
          data: {
            thumbnailUrl: meta.thumbnailUrl,
            videoUrl: meta.videoUrl || null,
            igUsername: null,
            igProfilePicUrl: null,
          },
        });
        enriched++;
        console.log(`[INSTAGRAM] Enriched ${item.id}`);
      }
    } catch (error) {
      failed++;
      console.error(`Failed for ${item.id} (${item.normalizedUrl}):`, error instanceof Error ? error.message : error);
    }
  }

  console.log(`Done. Enriched: ${enriched}, Skipped: ${skipped}, Failed: ${failed}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
