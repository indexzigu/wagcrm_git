// 스토리 스냅샷 분류함 — capture-stories 크론이 모은 "행사 기간 전량 수집" 스토리를
// 사람이 훑어보며 캠페인 홍보(CAMPAIGN)/무관(OTHER)으로 분류한다(오너 지시 2026-07-10:
// 태그 기반이 아니라 전량 수집 후 썸네일 후분류). 추후 LLM 배치 분류가 붙어도 이 화면이
// 검수·정정 표면으로 남는다.
import type { Metadata } from "next";
import { getPrisma } from "@/lib/prisma";
import { CrmShell } from "@/components/crm/crm-shell";
import { StoryCollectButton } from "@/components/crm/story-collect-button";
import { BulkContentCollectButton } from "@/components/crm/bulk-content-collect-button";
import { listCaptureWindowSellers } from "@/lib/story-capture";
import { StoryInboxGrid } from "@/components/crm/story-inbox-grid";
import {
  STORY_INBOX_FILTER_KEYS,
  classificationOfFilter,
  toStoryClassification,
  type StoryInboxCard,
  type StoryInboxFilter,
} from "@/lib/story-inbox";

export const metadata: Metadata = { title: "스토리 분류함" };

function fmtKst(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${mm}.${dd} ${hh}:${mi}`;
}

export default async function StoryInboxPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string }>;
}) {
  const { f } = await searchParams;
  const filter: StoryInboxFilter = STORY_INBOX_FILTER_KEYS.find((k) => k === f) ?? "unreviewed";

  const wanted = classificationOfFilter(filter);
  const where = wanted ? { classification: wanted } : {};

  const prisma = getPrisma();
  const [snapshots, counts, windowSellers] = await Promise.all([
    prisma.sellerStorySnapshot.findMany({
      where,
      orderBy: { takenAt: "desc" },
      take: 200,
      include: { seller: { select: { name: true, alias: true, snsHandle: true } } },
    }),
    prisma.sellerStorySnapshot.groupBy({ by: ["classification"], _count: true }),
    // 전체 수집 버튼 대상 — 크론과 동일한 수집창 판정(listCaptureWindowSellers SSOT)
    listCaptureWindowSellers(prisma),
  ]);
  // 표시명은 별칭 우선(P2 Seller Alias Priority)
  const bulkTargets = windowSellers.map((s) => ({ id: s.id, label: s.alias || s.name }));
  const countOf = (c: string) => counts.find((x) => x.classification === c)?._count ?? 0;

  // 3종 밖 분류값은 어느 탭에도 속하지 않으므로 그리드에 넘기지 않는다(전체 탭 개수에는 서버 합으로 남는다).
  const cards: StoryInboxCard[] = snapshots.flatMap((s) => {
    const classification = toStoryClassification(s.classification);
    if (!classification) return [];
    return [
      {
        id: s.id,
        displayName: s.seller.alias || s.seller.name,
        img: s.thumbnailUrl || s.sourceImageUrl,
        isVideo: s.mediaType === 2,
        sourceUrlOnly: !s.thumbnailUrl && !!s.sourceImageUrl,
        takenAtLabel: fmtKst(s.takenAt),
        snsHandle: s.seller.snsHandle,
        classification,
      },
    ];
  });

  return (
    // 페이지 머리(제목·설명) 없음 — 오너 디자인 방침(2026-10-21). 수집 버튼은 본문 맨 위 도구줄(분류 탭 줄)
    // 오른쪽 끝에 둔다. 세로 스크롤러는 CrmShell 이 소유한다.
    <CrmShell>
    <div className="mx-auto max-w-6xl px-6 py-8">
      <StoryInboxGrid
        filter={filter}
        counts={{ UNREVIEWED: countOf("UNREVIEWED"), CAMPAIGN: countOf("CAMPAIGN"), OTHER: countOf("OTHER") }}
        total={counts.reduce((sum, x) => sum + x._count, 0)}
        cards={cards}
        actions={
          <>
            {/* 전체 수집(게시물+스토리, 고비용·순차) vs 스토리만(저비용·1콜) — 두 옵션 분리 제공 */}
            <BulkContentCollectButton targets={bulkTargets} />
            <StoryCollectButton />
          </>
        }
      />
    </div>
    </CrmShell>
  );
}
