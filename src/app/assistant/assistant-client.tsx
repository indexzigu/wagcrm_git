"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SendIcon, Loader2Icon, PaperclipIcon, UploadCloudIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageList } from "@/components/crm/assistant/message-list";
import { ApprovalInbox } from "@/components/crm/assistant/approval-inbox";
import { ConversationList } from "@/components/crm/assistant/conversation-list";
import {
  PriceSheetIngestSlot,
  usePriceSheetIngest,
} from "@/components/crm/assistant/price-sheet-ingest-slot";
import { PRICE_SHEET_ACCEPT } from "@/components/crm/assistant/price-sheet-ingest";
import type { AssistantConversationSummaryView } from "@/components/crm/assistant/conversation-list";
import type { AssistantApiResponse, AssistantMessage, AssistantToolCallView } from "@/components/crm/assistant/types";

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// M1+M2: 서버(route.ts)와 동일한 상한 — 클라이언트에서도 전송 전 최근 턴만 잘라 보내
// 페이로드 크기를 줄인다 (서버 절삭에만 의존하면 매 요청마다 불필요하게 큰 body가 오간다).
const MAX_HISTORY_TURNS = 12;

// 청사진 §7-1: 빈 대화 전용 제안 칩 3개 — 전부 실존 READ 도구에 대응(존재하지 않는
// 능력을 제안하지 않는다).
const QUICK_ACTION_SUGGESTIONS = [
  "이번달 정산 현황 알려줘",
  "파이프라인 현황 보여줘",
  "최근 7일 주문 현황 알려줘",
] as const;

// 채팅 영속화(§2-2) 조회 응답의 메시지 형태 — toolCalls/actionProposalIds는 이미
// 저장소에서 역직렬화되어 온다.
type ConversationDetailMessage = {
  id: string;
  conversationId: string;
  role: "user" | "model";
  text: string;
  toolCalls: AssistantToolCallView[] | null;
  toolCallsTruncated: boolean;
  actionProposalIds: string[] | null;
  createdAt: string;
};

