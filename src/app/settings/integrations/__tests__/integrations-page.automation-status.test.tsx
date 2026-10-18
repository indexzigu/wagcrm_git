// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// 자동화 작업 상태(구 홈 「시스템 레이더」)는 2026-10-18 홈에서 설정 → 외부 연동 진단으로 옮겼다
// (애플 UI 리뉴얼 묶음 1-b, 오너 2026-10-17). 여기서는 그 자리에 실제로 붙어 있는지만 본다 —
// 카드 자체의 표시 계약은 system-radar-overdue.test.tsx · color-only-signal-carriers.test.tsx.

vi.mock("@/lib/asset-storage", () => ({
  getGoogleDriveConnectionStatus: async () => ({ connected: true, status: "CONNECTED", accountEmail: null, lastError: null }),
  SUPABASE_FREE_STORAGE_LIMIT_BYTES: 1024,
}));
vi.mock("@/lib/google-calendar", () => ({
  getGoogleCalendarConnectionStatus: async () => ({ connected: true, status: "CONNECTED", accountEmail: null, lastError: null }),
}));
vi.mock("@/lib/assets", () => ({ estimateSupabaseAssetBytes: async () => 0 }));
vi.mock("@/components/crm/integrations-diagnostic", () => ({
  IntegrationsDiagnostic: () => <div data-testid="diagnostic">연동 진단</div>,
}));
vi.mock("@/components/crm/system-radar-card", () => ({
  SystemRadarCard: () => <h2>자동화 작업 상태</h2>,
}));

import IntegrationsDiagnosticPage from "../page";

describe("설정 → 외부 연동 진단 — 자동화 작업 상태", () => {
  it("연동 진단 아래에 자동화 작업 상태 구역이 있다(바로가기 id 포함)", async () => {
    const { container } = render(await IntegrationsDiagnosticPage());
    const section = container.querySelector("#automation-status")!;
    expect(section).not.toBeNull();
    expect(section.contains(screen.getByRole("heading", { name: "자동화 작업 상태" }))).toBe(true);
    // 순서: 진단 카드가 먼저, 자동화 작업 상태가 뒤.
    const diagnostic = screen.getByTestId("diagnostic");
    expect(diagnostic.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
