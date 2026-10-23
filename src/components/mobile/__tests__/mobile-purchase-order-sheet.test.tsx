// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobilePurchaseOrderSheet } from "../mobile-purchase-order-sheet";
import type { MobilePurchaseOrderInfo } from "@/lib/mobile-campaign-sales";

/**
 * 모바일 발주서 간편 전송 시트(2026-10-23) — 데스크톱 발송 창과 **같은 라우트·같은 페이로드**를
 * 보내는지와, 축소판이 남긴 세 가지(받는 사람 편집 · 누락 동의 · 메일 재발송)를 고정한다.
 */

const INFO: MobilePurchaseOrderInfo = {
  orderCampaignId: "oc-1",
  sendable: true,
  toEmail: "order@brand.example.com",
  ccEmail: "cc@brand.example.com",
  sellerName: "하늘맘",
};

const PO_BASE = "/order-converter/api/campaigns/oc-1/purchase-order";

function row(overrides: Partial<{ productOrderId: string; needsConfirm: boolean; missing: string[] }> = {}) {
  return {
    productOrderId: "PO-1",
    orderId: "O-1",
    recipientName: "김수령",
    optionName: "30ml",
    quantity: 1,
    shippingMemo: "",
    needsConfirm: false,
    missing: [] as string[],
    ...overrides,
  };
}

function previewPayload(rows: ReturnType<typeof row>[], source: "prepared" | "live" = "live") {
  return {
    source,
    asOfIso: "2026-07-08T02:30:00.000Z",
    rows,
    summary: {
      lineCount: rows.length,
      quantityTotal: rows.reduce((sum, r) => sum + r.quantity, 0),
      needsConfirmCount: rows.filter((r) => r.needsConfirm).length,
      missingCount: rows.filter((r) => r.missing.length > 0).length,
    },
    empty: rows.length === 0 ? { message: "발주할 주문이 없습니다.", noWork: true } : null,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => payload };
}

const fetchMock = vi.fn();

type Scenario = {
  availability?: { available: boolean; reason?: string; asOfIso: string | null };
  preview?: ReturnType<typeof previewPayload>;
  commit?: { status?: number; body?: unknown };
  mail?: { status?: number; body?: unknown }[];
};

function stubFetch(scenario: Scenario) {
  const mailQueue = [...(scenario.mail ?? [{ status: 200, body: { message: "ok" } }])];
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === PO_BASE && method === "GET") {
      return jsonResponse({ availability: scenario.availability ?? { available: false, reason: "disabled", asOfIso: null } });
    }
    if (url.startsWith(`${PO_BASE}?`) && method === "GET") {
      return jsonResponse(scenario.preview ?? previewPayload([row()]));
    }
    if (url === PO_BASE && method === "POST") {
      const c = scenario.commit ?? {};
      return jsonResponse(
        c.body ?? {
          fileName: "발주서_기본_와이그라운드_하늘맘_260708.xlsx",
          fileBase64: btoa("xlsx"),
          productOrderIds: ["PO-1"],
          dropped: [],
          confirm: { requested: 0, succeeded: 0, failed: 0, firstError: "" },
        },
        c.status ?? 200,
      );
    }
    if (url === "/order-converter/api/send-email" && method === "POST") {
      const m = mailQueue.shift() ?? { status: 200, body: { message: "ok" } };
      return jsonResponse(m.body ?? { message: "ok" }, m.status ?? 200);
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function callsTo(pathPrefix: string, method = "GET") {
  return fetchMock.mock.calls.filter(
    ([input, init]) => String(input).startsWith(pathPrefix) && (init?.method ?? "GET") === method,
  );
}

function renderSheet(props: Partial<Parameters<typeof MobilePurchaseOrderSheet>[0]> = {}) {
  const onSent = vi.fn();
  render(
    <MobilePurchaseOrderSheet
      open
      onOpenChange={vi.fn()}
      purchaseOrder={INFO}
      campaignLabel="비타민C 앰플 · 하늘맘"
      onSent={onSent}
      {...props}
    />,
  );
  return { onSent };
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MobilePurchaseOrderSheet — 번들 경계", () => {
  it("서버 전용 모듈(prepared-po · naver-order-sync)을 직접 가져오지 않는다 — 클라이언트 번들이 깨진다", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "src/components/mobile/mobile-purchase-order-sheet.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(source).not.toMatch(/from "@\/lib\/order-converter\/prepared-po"/);
    expect(source).not.toMatch(/from "@\/lib\/order-converter\/naver-order-sync"/);
    expect(source).toMatch(/from "@\/lib\/order-converter\/prepared-po-format"/);
  });
});

