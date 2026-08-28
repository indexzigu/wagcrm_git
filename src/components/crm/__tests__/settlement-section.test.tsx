// @vitest-environment jsdom
// 정산 카드 「정산 및 회계 일정」 — 계산서 방향 표시 계약(2026-08-07).
//
// 카드는 채널 분기를 스스로 쓰지 않고 TAX_INVOICE_OBLIGATION_TABLE 에서 파생한다.
// 종전엔 두 칸을 양쪽 다 「발행」으로 하드코딩해 우리몰에서 라벨이 거짓말을 했다.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SettlementSection } from "../settlement-section";
import type { CampaignRow } from "@/lib/crm-types";
import { toast } from "sonner";
import { fetchGroupDetail } from "@/lib/campaign-group-client";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@/lib/campaign-group-client", () => ({
  fetchGroupDetail: vi.fn(),
}));

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "c1",
    dealName: "테스트딜",
    partnerName: "테스트거래처",
    sellerName: "테스트셀러",
    salesChannel: "OWN_MALL",
    sellerTaxType: "BUSINESS",
    sellerCompanyBusinessNumber: "1234567890",
    ...overrides,
  } as CampaignRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as never;
});

describe("SettlementSection — 계산서 방향 표시", () => {
  it("우리몰은 두 칸 다 「수취」로 렌더된다", () => {
    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    expect(screen.getByText("공급사 계산서 수취")).toBeInTheDocument();
    expect(screen.getByText("셀러 계산서 수취")).toBeInTheDocument();
    expect(screen.queryByText(/계산서 발행/)).not.toBeInTheDocument();
  });

  it("브랜드몰은 공급사 발행 · 셀러 수취다", () => {
    render(<SettlementSection campaign={makeCampaign({ salesChannel: "BRAND_MALL" })} onCampaignUpdated={vi.fn()} />);
    expect(screen.getByText("공급사 계산서 발행")).toBeInTheDocument();
    expect(screen.getByText("셀러 계산서 수취")).toBeInTheDocument();
  });

  it("셀러몰은 공급사 수취 · 셀러 발행이다", () => {
    render(<SettlementSection campaign={makeCampaign({ salesChannel: "SELLER_MALL" })} onCampaignUpdated={vi.fn()} />);
    expect(screen.getByText("공급사 계산서 수취")).toBeInTheDocument();
    expect(screen.getByText("셀러 계산서 발행")).toBeInTheDocument();
  });

  it("개인 셀러의 셀러 칸은 계산서가 아니라 원천징수 신고 칸이고 읽기 전용이다", () => {
    render(
      <SettlementSection
        campaign={makeCampaign({ salesChannel: "OWN_MALL", sellerTaxType: "INDIVIDUAL", sellerCompanyBusinessNumber: null })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    expect(screen.getByText("원천징수 신고")).toBeInTheDocument();
    expect(screen.queryByText("셀러 계산서 수취")).not.toBeInTheDocument();
    // 조작은 세무 처리 다이얼로그가 소유한다 — 여기서 쓰면 월 단위 사실이 두 곳에서 조작된다.
    expect(screen.getByLabelText("원천징수 신고 완료 (세무 처리에서 관리)")).toBeDisabled();
  });

  it("해당 없는 칸이라도 이미 붙여 둔 증빙 「확인」 링크는 계속 보여준다 — 첨부 버튼만 숨긴다", () => {
    render(
      <SettlementSection
        campaign={makeCampaign({
          salesChannel: "OWN_MALL",
          sellerTaxType: "INDIVIDUAL",
          sellerCompanyBusinessNumber: null,
          notesFromImport: JSON.stringify({ sellerInvoiceLink: "https://example.com/receipt.pdf" }),
        })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    expect(screen.getByRole("link", { name: /확인/ })).toHaveAttribute(
      "href",
      "https://example.com/receipt.pdf",
    );
    // 첨부 버튼은 두 칸 중 적용 가능한 공급사 칸에만 남는다 — 비적용(셀러) 칸은
    // 새 파일을 붙일 자리가 아니므로 여전히 숨는다.
    expect(screen.getAllByText("첨부")).toHaveLength(1);
  });

  it("개인 셀러인데 계산서 수취일이 이미 찍힌 레거시 행은 계속 보여준다 — 기록을 숨기지 않는다", () => {
    render(
      <SettlementSection
        campaign={makeCampaign({
          salesChannel: "OWN_MALL",
          sellerTaxType: "INDIVIDUAL",
          sellerCompanyBusinessNumber: null,
          sellerInvoiceIssuedAt: "2026-07-15",
        })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    // 원천징수 칸으로 갈아끼운 뒤에도 그 값은 남는다 — 화면에서 사라지면 오너가 해제할
    // 경로도 함께 사라진다(프로덕션에 그런 행이 실재한다). 편집 가능해야 지울 수 있다.
    expect(screen.getByLabelText("셀러 계산서 수취일 기록")).toHaveValue("2026-07-15");
  });

  it("값이 없으면 레거시 계산서 행을 렌더하지 않는다 — 평상시 밀도를 늘리지 않는다", () => {
    render(
      <SettlementSection
        campaign={makeCampaign({ salesChannel: "OWN_MALL", sellerTaxType: "INDIVIDUAL", sellerCompanyBusinessNumber: null })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("셀러 계산서 수취일 기록")).not.toBeInTheDocument();
  });
});

describe("SettlementSection — 원천징수 신고 상태(읽기 전용 파생)", () => {
  function makeIndividual(overrides: Partial<CampaignRow> = {}) {
    return makeCampaign({
      salesChannel: "OWN_MALL",
      sellerTaxType: "INDIVIDUAL",
      sellerCompanyBusinessNumber: null,
      ...overrides,
    });
  }

  /** `GET /api/settlement/tax-filing-log` 만 가로채고 나머지는 통과시킨다. */
  function mockFilingLog(completed: { kind: string; completedAt: string }[]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("tax-filing-log")) {
        return { ok: true, json: async () => ({ month: "2026-07", completed }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fetchMock as never;
    return fetchMock;
  }

  const ALL_THREE = [
    { kind: "WITHHOLDING_RETURN", completedAt: "2026-08-10T01:00:00.000Z" },
    { kind: "SIMPLIFIED_STATEMENT", completedAt: "2026-08-10T01:05:00.000Z" },
    { kind: "LOCAL_INCOME_TAX", completedAt: "2026-08-10T01:10:00.000Z" },
  ];

  it("지급 미완료면 조회하지 않고 「지급 완료 후 신고」로 둔다 — 귀속월 자체가 없다", async () => {
    const fetchMock = mockFilingLog([]);
    render(<SettlementSection campaign={makeIndividual()} onCampaignUpdated={vi.fn()} />);

    expect(await screen.findByText("지급 완료 후 신고")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("tax-filing-log"))).toHaveLength(0);
  });

  it("3절차 전부 완료면 체크되고 원천세 신고일이 뜬다 (오너 확정 기준)", async () => {
    mockFilingLog(ALL_THREE);
    render(
      <SettlementSection campaign={makeIndividual({ payoutCompletedAt: "2026-07-27" })} onCampaignUpdated={vi.fn()} />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("원천징수 신고 완료 (세무 처리에서 관리)")).toBeChecked(),
    );
    // 2026-08-10T01:00Z = KST 10:00 → 같은 날. 일자 축은 1번 원천세 신고다.
    expect(screen.getByText("2026-08-10")).toBeInTheDocument();
  });

  it("일부만 완료면 체크되지 않고 남은 건수를 그 달 기준으로 보여준다", async () => {
    mockFilingLog([{ kind: "WITHHOLDING_RETURN", completedAt: "2026-08-10T01:00:00.000Z" }]);
    render(
      <SettlementSection campaign={makeIndividual({ payoutCompletedAt: "2026-07-27" })} onCampaignUpdated={vi.fn()} />,
    );

    expect(await screen.findByText("2026-07분 · 2건 남음")).toBeInTheDocument();
    expect(screen.getByLabelText("원천징수 신고 완료 (세무 처리에서 관리)")).not.toBeChecked();
  });

  it("조회에 실패하면 「미신고」가 아니라 「조회 실패」로 말한다 — 없는 것과 못 읽은 것은 다르다", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("tax-filing-log")) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    }) as never;

    render(
      <SettlementSection campaign={makeIndividual({ payoutCompletedAt: "2026-07-27" })} onCampaignUpdated={vi.fn()} />,
    );

    expect(await screen.findByText("신고 기록 조회 실패")).toBeInTheDocument();
    expect(screen.queryByText(/건 남음/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("원천징수 신고 완료 (세무 처리에서 관리)")).not.toBeChecked();
    // 신고일 칸도 「없음」으로 두지 않는다 — 그건 미신고라는 **사실 주장**이고, 배지를
    // 못 보고 이 줄만 읽는 오너가 이미 끝낸 신고를 다시 하러 홈택스를 연다.
    expect(screen.getByText("확인 불가")).toBeInTheDocument();
    expect(screen.queryByText("없음")).not.toBeInTheDocument();
  });

  it("법인 셀러 캠페인은 신고 기록을 조회하지 않는다 — 동작이 한 글자도 바뀌지 않는다", async () => {
    const fetchMock = mockFilingLog(ALL_THREE);
    render(
      <SettlementSection
        campaign={makeCampaign({ salesChannel: "OWN_MALL", payoutCompletedAt: "2026-07-27" })}
        onCampaignUpdated={vi.fn()}
      />,
    );

    expect(screen.getByText("셀러 계산서 수취")).toBeInTheDocument();
    expect(screen.queryByText("원천징수 신고")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("tax-filing-log"))).toHaveLength(0),
    );
  });
});

describe("SettlementSection — 방향에 맞는 액션 버튼", () => {
  it("발행 칸에만 「홈택스 발행」이 뜬다 — 수취 칸에는 절대 없다", () => {
    render(<SettlementSection campaign={makeCampaign({ salesChannel: "BRAND_MALL" })} onCampaignUpdated={vi.fn()} />);
    // 브랜드몰 = 공급사 발행 / 셀러 수취
    expect(screen.getAllByRole("button", { name: "홈택스 발행" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "조회" })).toHaveLength(1);
  });

  it("우리몰은 두 칸 다 수취라 「홈택스 발행」이 하나도 없다 — 중복 발행 방어선", () => {
    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "홈택스 발행" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "조회" })).toHaveLength(2);
  });

  it("이미 발행일이 찍힌 칸은 「홈택스 발행」 대신 「발행 완료」를 보여준다 — 중복 발행 방지", () => {
    render(
      <SettlementSection
        campaign={makeCampaign({ salesChannel: "SELLER_MALL", sellerInvoiceIssuedAt: "2026-07-01" })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    // 셀러몰 = 공급사 수취 / 셀러 발행. 셀러 칸에 이미 발행일이 있으므로 발행 버튼이
    // 사라지고 정적 표시로 바뀐다 — 수취 칸(공급사)의 「수취 확인」 버튼은 영향받지 않는다.
    expect(screen.queryByRole("button", { name: "홈택스 발행" })).not.toBeInTheDocument();
    expect(screen.getByText("발행 완료")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "조회" })).toBeInTheDocument();
  });

  it("해당 없는 칸에는 액션 버튼이 없다", () => {
    render(
      <SettlementSection
        campaign={makeCampaign({ salesChannel: "SELLER_MALL", sellerTaxType: "INDIVIDUAL", sellerCompanyBusinessNumber: null })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    // 셀러몰 개인 셀러 = 셀러 발행 칸이 해당 없음 → 발행 버튼 없음, 공급사 수취만 남는다
    expect(screen.queryByRole("button", { name: "홈택스 발행" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "조회" })).toHaveLength(1);
  });

  it("수취 확인은 필드를 쓰지 않는다 — PATCH 를 부르지 않는다", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("tax-invoice-receipts")) {
        return {
          ok: true,
          json: async () => ({ scan: { sinceDays: 90, truncated: 0 }, summary: {}, results: [], unseenExpected: [] }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fetchMock as never;

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const methods = fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? "GET");
    expect(methods).not.toContain("PATCH");
  });

  it("수취 확인을 스캔이 끝나기 전에 연속으로 눌러도 스캔은 한 번만 나간다 — 동기 가드(2026-08-07 회귀 정정)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("tax-invoice-receipts")) {
        return { ok: true, json: async () => ({ results: [], unseenExpected: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fetchMock as never;

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    const button = screen.getAllByRole("button", { name: "조회" })[0];
    // await 없이 연속 클릭 — 첫 클릭의 그룹 조회·스캔 GET 이 끝나기 전에 두 번째가
    // 들어온다. ref 가드가 첫 await 이전에 잠그므로 두 번째는 즉시 반환돼야 한다.
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const receiptCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("tax-invoice-receipts"));
    expect(receiptCalls).toHaveLength(1);
  });
});

describe("SettlementSection — 수취 판정 배지", () => {
  /**
   * ⛔ 「확인됨」은 칸에 남기지 않는다(오너 지시 2026-08-15) — 체크박스·수취일이 이미
   * 그 사실을 말하고, 근거는 「조회」 모달이 통째로 보여준다.
   *
   * ⚠️ **없음만 단언하지 않는다.** 스캔이 아예 안 붙어도 「확인됨」은 없으므로, 그 단언
   * 하나로는 이 테스트가 무엇을 지키는지 알 수 없다(하네스가 고장 나도 초록이다).
   * 판정이 실제로 매칭됐다는 양성 증거 — 그 건이 모달에 떠서 승인까지 열린다 — 를 먼저
   * 확인한 뒤에 배지 부재를 본다.
   */
  it("매칭돼도 칸에는 「확인됨」을 그리지 않는다 — 근거는 조회 모달이 소유한다", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("tax-invoice-receipts")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                mail: {
                  uid: 1,
                  subject: "세금계산서 발행 안내",
                  fromAddress: "invoice@example.com",
                  receivedAt: "2026-07-01T00:00:00.000Z",
                  hasAttachmentEvidence: true,
                },
                verdict: {
                  status: "VERIFIED",
                  confidence: "ATTACHMENT",
                  // board-evidence.ts 의 resolveSlot: supplierInvoiceIssuedAt → SUPPLIER_GOODS
                  matchedKey: "c1:SUPPLIER_GOODS",
                  candidateKeys: [],
                  reasons: [],
                  observed: {
                    issueId: "IV-1",
                    writtenDate: "2026-07-01",
                    counterpartBusinessNumber: null,
                    totalAmount: 100000,
                    expectedTotalAmount: 100000,
                    amountDelta: 0,
                  },
                },
              },
            ],
            unseenExpected: [],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fetchMock as never;

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    // 공급사 계산서 칸의 수취 확인 — 카드 전체가 같은 스캔 결과를 공유한다.
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[0]);

    // 양성 증거: 그 건이 이 칸의 모달에 떴고(수취일 = 승인이 적을 값) 승인 경로도 열렸다.
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("2026-07-01");
    expect(within(dialog).getByRole("button", { name: "승인" })).toBeInTheDocument();

    // 그 위에서 「확인됨」은 화면 어디에도 없다 — 모달 본문도 그 단어를 쓰지 않는다.
    expect(screen.queryByText("확인됨")).not.toBeInTheDocument();
  });

  it("기대 건인데 메일을 못 본 경우 「메일 미발견」이 뜬다 — 「미수취」라고 단정하지 않는다", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("tax-invoice-receipts")) {
        return {
          ok: true,
          json: async () => ({
            results: [],
            unseenExpected: [
              {
                // board-evidence.ts 의 resolveSlot: sellerInvoiceIssuedAt → SELLER_COMMISSION
                key: "c1:SELLER_COMMISSION",
                campaignId: "c1",
                campaignLabel: "테스트딜",
                channel: "OWN_MALL",
                slot: "SELLER_COMMISSION",
                counterpartLabel: "셀러",
                counterpartBusinessNumberMissing: false,
                expectedTotalAmount: 50000,
                amountBasis: "commission",
                trackingField: "sellerInvoiceIssuedAt",
                alreadyMarkedAt: null,
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fetchMock as never;

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[0]);

    expect(await screen.findByText("메일 미발견")).toBeInTheDocument();
    // 메일 커버리지가 100% 가 아니므로 「안 왔다」로 단정하는 「미수취」 문구는 어디에도 없다.
    expect(screen.queryByText(/미수취/)).not.toBeInTheDocument();
  });
});

/**
 * 조회 모달의 **크기 안정성**(오너 지적 2026-08-15: 스켈레톤 창과 결과 창의 크기가 다르다).
 *
 * jsdom 은 레이아웃을 하지 않으므로 높이를 실제로 잴 수 없다 — 그래서 이 단언은 높이가
 * 아니라 **예약 선언**을 잠근다(`link-preview-refresh.test.tsx` 의 캡션 슬롯과 같은 방식).
 * 실높이 검증은 브라우저 실측으로 한다(1280×720 · 모달 448px: 조회 전후 창 364px · top 178
 * 고정, 종전 164→306px · top 278→207).
 */
describe("SettlementSection — 조회 모달 결과 슬롯", () => {
  /** 슬롯 = 다이얼로그 안에서 스크롤을 소유하는 그 div. */
  function resultSlot(dialog: HTMLElement): HTMLElement | undefined {
    return Array.from(dialog.querySelectorAll("div")).find((el) => el.className.includes("overflow-y-auto"));
  }

  it("스켈레톤일 때와 결과가 들어온 뒤가 같은 고정 높이를 선언한다", async () => {
    // 스캔 응답을 손에 쥐고 있다가 나중에 푼다 — 두 상태를 한 렌더 안에서 비교하기 위해.
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const scanBody = {
      scan: { sinceDays: 90, truncated: 0 },
      summary: {},
      results: [],
      unseenExpected: [],
    };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("tax-invoice-receipts")) {
        await pending;
        return { ok: true, json: async () => scanBody };
      }
      return { ok: true, json: async () => ({}) };
    }) as never;

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[0]);

    const dialog = await screen.findByRole("dialog");
    // ① 조회 중 — 스켈레톤이 슬롯 안에 있고, 슬롯은 이미 최종 크기를 잡고 있다.
    await within(dialog).findByText("메일함을 조회하고 있습니다.");
    const whileLoading = resultSlot(dialog)?.className;
    expect(whileLoading).toContain("h-[17rem]");

    // ② 결과 도착 — 같은 슬롯, 같은 선언. 달라지면 창이 그 차이만큼 튄다.
    release(null);
    await within(dialog).findByText(/메일함을 직접 확인해 주세요/);
    expect(resultSlot(dialog)?.className).toBe(whileLoading);
  });

  it("넘치는 건은 창을 키우지 않고 슬롯 안에서 스크롤한다 — 스크롤바 거터까지 예약한다", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ scan: { sinceDays: 90, truncated: 0 }, summary: {}, results: [], unseenExpected: [] }),
    })) as never;

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[0]);

    const dialog = await screen.findByRole("dialog");
    const slot = resultSlot(dialog);
    expect(slot?.className).toContain("overflow-y-auto");
    // 2건째가 들어오는 순간 스크롤바가 폭을 밀면 결국 같은 종류의 흔들림이다(P8 ①).
    expect(slot?.className).toContain("[scrollbar-gutter:stable]");
  });
});

