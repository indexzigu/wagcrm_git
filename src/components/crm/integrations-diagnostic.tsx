"use client";

import { useState } from "react";
import {
  FolderOpen,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Play,
  CloudLightning,
  ExternalLink,
  Server,
  HelpCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CalendarOrphanCleanupDialog } from "@/components/crm/calendar-orphan-cleanup-dialog";
import { Badge } from "@/components/ui/badge";

type IntegrationStatus = {
  connected: boolean;
  status: "CONNECTED" | "DISCONNECTED" | "ERROR";
  accountEmail: string | null;
  rootFolderId?: string | null;
  lastError: string | null;
  /** 입금·출금(회계·정산) 이벤트가 가는 캘린더 ID — null 이면 primary 로 통합 */
  financeCalendarId?: string | null;
};

type SupabaseStats = {
  supabaseEstimatedBytes: number;
  supabaseLimitBytes: number;
};

export function IntegrationsDiagnostic({
  initialDriveStatus,
  initialCalendarStatus,
  supabaseStats,
}: {
  initialDriveStatus: IntegrationStatus;
  initialCalendarStatus: IntegrationStatus;
  supabaseStats: SupabaseStats;
}) {
  const [drive, setDrive] = useState<IntegrationStatus>(initialDriveStatus);
  const [calendar, setCalendar] = useState<IntegrationStatus>(initialCalendarStatus);

  const [driveLoading, setDriveLoading] = useState(false);
  const [calendarLoading, setCalendarLoading] = useState(false);

  const [driveLastCheck, setDriveLastCheck] = useState<string | null>(null);
  const [calendarLastCheck, setCalendarLastCheck] = useState<string | null>(null);

  const [financeCalendarInput, setFinanceCalendarInput] = useState(
    initialCalendarStatus.financeCalendarId ?? "",
  );
  const [financeCalendarSaving, setFinanceCalendarSaving] = useState(false);

  async function saveFinanceCalendarId() {
    setFinanceCalendarSaving(true);
    try {
      const response = await fetch("/api/integrations/google-calendar/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financeCalendarId: financeCalendarInput.trim() || null }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error ?? "회계·정산 캘린더 저장에 실패했습니다.");
        return;
      }
      setCalendar(data as IntegrationStatus);
      setFinanceCalendarInput((data as IntegrationStatus).financeCalendarId ?? "");
      toast.success(
        (data as IntegrationStatus).financeCalendarId
          ? "회계·정산 캘린더를 저장했습니다. /calendar 의 '전체 동기화'를 한 번 실행하면 기존 입금·출금 일정이 새 캘린더로 이동합니다."
          : "회계·정산 캘린더 분리를 해제했습니다. 다음 동기화부터 모든 일정이 기본 캘린더로 갑니다.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "회계·정산 캘린더 저장에 실패했습니다.");
    } finally {
      setFinanceCalendarSaving(false);
    }
  }

  async function triggerDriveDiagnostic() {
    setDriveLoading(true);
    try {
      const response = await fetch("/api/integrations/google-drive/test", {
        method: "POST",
      });
      if (response.ok) {
        const nextStatus = (await response.json()) as IntegrationStatus;
        setDrive(nextStatus);
        setDriveLastCheck(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      } else {
        setDrive((prev) => ({
          ...prev,
          status: "ERROR",
          lastError: `구글 드라이브 진단 API가 응답 상태 코드 ${response.status}을 반환했습니다.`,
        }));
      }
    } catch (err) {
      setDrive((prev) => ({
        ...prev,
        status: "ERROR",
        lastError: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setDriveLoading(false);
    }
  }

  async function triggerCalendarDiagnostic() {
    setCalendarLoading(true);
    try {
      const response = await fetch("/api/integrations/google-calendar/test", {
        method: "POST",
      });
      if (response.ok) {
        const nextStatus = (await response.json()) as IntegrationStatus;
        setCalendar(nextStatus);
        setCalendarLastCheck(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      } else {
        setCalendar((prev) => ({
          ...prev,
          status: "ERROR",
          lastError: `구글 캘린더 진단 API가 응답 상태 코드 ${response.status}을 반환했습니다.`,
        }));
      }
    } catch (err) {
      setCalendar((prev) => ({
        ...prev,
        status: "ERROR",
        lastError: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setCalendarLoading(false);
    }
  }

  async function reconnectDrive() {
    try {
      const response = await fetch("/api/integrations/google-drive/connect", {
        method: "POST",
      });
      const data = await response.json();
      if (response.ok && data.authUrl) {
        window.location.href = data.authUrl;
      }
    } catch (err) {
      console.error("구글 드라이브 OAuth 연동 시도 실패:", err);
    }
  }

  async function reconnectCalendar() {
    try {
      const response = await fetch("/api/integrations/google-calendar/connect", {
        method: "POST",
      });
      const data = await response.json();
      if (response.ok && data.authUrl) {
        window.location.href = data.authUrl;
      }
    } catch (err) {
      console.error("구글 캘린더 OAuth 연동 시도 실패:", err);
    }
  }

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const statusMap = {
    CONNECTED: {
      label: "정상 연동됨",
      color: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/20 dark:text-emerald-400 dark:border-emerald-900/30",
      icon: <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />,
    },
    DISCONNECTED: {
      label: "연결 해제됨",
      color: "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
      icon: <AlertTriangle className="size-4 text-slate-400 shrink-0" />,
    },
    ERROR: {
      label: "인증 에러",
      color: "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/20 dark:text-rose-400 dark:border-rose-900/30",
      icon: <XCircle className="size-4 text-rose-500 shrink-0" />,
    },
  };

  return (
    <div className="w-full space-y-6 max-w-5xl">
      {/* 상단 소개 헤더 */}
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-50">외부 서비스 연동 진단 및 복구</h1>
        <p className="text-xs text-muted-foreground">
          구글 드라이브(에셋 스토리지) 및 구글 캘린더(일정 동기화)의 인증 무결성을 진단하고, 필요한 경우 자격 증명을 복원할 수 있습니다.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* 통합 진단 목록 카드 */}
        <Card className="rounded-[24px] border border-border/70 bg-white/90 shadow-soft-sm overflow-hidden lg:col-span-2">
          <CardHeader className="pb-3 border-b border-border/50 bg-slate-50/50 px-6 py-4">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Server className="size-4 text-primary shrink-0" />
              연동 서비스 자격 무결성 진단 목록
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 divide-y divide-border/50">
            {/* 1. 구글 드라이브 연동 */}
            <div className="p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-amber-50 rounded-xl border border-amber-100 dark:bg-amber-950/10 dark:border-amber-900/20">
                    <FolderOpen className="size-5 text-amber-600" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                      구글 드라이브 (Google Drive)
                      <Badge variant="outline" className={`py-0.5 px-2 text-[10px] font-semibold border ${statusMap[drive.status].color}`}>
                        <span className="flex items-center gap-1">
                          {statusMap[drive.status].icon}
                          {statusMap[drive.status].label}
                        </span>
                      </Badge>
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">대용량 마케팅 에셋 및 아카이빙 영구 보존 스토리지</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-lg text-xs gap-1 px-3 border-slate-200 hover:bg-slate-50"
                    onClick={triggerDriveDiagnostic}
                    disabled={driveLoading}
                  >
                    <Play className={`size-3 shrink-0 ${driveLoading ? "animate-spin" : ""}`} />
                    {driveLoading ? "진단 중..." : "진단 테스트"}
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 rounded-lg bg-primary hover:bg-primary/90 text-white text-xs gap-1 px-3"
                    onClick={reconnectDrive}
                  >
                    <ExternalLink className="size-3 shrink-0" />
                    재승인 및 복구
                  </Button>
                </div>
              </div>

              {/* 드라이브 상세 정보 */}
              <div className="grid gap-3 sm:grid-cols-2 bg-slate-50/50 p-4 rounded-xl border border-slate-100 text-xs">
                <div className="space-y-0.5">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase">연동 계정</span>
                  <p className="font-semibold text-slate-800 dark:text-slate-200">
                    {drive.accountEmail ?? "— 연결되지 않음 —"}
                  </p>
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase">루트 폴더 ID</span>
                  <p className="font-mono text-slate-600 dark:text-slate-400 truncate" title={drive.rootFolderId ?? ""}>
                    {drive.rootFolderId ?? "— 연결되지 않음 —"}
                  </p>
                </div>
              </div>

              {drive.lastError && (
                <div className="flex gap-2 items-start p-3 bg-rose-50/50 border border-rose-100 rounded-xl text-rose-800 text-xs">
                  <AlertTriangle className="size-3.5 text-rose-500 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="font-semibold">에러 로그</p>
                    <p className="font-mono mt-0.5 break-all">{drive.lastError}</p>
                  </div>
                </div>
              )}

              {driveLastCheck && (
                <p className="text-[10px] text-muted-foreground text-right">
                  마지막 구글 드라이브 진단 시각: <span className="font-semibold font-mono">{driveLastCheck}</span>
                </p>
              )}
            </div>

            {/* 2. 구글 캘린더 연동 */}
            <div className="p-6 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-blue-50 rounded-xl border border-blue-100 dark:bg-blue-950/10 dark:border-blue-900/20">
                    <Calendar className="size-5 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                      구글 캘린더 (Google Calendar)
                      <Badge variant="outline" className={`py-0.5 px-2 text-[10px] font-semibold border ${statusMap[calendar.status].color}`}>
                        <span className="flex items-center gap-1">
                          {statusMap[calendar.status].icon}
                          {statusMap[calendar.status].label}
                        </span>
                      </Badge>
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">캠페인 일정 및 입금/출금 예정일 자동 캘린더 등록</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-lg text-xs gap-1 px-3 border-slate-200 hover:bg-slate-50"
                    onClick={triggerCalendarDiagnostic}
                    disabled={calendarLoading}
                  >
                    <Play className={`size-3 shrink-0 ${calendarLoading ? "animate-spin" : ""}`} />
                    {calendarLoading ? "진단 중..." : "진단 테스트"}
                  </Button>
                  {/* 잔재 정리는 상시 쓰는 기능이 아니라 유지보수다 — 매일 쓰는 /calendar
                      주 액션 옆이 아니라 연동 진단 카드가 집이다(오너 지적 2026-07-31). */}
                  <CalendarOrphanCleanupDialog />
                  <Button
                    size="sm"
                    className="h-8 rounded-lg bg-primary hover:bg-primary/90 text-white text-xs gap-1 px-3"
                    onClick={reconnectCalendar}
                  >
                    <ExternalLink className="size-3 shrink-0" />
                    재승인 및 복구
                  </Button>
                </div>
              </div>

              {/* 캘린더 상세 정보 */}
              <div className="grid gap-3 sm:grid-cols-2 bg-slate-50/50 p-4 rounded-xl border border-slate-100 text-xs">
                <div className="space-y-0.5">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase">연동 계정</span>
                  <p className="font-semibold text-slate-800 dark:text-slate-200">
                    {calendar.accountEmail ?? "— 연결되지 않음 —"}
                  </p>
                </div>
                <div className="space-y-0.5">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase">캠페인 일정 캘린더</span>
                  <p className="font-semibold text-slate-600 dark:text-slate-400">
                    Primary Calendar (기본 캘린더)
                  </p>
                </div>
              </div>

              {/* 회계·정산 캘린더 분리(2026-08-25) — 입금·출금 이벤트만 이 캘린더로 간다.
                  비우면 종전대로 전부 primary. 반영·이사는 다음 동기화(전체 동기화 1회)다.
                  읽기 전용 진단 그리드와 시각 언어가 섞이지 않게 별도 블록으로 둔다(ss-ux P1). */}
              <div className="space-y-1.5 bg-slate-50/50 p-4 rounded-xl border border-slate-100 text-xs">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase">
                  회계·정산 캘린더 ID (선택)
                </span>
                <div className="flex items-center gap-2">
                  <Input
                    value={financeCalendarInput}
                    onChange={(e) => setFinanceCalendarInput(e.target.value)}
                    placeholder="예: c8e…@group.calendar.google.com (비우면 기본 캘린더로 통합)"
                    className="h-8 flex-1 bg-white font-mono text-xs"
                    disabled={financeCalendarSaving}
                  />
                  <Button
                    size="sm"
                    className="h-8 rounded-lg bg-primary px-3 text-xs text-white hover:bg-primary/90"
                    onClick={saveFinanceCalendarId}
                    disabled={
                      financeCalendarSaving ||
                      financeCalendarInput.trim() === (calendar.financeCalendarId ?? "")
                    }
                  >
                    {financeCalendarSaving ? "저장 중..." : "저장"}
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground leading-normal">
                  입금·출금 일정만 이 캘린더로 분리 등록합니다. 저장 후 캘린더 화면의
                  &lsquo;전체 동기화&rsquo;를 한 번 실행하면 기존 입금·출금 일정이 새 캘린더로
                  이동합니다. (구글 캘린더 설정 → 해당 캘린더 → 캘린더 통합 → 캘린더 ID)
                </p>
              </div>

              {calendar.lastError && (
                <div className="flex gap-2 items-start p-3 bg-rose-50/50 border border-rose-100 rounded-xl text-rose-800 text-xs">
                  <AlertTriangle className="size-3.5 text-rose-500 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="font-semibold">에러 로그</p>
                    <p className="font-mono mt-0.5 break-all">{calendar.lastError}</p>
                  </div>
                </div>
              )}

              {calendarLastCheck && (
                <p className="text-[10px] text-muted-foreground text-right">
                  마지막 구글 캘린더 진단 시각: <span className="font-semibold font-mono">{calendarLastCheck}</span>
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 도움말 및 스토리지 현황 우측 카드 */}
        <div className="space-y-6">
          {/* 1. 토큰 자격 자가 복구 가이드 */}
          <Card className="rounded-[24px] border border-border/70 bg-white/90 shadow-soft-sm overflow-hidden">
            <CardHeader className="pb-3 border-b border-border/50 bg-slate-50/50 px-6 py-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <HelpCircle className="size-4 text-indigo-500 shrink-0" />
                연동 자격 가이드
              </CardTitle>
            </CardHeader>
            <CardContent className="p-5 space-y-4 text-xs leading-relaxed text-slate-600">
              <div className="space-y-3">
                <div className="bg-amber-50/50 border border-amber-100/50 rounded-xl p-3 text-slate-700">
                  <div className="flex items-center gap-1.5 font-bold text-amber-800 mb-1">
                    <CloudLightning className="size-3.5 text-amber-500 shrink-0 animate-pulse" />
                    토큰 자격 자가 복구 원리
                  </div>
                  구글 API 보안 정책으로 인해 비활성 기간이 길어지거나 리프레시 토큰이 회수될 경우, 연동이 끊어질 수 있습니다. **[재승인 및 복구]** 버튼을 통해 사용자가 직접 동의 화면으로 리다이렉트되어 새로운 토큰을 갱신해 복구할 수 있습니다.
                </div>
                <div className="space-y-2">
                  <h4 className="font-bold text-slate-800">구글 드라이브 연동 단계</h4>
                  <ol className="list-decimal ml-4 space-y-1">
                    <li>[재승인 및 복구] 클릭 후 구글 로그인</li>
                    <li>WAG CRM 파일 업로드 권한 동의</li>
                    <li>인증 정보가 서버에 암호화 저장되어 정상 작동</li>
                  </ol>
                </div>
                <div className="space-y-2 pt-2 border-t border-slate-100">
                  <h4 className="font-bold text-slate-800">구글 캘린더 연동 단계</h4>
                  <ol className="list-decimal ml-4 space-y-1">
                    <li>[재승인 및 복구] 클릭 후 권한 승인</li>
                    <li>캘린더의 일정 수정(events) 권한 획득</li>
                    <li>캠페인 마일스톤 일정이 캘린더에 동기화</li>
                  </ol>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* 2. 스토리지 사용 현황 */}
          <Card className="rounded-[24px] border border-border/70 bg-white/90 shadow-soft-sm overflow-hidden">
            <CardHeader className="pb-3 border-b border-border/50 bg-slate-50/50 px-6 py-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Server className="size-4 text-primary shrink-0" />
                Supabase 파일 스토리지 점유율
              </CardTitle>
            </CardHeader>
            <CardContent className="p-5 space-y-4">
              <div className="flex justify-between items-end text-xs">
                <div>
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase">추정 사용량</span>
                  <div className="text-lg font-bold font-mono text-slate-800 mt-0.5">
                    {formatBytes(supabaseStats.supabaseEstimatedBytes)}
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase">전체 무료 한도</span>
                  <div className="text-xs font-semibold font-mono text-slate-500 mt-0.5">
                    {formatBytes(supabaseStats.supabaseLimitBytes)}
                  </div>
                </div>
              </div>

              {/* 게이지 바 */}
              <div className="space-y-1">
                <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden border border-slate-200/40">
                  <div
                    className="w-full origin-left bg-indigo-600 h-2 rounded-full transition-transform duration-500"
                    style={{ transform: `scaleX(${Math.min(1, supabaseStats.supabaseEstimatedBytes / supabaseStats.supabaseLimitBytes)})` }}
                  />
                </div>
                <div className="flex justify-between text-[9px] text-slate-500">
                  <span>점유율: {((supabaseStats.supabaseEstimatedBytes / supabaseStats.supabaseLimitBytes) * 100).toFixed(1)}%</span>
                  <span>(Direct Upload limit: 20MB)</span>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground leading-normal bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                Supabase 무료 한도를 초과하지 않도록, 대용량 파일은 **구글 드라이브**로 자동 이관해 가상 바로가기로 관리합니다.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
