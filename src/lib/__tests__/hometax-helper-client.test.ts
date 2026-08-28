// 홈택스 로컬 헬퍼 클라이언트 계약.
//
// 이 모듈은 CRM(https)에서 오너 Mac 의 로컬 헬퍼(http://127.0.0.1)로 발행 데이터를
// 보내는 유일한 통로다. 지키는 계약: ① 기본 주소는 loopback 이다 — 외부 호스트로
// 바뀌면 사업자번호·금액이 로컬 밖으로 나간다(P0). ② health 실패는 throw 가 아니라
// false 다(헬퍼 미실행이 정상 상태). ③ issue 응답의 status 는 알려진 3종만 통과한다
// — 모르는 응답을 성공처럼 다루면 "채워졌다"고 믿고 검토 없이 발급하게 된다.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HOMETAX_HELPER_BASE_URL,
  checkHometaxHelperHealth,
  sendInvoiceToHometaxHelper,
  waitForHometaxLogin,
} from "../hometax-helper-client";
import type { TaxInvoiceRow } from "../tax-invoice-builder";

const INVOICE = {
  invoiceType: "01",
  invoiceDate: "20260805",
  supplierBusinessNumber: "6866800667",
  totalSupplyAmount: 1_000_000,
  totalTaxAmount: 100_000,
  lineItems: [],
} as unknown as TaxInvoiceRow;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hometax-helper-client", () => {
  it("기본 주소는 loopback 이다 — 발행 데이터가 로컬 밖으로 나가면 안 된다", () => {
    expect(HOMETAX_HELPER_BASE_URL).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/);
  });

  it("헬퍼 미실행(네트워크 실패)이면 health 는 throw 없이 false 다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(checkHometaxHelperHealth()).resolves.toBe(false);
  });

  it("issue 는 /issue 로 invoice 를 POST 하고 알려진 status 를 그대로 돌려준다", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "FILLED" }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendInvoiceToHometaxHelper(INVOICE);
    expect(result).toEqual({ status: "FILLED" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${HOMETAX_HELPER_BASE_URL}/issue`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ invoice: INVOICE });
  });

  it("AWAITING_CONFIRM 은 정상 응답이다 — 발급 확인 창이 뜬 「사람 차례」 상태", async () => {
    // 헬퍼가 「발급하기」까지 누르는 개정(2026-08-08 오너 승인)으로 생긴 status 다.
    // 이 값이 목록에서 빠지면 **가장 성공에 가까운 순간이 「통신 실패」로 보고**된다 —
    // 2026-08-07 의 NEEDS_CHOICE 사고와 같은 부류라 행위로도 고정한다.
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ status: "AWAITING_CONFIRM", message: "확인 창이 떴습니다" }), {
        headers: { "content-type": "application/json" },
      }),
    ));
    await expect(sendInvoiceToHometaxHelper(INVOICE)).resolves.toEqual({
      status: "AWAITING_CONFIRM",
      message: "확인 창이 떴습니다",
    });
  });

  it("알 수 없는 status 는 성공으로 다루지 않고 throw 한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ status: "DONE_AND_ISSUED" }), {
        headers: { "content-type": "application/json" },
      }),
    ));
    await expect(sendInvoiceToHometaxHelper(INVOICE)).rejects.toThrow();
  });

  it("HTTP 오류 응답은 throw 한다(조용히 삼키지 않는다)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(sendInvoiceToHometaxHelper(INVOICE)).rejects.toThrow("HTTP 500");
  });

  it("헬퍼가 내는 status 를 하나도 빠뜨리지 않는다 — 빠지면 정상 응답이 「통신 실패」가 된다", () => {
    // 🪤 실사고(2026-08-07): 헬퍼의 `NEEDS_CHOICE`(홈택스가 사람이 누를 창을 띄운
    // 상태 — **폼은 채워져 있다**)가 이 목록에 없어서 클라이언트가 throw 했고,
    // 다이얼로그의 catch 가 「홈택스 로컬 헬퍼와의 통신에 실패했습니다」로 뭉갰다.
    // 오너는 멀쩡히 채워진 폼을 보며 실패 메시지를 읽었다. 검사의 목적은 **모르는
    // 값을 막는 것**이지 아는 값을 빠뜨리는 것이 아니므로, 두 소스를 대조해 고정한다.
    const helperSrc = readFileSync(
      resolve(process.cwd(), "scripts/hometax-helper/index.ts"),
      "utf8",
    );
    const issueSrc = helperSrc.slice(
      helperSrc.indexOf("async function handleIssue"),
      helperSrc.indexOf("const server = createServer"),
    );
    const statuses = [...issueSrc.matchAll(/status:\s*"([A-Z_]+)"/g)].map((m) => m[1]);
    // 양성 대조군 — 정규식이 깨지면 위 단언이 공짜로 통과한다.
    expect(new Set(statuses).size).toBeGreaterThanOrEqual(4);

    const clientSrc = readFileSync(
      resolve(process.cwd(), "src/lib/hometax-helper-client.ts"),
      "utf8",
    );
    for (const status of new Set(statuses)) {
      expect(clientSrc, `헬퍼의 status "${status}" 가 클라이언트에 없습니다`).toContain(
        `"${status}"`,
      );
    }
  });
});

describe("waitForHometaxLogin — 취소는 즉시 먹는다", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("long-poll 도중 abort 하면 chunk 가 끝나기를 기다리지 않고 돌아온다", async () => {
    // 🪤 실사용 지적(2026-08-09): 취소 신호가 fetch 에 연결돼 있지 않아, 「취소」를
    // 눌러도 진행 중인 15초 chunk 가 끝나야 반응했다 — 오너에게는 "취소 버튼이
    // 작동하지 않는다"로 보였다. 이 테스트는 abort 가 진행 중인 요청을 끊는지를
    // 행위로 고정한다(신호를 안 넘기면 아래 fetch 는 chunk 시간만큼 매달린다).
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        // resolve 하지 않는다 — long-poll 이 계속 매달려 있는 상황을 흉내 낸다.
      }),
    ));

    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = waitForHometaxLogin({ timeoutMs: 60_000, chunkMs: 15_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    await expect(pending).resolves.toBe(false);
    // chunk(15초)를 기다렸다면 이 단언이 잡는다 — 여유를 두되 chunk 보다 훨씬 짧게.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
