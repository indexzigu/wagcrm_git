// queue-reference-urls — 카톡 청크 텍스트의 콘텐츠 URL을 미분류 레퍼런스 인박스로 유입(R2b).
//
// 두 인제스트 라우트(work-records/ingest, kakao-uploads)의 WorkRecord upsert 직후 호출되는
// 부가 헬퍼. 스키마 변경 없이 기존 ReferenceInboxItem에 source="KAKAO"로 insert한다.
//
// 에러 격리(설계 §3-5): URL 추출/인박스 유입 실패가 카톡 인제스트 본류(WorkRecord 저장)를
// 깨뜨려선 안 된다. 호출부에서 try/catch로 감싸되(빈 catch 금지, 반드시 console.error),
// 이 함수 자체도 방어적으로 예외를 삼키지 않고 그대로 던진다 — 로깅은 호출부 계약.

import type { AppPrismaClient } from "../prisma-client";
import { deriveLinkName, extractContentUrls } from "../reference-url";
import { planKakaoInboxItems } from "../reference-inbox";

/**
 * 청크 텍스트에서 콘텐츠 도메인 URL을 추출해 미분류 인박스에 유입한다.
 *
 * 1) extractContentUrls로 후보 확보 — 없으면 즉시 return(DB 조회 비용 0).
 * 2) dedup 조회: 후보 normalizedUrl 중 status PENDING·DISMISSED로 이미 존재하는 값 제외.
 *    (관제탑 dedup 정책: 살아있거나 기각한 적 있는 URL은 자동 재유입하지 않음. Asset 승격되어
 *     인박스에서 삭제된 URL은 재유입 허용 — assign이 alreadyExists로 최종 방어.)
 * 3) 남은 것만 create: source="KAKAO", sourceRoomKey=roomKey, sourceRef=workRecordId,
 *    linkName=deriveLinkName(normalizedUrl), createdBy=null.
 *
 * @returns 실제로 생성한 인박스 아이템 수.
 */
export async function queueKakaoReferenceUrls(
  prisma: AppPrismaClient,
  workRecordId: string,
  roomKey: string,
  chunkText: string,
): Promise<number> {
  const candidates = extractContentUrls(chunkText);
  if (candidates.length === 0) return 0;

  // dedup: PENDING + DISMISSED 둘 다 제외(자동 유입이라 반복공유 잦음).
  const existing = await prisma.referenceInboxItem.findMany({
    where: {
      status: { in: ["PENDING", "DISMISSED"] },
      normalizedUrl: { in: candidates },
    },
    select: { normalizedUrl: true },
  });

  // TOCTOU 주의: ReferenceInboxItem에 normalizedUrl unique 제약이 없어, 이 findMany dedup
  // 조회와 아래 createMany 사이에 다른 요청(두 라우트 동시 실행/러너 재시도)이 같은 URL을
  // 먼저 insert하면 같은 URL의 PENDING이 중복 생성될 수 있다. 자동 유입 특성상 심각도는 낮고
  // (사용자가 인박스에서 기각 가능), 후속으로 @@unique([normalizedUrl, status]) 도입을 검토.
  const plan = planKakaoInboxItems(
    candidates,
    existing.map((row: { normalizedUrl: string }) => row.normalizedUrl),
  );
  if (plan.length === 0) return 0;

  await prisma.referenceInboxItem.createMany({
    data: plan.map((item) => ({
      rawUrl: item.rawUrl,
      normalizedUrl: item.normalizedUrl,
      linkName: deriveLinkName(item.normalizedUrl),
      source: "KAKAO",
      sourceRoomKey: roomKey,
      sourceRef: workRecordId,
      createdBy: null,
    })),
  });

  return plan.length;
}
