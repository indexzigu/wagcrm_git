// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// 송장 등록 흐름의 택배사 관문(오너 확정 2026-10-05) — **화면 단에서** 고정한다.
//
// 지키는 것: 택배사를 못 읽은 송장이 한 건이라도 있으면, 운영자가 택배사를 고르기 전에는
// ① 발송처리 API 호출 0 ② 일괄등록 엑셀 내려받기 0 ③ 작업 기록 0. 취소하면 그대로 0 으로 끝난다.
// 순수 로직(`courier-code.test.ts`)과 창(`courier-choice-dialog.test.tsx`)이 각자 맞아도, 화면이
// 관문보다 **앞에서** 내려받기·호출을 하면 전부 무의미해지므로 실제 컴포넌트를 띄워 순서를 본다.
// ⚠️ 네이버·메일 등 외부 호출은 전부 fetch 목이다 — 실제로 나가는 요청은 없다.

const xlsxWriteFile = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const refreshNow = vi.hoisted(() => vi.fn());
// 화면에 뜨는 캠페인 목록 — 기본은 1개, 「창이 떠 있는데 다른 캠페인이 또 묻는」 시험만 2개로 바꾼다.
const campaignList = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock("xlsx", () => {
  const mod = {
    utils: { json_to_sheet: vi.fn(() => ({})), book_new: vi.fn(() => ({})), book_append_sheet: vi.fn() },
    writeFile: xlsxWriteFile,
  };
  return { ...mod, default: mod };
});

vi.mock("@/lib/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/toast")>()),
  notify: notifyMock,
}));

