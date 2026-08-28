/**
 * 화면단 역할 분기 — 서버 게이트의 짝이다.
 *
 * 미들웨어만 막으면 operator 는 눌러도 실패하는 UI(방 관리 탭·자료 목록 링크·빈 귀속
 * 드롭다운)를 보게 된다. 여기서 고정하는 것은 "막힌 곳으로 나가는 입구를 아예 안 그린다"
 * 이지 권한 경계가 아니다 — 경계는 `middleware-role-gate.test.ts` 가 담당한다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ROLE_COOKIE } from "@/lib/auth-roles";

vi.mock("@/components/crm/crm-shell", () => ({
  CrmShell: ({ title, description, children }: {
    title?: React.ReactNode;
    description?: string;
    children: React.ReactNode;
  }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
      {children}
    </div>
  ),
}));

// 업로드 탭은 파일 입력·드래그 영역이라 이 테스트의 관심사가 아니다 — 대신 「귀속 대상
// 지정」 권한이 어떻게 전달되는지만 관찰할 수 있게 대역을 세운다.
vi.mock("../upload-tab", () => ({
  KatalkUploadTab: () => <div data-testid="upload-tab" />,
}));
vi.mock("../manage-tab", () => ({
  KatalkManageTab: () => <div data-testid="manage-tab" />,
}));

const { KatalkPage } = await import("../katalk-page");

function setRoleCookie(value: string | null) {
  if (value === null) {
    document.cookie = `${ROLE_COOKIE}=; max-age=0; path=/`;
    return;
  }
  document.cookie = `${ROLE_COOKIE}=${value}; path=/`;
}

afterEach(() => {
  cleanup();
  setRoleCookie(null);
});

describe("KatalkPage — operator", () => {
  it("방 관리 탭과 자료 목록 링크를 그리지 않는다", async () => {
    setRoleCookie("operator");
    render(<KatalkPage />);

    // useEffect 로 역할이 확정된 뒤의 상태를 본다.
    expect(await screen.findByTestId("upload-tab")).toBeTruthy();
    expect(screen.queryByText("방 관리")).toBeNull();
    expect(screen.queryByText("업로드")).toBeNull(); // 탭이 하나뿐이면 탭 껍데기도 없다
    expect(screen.queryByText("자료 목록")).toBeNull();
    expect(screen.queryByTestId("manage-tab")).toBeNull();
  });
});

describe("KatalkPage — admin", () => {
  it("역할 쿠키가 admin 이면 기존 화면 그대로다", async () => {
    setRoleCookie("admin");
    render(<KatalkPage />);

    expect(await screen.findByText("방 관리")).toBeTruthy();
    expect(screen.getByText("자료 목록")).toBeTruthy();
  });

  it("역할 쿠키가 없어도 기존 화면 그대로다 (미들웨어를 못 거친 경로 폴백)", async () => {
    render(<KatalkPage />);

    expect(await screen.findByText("방 관리")).toBeTruthy();
    expect(screen.getByText("자료 목록")).toBeTruthy();
  });
});
