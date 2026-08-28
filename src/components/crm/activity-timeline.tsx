"use client";

import { useCallback, useEffect, useState } from "react";
import { CommentInput } from "./comment-input";

// --- Types ---

export type ActivityLogEntry = {
  id: string;
  type: "CHANGE" | "CREATE" | "DELETE" | "MEMO";
  fieldName: string | null;
  previousValue: string | null;
  newValue: string | null;
  content: string | null;
  actor: string;
  createdAt: string;
};

export type Comment = {
  id: string;
  entityType: string;
  entityId: string;
  authorId: string;
  authorName: string;
  content: string;
  mentions: string; // JSON array of resolved userIds
  createdAt: string;
};

export type ActivityTimelineProps = {
  entityType: "PARTNER" | "SELLER" | "DEAL" | "CAMPAIGN";
  entityId: string;
  entries?: ActivityLogEntry[];
  comments?: Comment[];
  onMemoSubmit?: (content: string) => Promise<void>;
  onCommentCreated?: () => void;
};

// --- Unified timeline item ---

type TimelineItem =
  | { kind: "entry"; data: ActivityLogEntry }
  | { kind: "comment"; data: Comment };

// --- Relative time formatting (Korean) ---

export function formatRelativeTime(dateString: string): string {
  const now = Date.now();
  const date = new Date(dateString).getTime();
  const diffMs = now - date;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return "방금 전";
  if (diffMinutes < 60) return `${diffMinutes}분 전`;
  if (diffHours < 24) return `${diffHours}시간 전`;
  if (diffDays === 1) return "어제";
  if (diffDays < 7) return `${diffDays}일 전`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}주 전`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}개월 전`;
  return `${Math.floor(diffDays / 365)}년 전`;
}

// --- Build timeline from comments only, sorted by createdAt desc ---

export function mergeTimeline(
  entries: ActivityLogEntry[],
  comments: Comment[],
): TimelineItem[] {
  const items: TimelineItem[] = [
    ...entries.map((entry) => ({ kind: "entry" as const, data: entry })),
    ...comments.map((comment) => ({ kind: "comment" as const, data: comment })),
  ];

  items.sort(
    (a, b) =>
      new Date(b.data.createdAt).getTime() -
      new Date(a.data.createdAt).getTime(),
  );

  return items;
}

// --- Render comment content with highlighted @mentions ---

function renderContentWithMentions(content: string): React.ReactNode {
  // Split content by @mention patterns
  const mentionRegex = /@([a-zA-Z0-9_-]{1,50})\b/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(content)) !== null) {
    // Add text before the mention
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    // Add the highlighted mention
    parts.push(
      <span
        key={`mention-${match.index}`}
        className="font-medium text-blue-600 dark:text-blue-400"
      >
        @{match[1]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts.length > 0 ? parts : content;
}

// --- Entry renderers ---

function CommentEntry({ comment }: { comment: Comment }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium text-foreground/80">
        {comment.authorName}
      </span>
      <p className="whitespace-pre-wrap text-xs leading-5 text-foreground">
        {renderContentWithMentions(comment.content)}
      </p>
      <span className="text-[11px] text-muted-foreground/70">
        {formatRelativeTime(comment.createdAt)}
      </span>
    </div>
  );
}

function ActivityEntry({ entry }: { entry: ActivityLogEntry }) {
  const description =
    entry.type === "CHANGE"
      ? `${entry.fieldName ?? "필드"}: ${entry.previousValue ?? "-"} -> ${entry.newValue ?? "-"}`
      : entry.type === "CREATE"
        ? "항목이 생성되었습니다."
        : entry.type === "DELETE"
          ? "항목이 삭제되었습니다."
          : (entry.content ?? "메모가 등록되었습니다.");

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] font-medium text-foreground/80">{entry.actor}</span>
      <p className="whitespace-pre-wrap text-xs leading-5 text-foreground">{description}</p>
      <span className="text-[11px] text-muted-foreground/70">
        {formatRelativeTime(entry.createdAt)}
      </span>
    </div>
  );
}

// --- Main component ---

export function ActivityTimeline({
  entityType,
  entityId,
  entries,
  comments,
  onCommentCreated,
}: ActivityTimelineProps) {
  const [localEntries, setLocalEntries] = useState<ActivityLogEntry[]>(entries || []);
  const [localComments, setLocalComments] = useState<Comment[]>(comments || []);
  const [loading, setLoading] = useState(false);

  const isSelfFetching = entries === undefined || comments === undefined;

  const fetchTimelineData = useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    try {
      const [entriesRes, commentsRes] = await Promise.all([
        fetch(`/api/activity-log?entityType=${entityType}&entityId=${entityId}`),
        fetch(`/api/comments?entityType=${entityType}&entityId=${entityId}`),
      ]);

      if (entriesRes.ok && commentsRes.ok) {
        const entriesData = await entriesRes.json();
        const commentsData = await commentsRes.json();
        setLocalEntries(Array.isArray(entriesData?.entries) ? entriesData.entries : []);
        setLocalComments(Array.isArray(commentsData) ? commentsData : []);
      }
    } catch (err) {
      console.error("Failed to fetch timeline data:", err);
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId]);

  useEffect(() => {
    if (isSelfFetching) {
       
      fetchTimelineData();
    } else {
      setLocalEntries(entries || []);
      setLocalComments(comments || []);
    }
  }, [entityType, entityId, entries, comments, isSelfFetching, fetchTimelineData]);

  const handleCommentCreated = useCallback(() => {
    if (isSelfFetching) {
      fetchTimelineData();
    }
    if (onCommentCreated) {
      onCommentCreated();
    }
  }, [isSelfFetching, fetchTimelineData, onCommentCreated]);

  const userEntries = localEntries.filter(
    (entry) => entry.actor.trim().toUpperCase() !== "SYSTEM"
  );
  const timelineItems = mergeTimeline(userEntries, localComments);
  const isEmpty = timelineItems.length === 0;

  if (loading && isEmpty) {
    return <p className="text-xs text-muted-foreground">불러오는 중...</p>;
  }

  return (
    <div className="space-y-4">
      {/* Comment input with @mention autocomplete */}
      <CommentInput
        entityType={entityType}
        entityId={entityId}
        onCommentAdded={handleCommentCreated}
        emptyState={isEmpty}
      />

      {/* Comments */}
      {timelineItems.length > 0 && (
        <div className="space-y-2">
          {timelineItems.map((item) => (
            <div
              key={`${item.kind}-${item.data.id}`}
              className={
                item.kind === "comment"
                  ? "rounded-lg border border-blue-200/70 bg-blue-50/30 px-3 py-2 dark:border-blue-900/50 dark:bg-blue-950/20"
                  : "rounded-lg border border-slate-200/80 bg-slate-50/50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/40"
              }
            >
              {item.kind === "comment" ? (
                <CommentEntry comment={item.data} />
              ) : (
                <ActivityEntry entry={item.data} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