export function AssistantClient() {
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 채팅 영속화(§3): 대화 목록 상태 + 현재 선택된 대화 + 재수화 로딩 상태.
  const [conversations, setConversations] = useState<AssistantConversationSummaryView[]>([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);

  // §5-3: 대화 검색 — 입력창 상태(즉시 반영, UI 지연 없음)와 실제 조회 트리거는 분리한다.
  // 조회 자체는 300ms 디바운스 후에만 발화한다(아래 useEffect).
  const [searchQuery, setSearchQuery] = useState("");

  // 가격표 인제스트 슬롯(1단계) — /api/assistant 밖의 별도 흐름. 드롭 리스너는 우측
  // 채팅 패널에만 바인딩한다(좌측 대화 목록에 드롭하면 "어느 대화 귀속?"이라는 잘못된
  // 질문이 생김 — ss-ux P0 #3).
  const ingest = usePriceSheetIngest();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  // dragenter/dragleave는 자식 요소를 지날 때마다 쌍으로 발화한다 — 카운터 없이
  // boolean만 쓰면 오버레이가 깜빡인다.
  const dragDepthRef = useRef(0);

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      const file = event.dataTransfer.files?.[0];
      if (file) ingest.stageFile(file);
    },
    [ingest],
  );

  // stuck-guard: ESC로 드래그 취소하거나 브라우저 창 밖에서 놓으면 dragleave가 발화하지
  // 않아 카운터가 0으로 못 돌아오는 크로스브라우저 함정 — 윈도우 레벨 종료 신호에서
  // 무조건 리셋한다(code-reviewer MEDIUM). 패널 onDrop과 중복 리셋되어도 무해.
  useEffect(() => {
    const resetDrag = () => {
      dragDepthRef.current = 0;
      setDragActive(false);
    };
    window.addEventListener("dragend", resetDrag);
    window.addEventListener("drop", resetDrag);
    return () => {
      window.removeEventListener("dragend", resetDrag);
      window.removeEventListener("drop", resetDrag);
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  }, []);

  // §5-3: query가 있으면 fetch URL에 `?q=`로 인코딩해 붙인다. 부모(send/rename/delete)가
  // 현재 searchQuery를 그대로 넘겨 목록 일관성을 유지할 수 있도록 인자로 받는다(선택 인자라
  // 마운트 시 최초 호출·기존 무인자 호출과 하위호환).
  const loadConversations = useCallback(async (query?: string) => {
    setIsLoadingConversations(true);
    try {
      const url =
        query && query.length > 0
          ? `/api/assistant/conversations?q=${encodeURIComponent(query)}`
          : "/api/assistant/conversations";
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      setConversations(data.conversations ?? []);
    } catch {
      // 목록 로딩 실패는 채팅 자체를 막지 않는다 — 조용히 빈 목록으로 둔다(m4와 동일한 원칙).
    } finally {
      setIsLoadingConversations(false);
    }
  }, []);

  // 마운트 시 최근 대화 목록을 불러온다(§3 — 최근 30개, 무한스크롤 없음, 초기 로드는
  // 빈 검색어).
  useEffect(() => {
    void loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // §5-3: 검색어 입력 300ms 후에만 재조회한다(매 입력마다 요청을 보내지 않기 위한 디바운스).
  // 마운트 시 최초 로드(위 useEffect)와 중복 호출되지 않도록 이 effect는 searchQuery
  // 변경에만 반응한다 — 마운트 시 searchQuery는 빈 문자열이라 최초 렌더에서도 한 번 더
  // 빈 검색으로 재조회되지만, 결과가 동일해 목록 화면에는 영향이 없다.
  useEffect(() => {
    const timer = setTimeout(() => {
      void loadConversations(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, loadConversations]);

  // ts-review Minor-1: 대화 전환 레이스 가드. 빠른 연속 클릭/전송 중 전환 시 늦게 도착한
  // 응답이 현재 보고 있는 대화의 메시지를 덮어쓰지 않도록 "뷰 세대"를 ref로 관리하고,
  // 각 요청이 자기 세대가 여전히 최신일 때만 상태를 갱신한다.
  const viewGenRef = useRef(0);

  const handleSelectConversation = useCallback(
    async (conversationId: string) => {
      const gen = ++viewGenRef.current;
      setIsLoadingMessages(true);
      setErrorText(null);
      try {
        const res = await fetch(`/api/assistant/conversations/${conversationId}`);
        if (!res.ok) {
          throw new Error(`대화를 불러오지 못했습니다 (status=${res.status})`);
        }
        const data: { messages: ConversationDetailMessage[] } = await res.json();
        if (viewGenRef.current !== gen) return; // 그 사이 다른 대화로 전환됨 — 이 응답은 폐기

        const rehydrated: AssistantMessage[] = data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          toolCalls: m.toolCalls ?? undefined,
          toolCallsTruncated: m.toolCallsTruncated || undefined,
          actionProposalIds: m.actionProposalIds ?? undefined,
          createdAt: m.createdAt,
        }));

        setMessages(rehydrated);
        setSelectedConversationId(conversationId);
        scrollToBottom();
      } catch (err) {
        if (viewGenRef.current === gen) {
          setErrorText(err instanceof Error ? err.message : "대화를 불러오는 중 오류가 발생했습니다.");
        }
      } finally {
        if (viewGenRef.current === gen) {
          setIsLoadingMessages(false);
        }
      }
    },
    [scrollToBottom]
  );

  const handleNewConversation = useCallback(() => {
    viewGenRef.current += 1; // 진행 중인 이전 대화 로드/전송 응답을 무효화
    setMessages([]);
    setSelectedConversationId(null);
    setErrorText(null);
  }, []);

  // §5-1: 대화 삭제 — confirm은 ConversationList(presentational)가 이미 통과시킨 뒤 호출된다.
  // DELETE 성공 시 목록을 재조회하고, 삭제한 대화가 현재 선택 중이면 handleNewConversation과
  // 동일한 리셋(viewGenRef 무효화 포함)을 재사용해 레이스 없이 "새 대화" 상태로 되돌린다.
  const handleDeleteConversation = useCallback(
    async (conversationId: string) => {
      try {
        const res = await fetch(`/api/assistant/conversations/${conversationId}`, {
          method: "DELETE",
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || `삭제에 실패했습니다 (status=${res.status})`);
        }

        if (selectedConversationId === conversationId) {
          handleNewConversation();
        }
        // §5-3 주의: 현재 searchQuery를 유지한 채 재조회한다(목록 일관성).
        void loadConversations(searchQuery);
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : "대화를 삭제하는 중 오류가 발생했습니다.");
      }
    },
    [selectedConversationId, handleNewConversation, loadConversations, searchQuery]
  );

  // §5-2: 대화 이름 바꾸기 — 유효성 검사(prompt 결과 트림 후 비어있지 않음)는 이미
  // ConversationList(presentational)가 통과시킨 뒤 호출된다. PATCH 성공 시 목록을
  // 재조회해 갱신된 title을 반영한다(선택 상태·메시지는 무영향 — 제목만 바뀐다).
  const handleRenameConversation = useCallback(
    async (conversationId: string, title: string) => {
      try {
        const res = await fetch(`/api/assistant/conversations/${conversationId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || `이름 변경에 실패했습니다 (status=${res.status})`);
        }

        // §5-3 주의: 현재 searchQuery를 유지한 채 재조회한다(목록 일관성).
        void loadConversations(searchQuery);
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : "대화 이름을 바꾸는 중 오류가 발생했습니다.");
      }
    },
    [loadConversations, searchQuery]
  );

  // 청사진 §7-1: handleSend에서 input 상태 의존을 제거한 전송 함수. 히스토리 절삭·레이스
  // 가드(viewGenRef 캡처)·conversationId 동봉·응답 처리 로직은 그대로 보존한다. 텍스트박스
  // 전송(handleSend)과 제안 칩·행 액션 퀵액션(§7-1/§7-2)이 이 함수를 공유한다.
  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isSending) return;

      // ts-review Minor-1: 전송 시점의 뷰 세대를 캡처 — 응답 도착 전에 사용자가 다른 대화로
      // 전환/새 대화를 열었으면 이 응답을 현재 뷰에 append하지 않는다(서버에는 이미 저장돼
      // 있으므로 해당 대화를 다시 열면 재수화로 보인다).
      const gen = viewGenRef.current;

      const userMessage: AssistantMessage = {
        id: makeId(),
        role: "user",
        text: trimmed,
        createdAt: new Date().toISOString(),
      };

      const historyForRequest = messages
        .slice(-MAX_HISTORY_TURNS)
        .map((m) => ({ role: m.role, text: m.text }));

      setMessages((prev) => [...prev, userMessage]);
      setIsSending(true);
      setErrorText(null);
      scrollToBottom();

      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            history: historyForRequest,
            conversationId: selectedConversationId,
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error || `요청이 실패했습니다 (status=${res.status})`);
        }

        const data: AssistantApiResponse = await res.json();

        // ts-review Minor-1: 응답 도착 시점에 뷰가 다른 대화로 넘어갔으면 append하지 않는다.
        if (viewGenRef.current !== gen) return;

        const modelMessage: AssistantMessage = {
          id: makeId(),
          role: "model",
          text: data.reply,
          toolCalls: data.toolCalls,
          isClarification: data.isClarification,
          lintWarnings: data.lintWarnings,
          actionProposalId: data.actionProposalId,
          actionProposalIds: data.actionProposalIds,
          createdAt: new Date().toISOString(),
        };

        setMessages((prev) => [...prev, modelMessage]);
        // 응답의 conversationId를 유지한다 — 새 대화였다면 이제부터 이 대화에 이어서 저장된다.
        // §5-3 주의: 현재 searchQuery를 유지한 채 재조회한다(목록 일관성). 새 대화가 활성
        // 검색어에 안 맞으면 목록에 미표시될 수 있으나 본문 pane엔 정상 표시 — v1 수용.
        if (data.conversationId) {
          setSelectedConversationId(data.conversationId);
          void loadConversations(searchQuery);
        }
      } catch (err) {
        if (viewGenRef.current === gen) {
          setErrorText(err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.");
        }
      } finally {
        setIsSending(false);
        scrollToBottom();
      }
    },
    [isSending, messages, scrollToBottom, selectedConversationId, loadConversations, searchQuery]
  );

  // handleSend는 입력창 상태(input)를 sendMessage로 넘기고 입력창을 비우는 것으로 축소된다.
  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    await sendMessage(trimmed);
  }, [input, sendMessage]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col gap-3 overflow-hidden">
      {/* Phase 5 HITL: 승인 대기함 — 사이드바 신규 메뉴 없이 /assistant 페이지 내부
          섹션으로 배치한다(청사진 §0-8). */}
      <ApprovalInbox />

      <div className="flex flex-1 gap-3 overflow-hidden">
        {/* 채팅 영속화 §3: 대화 목록 패널 — 최근 30개, 클릭 시 재수화, "새 대화" 버튼. */}
        <ConversationList
          conversations={conversations}
          isLoading={isLoadingConversations}
          selectedId={selectedConversationId}
          onSelect={(id) => void handleSelectConversation(id)}
          onNewConversation={handleNewConversation}
          onDelete={(id) => void handleDeleteConversation(id)}
          onRename={(id, title) => void handleRenameConversation(id, title)}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          className="w-64 shrink-0"
        />

        <div
          className="relative flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* 가격표 파일 드래그 오버레이 — 패널 로컬 스택(z-10)에 머문다(포털 z-50 계열 금지,
              ss-ux P0 #9). 놓아도 즉시 업로드하지 않고 대기 바를 거치므로 문구가 결과를
              약속하지 않는다(P0 #5). */}
          {dragActive && (
            // pointer-events-none: 드래그/드롭 이벤트는 아래 요소에서 패널 핸들러로 버블되므로
            // 동작에 영향이 없고, 만에 하나 리셋을 놓쳐도 오버레이가 입력을 막지 않게 한다.
            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/5 backdrop-blur-[1px]">
              <UploadCloudIcon className="size-8 text-primary" />
              <p className="text-sm font-medium text-primary">가격표 파일을 여기에 놓으세요</p>
            </div>
          )}

          <div className="border-b border-border px-4 py-3">
            <h1 className="text-base font-semibold text-foreground">AI 어시스턴트</h1>
            <p className="text-xs text-muted-foreground">
              정산·딜·파이프라인·캠페인 재무·주문 현황을 자연어로 조회합니다. 가격표 파일을
              업로드하면 추출까지 진행합니다. 메모 등 쓰기 요청은 승인 대기 기안으로 상신됩니다.
            </p>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            {isLoadingMessages ? (
              <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" />
                대화를 불러오는 중입니다...
              </div>
            ) : (
              // 청사진 §7-2: 정산 리포트 행 액션 등 콘텍스트 퀵액션 콜백. isSending 중에는
              // sendMessage 내부 가드로도 막히지만, 명시적으로 undefined를 전달해 버튼을
              // disabled로 보이게 한다(§7-2 "isSending 중 disabled" 요구).
              <MessageList messages={messages} onQuickAction={isSending ? undefined : sendMessage} />
            )}
            {isSending && (
              <div className="flex items-center gap-2 px-4 pb-4 text-xs text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" />
                조회 중입니다...
              </div>
            )}
            {errorText && (
              <div className="mx-4 mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {errorText}
              </div>
            )}
          </div>

          {/* 가격표 인제스트 슬롯 — 대기 바/진행/결과 카드. 아래 제안 칩 줄과 입력줄 위
              슬롯을 상호 배타적으로 점유한다(ss-ux P0 #4). */}
          <PriceSheetIngestSlot
            state={ingest.state}
            onConfirm={(partnerId) => void ingest.confirmUpload(partnerId)}
            onApply={() => void ingest.applyClean()}
            onCancel={ingest.cancel}
            onDismiss={ingest.dismiss}
          />

          {/* 청사진 §7-1: 빈 대화(새 대화 시작 전)에만 입력창 위에 제안 칩을 보여준다.
              MessageList의 빈 상태 안내문(정중앙)과 겹치지 않도록 입력창 바로 위에 배치한다. */}
          {messages.length === 0 && !isLoadingMessages && !ingest.isOccupied && (
            <div className="flex flex-wrap gap-2 border-t border-border px-3 py-2.5">
              {QUICK_ACTION_SUGGESTIONS.map((suggestion) => (
                <Button
                  key={suggestion}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 rounded-full text-xs"
                  disabled={isSending}
                  onClick={() => void sendMessage(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2 border-t border-border p-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="파일 첨부"
              disabled={isSending || ingest.isRunning}
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon className="size-4" />
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept={PRICE_SHEET_ACCEPT}
              className="hidden"
              data-testid="price-sheet-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) ingest.stageFile(file);
                e.target.value = "";
              }}
            />
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="예: 이번 달 정산 현황 알려줘"
              className="min-h-11 resize-none"
              disabled={isSending}
            />
            <Button
              type="button"
              onClick={() => void handleSend()}
              disabled={isSending || input.trim().length === 0}
              size="icon"
              aria-label="전송"
            >
              <SendIcon className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
