/**
 * `/assistant` 는 결재함으로 보낸다 (Plan 3 Task A3).
 *
 * 채팅 은퇴로 화면은 사라졌지만 경로는 남긴다 — 옛 북마크·딥링크가 404 로 떨어지지 않게
 * 하고, `/assistant` 가 `RESERVED_PORTAL_SLUGS` 에 들어 있어 셀러 포털이 이 한 세그먼트를
 * 가져가지 않게 하기 위해서다.
 */
import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

import AssistantPage from "../page";

describe("/assistant", () => {
  it("결재함으로 리다이렉트한다", () => {
    AssistantPage();

    expect(redirectMock).toHaveBeenCalledWith("/approvals");
  });
});
