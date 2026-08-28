"use client";

import { Loader2Icon, MessageSquarePlusIcon, PencilIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// 채팅 영속화 청사진 §3: GET /api/assistant/conversations 응답 항목 형태(목록용 요약).
export type AssistantConversationSummaryView = {
  id: string;
  title: string | null;
  updatedAt: string;
  messageCount: number;
};

function formatDateTime(value: string): string {
  try {
    return new Date(value).toLocaleString("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

/**
 * 대화 목록 패널 (청사진 §3). 최근 대화 30개, 클릭 시 재수화, "새 대화" 버튼.
 * 데이터 로딩(fetch /api/assistant/conversations)은 assistant-client.tsx가 담당하고
 * 이 컴포넌트는 목록/선택 상태만 props로 받는 순수 프레젠테이션 컴포넌트다.
 */
export function ConversationList({
  conversations,
  isLoading,
  selectedId,
  onSelect,
  onNewConversation,
  onDelete,
  onRename,
  searchQuery,
  onSearchChange,
  className,
}: {
  conversations: AssistantConversationSummaryView[];
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewConversation: () => void;
  // §5-1: 삭제 확인(confirm) 통과 후 호출되는 콜백 — 이 컴포넌트는 presentational이라
  // 실제 DELETE fetch는 assistant-client.tsx가 담당한다(기존 onSelect/onNewConversation과
  // 동일한 관례).
  onDelete: (id: string) => void;
  // §5-2: prompt로 입력받은 새 제목이 유효(트림 후 비어있지 않음)할 때 호출되는 콜백 —
  // 실제 PATCH fetch는 assistant-client.tsx가 담당한다(onDelete와 동일한 관례).
  onRename: (id: string, title: string) => void;
  // §5-3: 검색 입력창 — controlled value/onChange. 디바운스·fetch는 부모(assistant-client)
  // 책임이라 이 컴포넌트는 presentational 그대로 유지한다(onDelete/onRename과 동일 원칙).
  searchQuery: string;
  onSearchChange: (value: string) => void;
  className?: string;
}) {
  // §5-3: 검색어가 있는데 결과가 0건이면 "검색 결과 없음"으로 기존 빈 상태 문구와
  // 구분한다(검색어가 없으면 기존 문구 "저장된 대화가 없습니다" 그대로 유지).
  const isSearching = searchQuery.trim().length > 0;

  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border border-border bg-card p-3", className)}>
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-semibold text-foreground">대화 목록</h2>
        <Button size="sm" variant="outline" onClick={onNewConversation}>
          <MessageSquarePlusIcon className="size-3.5" />
          새 대화
        </Button>
      </div>

      <div className="relative px-1">
        <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="대화 검색"
          className="pl-7"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          불러오는 중...
        </div>
      ) : conversations.length === 0 ? (
        <p className="px-1 py-6 text-center text-xs text-muted-foreground">
          {isSearching ? "검색 결과 없음" : "저장된 대화가 없습니다."}
        </p>
      ) : (
        <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {conversations.map((conversation) => {
            const isSelected = conversation.id === selectedId;
            return (
              <li key={conversation.id} className="group/item relative">
                <button
                  type="button"
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() => onSelect(conversation.id)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 pr-14 text-left transition-colors",
                    isSelected
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                >
                  <span className="truncate text-sm">{conversation.title || "제목 없음"}</span>
                  <span className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
                    {formatDateTime(conversation.updatedAt)}
                    <Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
                      {conversation.messageCount}건
                    </Badge>
                  </span>
                </button>
                {/* §5-2: hover 시 노출되는 이름 바꾸기(연필) 버튼. 항목 클릭(onSelect)과
                    이벤트가 섞이지 않도록 stopPropagation으로 분리한다(삭제 버튼과 동일 패턴). */}
                <button
                  type="button"
                  aria-label="대화 이름 바꾸기"
                  title="대화 이름 바꾸기"
                  onClick={(event) => {
                    event.stopPropagation();
                    const input = window.prompt("새 대화 이름", conversation.title ?? "");
                    if (!input) return;
                    const trimmed = input.trim();
                    if (trimmed.length === 0) return;
                    onRename(conversation.id, trimmed);
                  }}
                  className="absolute right-8 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/item:opacity-100 focus-visible:opacity-100"
                >
                  <PencilIcon className="size-3.5" />
                </button>
                {/* §5-1: hover 시 노출되는 삭제 버튼. 항목 클릭(onSelect)과 이벤트가 섞이지
                    않도록 stopPropagation으로 분리한다. */}
                <button
                  type="button"
                  aria-label="대화 삭제"
                  title="대화 삭제"
                  onClick={(event) => {
                    event.stopPropagation();
                    const confirmed = window.confirm(
                      "이 대화를 삭제할까요? 되돌릴 수 없습니다. 기안·감사 기록은 유지됩니다."
                    );
                    if (!confirmed) return;
                    onDelete(conversation.id);
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/item:opacity-100 focus-visible:opacity-100"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
