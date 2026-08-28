// 홈택스 발행 공용 훅 계약 — 보드와 정산 카드가 공유한다.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useHometaxIssue } from "../use-hometax-issue";

// ⚠️ `vi.mock` 은 파일 최상단으로 **호이스팅**된다 — 팩토리가 바깥 `const` 를 참조하면
//    TDZ 로 죽는다. 목 객체는 `vi.hoisted` 안에서 만든다(이 레포의 기존 선례:
//    `src/services/__tests__/campaignGroupService.test.ts`).
const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  checkHometaxHelperHealth: vi.fn(),
  sendInvoiceToHometaxHelper: vi.fn(),
  wakeHometaxHelper: vi.fn(),
  waitForHometaxHelper: vi.fn(),
  waitForHometaxLogin: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/hometax-helper-client", () => ({
  checkHometaxHelperHealth: mocks.checkHometaxHelperHealth,
  sendInvoiceToHometaxHelper: mocks.sendInvoiceToHometaxHelper,
  wakeHometaxHelper: mocks.wakeHometaxHelper,
  waitForHometaxHelper: mocks.waitForHometaxHelper,
  waitForHometaxLogin: mocks.waitForHometaxLogin,
  HOMETAX_HELPER_INSTALL_COMMAND: "install",
  HOMETAX_HELPER_START_COMMAND: "start",
}));

function Harness({ campaignIds }: { campaignIds: string[] }) {
  const { sendingKey, sendToHometax } = useHometaxIssue();
  return (
    <button onClick={() => void sendToHometax({ key: "k1", campaignIds, counterpartName: "상대" })}>
      {sendingKey ? "전송 중" : "홈택스 발행"}
    </button>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkHometaxHelperHealth.mockResolvedValue(true);
  mocks.sendInvoiceToHometaxHelper.mockResolvedValue({ status: "FILLED" });
});

describe("useHometaxIssue", () => {
  it("campaignIds 전원을 라우트에 보낸다 — 그룹 부분 전송 금지", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ rows: [{ id: "r1" }] }) })) as never;
    render(<Harness campaignIds={["c1", "c2"]} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.sendInvoiceToHometaxHelper).toHaveBeenCalled());
    const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.campaignIds).toEqual(["c1", "c2"]);
    expect(body.format).toBe("json");
  });

  it("행이 1건이 아니면 헬퍼로 보내지 않는다 — 어떤 장을 채울지 조용히 고르지 않는다", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ rows: [{ id: "a" }, { id: "b" }] }) })) as never;
    render(<Harness campaignIds={["c1"]} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(mocks.sendInvoiceToHometaxHelper).not.toHaveBeenCalled();
  });

  it("로그인이 풀리면 발행을 다시 쏘지 않고 상태만 기다린 뒤 한 번만 재시도한다", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ rows: [{ id: "r1" }] }) })) as never;
    mocks.sendInvoiceToHometaxHelper
      .mockResolvedValueOnce({ status: "NEED_LOGIN" })
      .mockResolvedValueOnce({ status: "FILLED" });
    mocks.waitForHometaxLogin.mockResolvedValue(true);
    render(<Harness campaignIds={["c1"]} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled());
    expect(mocks.sendInvoiceToHometaxHelper).toHaveBeenCalledTimes(2);
    expect(mocks.waitForHometaxLogin).toHaveBeenCalledTimes(1);
  });

  it("호출부가 onValidationDetails 를 안 넘기면(카드) 그룹 멤버 전원의 결번을 합쳐 토스트에 싣는다", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({
        details: [
          { campaignId: "c1", campaignName: "캠페인1", missingFields: ["사업자등록번호"] },
          { campaignId: "c2", campaignName: "캠페인2", missingFields: ["대표자명"] },
        ],
      }),
    })) as never;
    render(<Harness campaignIds={["c1", "c2"]} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    const message = mocks.toast.error.mock.calls[0][0] as string;
    expect(message).toContain("사업자등록번호");
    expect(message).toContain("대표자명");
    expect(mocks.sendInvoiceToHometaxHelper).not.toHaveBeenCalled();
  });

  it("결번 상세의 missingFields 가 전부 비어 있으면 일반 문구로 떨어진다(콜론만 남기지 않는다)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({
        details: [{ campaignId: "c1", campaignName: "캠페인1", missingFields: [] }],
      }),
    })) as never;
    render(<Harness campaignIds={["c1"]} />);
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    const message = mocks.toast.error.mock.calls[0][0] as string;
    expect(message.trim().endsWith(":")).toBe(false);
    expect(message).not.toContain("발행 데이터가 부족합니다:");
  });
});
