"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface ReminderSettings {
  sellerNoResponse: { enabled: boolean; intervals: [number, number, number] };
  settlementOverdue: { enabled: boolean; thresholdDays: number };
  stagnantStatus: { enabled: boolean };
}

const DEFAULT_SETTINGS: ReminderSettings = {
  sellerNoResponse: { enabled: true, intervals: [3, 5, 7] },
  settlementOverdue: { enabled: true, thresholdDays: 7 },
  stagnantStatus: { enabled: true },
};

export default function ReminderSettingsPage() {
  const [settings, setSettings] = useState<ReminderSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    async function loadSettings() {
      try {
        const res = await fetch("/api/settings/reminders");
        if (res.ok) {
          const data = await res.json();
          setSettings(data);
        }
      } catch {
        toast.error("설정을 불러오는데 실패했습니다");
      } finally {
        setLoading(false);
      }
    }
    void loadSettings();
  }, []);

  function validateIntervals(intervals: [number, number, number]): boolean {
    const [d1, d2, d3] = intervals;
    if (d1 >= d2 || d2 >= d3) {
      setValidationError("리마인더 간격은 오름차순이어야 합니다 (1단계 < 2단계 < 3단계)");
      return false;
    }
    setValidationError(null);
    return true;
  }

  function updateInterval(index: 0 | 1 | 2, value: number) {
    const newIntervals: [number, number, number] = [...settings.sellerNoResponse.intervals] as [number, number, number];
    newIntervals[index] = value;
    setSettings((prev) => ({
      ...prev,
      sellerNoResponse: { ...prev.sellerNoResponse, intervals: newIntervals },
    }));
    validateIntervals(newIntervals);
  }

  async function handleSave() {
    if (!validateIntervals(settings.sellerNoResponse.intervals)) return;

    setSaving(true);
    try {
      await withMutationFeedback(
        (async () => {
          const res = await fetch("/api/settings/reminders", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings),
          });
          if (res.ok) {
            const updated = await res.json();
            setSettings(updated);
          } else {
            const err = await res.json();
            throw new Error(err.error?.fieldErrors?.intervals?.[0] ?? "설정 저장에 실패했습니다");
          }
        })()
      ).catch(() => {});
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="w-full">
        <div className="text-sm text-muted-foreground">로딩 중...</div>
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="max-w-2xl space-y-6">
        {/* Seller No-Response */}
        <Card className="rounded-[24px] border border-border/70 bg-white/90 shadow-soft-sm overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-border/50 py-3.5 px-6">
            <div>
              <CardTitle className="text-sm font-semibold text-slate-800">셀러 무응답 리마인더</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                제안 후 무응답 시 단계별 리마인드 메시지를 생성합니다
              </p>
            </div>
            <Switch
              checked={settings.sellerNoResponse.enabled}
              onCheckedChange={(checked) =>
                setSettings((prev) => ({
                  ...prev,
                  sellerNoResponse: { ...prev.sellerNoResponse, enabled: checked },
                }))
              }
            />
          </CardHeader>
          <CardContent className="p-6">
            {settings.sellerNoResponse.enabled ? (
              <div className="space-y-4">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase">리마인더 간격 (일)</p>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-[10px] text-muted-foreground font-medium">1단계</Label>
                    <Input
                      type="number"
                      min="1"
                      value={settings.sellerNoResponse.intervals[0]}
                      onChange={(e) => updateInterval(0, parseInt(e.target.value) || 1)}
                      className="h-9 mt-1 border-slate-200 focus-visible:ring-focus-ring text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground font-medium">2단계</Label>
                    <Input
                      type="number"
                      min="1"
                      value={settings.sellerNoResponse.intervals[1]}
                      onChange={(e) => updateInterval(1, parseInt(e.target.value) || 1)}
                      className="h-9 mt-1 border-slate-200 focus-visible:ring-focus-ring text-xs"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-muted-foreground font-medium">3단계</Label>
                    <Input
                      type="number"
                      min="1"
                      value={settings.sellerNoResponse.intervals[2]}
                      onChange={(e) => updateInterval(2, parseInt(e.target.value) || 1)}
                      className="h-9 mt-1 border-slate-200 focus-visible:ring-focus-ring text-xs"
                    />
                  </div>
                </div>
                {validationError && (
                  <p className="text-xs text-destructive bg-destructive/5 border border-destructive/10 p-2 rounded-lg font-medium">{validationError}</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-2">리마인더 비활성화 상태</p>
            )}
          </CardContent>
        </Card>

        {/* Settlement Overdue */}
        <Card className="rounded-[24px] border border-border/70 bg-white/90 shadow-soft-sm overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-border/50 py-3.5 px-6">
            <div>
              <CardTitle className="text-sm font-semibold text-slate-800">정산 지연 리마인더</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                정산 대기 상태가 일정 기간 초과 시 독촉 메시지를 생성합니다
              </p>
            </div>
            <Switch
              checked={settings.settlementOverdue.enabled}
              onCheckedChange={(checked) =>
                setSettings((prev) => ({
                  ...prev,
                  settlementOverdue: { ...prev.settlementOverdue, enabled: checked },
                }))
              }
            />
          </CardHeader>
          <CardContent className="p-6">
            {settings.settlementOverdue.enabled ? (
              <div className="max-w-[200px] space-y-1">
                <Label className="text-[10px] text-muted-foreground font-medium">기준 일수</Label>
                <Input
                  type="number"
                  min="1"
                  value={settings.settlementOverdue.thresholdDays}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      settlementOverdue: {
                        ...prev.settlementOverdue,
                        thresholdDays: parseInt(e.target.value) || 1,
                      },
                    }))
                  }
                  className="h-9 mt-1 border-slate-200 focus-visible:ring-focus-ring text-xs"
                />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-2">리마인더 비활성화 상태</p>
            )}
          </CardContent>
        </Card>

        {/* Stagnant Status */}
        <Card className="rounded-[24px] border border-border/70 bg-white/90 shadow-soft-sm overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between gap-4 py-4 px-6">
            <div>
              <CardTitle className="text-sm font-semibold text-slate-800">상태 정체 리마인더</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                캠페인이 특정 상태에 오래 머물 때 후속 조치를 제안합니다
              </p>
            </div>
            <Switch
              checked={settings.stagnantStatus.enabled}
              onCheckedChange={(checked) =>
                setSettings((prev) => ({
                  ...prev,
                  stagnantStatus: { enabled: checked },
                }))
              }
            />
          </CardHeader>
        </Card>

        {/* Save Button */}
        <div className="flex justify-end border-t border-slate-100 pt-5">
          <Button onClick={handleSave} disabled={saving || !!validationError} className="h-9 px-4 rounded-lg text-xs shadow-soft-sm">
            {saving ? "저장 중..." : "설정 저장"}
          </Button>
        </div>
      </div>
    </div>
  );
}
