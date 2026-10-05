/**
 * `/settings/reminders` 는 운영 정책 화면으로 보낸다.
 *
 * 읽는 백엔드가 없는 토글만 남아 은퇴한 화면이다 — 옛 북마크·딥링크가 404 로 떨어지지
 * 않게 경로는 남긴다(선례: `src/app/assistant/__tests__/redirect.test.tsx`).
 */
import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (path: string) => redirectMock(path),
}));

import ReminderSettingsPage from "../page";

describe("/settings/reminders", () => {
  it("운영 정책 화면으로 리다이렉트한다", () => {
    ReminderSettingsPage();

    expect(redirectMock).toHaveBeenCalledWith("/settings/operations");
  });
});
