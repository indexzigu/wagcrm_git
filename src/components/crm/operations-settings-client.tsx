"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CircleDollarSign, Save, Target, CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type GoalResponse = {
  year: string;
  annualTarget: number | null;
  monthlyTargets: Array<number | null>;
  canEdit: boolean;
  schemaReady: boolean;
};

// 알림 크론 폐지(2026-07-24)로 남은 설정은 일정 커버리지 임계뿐이다.
type ReminderSettings = {
  scheduleThresholds: { idealDays: number; minDays: number; deadlineDays: number };
};

type ChannelFee = {
  id: string;
  channel: string;
  label: string;
  feeRate: number;
  paymentRate: number;
  notes: string | null;
};

function parseAmount(value: string) {
  return value.trim() === "" ? null : Number(value);
}

export function OperationsSettingsClient() {
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [goals, setGoals] = useState<GoalResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [reminders, setReminders] = useState<ReminderSettings | null>(null);
  const [channels, setChannels] = useState<ChannelFee[]>([]);
  const [savingSection, setSavingSection] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const response = await fetch(`/api/settings/revenue-goals?year=${year}`);
      if (!response.ok) {
        toast.error("매출 목표를 불러오지 못했습니다.");
        return;
      }
      setGoals(await response.json());
    }
    void load();
  }, [year]);

  useEffect(() => {
    async function loadOperationsSettings() {
      const [reminderResponse, channelResponse] = await Promise.all([
        fetch("/api/settings/reminders"),
        fetch("/api/settings/channel-fees"),
      ]);
      if (reminderResponse.ok) setReminders(await reminderResponse.json());
      if (channelResponse.ok) setChannels((await channelResponse.json()).channels);
    }
    void loadOperationsSettings();
  }, []);

  async function save() {
    if (!goals) return;
    setSaving(true);
    const response = await fetch("/api/settings/revenue-goals", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(goals),
    });
    setSaving(false);
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      toast.error(payload?.error ?? "매출 목표 저장에 실패했습니다.");
      return;
    }
    toast.success("매출 목표를 저장했습니다.");
  }

  async function saveReminders() {
    if (!reminders) return;
    setSavingSection("reminders");
    const response = await fetch("/api/settings/reminders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reminders),
    });
    setSavingSection(null);
    if (response.ok) {
      toast.success("일정 확보 기준일을 저장했습니다.");
    } else {
      toast.error("일정 확보 기준일 저장에 실패했습니다.");
    }
  }

  async function saveChannel(channel: ChannelFee) {
    setSavingSection(channel.channel);
    const response = await fetch("/api/settings/channel-fees", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(channel),
    });
    setSavingSection(null);
    if (response.ok) {
      toast.success(`${channel.label} 수수료를 저장했습니다.`);
    } else {
      toast.error("채널 수수료 저장에 실패했습니다.");
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <Card className="rounded-[24px] border border-border/70 bg-white/90 shadow-soft-sm overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-3 border-b border-border/50 py-3.5 px-6">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Target className="size-4 text-primary" /> 매출 목표
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">캠페인 목표가 아니라 월·연 서비스 매출 목표를 독립 관리합니다.</p>
          </div>
          <Input 
            className="w-28 h-8 text-xs border-slate-200 focus-visible:ring-focus-ring" 
            type="number" 
            min="2020" 
            max="2100" 
            value={year} 
            onChange={(event) => setYear(event.target.value)} 
          />
        </CardHeader>
        <CardContent className="space-y-5 p-6">
          {!goals ? <p className="text-xs text-muted-foreground">불러오는 중...</p> : (
            <>
              <label className="block space-y-1">
                <span className="text-[11px] font-semibold text-muted-foreground uppercase">연간 목표 매출</span>
                <Input
                  type="number"
                  min="0"
                  disabled={!goals.canEdit}
                  value={goals.annualTarget ?? ""}
                  onChange={(event) => setGoals({ ...goals, annualTarget: parseAmount(event.target.value) })}
                  className="border-slate-200 focus-visible:ring-focus-ring"
                />
              </label>
              <div className="grid gap-3.5 sm:grid-cols-3 lg:grid-cols-4">
                {goals.monthlyTargets.map((value, index) => (
                  <label key={index} className="space-y-1">
                    <span className="text-[11px] font-semibold text-muted-foreground">{index + 1}월 목표</span>
                    <Input
                      type="number"
                      min="0"
                      disabled={!goals.canEdit}
                      value={value ?? ""}
                      onChange={(event) => {
                        const monthlyTargets = [...goals.monthlyTargets];
                        monthlyTargets[index] = parseAmount(event.target.value);
                        setGoals({ ...goals, monthlyTargets });
                      }}
                      className="border-slate-200 focus-visible:ring-focus-ring h-9"
                    />
                  </label>
                ))}
              </div>
              <div className="flex items-center justify-between pt-2">
                <p className="text-[10px] font-medium text-muted-foreground">
                  {goals.canEdit ? "✓ 관리자 권한으로 편집 중" : "목표 수정은 관리자만 가능합니다."}
                </p>
                {goals.canEdit ? (
                  <Button 
                    onClick={save} 
                    disabled={saving || !goals.schemaReady} 
                    className="h-9 px-4 rounded-lg text-xs shadow-soft-sm"
                  >
                    <Save className="mr-1.5 size-3.5" />
                    {saving ? "저장 중..." : "목표 저장"}
                  </Button>
                ) : null}
              </div>
              {!goals.schemaReady ? (
                <p className="text-[11px] font-semibold text-rose-600 bg-rose-50 border border-rose-100 p-3 rounded-xl">
                  ⚠️ 현재 DB에 `RevenueGoal` 테이블이 없어 목표 저장이 비활성 상태입니다. 최신 마이그레이션 적용 후 사용 가능합니다.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-[24px] border border-border/70 bg-white/90 shadow-soft-sm overflow-hidden">
        <CardHeader className="border-b border-border/50 py-3.5 px-6">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <CalendarRange className="size-4 text-blue-500" /> 일정 확보 기준일
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5 p-6">
          {!reminders ? <p className="text-xs text-muted-foreground">불러오는 중...</p> : (
            <>
              <div>
                <p className="text-xs font-semibold text-slate-800">대시보드 일정 커버리지 기준</p>
                <p className="text-[11px] text-muted-foreground">공구 시작일 기준으로 역산하여 브리핑 카드의 긴급도를 판단합니다.</p>
              </div>
              <div className="grid gap-3.5 sm:grid-cols-3 pt-2 border-t border-slate-100">
                <label className="space-y-1">
                  <span className="text-[11px] font-semibold text-muted-foreground">이상적 확보 기한 (일 전)</span>
                  <Input 
                    type="number" 
                    min="1" 
                    value={reminders.scheduleThresholds.idealDays} 
                    onChange={(e) => setReminders({ ...reminders, scheduleThresholds: { ...reminders.scheduleThresholds, idealDays: Number(e.target.value) } })} 
                    className="border-slate-200 focus-visible:ring-focus-ring h-9"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] font-semibold text-muted-foreground">최소 확정 기한 (일 전)</span>
                  <Input 
                    type="number" 
                    min="1" 
                    value={reminders.scheduleThresholds.minDays} 
                    onChange={(e) => setReminders({ ...reminders, scheduleThresholds: { ...reminders.scheduleThresholds, minDays: Number(e.target.value) } })} 
                    className="border-slate-200 focus-visible:ring-focus-ring h-9"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] font-semibold text-muted-foreground">최후 마지노선 (일 전)</span>
                  <Input 
                    type="number" 
                    min="1" 
                    value={reminders.scheduleThresholds.deadlineDays} 
                    onChange={(e) => setReminders({ ...reminders, scheduleThresholds: { ...reminders.scheduleThresholds, deadlineDays: Number(e.target.value) } })} 
                    className="border-slate-200 focus-visible:ring-focus-ring h-9"
                  />
                </label>
              </div>
              <div className="flex justify-end border-t border-slate-100 pt-5">
                <Button 
                  variant="outline" 
                  onClick={saveReminders} 
                  disabled={savingSection === "reminders"}
                  className="h-9 px-4 rounded-lg text-xs shadow-soft-sm hover:bg-slate-50"
                >
                  <Save className="mr-1.5 size-3.5" />
                  설정 저장
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-[24px] border border-border/70 bg-white/90 shadow-soft-sm overflow-hidden">
        <CardHeader className="border-b border-border/50 py-3.5 px-6">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <CircleDollarSign className="size-4 text-indigo-500" /> 채널 수수료
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 p-6">
          {channels.map((channel) => (
            <div 
              key={channel.channel} 
              className="space-y-3.5 rounded-xl border border-slate-100 bg-white/50 p-4 shadow-soft-sm hover:bg-white/80 transition-colors"
            >
              <p className="text-xs font-bold text-slate-800">{channel.label}</p>
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">스토어 수수료 (%)</span>
                  <Input 
                    type="number" 
                    min="0" 
                    step="0.01" 
                    value={channel.feeRate} 
                    onChange={(event) => setChannels((current) => current.map((item) => item.channel === channel.channel ? { ...item, feeRate: Number(event.target.value) } : item))} 
                    className="border-slate-200 focus-visible:ring-focus-ring h-8 text-xs"
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">결제 수수료 (%)</span>
                  <Input 
                    type="number" 
                    min="0" 
                    step="0.01" 
                    value={channel.paymentRate} 
                    onChange={(event) => setChannels((current) => current.map((item) => item.channel === channel.channel ? { ...item, paymentRate: Number(event.target.value) } : item))} 
                    className="border-slate-200 focus-visible:ring-focus-ring h-8 text-xs"
                  />
                </label>
              </div>
              <div className="flex justify-end pt-1">
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={() => saveChannel(channel)} 
                  disabled={savingSection === channel.channel}
                  className="h-8 rounded-lg text-[11px] shadow-soft-sm hover:bg-slate-50"
                >
                  <Save className="mr-1 size-3" />
                  저장
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
