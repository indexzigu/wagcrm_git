import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkPreviewRefresh } from "@/components/crm/link-preview-refresh";

/**
 * 이 컴포넌트의 핵심 계약은 **순서**다 — 복사가 fetch 보다 먼저 일어나야 한다.
 * 수집은 최대 20초라, 뒤에 두면 클립보드가 사용자 제스처 창을 벗어나 브라우저가
 * 거부한다. 순서가 뒤집혀도 화면은 멀쩡해 보이고 "복사됐다는데 클립보드가 비어
 * 있다"로만 드러나므로, 테스트가 순서를 직접 본다.
 */

const calls: string[] = [];
let writeText: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let resolveFetch: (value: Response) => void;

function mount(preview = {}) {
  return render(
    <LinkPreviewRefresh code="Kp7mQ2xd" shortUrl="https://go.ygrd.kr/Kp7mQ2xd" preview={preview} />,
  );
}

beforeEach(() => {
  calls.length = 0;
  writeText = vi.fn(async () => {
    calls.push("copy");
  });
  Object.assign(navigator, { clipboard: { writeText } });
  fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        calls.push("fetch");
        resolveFetch = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("LinkPreviewRefresh", () => {
  it("복사를 fetch 보다 먼저 한다", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /새로고침/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(calls).toEqual(["copy", "fetch"]);
  });

  it("복사하는 URL 은 코드에 꼬리를 얹은 것이고 정본 단축링크가 아니다", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /새로고침/ }));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).not.toBe("https://go.ygrd.kr/Kp7mQ2xd");
    expect(copied).toMatch(/^https:\/\/go\.ygrd\.kr\/Kp7mQ2xd\/r[0-9a-z]+$/);
  });

  it("수집 중에는 진행 캡션을 띄우고 버튼을 잠근다 — 라벨은 복사 확인이 소유한다", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /새로고침/ }));

    expect(await screen.findByText("미리보기를 다시 읽는 중…")).toBeInTheDocument();
    // 복사 확인(즉시 축)과 수집 진행(긴 축)은 서로 다른 캐리어에 탄다.
    expect(screen.getByRole("button", { name: /복사됨/ })).toBeDisabled();
  });

  it("진행 중에는 버튼이 잠겨 POST 가 한 번만 나간다", async () => {
    mount();
    const button = screen.getByRole("button", { name: /새로고침/ });
    await userEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("성공하면 우회용 링크임을 밝히고 새 제목을 그린다", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /새로고침/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    resolveFetch(ok({ refreshed: true, ogTitle: "여름 공구", ogImage: null, ogFetchedAt: new Date().toISOString() }));

    expect(await screen.findByText(/카톡 캐시 우회용 링크를 복사했습니다/)).toBeInTheDocument();
    expect(await screen.findByText("여름 공구")).toBeInTheDocument();
  });

  it("수집이 실패해도 복사 사실은 남고 그대로 써도 된다고 말한다", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: /새로고침/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    resolveFetch(ok({ refreshed: false }));

    expect(await screen.findByText(/카톡 캐시 우회용 링크를 복사했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/미리보기를 읽지 못했습니다/)).toBeInTheDocument();
    expect(screen.getByText(/그대로 공유해도 됩니다/)).toBeInTheDocument();
  });

  it("클립보드가 거부되면 재수집을 시작하지 않는다 — 공유할 것이 없다", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    mount();
    await userEvent.click(screen.getByRole("button", { name: /새로고침/ }));

    expect(await screen.findByText(/링크 복사에 실패했습니다/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("클립보드 프로미스가 아직 안 끝난 창(재클릭 시점엔 phase 도 disabled 도 아직 idle)에 재클릭해도 복사·POST 가 한 번만 나간다", async () => {
    // ⚠️ 위 "진행 중에는 버튼이 잠겨" 케이스와 다르다 — 그 케이스는 fetch 단계까지
    // 간 뒤(phase === "running", 버튼 disabled)에 두 번째 클릭을 넣는다. 여기서
    // 노리는 결함은 그보다 **앞선** 창이다: 클릭 시점부터 클립보드 프로미스가
    // resolve 될 때까지는 phase 가 여전히 "idle" 이라 disabled 도 걸리지 않는다.
    let resolveClipboard!: () => void;
    writeText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          calls.push("copy");
          resolveClipboard = () => resolve();
        }),
    );
    mount();
    const button = screen.getByRole("button", { name: /새로고침/ });

    await userEvent.click(button);
    // 이 시점에서 버튼은 아직 disabled 가 아니다(클립보드 프로미스 미해결 — phase === "idle").
    expect(button).not.toBeDisabled();
    await userEvent.click(button);

    resolveClipboard();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * jsdom 은 레이아웃을 하지 않으므로 줄바꿈을 실제로 잴 수 없다. 그래서 이 단언은
   * 높이가 아니라 **예약 선언**을 잠근다 — 이 슬롯은 가장 좁은 표면(유입 리포트
   * 상세 시트 576px)의 최악 상태인 3줄을 예약해야 한다. `min-h-8` 로 되돌리면
   * 그 시트에서만 실패 문구가 뜰 때 아래가 밀린다(P8 Layout Stability).
   */
  it("캡션 슬롯은 3줄을 예약한다 — 좁은 표면의 최악 상태 기준", () => {
    mount({ ogFetchedAt: new Date().toISOString() });
    const caption = screen.getByText(/마지막 수집:/).closest("div");
    expect(caption).toHaveClass("min-h-12");
  });
});
