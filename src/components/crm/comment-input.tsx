"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { SendHorizonal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// --- Types ---

export type CommentInputProps = {
  entityType: "PARTNER" | "SELLER" | "DEAL" | "CAMPAIGN";
  entityId: string;
  onCommentAdded?: () => void;
  /** When true, shows an empty-state placeholder guiding the user to create their first activity record */
  emptyState?: boolean;
};

type UserSuggestion = {
  id: string;
  displayName: string;
  email: string;
};

// --- Component ---

export function CommentInput({
  entityType,
  entityId,
  onCommentAdded,
  emptyState = false,
}: CommentInputProps) {
  const [content, setContent] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [suggestions, setSuggestions] = useState<UserSuggestion[]>([]);
  const [mentionQuery, setMentionQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Fetch user suggestions when mention query changes
  useEffect(() => {
    if (!showAutocomplete) return;

    const controller = new AbortController();
    const fetchUsers = async () => {
      try {
        const res = await fetch(
          `/api/users?q=${encodeURIComponent(mentionQuery)}`,
          { signal: controller.signal },
        );
        if (res.ok) {
          const data = await res.json();
          setSuggestions(data);
          setSelectedIndex(0);
        }
      } catch {
        // Ignore abort errors
      }
    };

    void fetchUsers();
    return () => controller.abort();
  }, [mentionQuery, showAutocomplete]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const cursorPos = e.target.selectionStart;
      setContent(value);

      // Detect @ trigger
      const textBeforeCursor = value.slice(0, cursorPos);
      const atMatch = textBeforeCursor.match(/@([a-zA-Z0-9_-]*)$/);

      if (atMatch) {
        setShowAutocomplete(true);
        setMentionQuery(atMatch[1]);
        setMentionStartPos(cursorPos - atMatch[0].length);
      } else {
        setShowAutocomplete(false);
        setMentionQuery("");
        setMentionStartPos(null);
      }
    },
    [],
  );

  const insertMention = useCallback(
    (user: UserSuggestion) => {
      if (mentionStartPos === null) return;

      const before = content.slice(0, mentionStartPos);
      const cursorPos = textareaRef.current?.selectionStart ?? content.length;
      const after = content.slice(cursorPos);
      const mention = `@${user.displayName.replace(/\s+/g, "-")} `;
      const newContent = before + mention + after;

      setContent(newContent);
      setShowAutocomplete(false);
      setMentionQuery("");
      setMentionStartPos(null);

      // Restore focus
      setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          const newPos = before.length + mention.length;
          textarea.focus();
          textarea.setSelectionRange(newPos, newPos);
        }
      }, 0);
    },
    [content, mentionStartPos],
  );

  const handleSubmit = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, entityId, content: trimmed }),
      });

      if (res.ok) {
        setContent("");
        onCommentAdded?.();
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [content, entityId, entityType, isSubmitting, onCommentAdded]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showAutocomplete && suggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < suggestions.length - 1 ? prev + 1 : 0,
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : suggestions.length - 1,
          );
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          insertMention(suggestions[selectedIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setShowAutocomplete(false);
          return;
        }
      }

      // Submit on Enter (without Shift)
      if (e.key === "Enter" && !e.shiftKey && !showAutocomplete) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [showAutocomplete, suggestions, selectedIndex, insertMention, handleSubmit],
  );

  return (
    <div className="relative rounded-lg border border-border/70 bg-background p-3">
      <Textarea
        ref={textareaRef}
        placeholder={
          emptyState
            ? "아직 활동기록이 없습니다. 메모를 입력하여 첫 기록을 남겨보세요."
            : "코멘트를 입력하세요... (@로 멘션)"
        }
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        className="min-h-[72px] resize-none border-0 bg-transparent px-0 py-0 text-xs shadow-none focus-visible:ring-0"
      />
      <div className="mt-2 flex justify-end">
        <Button
          size="sm"
          disabled={!content.trim() || isSubmitting}
          onClick={() => void handleSubmit()}
        >
          <SendHorizonal className="mr-1 size-3.5" />
          코멘트
        </Button>
      </div>

      {/* Autocomplete dropdown */}
      {showAutocomplete && suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-full max-w-xs rounded-md border border-border bg-popover p-1 shadow-overlay">
          {suggestions.map((user, index) => (
            <button
              key={user.id}
              type="button"
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs ${
                index === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(user);
              }}
            >
              <span className="font-medium">{user.displayName}</span>
              <span className="text-muted-foreground">{user.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
