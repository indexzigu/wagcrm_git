// TODO(B3 삭제 후보): 이 훅은 소비처가 없는 죽은 코드다(B1-3/B1-4 청사진 결정 A).
// 실제 /outreach 화면(src/app/outreach/page.tsx)은 동일 로직을 인라인으로 복제해서 쓰며,
// 그 인라인 fetch/state는 이미 useQuery(queryKeys.outreach())로 전환됐다.
// 이 파일은 참고용으로만 남겨두고, 다음 정리 라운드(B3)에서 삭제 검토할 것.
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import type { OutreachRow } from "@/components/crm/outreach-list";
import type { OutreachStatus } from "@/lib/validations/outreach";

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export type UseOutreachOptions = {
  onStatusChange?: (id: string, newStatus: OutreachStatus) => Promise<any>;
  onCreateCampaign?: (taskId: string) => Promise<any>;
  onReminderSent?: (taskId: string) => Promise<any>;
  onDropTask?: (taskId: string, reason: string) => Promise<any>;
  onSaveField?: (taskId: string, field: string, value: string) => Promise<any>;
};

export function useOutreach(options?: UseOutreachOptions) {
  const [tasks, setTasks] = useState<OutreachRow[]>([]);
  const [selectedTask, setSelectedTask] = useState<OutreachRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingMemoField, setSavingMemoField] = useState<string | null>(null);

  const fetchTasks = useCallback(async () => {
    try {
      const response = await fetch("/api/outreach");
      if (!response.ok) {
        throw new Error("영업 테스크를 불러오지 못했습니다.");
      }
      const data = await response.json();
      setTasks(data.outreaches ?? []);
    } catch {
      toast.error("영업 테스크를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  const applyTaskUpdate = useCallback((taskId: string, updated: Partial<OutreachRow>) => {
    setTasks((current) =>
      current.map((item) =>
        item.id === taskId
          ? {
              ...item,
              ...updated,
            }
          : item
      )
    );
    setSelectedTask((current) =>
      current && current.id === taskId
        ? {
            ...current,
            ...updated,
          }
        : current
    );
  }, []);

  useEffect(() => {
    void fetchTasks();
  }, [fetchTasks]);

  const handleStatusChange = useCallback(async (id: string, newStatus: OutreachStatus) => {
    try {
      if (options?.onStatusChange) {
        const updated = await options.onStatusChange(id, newStatus);
        applyTaskUpdate(id, updated);
        return;
      }
      const currentTask = tasks.find((item) => item.id === id);
      const shouldCreateCampaignOnConvert =
        newStatus === "CONVERTED" && currentTask != null && !currentTask.linkedCampaignId;

      const response = await fetch(`/api/outreach/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          status: shouldCreateCampaignOnConvert ? "PENDING_APPROVAL" : newStatus,
          autoCreateCampaign: shouldCreateCampaignOnConvert || undefined,
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || "상태 변경에 실패했습니다.");
      }
      const updated = await response.json();
      applyTaskUpdate(id, updated);
      toast.success("진행 상태가 변경되었습니다.");
    } catch (err: any) {
      toast.error(err.message || "상태 변경에 실패했습니다.");
      throw err;
    }
  }, [applyTaskUpdate, tasks, options]);

  const handleCreateCampaign = useCallback(async (taskId: string) => {
    try {
      if (options?.onCreateCampaign) {
        const updated = await options.onCreateCampaign(taskId);
        applyTaskUpdate(taskId, updated);
        return;
      }
      const promise = fetch(`/api/outreach/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PENDING_APPROVAL", autoCreateCampaign: true }),
      }).then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error ?? "캠페인 생성에 실패했습니다.");
        }
        const updated = await res.json();
        applyTaskUpdate(taskId, updated);
        return updated;
      });

      withMutationFeedback(promise, "캠페인이 생성되었습니다.").catch(() => {});
      await promise;
    } catch (err: any) {
      throw err;
    }
  }, [applyTaskUpdate, options]);

  const handleReminderSent = useCallback(async (taskId: string) => {
    try {
      if (options?.onReminderSent) {
        const updated = await options.onReminderSent(taskId);
        applyTaskUpdate(taskId, updated);
        return;
      }
      const now = new Date();
      const promise = fetch(`/api/outreach/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "PROPOSED",
          lastReminderAt: now.toISOString(),
          nextReminderAt: addDays(now, 3).toISOString(),
        }),
      }).then(async (res) => {
        if (!res.ok) throw new Error("리마인드 처리에 실패했습니다.");
        const updated = await res.json();
        applyTaskUpdate(taskId, updated);
        return updated;
      });

      withMutationFeedback(promise, "리마인드가 처리되었습니다.").catch(() => {});
      await promise;
    } catch (err: any) {
      throw err;
    }
  }, [applyTaskUpdate, options]);

  const handleDropTask = useCallback(async (taskId: string, reason: string) => {
    try {
      if (options?.onDropTask) {
        const updated = await options.onDropTask(taskId, reason);
        applyTaskUpdate(taskId, updated);
        return;
      }
      const promise = fetch(`/api/outreach/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "DROPPED",
          dropReason: reason.trim() || "수동 종료",
        }),
      }).then(async (res) => {
        if (!res.ok) throw new Error("드랍 처리에 실패했습니다.");
        const updated = await res.json();
        applyTaskUpdate(taskId, updated);
        return updated;
      });

      withMutationFeedback(promise, "영업 테스크가 드랍(종료)되었습니다.").catch(() => {});
      await promise;
    } catch (err: any) {
      throw err;
    }
  }, [applyTaskUpdate, options]);

  const handleTaskFieldSave = useCallback(async (taskId: string, field: string, value: string) => {
    try {
      if (options?.onSaveField) {
        const updated = await options.onSaveField(taskId, field, value);
        applyTaskUpdate(taskId, updated);
        return;
      }
      setSavingMemoField(`${taskId}:${field}`);
      const promise = fetch(`/api/outreach/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value.trim() || null }),
      }).then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error ?? "테스크 정보 저장에 실패했습니다.");
        }
        const updated = await res.json();
        applyTaskUpdate(taskId, updated);
        return updated;
      }).finally(() => {
        setSavingMemoField(null);
      });

      withMutationFeedback(promise, "저장되었습니다.").catch(() => {});
      await promise;
    } catch (err: any) {
      throw err;
    }
  }, [applyTaskUpdate, options]);

  return {
    tasks,
    setTasks,
    selectedTask,
    setSelectedTask,
    loading,
    setLoading,
    fetchTasks,
    savingMemoField,
    handleStatusChange,
    handleCreateCampaign,
    handleReminderSent,
    handleDropTask,
    handleTaskFieldSave,
  };
}