describe("SettlementSection — 입금·지급 라벨의 채널별 상대 병기", () => {
  it("브랜드몰 카드는 입금 상대를 공급사로, 지급 상대를 셀러로 적는다", () => {
    render(<SettlementSection campaign={makeCampaign({ salesChannel: "BRAND_MALL" })} onCampaignUpdated={vi.fn()} />);
    expect(screen.getByText(/입금 예정 \(공급사\)/)).toBeInTheDocument();
    expect(screen.getByText(/지급 예정 \(셀러\)/)).toBeInTheDocument();
  });

  it("우리몰 카드는 입금 칸 없이 지급(공급사)·지급(셀러) 두 칸을 그린다", () => {
    // 몰 정산금은 캠페인 기간 동안 일별 입금이라 단일 입금 예정일이 실효가 없다
    // (오너 확정 2026-08-25). 지급 두 상대를 한 칸에 뭉개지도 않는다.
    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    expect(screen.queryByText(/입금 예정/)).not.toBeInTheDocument();
    expect(screen.getByText(/지급 예정 \(공급사\)/)).toBeInTheDocument();
    expect(screen.getByText(/지급 예정 \(셀러\)/)).toBeInTheDocument();
    expect(screen.queryByText(/공급사·셀러/)).not.toBeInTheDocument();
  });

  it("우리몰: 공급사 지급 칸은 전용 필드, 셀러 지급 칸은 기존 payout 필드에 저장한다", async () => {
    const onCampaignUpdated = vi.fn();
    render(
      <SettlementSection
        campaign={makeCampaign({ salesChannel: "OWN_MALL" })}
        onCampaignUpdated={onCampaignUpdated}
      />,
    );
    const supplierBox = screen.getByText(/지급 예정 \(공급사\)/).closest("div");
    const checkbox = supplierBox?.querySelector("input[type=checkbox]");
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox as Element);
    const fetchMock = vi.mocked(global.fetch);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("/api/campaigns/c1")),
      ).toBe(true);
    });
    const patchCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/campaigns/c1"))!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body));
    expect(Object.keys(body)).toEqual(["supplierPayoutCompletedAt"]);
    expect(body.supplierPayoutCompletedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("우리몰: 과거 입금 기록이 있으면 읽기 전용으로 남긴다(숨기지 않는다)", () => {
    render(
      <SettlementSection
        campaign={makeCampaign({
          salesChannel: "OWN_MALL",
          isDepositReceived: true,
          depositReceivedAt: "2026-07-20",
        })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    expect(screen.getByText(/과거 입금 기록\(몰 정산금\)/)).toBeInTheDocument();
    expect(screen.getByText(/완료 2026-07-20/)).toBeInTheDocument();
  });

  it("개인 셀러여도 지급 칸이 그대로 남는다 — 계산서가 없을 뿐 지급은 받는다", () => {
    // ⛔ 계산서 슬롯의 isIndividualSeller 분기를 자금 라벨에 복사하면 이 칸이 사라진다.
    //    원천징수 대상 셀러도 차인지급액을 받으므로 지급 자체는 존재한다.
    render(
      <SettlementSection
        campaign={makeCampaign({
          salesChannel: "BRAND_MALL",
          sellerTaxType: "INDIVIDUAL",
          sellerCompanyBusinessNumber: null,
        })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    expect(screen.getByText(/지급 예정 \(셀러\)/)).toBeInTheDocument();
  });

  /**
   * 오너 결정 2026-08-26 — 완료를 체크하면 **예정일은 더 이상 쓸 일이 없다.** 새 입력칸을
   * 만드는 대신 같은 칸의 뜻을 「지급일(실제 이체일)」로 바꿔, 늦게 체크했을 때 실제 날짜로
   * 고칠 수 있게 한다(그 값이 캘린더 4표면이 서는 날짜다).
   * ⛔ 예정일 **컬럼**을 덮어쓰지는 않는다 — 지연 판정·정산 목록·리포트가 그 값을 읽는다.
   */
  it("미완료 칸은 예정일을 편집한다", async () => {
    render(
      <SettlementSection
        campaign={makeCampaign({ salesChannel: "BRAND_MALL", expectedPayoutDate: "2026-07-20" })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("지급 예정일 (셀러)") as HTMLInputElement;
    expect(input.defaultValue).toBe("2026-07-20");

    fireEvent.change(input, { target: { value: "2026-07-21" } });
    fireEvent.blur(input);

    const fetchMock = vi.mocked(global.fetch);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("/api/campaigns/c1")),
      ).toBe(true);
    });
    const patchCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/campaigns/c1"))!;
    expect(JSON.parse(String((patchCall[1] as RequestInit).body))).toEqual({
      expectedPayoutDate: "2026-07-21",
    });
  });

  it("완료된 칸은 같은 자리가 「지급일」이 되어 실제 이체일을 편집한다", async () => {
    render(
      <SettlementSection
        campaign={makeCampaign({
          salesChannel: "BRAND_MALL",
          expectedPayoutDate: "2026-07-20",
          payoutCompletedAt: "2026-07-18",
          isPayoutCompleted: true,
        })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("지급 예정일 (셀러)")).not.toBeInTheDocument();
    const input = screen.getByLabelText("지급일 (셀러)") as HTMLInputElement;
    expect(input.defaultValue).toBe("2026-07-18");

    fireEvent.change(input, { target: { value: "2026-07-15" } });
    fireEvent.blur(input);

    const fetchMock = vi.mocked(global.fetch);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).includes("/api/campaigns/c1")),
      ).toBe(true);
    });
    const patchCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/campaigns/c1"))!;
    expect(JSON.parse(String((patchCall[1] as RequestInit).body))).toEqual({
      payoutCompletedAt: "2026-07-15",
    });
  });

  /**
   * 완료 배지를 걷어낸 뒤(값이 입력칸에 그대로 뜬다) 그 칸에는 **완료를 알리는 캐리어가
   * 체크박스와 9px 캡션뿐**이 됐다 — P8 §3(색은 캐리어에 탄다). 칸 자체에 옅은 완료 틴트를
   * 얹어, 「체크했다 = 이 칸이 이제 실제 이체일을 편집한다」를 색으로도 알린다.
   * (신규 색 아님 — 캘린더 완료 도트가 쓰는 `status-success` 계열 재사용.)
   */
  it("완료된 대금 칸은 완료 틴트를 얹는다", () => {
    const { container } = render(
      <SettlementSection
        campaign={makeCampaign({
          salesChannel: "BRAND_MALL",
          payoutCompletedAt: "2026-07-18",
          isPayoutCompleted: true,
        })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    const boxes = [...container.querySelectorAll("div")].filter((el) =>
      el.className.includes("rounded-xl") && el.textContent?.includes("지급 완료"),
    );
    expect(boxes.some((el) => el.className.includes("status-success"))).toBe(true);
    // 미완료 칸은 종전 그대로 무채색이다 — 다 칠하면 아무것도 안 튄다(P8 §2).
    const pending = [...container.querySelectorAll("div")].filter((el) =>
      el.className.includes("rounded-xl") && el.textContent?.includes("입금 예정"),
    );
    expect(pending.some((el) => el.className.includes("status-success"))).toBe(false);
  });

  it("셀러몰 카드는 입금 상대를 셀러로, 지급 상대를 공급사로 적는다", () => {
    render(<SettlementSection campaign={makeCampaign({ salesChannel: "SELLER_MALL" })} onCampaignUpdated={vi.fn()} />);
    expect(screen.getByText(/입금 예정 \(셀러\)/)).toBeInTheDocument();
    expect(screen.getByText(/지급 예정 \(공급사\)/)).toBeInTheDocument();
    expect(screen.queryByText("두 상대의 지급을 한 번에 표시합니다")).not.toBeInTheDocument();
  });
});

