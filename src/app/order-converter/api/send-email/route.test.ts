import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// 실제 메일은 보내지 않는다 — nodemailer·DB·저장소 전부 모의 객체다. 주소·이름은 합성 데이터.

const sendMailMock = vi.fn();
const taskUpsertMock = vi.fn();
const campaignFindUniqueMock = vi.fn();
const stampPoRequestedMock = vi.fn();

vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: (...args: unknown[]) => sendMailMock(...args) }) },
}));

vi.mock("@/lib/order-converter/prisma", () => ({
  prisma: {
    orderCampaign: { findUnique: (...args: unknown[]) => campaignFindUniqueMock(...args) },
    dailyOrderTask: { upsert: (...args: unknown[]) => taskUpsertMock(...args) },
  },
}));

vi.mock("@/repositories/orderFulfillmentRepository", () => ({
  orderFulfillmentRepository: {
    stampPoRequested: (...args: unknown[]) => stampPoRequestedMock(...args),
    getPoRequestedSet: vi.fn(async () => new Set<string>()),
  },
}));

vi.mock("@/lib/order-converter/campaign-orders", () => ({
  resolveCampaignExpectedOrderIds: vi.fn(async () => ({ orderIds: new Set<string>() })),
}));

vi.mock("@/lib/mail-config", () => ({
  resolveMailCredentials: () => ({ user: "sender@example.com", pass: "test-only" }),
  resolveSmtpConfig: () => ({}),
  resolveMailFrom: () => ({ name: "테스트 발신", email: "sender@example.com" }),
}));

import { POST } from "./route";

function buildRequest(): NextRequest {
  const form = new FormData();
  form.set("file", new File(["dummy"], "po.xlsx"));
  form.set("to", "supplier@example.com");
  form.set("campaignId", "oc-1");
  form.set("productOrderIds", "P1,P2");
  return new NextRequest("http://localhost/order-converter/api/send-email", { method: "POST", body: form });
}

describe("POST /order-converter/api/send-email — 발송과 기록의 순서", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    campaignFindUniqueMock.mockResolvedValue({ id: "oc-1", sellerName: "테스트셀러" });
    sendMailMock.mockResolvedValue({ messageId: "m-1" });
    stampPoRequestedMock.mockResolvedValue(undefined);
    taskUpsertMock.mockResolvedValue({});
  });

  it("발송과 기록이 모두 되면 200 이고 기록 실패 표시가 없다", async () => {
    const res = await POST(buildRequest());
    expect(res.status).toBe(200);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(taskUpsertMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.recordSaved).toBe(true);
    expect(body.warning).toBeUndefined();
  });

  // 메일은 되돌릴 수 없다. 발송 뒤의 기록 저장이 실패했다고 「발송 실패」로 답하면 화면이
  // 「메일 다시 보내기」를 열어 거래처에 같은 발주서가 두 번 간다.
  it("메일이 나간 뒤 기록 저장이 실패해도 실패(500)로 답하지 않는다", async () => {
    taskUpsertMock.mockRejectedValue(new Error("db down"));
    const res = await POST(buildRequest());
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recordSaved).toBe(false);
    expect(typeof body.warning).toBe("string");
    // 삼키지 않는다 — 서버 로그에 남긴다.
    expect(console.error).toHaveBeenCalled();
  });

  it("메일 발송 자체가 실패하면 500 이고 기록을 남기지 않는다", async () => {
    sendMailMock.mockRejectedValue(new Error("smtp refused"));
    const res = await POST(buildRequest());
    expect(res.status).toBe(500);
    expect(taskUpsertMock).not.toHaveBeenCalled();
    expect(stampPoRequestedMock).not.toHaveBeenCalled();
  });
});
