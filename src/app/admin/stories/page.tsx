// 스토리 스냅샷 분류함 — capture-stories 크론이 모은 "행사 기간 전량 수집" 스토리를
// 사람이 훑어보며 캠페인 홍보(CAMPAIGN)/무관(OTHER)으로 분류한다(오너 지시 2026-07-10:
// 태그 기반이 아니라 전량 수집 후 썸네일 후분류). 추후 LLM 배치 분류가 붙어도 이 화면이
// 검수·정정 표면으로 남는다.
import type { Metadata } from "next";
import Link from "next/link";
import { getPrisma } from "@/lib/prisma";
import { StoryCollectButton } from "@/components/crm/story-collect-button";
import { BulkContentCollectButton } from "@/components/crm/bulk-content-collect-button";
import { listCaptureWindowSellers } from "@/lib/story-capture";
import { classifyStory } from "./actions";

export const metadata: Metadata = { title: "스토리 분류함" };

type Filter = "unreviewed" | "campaign" | "other" | "all";

const FILTERS: { key: Filter; label: string; where?: string }[] = [
  { key: "unreviewed", label: "미분류" },
  { key: "campaign", label: "캠페인 홍보" },
  { key: "other", label: "무관" },
  { key: "all", label: "전체" },
];

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
  const filter: Filter = (FILTERS.find((x) => x.key === f)?.key ?? "unreviewed") as Filter;

  const where =
    filter === "unreviewed"
      ? { classification: "UNREVIEWED" }
      : filter === "campaign"
        ? { classification: "CAMPAIGN" }
        : filter === "other"
          ? { classification: "OTHER" }
          : {};

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

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">스토리 분류함</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            행사 기간(시작 7일 전~마감 1일 후) 중 셀러의 모든 스토리를 매일 자정에 수집합니다. 캠페인 홍보
            스토리만 골라 분류하면 홍보 이력·성과 근거로 남습니다.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* 전체 수집(게시물+스토리, 고비용·순차) vs 스토리만(저비용·1콜) — 두 옵션 분리 제공 */}
          <BulkContentCollectButton targets={bulkTargets} />
          <StoryCollectButton />
        </div>
      </header>

      <nav className="mb-5 flex items-center gap-1.5">
        {FILTERS.map((tab) => {
          const count =
            tab.key === "all"
              ? counts.reduce((a, x) => a + x._count, 0)
              : countOf(tab.key === "unreviewed" ? "UNREVIEWED" : tab.key === "campaign" ? "CAMPAIGN" : "OTHER");
          const active = tab.key === filter;
          return (
            <Link
              key={tab.key}
              href={`/admin/stories?f=${tab.key}`}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              {tab.label} {count}
            </Link>
          );
        })}
      </nav>

      {snapshots.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
          {filter === "unreviewed"
            ? "분류할 스토리가 없습니다. 다음 수집(매일 00:00 KST)을 기다려주세요."
            : "해당 분류의 스토리가 없습니다."}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {snapshots.map((s) => {
            const displayName = s.seller.alias || s.seller.name;
            const img = s.thumbnailUrl || s.sourceImageUrl;
            return (
              <div key={s.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-soft-sm">
                <div className="relative aspect-[9/16] bg-slate-100">
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-[11px] text-slate-500">
                      썸네일 없음
                    </div>
                  )}
                  {s.mediaType === 2 && (
                    <span className="absolute right-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      영상
                    </span>
                  )}
                  {!s.thumbnailUrl && s.sourceImageUrl && (
                    <span className="absolute left-1.5 top-1.5 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      원본 URL(만료 가능)
                    </span>
                  )}
                </div>
                <div className="px-2.5 py-2">
                  <div className="truncate text-xs font-semibold text-slate-800">{displayName}</div>
                  <div className="mt-0.5 text-[10px] text-slate-500">
                    {fmtKst(s.takenAt)} · @{s.seller.snsHandle}
                  </div>
                  <div className="mt-2 flex gap-1">
                    {s.classification === "UNREVIEWED" ? (
                      <>
                        <form action={classifyStory.bind(null, s.id, "CAMPAIGN")} className="flex-1">
                          <button className="w-full rounded-md bg-emerald-600 py-1 text-[11px] font-bold text-white hover:bg-emerald-500">
                            캠페인
                          </button>
                        </form>
                        <form action={classifyStory.bind(null, s.id, "OTHER")} className="flex-1">
                          <button className="w-full rounded-md bg-slate-200 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-300">
                            무관
                          </button>
                        </form>
                      </>
                    ) : (
                      <form action={classifyStory.bind(null, s.id, "UNREVIEWED")} className="flex-1">
                        <button className="w-full rounded-md border border-slate-200 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-50">
                          {s.classification === "CAMPAIGN" ? "✓ 캠페인 홍보" : "무관"} (되돌리기)
                        </button>
                      </form>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