vi.mock("../crm-shell", () => ({
  CrmShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const campaign = {
  id: "order-1",
  name: "테스트 주문 캠페인",
  template: "brand",
  sellerName: "테스트 셀러",
  toEmail: "ops@example.com",
  ccEmail: "",
  tasks: [],
  mappings: [],
  salesCampaigns: [],
  dailyStats: [],
  insights: null,
  isActive: true,
};
const secondCampaign = { ...campaign, id: "order-2", name: "두 번째 주문 캠페인" };

vi.mock("@/hooks/useCampaigns", () => ({
  useCampaigns: () => ({
    campaigns: campaignList.current,
    isLoading: false,
    fetchCampaigns: vi.fn(),
    createCampaign: vi.fn(),
    updateCampaign: vi.fn(),
    deleteCampaign: vi.fn(),
    toggleCampaignStatus: vi.fn(),
    syncMeta: { lastSync: null, syncing: false, syncType: null },
    refreshNow,
    refreshing: false,
  }),
}));
vi.mock("@/hooks/useNaverProducts", () => ({
  useNaverProducts: () => ({ naverProducts: [], isFetchingNaver: false, fetchNaverProducts: vi.fn() }),
}));
vi.mock("@/hooks/useClaims", () => ({
  useClaims: () => ({ claims: [], isLoading: false, error: null, refetch: vi.fn() }),
}));

import OrderDashboard from "../order-dashboard";

type FetchCall = { url: string; body: unknown };
let fetchCalls: FetchCall[] = [];
type TrackingMap = Record<string, { 택배사: string; 송장번호: string }>;
let trackingMap: TrackingMap = {};
// 캠페인별로 다른 회신을 돌려줘야 할 때만 채운다(없으면 trackingMap 을 쓴다).
let trackingMapByCampaign: Record<string, TrackingMap> = {};

const dispatchCalls = () => fetchCalls.filter((c) => c.url.includes("/api/naver/dispatch"));
const actionLogPosts = () => fetchCalls.filter((c) => c.url.endsWith("/api/action-log") && c.body !== null);

beforeEach(() => {
  fetchCalls = [];
  trackingMapByCampaign = {};
  campaignList.current = [campaign];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      fetchCalls.push({ url, body });
      let payload: unknown = {};
      if (url.includes("/parse-reply")) {
        const campaignId = /campaigns\/([^/]+)\/parse-reply/.exec(url)?.[1] ?? "";
        payload = { trackingMap: trackingMapByCampaign[campaignId] ?? trackingMap };
      }
      else if (url.includes("/api/naver/dispatch")) {
        payload = { successCount: body.dispatchRequests.length, failCount: 0, skipCount: 0, skipped: [], failed: [] };
      } else if (url.includes("/api/action-log")) payload = { logs: [] };
      return { ok: true, status: 200, json: async () => payload } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function uploadTo(input: HTMLElement) {
  const file = new File(["x"], "reply.xlsx");
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(1) });
  fireEvent.change(input, { target: { files: [file] } });
}

async function uploadInvoice() {
  render(<OrderDashboard />);
  uploadTo(await screen.findByLabelText(/송장등록/));
}

async function choose(triggerName: string, optionLabel: string) {
  fireEvent.click(screen.getByRole("combobox", { name: triggerName }));
  fireEvent.click(await screen.findByRole("option", { name: optionLabel }));
}

describe("주문관리 화면 — 송장 등록의 택배사 관문", () => {
  it("전부 인식된 송장은 창 없이 종전대로 내려받고 보낸다", async () => {
    trackingMap = {
      "2026100500000001": { 택배사: "CJ대한통운", 송장번호: "111" },
      "2026100500000002": { 택배사: "롯데택배", 송장번호: "222" },
    };
    await uploadInvoice();

    await waitFor(() => expect(dispatchCalls()).toHaveLength(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(xlsxWriteFile).toHaveBeenCalledTimes(1);
    expect(dispatchCalls()[0].body).toMatchObject({
      dispatchRequests: [
        { productOrderId: "2026100500000001", deliveryCompanyCode: "CJGLS", trackingNumber: "111" },
        { productOrderId: "2026100500000002", deliveryCompanyCode: "HYUNDAI", trackingNumber: "222" },
      ],
    });
    await waitFor(() => expect(actionLogPosts()).toHaveLength(1));
    expect((actionLogPosts()[0].body as { details: unknown }).details).toBeNull();
  });

  describe("택배사를 못 읽은 송장이 섞여 있으면", () => {
    beforeEach(() => {
      trackingMap = {
        "2026100500000001": { 택배사: "CJ대한통운", 송장번호: "111" },
        "2026100500000002": { 택배사: "경동택배", 송장번호: "222" },
        "2026100500000003": { 택배사: "", 송장번호: "333" },
        "2026100500000004": { 택배사: "경동택배", 송장번호: "444" },
      };
    });

    it("고르기 전에는 발송처리·내려받기·작업 기록이 전부 0 이고, 고르면 그 택배사로 이어서 등록한다", async () => {
      await uploadInvoice();

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("heading", { name: "택배사를 확인해 주세요" })).toBeInTheDocument();
      expect(dialog).toHaveTextContent("송장 3건의 택배사를 알아보지 못했습니다.");
      expect(dispatchCalls()).toHaveLength(0);
      expect(xlsxWriteFile).not.toHaveBeenCalled();
      expect(actionLogPosts()).toHaveLength(0);

      await choose("경동택배 택배사 선택", "한진택배");
      // 한 묶음만 골랐다 — 아직 아무것도 나가지 않는다.
      expect(within(dialog).getByRole("button", { name: "선택한 택배사로 등록" })).toBeDisabled();
      expect(dispatchCalls()).toHaveLength(0);

      await choose("택배사 미기재 택배사 선택", "우체국택배");
      fireEvent.click(within(dialog).getByRole("button", { name: "선택한 택배사로 등록" }));

      await waitFor(() => expect(dispatchCalls()).toHaveLength(1));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        (dispatchCalls()[0].body as { dispatchRequests: Array<{ productOrderId: string; deliveryCompanyCode: string }> })
          .dispatchRequests.map((r) => [r.productOrderId, r.deliveryCompanyCode]),
      ).toEqual([
        ["2026100500000001", "CJGLS"],
        ["2026100500000002", "HANJIN"],
        ["2026100500000003", "EPOST"],
        ["2026100500000004", "HANJIN"],
      ]);
      expect(xlsxWriteFile).toHaveBeenCalledTimes(1);

      await waitFor(() => expect(actionLogPosts()).toHaveLength(1));
      expect(actionLogPosts()[0].body).toMatchObject({
        action: "REGISTER_INVOICE",
        successCount: 4,
        details: {
          courierOverrides: [
            { raw: "경동택배", code: "HANJIN", count: 2 },
            { raw: "택배사 미기재", code: "EPOST", count: 1 },
          ],
        },
      });
    });

    it("취소하면 발송처리 0 · 내려받기 0 · 작업 기록 0 으로 끝나고 창이 닫힌다", async () => {
      await uploadInvoice();

      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      // 취소 뒤 잠금이 풀려 다시 올릴 수 있어야 한다(업로드 라벨의 잠금 해제 = 흐름이 끝났다는 신호).
      await waitFor(() => expect(screen.getByLabelText(/송장등록/)).toBeEnabled());
      expect(dispatchCalls()).toHaveLength(0);
      expect(xlsxWriteFile).not.toHaveBeenCalled();
      expect(actionLogPosts()).toHaveLength(0);
      expect(refreshNow).not.toHaveBeenCalled();
    });
  });

  it("창이 떠 있는데 다른 캠페인이 또 물으면, 앞선 흐름은 취소로 끝나 잠금이 풀리고 새 창이 뜬다", async () => {
    campaignList.current = [campaign, secondCampaign];
    trackingMapByCampaign = {
      "order-1": { "2026100500000001": { 택배사: "경동택배", 송장번호: "111" } },
      "order-2": { "2026100500000009": { 택배사: "건영택배", 송장번호: "999" } },
    };
    render(<OrderDashboard />);
    const [inputA, inputB] = await screen.findAllByLabelText(/송장등록/);

    uploadTo(inputA);
    await screen.findByRole("combobox", { name: "경동택배 택배사 선택" });
    expect(inputA).toBeDisabled();
    // A 창에서 하나 골라 둔다 — 이 선택이 B 창으로 새어 들어가면 안 된다.
    await choose("경동택배 택배사 선택", "한진택배");

    uploadTo(inputB);
    await screen.findByRole("combobox", { name: "건영택배 택배사 선택" });

    // A 의 흐름은 취소로 끝났다 — 아무것도 나가지 않았고 A 의 잠금이 풀렸다.
    await waitFor(() => expect(inputA).toBeEnabled());
    expect(screen.queryByRole("combobox", { name: "경동택배 택배사 선택" })).not.toBeInTheDocument();
    expect(dispatchCalls()).toHaveLength(0);
    expect(xlsxWriteFile).not.toHaveBeenCalled();
    expect(actionLogPosts()).toHaveLength(0);

    // B 창은 새 창이다 — 아직 아무것도 골라져 있지 않고, 고르면 B 의 송장만 나간다.
    const dialog = screen.getByRole("dialog");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "선택한 택배사로 등록" })).toBeDisabled();
    await choose("건영택배 택배사 선택", "우체국택배");
    fireEvent.click(within(dialog).getByRole("button", { name: "선택한 택배사로 등록" }));

    await waitFor(() => expect(dispatchCalls()).toHaveLength(1));
    expect(
      (dispatchCalls()[0].body as { dispatchRequests: Array<{ productOrderId: string; deliveryCompanyCode: string }> })
        .dispatchRequests.map((r) => [r.productOrderId, r.deliveryCompanyCode]),
    ).toEqual([["2026100500000009", "EPOST"]]);
    await waitFor(() => expect(inputB).toBeEnabled());
  });

  it("화면이 사라지면 묻던 흐름도 취소로 끝나 아무것도 나가지 않는다", async () => {
    trackingMap = { "2026100500000001": { 택배사: "경동택배", 송장번호: "111" } };
    const { unmount } = render(<OrderDashboard />);
    uploadTo(await screen.findByLabelText(/송장등록/));
    await screen.findByRole("dialog");

    unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchCalls()).toHaveLength(0);
    expect(xlsxWriteFile).not.toHaveBeenCalled();
    expect(actionLogPosts()).toHaveLength(0);
  });
});