describe("SettlementSection — 정산 그룹 조회 실패(P0: 에러를 삼키지 않는다)", () => {
  it("수취 확인 중 그룹 조회가 실패하면 오너에게 토스트로 고지하고 캠페인 단독으로 계속 진행한다", async () => {
    vi.mocked(fetchGroupDetail).mockRejectedValue(new Error("network down"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("tax-invoice-receipts")) {
        return { ok: true, json: async () => ({ results: [], unseenExpected: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fetchMock as never;

    render(
      <SettlementSection
        campaign={makeCampaign({ salesChannel: "OWN_MALL", groupId: "group-1" })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[0]);

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    // 조회 실패에도 불구하고 스캔 자체는 계속 나간다 — 판정 범위가 캠페인 단독으로
    // 좁아질 뿐, 수취 확인 자체를 막지 않는다.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("tax-invoice-receipts"))).toBe(
        true,
      ),
    );
  });
});

/**
 * 계산서 유사도 **승인 카드**(설계 2026-08-12).
 *
 * ⛔ 이 화면이 세무 처리 다이얼로그와 다른 점은 **범위**다. 정산 상세는 캠페인 한 건(그룹이면
 * 그 그룹)의 화면이라, 스캔 전체의 제안을 그대로 띄우면 지금 보고 있는 건과 무관한 셀러의
 * 승인 버튼이 섞인다 — 오너가 무엇을 승인하는지 화면이 말해 주지 않는 상태가 된다.
 */
describe("SettlementSection — 계산서 승인 카드", () => {
  function suggestionRow(campaignId: string, counterpartLabel: string) {
    return {
      mail: { uid: 1, subject: "s", fromAddress: "f", receivedAt: "2026-07-31", hasAttachmentEvidence: true },
      decision: null,
      suggestion: {
        key: `${campaignId}:SELLER_COMMISSION`,
        campaignId,
        campaignLabel: `${counterpartLabel} 캠페인`,
        slot: "SELLER_COMMISSION",
        counterpartLabel,
        trackingField: "sellerInvoiceIssuedAt",
        signals: [
          { kind: "WRITTEN_DATE", result: "MATCH", detail: "작성일자가 정산 기간 안" },
          { kind: "CAMPAIGN_NAME", result: "MATCH", detail: "품목명과 캠페인명 일치" },
          { kind: "COUNTERPART_NAME", result: "UNKNOWN", detail: "발행자 상호를 신뢰할 수 없어 대조 불가" },
        ],
        matchedSignalCount: 2,
        evaluatedSignalCount: 2,
        expectedTotalAmount: 5500000,
        observedTotalAmount: 5489000,
        amountDelta: -11000,
        amountDeltaRatio: 0.002,
      },
      verdict: {
        status: "NEEDS_REVIEW",
        confidence: "ATTACHMENT",
        matchedKey: `${campaignId}:SELLER_COMMISSION`,
        candidateKeys: [`${campaignId}:SELLER_COMMISSION`],
        reasons: [{ code: "AMOUNT_MISMATCH", message: "금액이 다릅니다." }],
        observed: {
          issueId: campaignId.padEnd(24, "0"),
          writtenDate: "2026-07-31",
          counterpartBusinessNumber: "1112233333",
          totalAmount: 5489000,
          expectedTotalAmount: 5500000,
          amountDelta: -11000,
        },
      },
    };
  }

  function mockScanWith(results: unknown[]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("tax-invoice-receipts")) {
        return {
          ok: true,
          json: async () => ({
            scan: { sinceDays: 90, truncated: 0 },
            summary: {},
            results,
            unseenExpected: [],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fetchMock as never;
    return fetchMock;
  }

  it("이 캠페인의 제안만 그리고 다른 캠페인 것은 그리지 않는다", async () => {
    mockScanWith([suggestionRow("c1", "이캠페인상대"), suggestionRow("다른캠페인", "남의상대")]);

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[1] /* 셀러 칸 */);

    // 「조회」 한 번이 모달을 열고, 조회부터 승인까지 그 안에서 끝난다(오너 지시 2026-08-15).
    // ⚠️ 모달은 스캔이 끝나기 **전에** 로딩 스켈레톤으로 먼저 뜬다 — `findByRole("dialog")`
    //    는 그 마운트 순간 바로 풀리므로, 내용 확인은 반드시 async 쿼리(`findByText`)로
    //    한다. 동기 `getByText` 를 쓰면 로컬에선 우연히 통과해도 CI 에서 타이밍이 어긋나면
    //    떨어진다(실측 — PR #401 CI 실패).
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("이캠페인상대");
    // ⛔ 범위 밖 제안이 새어 나오면 실패한다.
    expect(screen.queryByText(/남의상대/)).not.toBeInTheDocument();
  });

  it("그룹이면 멤버 전원의 키를 범위로 본다", async () => {
    (fetchGroupDetail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      members: [{ campaignId: "c1" }, { campaignId: "c2" }],
    });
    // 그룹 대표(anchor)가 형제 멤버 id 인 경우 — 범위를 캠페인 자기 id 로만 잡으면 놓친다.
    mockScanWith([suggestionRow("c2", "그룹상대")]);

    render(
      <SettlementSection
        campaign={makeCampaign({ salesChannel: "OWN_MALL", groupId: "group-1" })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[1] /* 셀러 칸 */);

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("그룹상대");
  });

  it("차이 금액을 숫자로 보여준다", async () => {
    mockScanWith([suggestionRow("c1", "이캠페인상대")]);

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[1] /* 셀러 칸 */);

    // 기대·수취·차이는 각각 제 줄을 갖는다(key-value 표) — 문장에 녹이지 않는다.
    const dialog = await screen.findByRole("dialog");
    const amounts = within(dialog);
    await amounts.findByText("5,500,000원");
    expect(amounts.getByText("5,489,000원")).toBeInTheDocument();
    expect(amounts.getByText("-11,000원")).toBeInTheDocument();
  });

  it("제안이 없으면 카드를 그리지 않는다", async () => {
    const fetchMock = mockScanWith([]);

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[1] /* 셀러 칸 */);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("tax-invoice-receipts"))).toBe(true),
    );
    expect(screen.queryByText(/계산서로 추정/)).not.toBeInTheDocument();
  });
});

/**
 * 승인 UI 의 **자리**와 `VERIFIED` 건의 승인 경로(2026-08-14, 오너 신고에서 나옴).
 *
 * 증상: 「셀러 계산서 수취」 칸이 「확인됨」이라고 말하는데 체크박스는 비어 있고 수취일도
 * 없다. 원인은 두 겹이었다 —
 *  ① `suggestReceiptMatch` 가 `NEEDS_REVIEW` 에만 제안을 붙이므로 **정확히 맞은 건일수록**
 *     승인 카드가 아예 안 떴다(승인만이 유일한 쓰기 경로인데 그 경로가 없었다).
 *  ② 카드가 떠도 계산서 칸에서 떨어진 별도 섹션에 있어, 판정과 조작이 끊겨 있었다.
 *
 * ⛔ 이 두 단언을 「자동 반영」으로 바꿔 대체하지 말 것 — 「자동 확정하지 않는다, 항상
 * 1클릭 승인 대기」는 오너 확정(2026-08-12)이다. 여기서 고정하는 것은 **버튼의 존재와
 * 위치**이지 자동화가 아니다.
 */
describe("SettlementSection — VERIFIED 건의 승인 경로", () => {
  function verifiedRow(campaignId: string) {
    return {
      mail: { uid: 2, subject: "s", fromAddress: "f", receivedAt: "2026-07-31", hasAttachmentEvidence: true },
      decision: null,
      suggestion: null,
      verdict: {
        status: "VERIFIED",
        confidence: "ATTACHMENT",
        matchedKey: `${campaignId}:SELLER_COMMISSION`,
        candidateKeys: [`${campaignId}:SELLER_COMMISSION`],
        reasons: [],
        observed: {
          issueId: "202607310000000000000001",
          writtenDate: "2026-07-31",
          counterpartBusinessNumber: "1112233333",
          totalAmount: 5500000,
          expectedTotalAmount: 5500000,
          amountDelta: 0,
        },
      },
    };
  }

  // ⚠️ `init` 인자를 시그니처에 남긴다 — 빼면 `mock.calls` 가 1-튜플로 좁혀져
  //    `calls[n][1]`(요청 본문 검사)이 타입 오류가 된다.
  function mockScanWith(results: unknown[]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).includes("tax-invoice-receipts")) {
        return {
          ok: true,
          json: async () => ({
            scan: { sinceDays: 90, truncated: 0 },
            summary: {},
            results,
            unseenExpected: [],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fetchMock as never;
    return fetchMock;
  }

  it("VERIFIED 건에도 승인 버튼이 뜬다 — 「확인됨」이 기록으로 갈 경로가 있어야 한다", async () => {
    mockScanWith([verifiedRow("c1")]);

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[1] /* 셀러 칸 */);

    // 모달 안에서 확정한다 — 주 버튼은 동사 한 단어다(ss-copy).
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog);
    await confirm.findByRole("button", { name: "승인" });
    // 승인이 실제로 적는 값(계산서 작성일자)을 반드시 보여준다.
    expect(confirm.getByText("2026-07-31")).toBeInTheDocument();
  });

  it("조회한 칸의 계산서만 그 모달에 뜬다 — 형제 칸의 건이 섞이지 않는다", async () => {
    mockScanWith([verifiedRow("c1")]);

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    // 공급사 칸에서 조회하면 셀러 슬롯의 이 건은 그 모달에 없어야 한다.
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[0] /* 공급사 칸 */);
    const supplierDialog = await screen.findByRole("dialog");
    const supplier = within(supplierDialog);
    await supplier.findByText(/찾지 못했습니다|맞는 계산서를 찾지 못했습니다/);
    expect(supplier.queryByRole("button", { name: "승인" })).not.toBeInTheDocument();
    // 본문 아래에 「닫기」를 또 두지 않는다 — 닫는 방법은 헤더의 닫기 버튼 하나뿐이다.
    expect(supplier.getAllByRole("button", { name: "닫기" })).toHaveLength(1);
    fireEvent.click(supplier.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // 셀러 칸에서 조회하면 그 건이 뜬다.
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[1] /* 셀러 칸 */);
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByRole("button", { name: "승인" })).toBeInTheDocument(),
    );
  });

  it("승인 요청의 targetKeys 는 판정이 특정한 matchedKey 다", async () => {
    const fetchMock = mockScanWith([verifiedRow("c1")]);

    render(<SettlementSection campaign={makeCampaign({ salesChannel: "OWN_MALL" })} onCampaignUpdated={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[1] /* 셀러 칸 */);
    const targetKeysDialog = await screen.findByRole("dialog");
    fireEvent.click(await within(targetKeysDialog).findByRole("button", { name: "승인" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("receipts/decision"))).toBe(true),
    );
    const call = fetchMock.mock.calls.find((entry) => String(entry[0]).includes("receipts/decision"));
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.action).toBe("approve");
    expect(body.targetKeys).toEqual(["c1:SELLER_COMMISSION"]);
    // ⚠️ 수취일에는 **계산서 작성일자**가 간다 — 오늘 날짜로 대신 찍으면 없는 사실이 된다.
    expect(body.writtenDate).toBe("2026-07-31");
  });

  /**
   * ⛔ **한 칸에 계산서가 둘 이상 매칭되면 첫 결정에서 닫지 않는다.**
   *
   * 그룹이 멤버별로 후퇴했거나 중복 발행이 의심될 때 한 칸의 모달에 여러 건이 뜬다.
   * 첫 승인에서 모달이 닫히면 나머지는 화면에서 사라지고, 오너는 「조회 한 번으로 끝냈다」고
   * 믿은 채 남은 건을 놓친다 — 이 화면의 지시("조회에서 승인까지")가 다건에서 깨지는 지점.
   */
  it("매칭이 여러 건이면 하나를 승인해도 모달이 닫히지 않는다", async () => {
    const second = {
      ...verifiedRow("c1"),
      verdict: {
        ...verifiedRow("c1").verdict,
        observed: { ...verifiedRow("c1").verdict.observed, issueId: "202607310000000000000009" },
      },
    };
    mockScanWith([verifiedRow("c1"), second]);

    render(<SettlementSection campaign={makeCampaign()} onCampaignUpdated={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[1] /* 셀러 칸 */);
    const dialog = await screen.findByRole("dialog");
    const approves = await within(dialog).findAllByRole("button", { name: "승인" });
    expect(approves).toHaveLength(2);

    fireEvent.click(approves[0]);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    // 남은 건이 있으므로 모달은 열린 채로 남는다.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  /**
   * ⛔ **`suggestion` 유무로 「누구 것인가」를 가르지 않는다.** 유사도 제안은 `NEEDS_REVIEW`
   * 에만 붙으므로 판정이 정확히 맞은 건일수록 상대·캠페인이 빠진다 — 세무 처리 다이얼로그는
   * 이번 달 전량을 한 목록에 섞으므로 그 행이 누구 것인지 알 방법이 없어진다.
   */
  it("제안이 없는 VERIFIED 건도 발행자·사업자번호로 식별을 남긴다", async () => {
    mockScanWith([verifiedRow("c1")]);

    render(<SettlementSection campaign={makeCampaign()} onCampaignUpdated={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[1] /* 셀러 칸 */);
    const dialog = within(await screen.findByRole("dialog"));
    await dialog.findByText("1112233333");
  });

  /**
   * ⛔ 결정 뒤에 **캠페인도 다시 읽는다.** 스캔만 갱신하면 카드는 「승인됨」인데 바로 위
   * 체크박스와 아래 수취일은 빈 채로 남는다 — 오너가 신고한 그 화면이 승인 버튼을 눌러도
   * 한 번 더 재현된다(체크박스·날짜는 `campaign` prop 에서 값을 읽기 때문).
   */
  it("승인하면 캠페인을 다시 읽어 체크박스·수취일에 반영한다", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("tax-invoice-receipts")) {
        return {
          ok: true,
          json: async () => ({
            scan: { sinceDays: 90, truncated: 0 },
            summary: {},
            results: [verifiedRow("c1")],
            unseenExpected: [],
          }),
        };
      }
      if (url.includes("/api/campaigns/c1")) {
        return { ok: true, json: async () => ({ ...makeCampaign(), sellerInvoiceIssuedAt: "2026-07-31" }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fetchMock as never;
    const onCampaignUpdated = vi.fn();

    render(<SettlementSection campaign={makeCampaign()} onCampaignUpdated={onCampaignUpdated} />);
    fireEvent.click(screen.getAllByRole("button", { name: "조회" })[1] /* 셀러 칸 */);
    const refreshDialog = await screen.findByRole("dialog");
    fireEvent.click(await within(refreshDialog).findByRole("button", { name: "승인" }));

    await waitFor(() => expect(onCampaignUpdated).toHaveBeenCalled());
    expect(onCampaignUpdated.mock.calls[0][0]).toMatchObject({ sellerInvoiceIssuedAt: "2026-07-31" });
  });
});
