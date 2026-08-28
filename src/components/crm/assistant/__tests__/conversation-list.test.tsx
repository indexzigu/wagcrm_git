// @vitest-environment jsdom
/**
 * ConversationList — 대화 목록 패널 (채팅 영속화 청사진 §3).
 * 최근 대화 30개, 클릭 시 onSelect(id) 호출, "새 대화" 버튼으로 onNewConversation 호출.
 * 데이터 로딩(fetch)은 assistant-client.tsx가 담당하고, 이 컴포넌트는 순수 프레젠테이션이다
 * (ApprovalInbox의 훅 주입 패턴과 달리, 이 컴포넌트는 목록/선택 상태를 props로만 받는다).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationList } from "../conversation-list";
import type { AssistantConversationSummaryView } from "../conversation-list";

function makeConversation(
  overrides: Partial<AssistantConversationSummaryView> = {}
): AssistantConversationSummaryView {
  return {
    id: "conv-1",
    title: "이번 달 정산 현황 알려줘",
    updatedAt: "2026-07-06T00:00:00Z",
    messageCount: 4,
    ...overrides,
  };
}

describe("ConversationList", () => {
  it("로딩 중이면 로딩 문구를 보여준다", () => {
    render(
      <ConversationList
        conversations={[]}
        isLoading={true}
        selectedId={null}
        onSelect={vi.fn()}
        onNewConversation={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
      />
    );
    expect(screen.getByText(/불러오는 중/)).toBeInTheDocument();
  });

  it("대화가 없으면 빈 상태 문구를 보여준다", () => {
    render(
      <ConversationList
        conversations={[]}
        isLoading={false}
        selectedId={null}
        onSelect={vi.fn()}
        onNewConversation={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
      />
    );
    expect(screen.getByText(/저장된 대화가 없습니다/)).toBeInTheDocument();
  });

  it("대화 목록의 title과 메시지수를 보여준다", () => {
    render(
      <ConversationList
        conversations={[makeConversation(), makeConversation({ id: "conv-2", title: null, messageCount: 2 })]}
        isLoading={false}
        selectedId={null}
        onSelect={vi.fn()}
        onNewConversation={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
      />
    );

    expect(screen.getByText("이번 달 정산 현황 알려줘")).toBeInTheDocument();
    // title이 null이면 "제목 없음" 같은 대체 문구를 보여준다.
    expect(screen.getByText(/제목 없음/)).toBeInTheDocument();
  });

  it("대화 항목 클릭 시 onSelect(id)를 호출한다", () => {
    const onSelect = vi.fn();
    render(
      <ConversationList
        conversations={[makeConversation()]}
        isLoading={false}
        selectedId={null}
        onSelect={onSelect}
        onNewConversation={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText("이번 달 정산 현황 알려줘"));
    expect(onSelect).toHaveBeenCalledWith("conv-1");
  });

  it("선택된 대화는 다른 스타일(aria-current)로 표시된다", () => {
    render(
      <ConversationList
        conversations={[makeConversation()]}
        isLoading={false}
        selectedId="conv-1"
        onSelect={vi.fn()}
        onNewConversation={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
      />
    );

    const item = screen.getByRole("button", { name: /이번 달 정산 현황 알려줘/ });
    expect(item).toHaveAttribute("aria-current", "true");
  });

  it("'새 대화' 버튼 클릭 시 onNewConversation을 호출한다", () => {
    const onNewConversation = vi.fn();
    render(
      <ConversationList
        conversations={[makeConversation()]}
        isLoading={false}
        selectedId="conv-1"
        onSelect={vi.fn()}
        onNewConversation={onNewConversation}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        searchQuery=""
        onSearchChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "새 대화" }));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  // §5-1: 대화 삭제 — hover 노출 삭제 버튼, confirm 취소/확인, 클릭 이벤트 분리.
  describe("삭제 버튼 (§5-1)", () => {
    it("각 대화 항목에 삭제 버튼(휴지통 아이콘)을 렌더링한다", () => {
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={vi.fn()}
          onRename={vi.fn()}
          searchQuery=""
          onSearchChange={vi.fn()}
        />
      );

      expect(screen.getByRole("button", { name: /삭제/ })).toBeInTheDocument();
    });

    it("삭제 버튼 클릭 시 confirm이 뜨고, 취소하면 onDelete가 호출되지 않는다", () => {
      const onDelete = vi.fn();
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={onDelete}
          onRename={vi.fn()}
          searchQuery=""
          onSearchChange={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /삭제/ }));

      expect(confirmSpy).toHaveBeenCalledWith(
        "이 대화를 삭제할까요? 되돌릴 수 없습니다. 기안·감사 기록은 유지됩니다."
      );
      expect(onDelete).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("삭제 버튼 클릭 후 confirm을 확인하면 onDelete(id)가 호출된다", () => {
      const onDelete = vi.fn();
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={onDelete}
          onRename={vi.fn()}
          searchQuery=""
          onSearchChange={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /삭제/ }));

      expect(onDelete).toHaveBeenCalledWith("conv-1");
      confirmSpy.mockRestore();
    });

    it("삭제 버튼 클릭은 항목 선택(onSelect)을 트리거하지 않는다(이벤트 분리)", () => {
      const onSelect = vi.fn();
      const onDelete = vi.fn();
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={onSelect}
          onNewConversation={vi.fn()}
          onDelete={onDelete}
          onRename={vi.fn()}
          searchQuery=""
          onSearchChange={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /삭제/ }));

      expect(onSelect).not.toHaveBeenCalled();
      expect(onDelete).toHaveBeenCalledWith("conv-1");
      confirmSpy.mockRestore();
    });
  });

  // §5-2: 대화 이름 바꾸기 — hover 노출 연필 버튼, prompt 취소/빈입력/확인, 클릭 이벤트 분리.
  describe("이름 바꾸기 버튼 (§5-2)", () => {
    it("각 대화 항목에 이름 바꾸기 버튼(연필 아이콘)을 렌더링한다", () => {
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={vi.fn()}
          onRename={vi.fn()}
          searchQuery=""
          onSearchChange={vi.fn()}
        />
      );

      expect(screen.getByRole("button", { name: /이름/ })).toBeInTheDocument();
    });

    it("이름 바꾸기 버튼 클릭 시 prompt가 현재 title을 기본값으로 뜬다", () => {
      const onRename = vi.fn();
      const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={vi.fn()}
          onRename={onRename}
          searchQuery=""
          onSearchChange={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /이름/ }));

      expect(promptSpy).toHaveBeenCalledWith("새 대화 이름", "이번 달 정산 현황 알려줘");
      promptSpy.mockRestore();
    });

    it("prompt를 취소(null)하면 onRename이 호출되지 않는다", () => {
      const onRename = vi.fn();
      const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={vi.fn()}
          onRename={onRename}
          searchQuery=""
          onSearchChange={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /이름/ }));

      expect(onRename).not.toHaveBeenCalled();
      promptSpy.mockRestore();
    });

    it("prompt에 공백만 입력하면(트림 후 빈 문자열) onRename이 호출되지 않는다", () => {
      const onRename = vi.fn();
      const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("   ");
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={vi.fn()}
          onRename={onRename}
          searchQuery=""
          onSearchChange={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /이름/ }));

      expect(onRename).not.toHaveBeenCalled();
      promptSpy.mockRestore();
    });

    it("prompt에 유효한 값을 입력하면 트림된 값으로 onRename(id, title)이 호출된다", () => {
      const onRename = vi.fn();
      const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("  새 대화 이름  ");
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={vi.fn()}
          onRename={onRename}
          searchQuery=""
          onSearchChange={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /이름/ }));

      expect(onRename).toHaveBeenCalledWith("conv-1", "새 대화 이름");
      promptSpy.mockRestore();
    });

    it("이름 바꾸기 버튼 클릭은 항목 선택(onSelect)을 트리거하지 않는다(이벤트 분리)", () => {
      const onSelect = vi.fn();
      const onRename = vi.fn();
      const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("새 대화 이름");
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={onSelect}
          onNewConversation={vi.fn()}
          onDelete={vi.fn()}
          onRename={onRename}
          searchQuery=""
          onSearchChange={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: /이름/ }));

      expect(onSelect).not.toHaveBeenCalled();
      expect(onRename).toHaveBeenCalledWith("conv-1", "새 대화 이름");
      promptSpy.mockRestore();
    });
  });

  // §5-3: 대화 검색 — 헤더 아래 검색 입력창(controlled). 디바운스·fetch는 부모(assistant-client)
  // 책임이라 이 컴포넌트는 value 표시·onChange 호출·검색어+결과0 문구만 검증한다.
  describe("검색 입력창 (§5-3)", () => {
    it("검색 입력창을 렌더링하고 searchQuery를 value로 표시한다", () => {
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={vi.fn()}
          onRename={vi.fn()}
          searchQuery="정산"
          onSearchChange={vi.fn()}
        />
      );

      const searchInput = screen.getByPlaceholderText("대화 검색");
      expect(searchInput).toHaveValue("정산");
    });

    it("검색 입력창에 입력하면 onSearchChange(value)를 호출한다", () => {
      const onSearchChange = vi.fn();
      render(
        <ConversationList
          conversations={[makeConversation()]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={vi.fn()}
          onRename={vi.fn()}
          searchQuery=""
          onSearchChange={onSearchChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("대화 검색");
      fireEvent.change(searchInput, { target: { value: "정산" } });

      expect(onSearchChange).toHaveBeenCalledWith("정산");
    });

    it("검색어가 있고 결과가 0건이면 '검색 결과 없음' 문구를 보여준다(기존 빈 상태 문구와 구분)", () => {
      render(
        <ConversationList
          conversations={[]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={vi.fn()}
          onRename={vi.fn()}
          searchQuery="존재하지않는검색어"
          onSearchChange={vi.fn()}
        />
      );

      expect(screen.getByText(/검색 결과 없음/)).toBeInTheDocument();
      expect(screen.queryByText(/저장된 대화가 없습니다/)).not.toBeInTheDocument();
    });

    it("검색어가 없고 결과가 0건이면 기존 빈 상태 문구('저장된 대화가 없습니다')를 그대로 보여준다", () => {
      render(
        <ConversationList
          conversations={[]}
          isLoading={false}
          selectedId={null}
          onSelect={vi.fn()}
          onNewConversation={vi.fn()}
          onDelete={vi.fn()}
          onRename={vi.fn()}
          searchQuery=""
          onSearchChange={vi.fn()}
        />
      );

      expect(screen.getByText(/저장된 대화가 없습니다/)).toBeInTheDocument();
      expect(screen.queryByText(/검색 결과 없음/)).not.toBeInTheDocument();
    });
  });
});