describe("MobilePurchaseOrderSheet — 미리보기", () => {
  it("열리면 준비본 여부를 묻고, 불가면 지금 수집(live)으로 미리보기를 읽는다 — 네이버 쓰기 없음", async () => {
    stubFetch({});
    renderSheet();

    await screen.findByRole("button", { name: "발송" });
    const previews = callsTo(`${PO_BASE}?`);
    expect(previews).toHaveLength(1);
    expect(String(previews[0][0])).toContain("source=live");
    expect(String(previews[0][0])).toContain("includePending=false");
    expect(callsTo(PO_BASE, "POST")).toHaveLength(0);
    expect(screen.getByText(/지금 수집/)).toBeInTheDocument();
  });

  it("준비본 불가 사유는 서버가 보낸 문장을 그대로 보인다", async () => {
    stubFetch({
      availability: { available: false, reason: "disabled", asOfIso: null, message: "이 캠페인은 발주서 자동 준비가 꺼져 있습니다." } as never,
    });
    renderSheet();
    await screen.findByRole("button", { name: "발송" });
    expect(screen.getByText(/자동 준비가 꺼져 있습니다/)).toBeInTheDocument();
  });

  it("준비본이 가능하면 자동으로 준비본(prepared)을 고른다 — 사용자 선택 없음", async () => {
    stubFetch({
      availability: { available: true, asOfIso: "2026-07-08T02:00:00.000Z" },
      preview: previewPayload([row()], "prepared"),
    });
    renderSheet();

    await screen.findByRole("button", { name: "발송" });
    expect(String(callsTo(`${PO_BASE}?`)[0][0])).toContain("source=prepared");
    expect(screen.getByText(/준비본/)).toBeInTheDocument();
  });

  it("받는 사람은 브랜드 수신처로 채워지고 편집할 수 있다 · 참조는 표시만", async () => {
    stubFetch({});
    renderSheet();

    const to = (await screen.findByLabelText("메일 주소")) as HTMLInputElement;
    expect(to.value).toBe("order@brand.example.com");
    expect(screen.getByText(/참조 cc@brand\.example\.com/)).toBeInTheDocument();
    expect(screen.queryByLabelText("참조")).toBeNull();
    expect(screen.queryByLabelText("받는 사람")).toBeNull();
  });

  it("발주확인이 필요한 행이 있으면 버튼이 「발주확인하고 발송」이다", async () => {
    stubFetch({ preview: previewPayload([row({ needsConfirm: true })]) });
    renderSheet();
    expect(await screen.findByRole("button", { name: "발주확인하고 발송" })).toBeEnabled();
  });

  it("발주할 주문이 없으면 버튼이 비활성이다", async () => {
    stubFetch({ preview: previewPayload([]) });
    renderSheet();
    expect(await screen.findByRole("button", { name: "발송" })).toBeDisabled();
    expect(screen.getByText("발주할 주문이 없습니다.")).toBeInTheDocument();
  });

  it("누락 행이 있으면 동의 체크 전에는 보낼 수 없다", async () => {
    stubFetch({ preview: previewPayload([row({ missing: ["phone"] })]) });
    const user = userEvent.setup();
    renderSheet();

    const send = await screen.findByRole("button", { name: "발송" });
    expect(send).toBeDisabled();
    await user.click(screen.getByLabelText("빈 칸 주문 포함 동의"));
    expect(send).toBeEnabled();
  });

  it("누락이 없으면 동의 체크 없이 안내줄만 같은 자리에 둔다 — 레이아웃 안정", async () => {
    stubFetch({});
    renderSheet();
    await screen.findByRole("button", { name: "발송" });
    expect(screen.queryByLabelText("빈 칸 주문 포함 동의")).toBeNull();
    expect(screen.getByText(/빈 주문 없음/)).toBeInTheDocument();
  });

  it("미리보기 실패면 오류와 「다시 불러오기」만 보이고 보내기 버튼은 없다", async () => {
    stubFetch({});
    fetchMock.mockImplementationOnce(async () => jsonResponse({ availability: null }));
    fetchMock.mockImplementationOnce(async () => jsonResponse({ error: "양식이 없습니다." }, 400));
    renderSheet();

    expect(await screen.findByText("양식이 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "미리보기 다시 불러오기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "발송" })).toBeNull();
  });
});

