// @vitest-environment jsdom
/**
 * PrivacyModeProvider — 탭 제목 누출 + 초기화 레이스 회귀 방지.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrivacyModeProvider, usePrivacyMode } from "./privacy-mode-provider";

const KEY = "wag-crm:privacy-mode";

function ToggleConsumer() {
  const { isPrivacyMode, togglePrivacyMode } = usePrivacyMode();
  return (
    <button onClick={togglePrivacyMode}>{isPrivacyMode ? "private" : "brand"}</button>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.title = "WAG CRM";
});

describe("PrivacyModeProvider", () => {
  it("프라이버시 ON: 탭 제목을 중립으로, 스트리밍 메타데이터의 되돌림도 방어", async () => {
    window.localStorage.setItem(KEY, "true");
    render(
      <PrivacyModeProvider>
        <span />
      </PrivacyModeProvider>
    );

    await waitFor(() => expect(document.title).toBe("Au79 CRM"));

    // Next 스트리밍 메타데이터가 <title>을 기본값으로 되돌리는 상황 재현
    document.title = "WAG CRM";
    await waitFor(() => expect(document.title).toBe("Au79 CRM"));
  });

  it("초기화 레이스: 마운트가 저장된 'true'를 'false'로 덮어쓰지 않음", async () => {
    window.localStorage.setItem(KEY, "true");
    render(
      <PrivacyModeProvider>
        <span />
      </PrivacyModeProvider>
    );

    await waitFor(() => expect(document.title).toBe("Au79 CRM"));
    expect(window.localStorage.getItem(KEY)).toBe("true");
  });

  it("프라이버시 OFF: 탭 제목은 기본값 유지", async () => {
    render(
      <PrivacyModeProvider>
        <span />
      </PrivacyModeProvider>
    );

    await waitFor(() =>
      expect(document.documentElement.dataset.privacyMode).toBe("off")
    );
    expect(document.title).toBe("WAG CRM");
  });

  it("프라이버시 OFF: 감시하지 않으므로 라우트별 제목 변경이 유지됨", async () => {
    render(
      <PrivacyModeProvider>
        <span />
      </PrivacyModeProvider>
    );
    await waitFor(() => expect(document.title).toBe("WAG CRM"));

    // OFF에서는 observer가 없어야 한다 — 이후 제목 변경이 되돌려지면 안 됨.
    document.title = "딜 상세 — WAG CRM";
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.title).toBe("딜 상세 — WAG CRM");
  });

  it("토글 OFF: 브랜드 제목·dataset·저장값을 복원", async () => {
    window.localStorage.setItem(KEY, "true");
    const user = userEvent.setup();

    render(
      <PrivacyModeProvider>
        <ToggleConsumer />
      </PrivacyModeProvider>
    );
    await waitFor(() =>
      expect(screen.getByRole("button")).toHaveTextContent("private")
    );

    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(document.title).toBe("WAG CRM"));
    expect(window.localStorage.getItem(KEY)).toBe("false");
    expect(document.documentElement.dataset.privacyMode).toBe("off");
  });
});
