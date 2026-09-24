// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PriceSheetList } from "../price-sheet/price-sheet-list";
import { QuickSettlementModal } from "../quick-settlement-modal";
import { KatalkUploadTab } from "../katalk/upload-tab";

// interfaces 점검 묶음 G2(2026-09-24): 업로드 드롭존은 `<input type="file" class="hidden">` 을
// 드롭존 div 클릭으로만 열었다 — display:none 입력은 탭 순서에 없고 div 는 포커스를 못 받아
// 키보드로는 파일을 올릴 길이 없었다. 드롭존 안의 실제 「파일 선택」 버튼이 그 경로다.
// 드래그·드롭존 클릭(포인터 경로)은 그대로 둔다.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/crm/crm-shell", () => ({
  CrmShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
// 역할 미확정(null)이면 업로드 탭은 조회를 쏘지 않는다 — 이 테스트는 파일 선택 경로만 본다.
vi.mock("@/hooks/use-user-role", () => ({ useUserRole: () => null }));

let clickSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ priceSheets: [], partners: [] }),
  });
  // 실제 파일 창은 jsdom 에 없다 — 버튼이 **파일 입력의 click()** 을 부르는지만 본다.
  clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  clickSpy.mockRestore();
});

/** 「파일 선택」을 키보드로 눌렀을 때 file 입력의 click() 이 불렸는가. */
async function pressFilePicker() {
  const user = userEvent.setup();
  const button = await screen.findByRole("button", { name: "파일 선택" });
  button.focus();
  await user.keyboard("{Enter}");
  const targets = clickSpy.mock.instances as unknown as HTMLInputElement[];
  return targets;
}

describe("업로드 드롭존 — 키보드 「파일 선택」 경로", () => {
  it("가격표 인제스트: 버튼 Enter 가 파일 입력을 연다", async () => {
    render(<PriceSheetList />);
    const targets = await pressFilePicker();
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0].type).toBe("file");
  });

  it("카톡 업로드: 버튼 Enter 가 (여러 파일) 파일 입력을 연다", async () => {
    render(<KatalkUploadTab />);
    const targets = await pressFilePicker();
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0].type).toBe("file");
    expect(targets[0].multiple).toBe(true);
  });

  it("빠른 정산 증빙: 버튼 Enter 가 파일 입력을 한 번 연다", async () => {
    render(
      <QuickSettlementModal
        isOpen
        onClose={vi.fn()}
        onSuccess={vi.fn()}
        data={{
          id: "c1",
          title: "테스트 캠페인",
          sellerName: "셀러",
          accountNumber: null,
          overdueSlot: {
            kind: "PAYOUT",
            verb: "지급",
            counterpartLabel: "셀러",
            flagField: "isPayoutCompleted",
          },
          targetAmount: 1000,
        }}
      />,
    );
    const targets = await pressFilePicker();
    // 입력이 드롭존 밖에 있고 버튼이 전파를 막으므로 정확히 한 번이다.
    await waitFor(() => expect(targets).toHaveLength(1));
    expect(targets[0].type).toBe("file");
  });
});
