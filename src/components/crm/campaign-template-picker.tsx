"use client";

import { useEffect, useState } from "react";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";

export type CampaignTemplate = {
  id: string;
  name: string;
  dealId: string | null;
  salesChannel: string | null;
  marginSettings: string | null;
  trackingPattern: string | null;
};

type CampaignTemplatePickerProps = {
  onSelect: (template: CampaignTemplate) => void;
};

export function CampaignTemplatePicker({ onSelect }: CampaignTemplatePickerProps) {
  const [templates, setTemplates] = useState<CampaignTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchTemplates() {
      if (!cancelled) {
        setLoading(true);
      }
      try {
        const res = await fetch("/api/campaigns/templates");
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            setTemplates(data);
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetchTemplates();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setDeletingId(id);
    try {
      await withMutationFeedback(
        (async () => {
          const res = await fetch(`/api/campaigns/templates/${id}`, {
            method: "DELETE",
          });
          if (res.ok) {
            setTemplates((prev) => prev.filter((t) => t.id !== id));
          } else {
            throw new Error("템플릿 삭제에 실패했습니다");
          }
        })()
      ).catch(() => {});
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-sm text-muted-foreground">템플릿 불러오는 중...</p>
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </EmptyMedia>
          <EmptyTitle>저장된 템플릿 없음</EmptyTitle>
          <EmptyDescription>
            캠페인 설정을 템플릿으로 저장하면 여기에 표시됩니다.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ScrollArea className="max-h-64">
      <div className="flex flex-col gap-2 p-1">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => onSelect(template)}
            className="group flex w-full items-center justify-between rounded-lg border border-transparent bg-muted/40 px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-muted/80"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{template.name}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {[
                  template.salesChannel,
                  template.trackingPattern,
                ]
                  .filter(Boolean)
                  .join(" · ") || "설정 없음"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="ml-2 h-7 w-7 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100"
              disabled={deletingId === template.id}
              onClick={(e) => handleDelete(e, template.id)}
              aria-label={`${template.name} 삭제`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-muted-foreground"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            </Button>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
