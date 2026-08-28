import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { classifyReferenceUrl, deriveYoutubeThumbnailUrl } from "@/lib/reference-enrich";
import { fetchInstagramPostMeta, fetchInstagramProfileMeta } from "@/lib/reference-enrich-proxy";
import { classifyInstagramUrl, extractInstagramUsername } from "@/lib/reference-kind";
import { verifyCronAuth } from "@/lib/cron-auth";

// 미분류 인박스 아이템 썸네일/메타데이터 보강 sweep
// Kakao 등을 통해 유입된 ReferenceInboxItem 중 썸네일이 없는 PENDING 항목을 스윕한다.
// enrich-references 와 비슷하게 Vercel 크론 등에 의해 주기적으로 호출될 수 있다.
export const maxDuration = 300;

const BATCH_SIZE = 8;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const prisma = getPrisma();
  const deadlineMs = Date.now() + 240_000;

  const items = await prisma.referenceInboxItem.findMany({
    where: {
      status: "PENDING",
      thumbnailUrl: null,
    },
    orderBy: { createdAt: "desc" },
    take: BATCH_SIZE,
  });

  let enriched = 0;
  let skippedUnsupported = 0;
  let failed = 0;
  let instagramTouched = false;

  for (const item of items) {
    if (Date.now() >= deadlineMs) break;

    try {
      const url = item.normalizedUrl;
      const source = classifyReferenceUrl(url);

      if (source === "UNSUPPORTED") {
        skippedUnsupported++;
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
        } else {
          skippedUnsupported++;
        }
        continue;
      }

      if (source === "INSTAGRAM") {
        const kind = classifyInstagramUrl(url);

        // 프로필·릴스 피드 링크: 게시물 썸네일이 없으므로 계정 정보로 보강한다.
        // (기존에는 fetchInstagramPostMeta의 shortcode 파싱이 throw해 매 스윕 실패로
        //  BATCH_SIZE 슬롯을 영구 점유하던 유형 — 이 분기가 근본 해결)
        if (kind === "PROFILE" || kind === "PROFILE_REELS") {
          const username = extractInstagramUsername(url);
          if (!username) throw new Error("프로필 URL에서 계정명 추출 실패");
          // RapidAPI 경로도 embed 경로와 같은 스로틀을 공유(연속 호출 레이트리밋 방어).
          if (instagramTouched) await sleep(2500 + Math.floor(Math.random() * 2000));
          instagramTouched = true;
          const profile = await fetchInstagramProfileMeta(username);
          if (!profile.username || !profile.profilePicUrl) {
            // 계정을 못 찾았거나(삭제·비공개 등) 프로필 사진이 없는 상태 — 재시도해도
            // 달라지지 않는 영구 조건이라 실패가 아니라 무시로 센다(실패로 세면 이
            // 배치가 이 항목 때문에 영원히 ERROR로 고정된다).
            skippedUnsupported++;
            continue;
          }
          await prisma.referenceInboxItem.update({
            where: { id: item.id },
            data: {
              thumbnailUrl: profile.profilePicUrl,
              igUsername: profile.username,
              igProfilePicUrl: profile.profilePicUrl,
              igFullName: profile.fullName,
              igBio: profile.bio,
              igFollowerCount: profile.followerCount,
              igPostCount: profile.postCount,
            },
          });
          enriched++;
          continue;
        }

        if (kind !== "POST") {
          // 인스타 호스트지만 게시물/프로필 어느 쪽도 아닌 URL(스토리 하이라이트 등).
          // embed 파싱이 무조건 throw하는 유형이라 시도 자체를 건너뛴다.
          skippedUnsupported++;
          continue;
        }

        if (instagramTouched) await sleep(2500 + Math.floor(Math.random() * 2000));
        instagramTouched = true;

        const meta = await fetchInstagramPostMeta(url);
        if (!meta?.thumbnailUrl) {
          // 게시물이 삭제·비공개 등으로 임베드에 썸네일이 없는 상태 — 재시도해도
          // 달라지지 않는 영구 조건이라 실패가 아니라 무시로 센다(실패로 세면 이
          // 배치가 이 항목 때문에 영원히 ERROR로 고정된다).
          skippedUnsupported++;
          continue;
        }

        // 인박스 아이템은 스토리지 재호스팅 대신 우선 외부 썸네일을 직접 기록
        // (딜 배정 시 Asset 승격 과정에서 enrich-references가 재호스팅 처리)
        // igUsername/igProfilePicUrl은 embed가 제공하지 않으므로 건드리지 않는다
        // (수집 봇이 채운 값을 null로 덮던 기존 동작 제거).
        await prisma.referenceInboxItem.update({
          where: { id: item.id },
          data: {
            thumbnailUrl: meta.thumbnailUrl,
            videoUrl: meta.videoUrl ?? null,
          },
        });
        enriched++;
      }
    } catch (e) {
      failed++;
      console.error(
        `[enrich-inbox] item ${item.id} (${item.normalizedUrl}) 보강 실패:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  const nextExpectedRunAt = new Date();
  nextExpectedRunAt.setUTCHours(18, 5, 0, 0); // 18:00 UTC + 5min buffer
  if (Date.now() >= nextExpectedRunAt.getTime()) {
    nextExpectedRunAt.setUTCDate(nextExpectedRunAt.getUTCDate() + 1);
  }

  const jobKey = "enrich-inbox";
  const finalStatus = failed > 0 ? "ERROR" : "SUCCESS";
  const finalMessage = `스캔: ${items.length}, 성공: ${enriched}, 무시: ${skippedUnsupported}, 실패: ${failed}`;

  await prisma.systemTaskStatus.upsert({
    where: { jobKey },
    create: {
      jobKey,
      status: finalStatus,
      lastRunAt: new Date(),
      nextExpectedRunAt,
      lastErrorMessage: failed > 0 ? "일부 썸네일 수집이 실패했습니다." : null,
    },
    update: {
      status: finalStatus,
      lastRunAt: new Date(),
      nextExpectedRunAt,
      lastErrorMessage: failed > 0 ? "일부 썸네일 수집이 실패했습니다." : null,
    },
  });

  await prisma.systemTaskLog.create({
    data: {
      jobKey,
      status: finalStatus,
      message: finalMessage,
      details: { scanned: items.length, enriched, skippedUnsupported, failed },
    },
  });

  return NextResponse.json({ scanned: items.length, enriched, skippedUnsupported, failed });
}
