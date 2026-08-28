import Link from "next/link";
import { ArrowUpRightIcon } from "lucide-react";
import { CrmShell } from "@/components/crm/crm-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getCachedMetaReviewChecklistData } from "@/lib/cached-crm-data";

export default async function MetaReviewChecklistPage() {
  const { data, thirtyDaysAgoStr, instagramSuccessLogs } = await getCachedMetaReviewChecklistData();

  // 증빙 집계는 provider·기간·성공을 DB에서 좁힌 전용 조회를 쓴다 — 공유 top-20 창을
  // 필터하면 다른 provider 행(NAVER 계측 등)이 상위를 점거할 때 0건으로 보인다.
  const recentSuccess = instagramSuccessLogs.filter(
    (log) => log.calledAt.slice(0, 10) >= thirtyDaysAgoStr,
  );

  return (
    <CrmShell>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
          {/* 제어 탑바 */}
          <div className="crm-topbar flex flex-col gap-4 border-b border-border/70 px-5 py-3 sm:flex-row sm:items-center sm:justify-between shrink-0 bg-white/40">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-primary mb-0.5">
                Operations
              </p>
              <h1 className="text-sm font-bold text-foreground">
                Meta App Review 체크리스트
              </h1>
            </div>
            <Button variant="outline" size="sm" className="h-8 rounded-lg text-xs" asChild>
              <Link href="/privacy">
                <ArrowUpRightIcon className="mr-1 size-3.5 text-muted-foreground" />
                Privacy page
              </Link>
            </Button>
          </div>

          {/* 본문 스크롤 영역 */}
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            <section className="grid gap-4 md:grid-cols-3">
              <ReviewCard
                title="최근 30일 성공 호출"
                ok={recentSuccess.length > 0}
                detail={`${recentSuccess.length}건`}
              />
              <ReviewCard
                title="Privacy Policy URL"
                ok
                detail="/privacy 페이지 준비됨"
              />
              <ReviewCard
                title="1080p 시연 영상"
                ok={false}
                detail="실제 제출 전 녹화 필요"
              />
            </section>

            <Card className="rounded-[24px] border border-border/70 bg-white/90 shadow-soft-sm overflow-hidden">
              <CardHeader className="border-b border-border/50 py-3.5 px-6">
                <CardTitle className="text-xs font-semibold text-foreground">최근 API 로그</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2.5 pt-4 px-6 pb-5">
                {data.apiCallLogs.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">최근 API 호출 로그가 없습니다.</p>
                ) : (
                  data.apiCallLogs.map((log) => (
                    <div
                      key={log.id}
                      className="flex items-center justify-between rounded-xl border border-slate-100 bg-white/50 px-4 py-3 text-xs shadow-soft-sm hover:bg-slate-50/50 transition-colors"
                    >
                      <div className="min-w-0 pr-4">
                        <div className="truncate font-semibold text-slate-800">
                          {log.provider} · <span className="font-mono text-[10px] text-muted-foreground">{log.permissionScope ?? "internal"}</span>
                        </div>
                        <div className="truncate text-[10px] text-slate-500 font-mono mt-0.5">
                          {log.endpoint} · {new Date(log.calledAt).toLocaleString("ko-KR")}
                        </div>
                      </div>
                      <Badge variant={log.success ? "default" : "destructive"} className="h-5 px-1.5 text-[10px] font-mono shrink-0">
                        {log.statusCode}
                      </Badge>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </CrmShell>
  );
}

function ReviewCard({
  title,
  ok,
  detail,
}: {
  title: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <Card className="rounded-[24px] border border-border/70 bg-white/90 shadow-soft-sm overflow-hidden p-5 flex flex-col justify-between h-32">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold text-slate-700">{title}</h3>
        <Badge variant={ok ? "default" : "secondary"} className="h-5 px-2 text-[10px]">
          {ok ? "준비됨" : "작업 필요"}
        </Badge>
      </div>
      <p className="text-[11px] font-medium text-muted-foreground">{detail}</p>
    </Card>
  );
}