describe("MobilePurchaseOrderSheet — 확정·발송", () => {
  it("확정 POST 는 데스크톱과 같은 몸체(source·전체 id·확인 필요 id·includePending=false)를 보내고, 메일은 편집한 받는 사람으로 간다", async () => {
    stubFetch({
      preview: previewPayload([row({ productOrderId: "PO-1", needsConfirm: true }), row({ productOrderId: "PO-2" })]),
      commit: {
        body: {
          fileName: "발주서.xlsx",
          fileBase64: btoa("xlsx"),
          productOrderIds: ["PO-1", "PO-2"],
          dropped: [],
          confirm: { requested: 1, succeeded: 1, failed: 0, firstError: "" },
        },
      },
    });
    const user = userEvent.setup();
    const { onSent } = renderSheet();

    const to = await screen.findByLabelText("메일 주소");
    await user.clear(to);
    await user.type(to, "other@brand.example.com");
    await user.click(screen.getByRole("button", { name: "발주확인하고 발송" }));

    await screen.findByText(/발주서 2건 · other@brand\.example\.com/);
    const [, commitInit] = callsTo(PO_BASE, "POST")[0];
    expect(JSON.parse(String(commitInit?.body))).toEqual({
      source: "live",
      productOrderIds: ["PO-1", "PO-2"],
      confirmIds: ["PO-1"],
      includePending: false,
    });

    const [, mailInit] = callsTo("/order-converter/api/send-email", "POST")[0];
    const form = mailInit?.body as FormData;
    expect(form.get("to")).toBe("other@brand.example.com");
    expect(form.get("cc")).toBe("cc@brand.example.com");
    expect(form.get("campaignId")).toBe("oc-1");
    expect(form.get("productOrderIds")).toBe("PO-1,PO-2");
    expect(String(form.get("subject"))).toMatch(/^\[와이그라운드\] 하늘맘 \d{6} 발주서 보내드립니다\.$/);
    expect(String(form.get("message"))).toContain("하늘맘 발주서를 첨부하여");
    expect((form.get("file") as File).name).toBe("발주서.xlsx");
    expect(onSent).toHaveBeenCalledWith(2);
    expect(screen.getByText(/네이버 발주확인 1\/1/)).toBeInTheDocument();
  });

  it("받는 사람이 비어 있으면 확정 POST 를 보내지 않는다", async () => {
    stubFetch({});
    const user = userEvent.setup();
    renderSheet({ purchaseOrder: { ...INFO, toEmail: null } });

    await user.click(await screen.findByRole("button", { name: "발송" }));
    expect(screen.getByRole("alert")).toHaveTextContent("받는 사람 이메일을 입력하세요.");
    expect(callsTo(PO_BASE, "POST")).toHaveLength(0);
  });

  it("이메일 형식이 아니면 되돌릴 수 없는 발주확인 전에 막는다 — 쉼표 목록은 허용", async () => {
    stubFetch({});
    const user = userEvent.setup();
    renderSheet({ purchaseOrder: { ...INFO, toEmail: "a@b" } });

    await user.click(await screen.findByRole("button", { name: "발송" }));
    expect(screen.getByRole("alert")).toHaveTextContent("이메일 주소 형식을 확인하세요.");
    expect(callsTo(PO_BASE, "POST")).toHaveLength(0);

    const to = screen.getByLabelText("메일 주소");
    await user.clear(to);
    await user.type(to, "a@brand.example.com, b@brand.example.com");
    await user.click(screen.getByRole("button", { name: "발송" }));
    await screen.findByText(/발주서 1건 ·/);
    expect(callsTo(PO_BASE, "POST")).toHaveLength(1);
  });

  it("발주확인 진행 중에는 닫히지 않는다 — 닫았다 열면 두 번째 발주확인이 가능해지기 때문", async () => {
    let resolveCommit: (() => void) | null = null;
    stubFetch({});
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === PO_BASE && method === "GET") return jsonResponse({ availability: { available: false, reason: "disabled", asOfIso: null } });
      if (url.startsWith(`${PO_BASE}?`)) return jsonResponse(previewPayload([row()]));
      if (url === PO_BASE && method === "POST") {
        await new Promise<void>((resolve) => {
          resolveCommit = resolve;
        });
        return jsonResponse({ fileName: "f.xlsx", fileBase64: btoa("x"), productOrderIds: ["PO-1"], dropped: [], confirm: { requested: 0, succeeded: 0, failed: 0, firstError: "" } });
      }
      return jsonResponse({ message: "ok" });
    });
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderSheet({ onOpenChange });

    await user.click(await screen.findByRole("button", { name: "발송" }));
    await screen.findByRole("button", { name: "발주확인 중…" });
    await user.click(screen.getByRole("button", { name: "발주서 전송 닫기" }));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    resolveCommit!();
    await screen.findByText(/발주서 1건 ·/);
    expect(callsTo(PO_BASE, "POST")).toHaveLength(1);
  });

  it("확정이 실패하면 미리보기를 버리고 다시 불러오게 한다(발주확인이 일부 일어났을 수 있다)", async () => {
    stubFetch({ commit: { status: 502, body: { error: "네이버 응답 없음" } } });
    const user = userEvent.setup();
    renderSheet();

    await user.click(await screen.findByRole("button", { name: "발송" }));
    expect(await screen.findByText(/네이버 응답 없음.*미리보기를 다시 불러와/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "발송" })).toBeNull();
    expect(callsTo("/order-converter/api/send-email", "POST")).toHaveLength(0);
  });

  it("확정 409(보낼 행 0건 — 전부 취소·이미 요청됨)도 서버 문장을 보이고 메일은 보내지 않는다", async () => {
    stubFetch({
      commit: {
        status: 409,
        body: { error: "발주서에 실을 주문이 없습니다.", dropped: [{ productOrderId: "PO-1", recipientName: "김수령", reason: "already-requested" }], confirm: { requested: 0, succeeded: 0, failed: 0, firstError: "" } },
      },
    });
    const user = userEvent.setup();
    renderSheet();

    await user.click(await screen.findByRole("button", { name: "발송" }));
    expect(await screen.findByText(/발주서에 실을 주문이 없습니다\..*미리보기를 다시 불러와/)).toBeInTheDocument();
    expect(callsTo("/order-converter/api/send-email", "POST")).toHaveLength(0);
  });

  it("메일만 실패하면 「메일 다시 보내기」로 같은 파일을 재발송하고 확정을 반복하지 않는다", async () => {
    stubFetch({ mail: [{ status: 500, body: { error: "SMTP 거부" } }, { status: 200 }] });
    const user = userEvent.setup();
    const { onSent } = renderSheet();

    await user.click(await screen.findByRole("button", { name: "발송" }));
    expect(await screen.findByText("SMTP 거부")).toBeInTheDocument();
    expect(onSent).not.toHaveBeenCalled();
    // 실패 화면에서도 받는 사람을 고칠 수 있고(가장 흔한 실패가 주소 오타), 미리보기 카드는 다시 뜨지 않는다.
    const to = screen.getByLabelText("메일 주소");
    await user.clear(to);
    await user.type(to, "fixed@brand.example.com");
    expect(screen.queryByRole("region", { name: "발주 미리보기" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "메일 다시 보내기" }));
    await screen.findByText(/발주서 1건 · fixed@brand\.example\.com/);
    expect(callsTo(PO_BASE, "POST")).toHaveLength(1);
    const mails = callsTo("/order-converter/api/send-email", "POST");
    expect(mails).toHaveLength(2);
    expect((mails[1][1]?.body as FormData).get("to")).toBe("fixed@brand.example.com");
    expect(onSent).toHaveBeenCalledWith(1);
  });

  it("빠진 주문(dropped)은 사유와 함께 보여 준다", async () => {
    stubFetch({
      commit: {
        body: {
          fileName: "발주서.xlsx",
          fileBase64: btoa("xlsx"),
          productOrderIds: ["PO-1"],
          dropped: [{ productOrderId: "PO-9", recipientName: "박취소", reason: "status-changed" }],
          confirm: { requested: 0, succeeded: 0, failed: 0, firstError: "" },
        },
      },
    });
    const user = userEvent.setup();
    renderSheet();

    await user.click(await screen.findByRole("button", { name: "발송" }));
    await waitFor(() => expect(screen.getByText(/발주서에서 빠진 주문 1건/)).toBeInTheDocument());
    expect(screen.getByText(/박취소 · 취소·변경됨/)).toBeInTheDocument();
  });
});
