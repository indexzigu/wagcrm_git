import { useState } from "react";

import {
  LinkedEntitySection,
  type LinkedEntityItem,
  type LinkedEntitySectionProps,
} from "./linked-entity-section";
import { UserCircle2 } from "lucide-react";
import { LinkSearchDialog } from "./link-search-dialog";
import { taskStatusLabels } from "@/lib/crm-types";

// --- Types ---

export type LinkedTask = {
  id: string;
  title: string;
  status: string;
  dueDate?: string | null;
  assigneeName?: string | null;
};

type LinkedTasksListProps = Omit<
  LinkedEntitySectionProps,
  "entities"
> & {
  tasks: LinkedTask[];
  onLinkTask?: (taskId: string) => Promise<void>;
  excludeIds?: string[];
};


// --- Component ---

export function LinkedTasksList({
  tasks,
  title,
  onLinkTask,
  excludeIds,
  onLinkClick,
  ...props
}: LinkedTasksListProps) {
  const [searchOpen, setSearchOpen] = useState(false);

  const linkedTaskItems: LinkedEntityItem[] = tasks.map((task) => {
    return {
      id: task.id,
      primaryLabel: task.title,
      secondaryLabels: [],
      customNode: (
        <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5">
          <div className="flex w-full items-center gap-x-2 text-[11px] truncate">
            <span className="font-semibold text-foreground truncate">
              {task.title}
            </span>
            {task.assigneeName && (
              <div className="flex shrink-0 items-center gap-1 border-l border-border pl-2 text-muted-foreground">
                <UserCircle2 className="size-3" />
                <span className="truncate">{task.assigneeName}</span>
              </div>
            )}
          </div>
          {task.dueDate && (
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              마감일: {new Date(task.dueDate).toLocaleDateString()}
            </p>
          )}
        </div>
      ),
      status: taskStatusLabels[task.status] || task.status,
    };
  });

  return (
    <>
      <LinkedEntitySection
        title={title ?? `영업 테스크 (${tasks.length}건)`}
        entities={linkedTaskItems}
        onLinkClick={onLinkClick ?? (onLinkTask ? () => setSearchOpen(true) : undefined)}
        {...props}
      />
      {onLinkTask && (
        <LinkSearchDialog
          open={searchOpen}
          onOpenChange={setSearchOpen}
          entityType="task"
          searchEndpoint="/api/search/tasks"
          excludeIds={excludeIds}
          title="테스크 검색"
          placeholder="테스크명 검색"
          onSelect={async (item) => {
            await onLinkTask(item.id);
            setSearchOpen(false);
          }}
        />
      )}
    </>
  );
}
