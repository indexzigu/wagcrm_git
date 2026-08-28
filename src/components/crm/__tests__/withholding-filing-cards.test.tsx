// @vitest-environment jsdom
// 원천징수 절차 3카드(WithholdingFilingCards) 계약.
//
// 가장 중요한 계약은 위택스 「과세표준」이 `incomeTax`(소득세)와 같고 `preTaxTotal`
// (총지급액)과는 달라야 한다는 것이다 — 과세표준에 총지급액을 넣으면 세액이 10배가
// 되는, 이 도우미가 막아야 할 1순위 오입력이다(설계 문서 「실제 화면 필드명」).
// 그래서 아래 픽스처는 preTaxTotal과 incomeTax를 크게 다른 값으로 골라, 둘이 뒤섞이면
// 이 테스트가 반드시 실패하게 한다.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WithholdingFilingCards } from "../withholding-filing-cards";
import { withholdingDueDate } from "@/lib/withholding-report";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const REPORT = {
  month: "2026-07",
  rows: [
    {
      sellerId: "s1",
      sellerRealName: "김철수",
      sellerAlias: null,
      residentNumber: "9001011234567",
      lines: [{ campaignId: "c1", label: "딜A - 셀러1 1차", payoutDate: "2026-07-15", preTaxPayout: 10_000_000, withholdingTax: 330_000 }],
      preTaxTotal: 10_000_000,
      withholdingTotal: 330_000,
      incomeTax: 300_000, // preTaxTotal(10,000,000)의 3% — 총지급액과 자릿수부터 다르다.
      localIncomeTax: 30_000,
      postTaxTotal: 9_670_000,
    },
  ],
  totals: {
    sellerCount: 1,
    preTaxTotal: 10_000_000,
    withholdingTotal: 330_000,
    incomeTax: 300_000,
    localIncomeTax: 30_000,
  },
  warnings: [] as string[],
};

function mockFetch(overrides?: { completed?: { kind: string; completedAt: string }[] }) {
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("tax-filing-log")) {
      return { ok: true, json: async () => ({ month: "2026-07", completed: overrides?.completed ?? [] }) } as Response;
    }
    return { ok: true, json: async () => REPORT } as Response;
  }) as never;
}

beforeEach(() => {
  mockFetch();
});

describe("원천징수 절차 3카드", () => {
  it("위택스 「과세표준」은 소득세(incomeTax) 값이고 총지급액(preTaxTotal)이 아니다", async () => {
    render(<WithholdingFilingCards month="2026-07" />);

    // 과세표준 필드는 300,000원(incomeTax)이어야 한다 — 10,000,000원(preTaxTotal)이
    // 나오면 세액이 10배로 오신고되는 그 사고가 재현된 것이다. 소득세 값은 카드1에도
    // 같은 금액으로 나오므로(정상 — 같은 SSOT), testId로 카드3의 과세표준 필드만 짚는다.
    const standard = await screen.findByTestId("local-tax-standard-value");
    expect(standard).toHaveTextContent("300,000원");
    expect(standard).not.toHaveTextContent("10,000,000원");
  });

  it("과세표준 값 바로 옆에 총 지급액이 아니라는 경고를 고정 노출한다", async () => {
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByText(/「소득세」 금액입니다/);
  });

  it("금액 칸 이름은 오너가 실제 입력하는 신고서 화면 기준이다 — 법정 서식 표기로 되돌리지 않는다", async () => {
    // T-028(오너 실측 2026-08-11). 초판 라벨은 안내자료 캡처에서 옮긴 것이라 실제
    // 입력 화면과 달랐다 — 카드가 「칸 이름을 그대로 보여준다」는 전제로 서 있으므로
    // 이름이 틀리면 카드의 존재 이유가 무너진다. 옛 표기로의 회귀를 함께 막는다.
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByText("(5)총 지급액(세전)");
    expect(screen.getByText("(6)소득세")).toBeInTheDocument();
    expect(screen.getByText("지급액(세전)")).toBeInTheDocument();
    expect(screen.queryByText("(5)총지급금액")).not.toBeInTheDocument();
    expect(screen.queryByText("(6)소득세 등")).not.toBeInTheDocument();
  });

  it("금액이 세전(원천징수 전)임을 값 옆에서 안내한다", async () => {
    // 라벨 접미사만으로는 「세전」의 뜻(= 차인지급액이 아님)이 전달되지 않는다.
    // 차인지급액을 총 지급액 칸에 넣으면 소득이 과소신고된다 — 카드 3의 세액 10배
    // 오입력과 반대 방향의 같은 급 사고라 값 옆 고정 노출로 막는다.
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByText(/차인지급액이 아닙니다/);
    expect(screen.getByText(/같은 기준\(원천징수 전\)/)).toBeInTheDocument();
  });

  it("과세표준 필드는 흔한 caution 문구들과 다른 강조 박스(bg-status-urgent-bg)를 쓴다", async () => {
    // §2 습관화 방지 — 이 화면은 이미 「실명 미등록」·「세액 칸이 없습니다」 같은 caution/
    // urgent 문구를 여러 개 보여준다. 가장 위험한 값(과세표준)은 같은 회색 상자가 아니라
    // 별도 톤 박스로 눈에 띄어야 한다.
    render(<WithholdingFilingCards month="2026-07" />);
    const standard = await screen.findByTestId("local-tax-standard-value");
    const box = standard.closest("div.rounded-md");
    expect(box?.className).toContain("bg-status-urgent-bg");
  });

  it("위택스 라벨은 색이 아니라 평문 강조로만 「홈택스가 아니다」를 표시한다", async () => {
    // 제출처(홈택스/위택스)는 범주다 — 심각도 색을 받으면 안 된다(design-system.md
    // §4). "위택스(홈택스 아님)"라는 문구 자체로 구분하고, 그 span 은 다른 카드의
    // "홈택스" span 과 같은 무채색 클래스를 쓴다.
    render(<WithholdingFilingCards month="2026-07" />);
    const label = await screen.findByText("위택스(홈택스 아님)");
    expect(label.className).not.toContain("status-urgent");
    expect(label.className).not.toContain("status-caution");
  });

  it("특별징수세액을 단정하지 않는다 — 검산 기준으로만 근거와 함께 병기한다", async () => {
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByRole("heading", { name: /지방소득세 특별징수/ });
    // "특별징수세액: 30,000원" 처럼 확정값 라벨로 렌더되지 않는다.
    expect(screen.queryByText(/^특별징수세액$/)).not.toBeInTheDocument();
    // 대신 근거를 밝힌 대조 문구가 있어야 한다. 오너 실측(2026-08-11)으로 위택스가 세액을
    // 자동으로 채우는 것이 확인됐으므로, 이 값의 용도는 "입력할 값"이 아니라 "검산 기준"이다.
    expect(screen.getByText(/명세서상 실제 원천징수 지방소득세/)).toBeInTheDocument();
    expect(screen.getByText(/위택스가 자동으로 채웁니다/)).toBeInTheDocument();
  });

  it("위택스 직접 접속 경로가 본문이고 홈택스 신고이동은 대체 경로다", async () => {
    // 오너는 위택스에 직접 들어가 한건신고한다(확인 2026-08-11). 초판은 홈택스
    // 「지방소득세 신고이동」을 "권장"으로 카드 머리에 세워, 매달 건너뛰는 문장이
    // 맨 위에 있었다. 순서를 되돌리는 회귀를 막는다.
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByRole("heading", { name: /지방소득세 특별징수/ });
    expect(screen.getByText("위택스 → 신고 → 지방소득세 → 특별징수 → 한건신고")).toBeInTheDocument();
    expect(screen.queryByText(/^권장:/)).not.toBeInTheDocument();
    expect(screen.getByText(/「지방소득세 신고이동」으로 들어오면/)).toBeInTheDocument();
  });

  it("신고세액 표에서 어느 행에 넣는지(사업소득)를 말해준다", async () => {
    // 그 표는 이자·배당·사업·근로 등 11개 행이다. 행을 지정하지 않으면 오너가 매달
    // 다시 고른다 — 설계 문서에는 있었는데 초판 구현에서 누락된 항목이다.
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByRole("heading", { name: /지방소득세 특별징수/ });
    expect(screen.getByText("「사업소득」 행")).toBeInTheDocument();
  });

  it("고르는 칸에는 복사 버튼을 달지 않는다 — 치는 칸에만 단다", async () => {
    // 위택스 한건신고에서 납부시기는 라디오, 지급연월·귀속연월은 드롭다운이라 복사할
    // 대상이 없다. 복사 버튼 유무가 "치는 칸이냐 고르는 칸이냐"의 표지라서, 전부 버튼을
    // 달면 그 구분이 사라지고 누를 수 없는 버튼만 늘어난다.
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByRole("heading", { name: /지방소득세 특별징수/ });
    for (const label of ["납부시기", "지급연월", "귀속연월"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: `${label} 복사` })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "과세표준 복사" })).toBeInTheDocument();
  });

  // 이름·코드 **양쪽**을 고정한다. 홈택스가 어느 쪽을 받는지 미확인이라(T-030) 한쪽만
  // 남기는 회귀가 실제로 제안된 적이 있다 — 그 제안은 코드를 화면에서 지웠다.
  it("업종은 이름과 코드를 함께 채운다 — '확인 필요'로 렌더되지 않는다", async () => {
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByText("김철수");
    const cell = screen.getByTestId("industry-s1");
    expect(cell).toHaveTextContent("기타자영업");
    expect(cell).toHaveTextContent("940909");
    expect(screen.getByRole("columnheader", { name: "업종" })).toBeInTheDocument();
    expect(screen.queryByText("확인 필요")).not.toBeInTheDocument();
  });

  it("귀속년월·지급년월이 같은 값(지급월)으로 표시된다 — 귀속월=지급월 확정", async () => {
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByRole("heading", { name: /원천세 신고/ });
    const values = screen.getAllByText("2026-07");
    expect(values.length).toBeGreaterThanOrEqual(2);
  });

  it("주민등록번호는 기본 마스킹이고 행 단위로만 펼쳐진다", async () => {
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByText("김철수");
    expect(screen.queryByText("9001011234567")).not.toBeInTheDocument();
    expect(screen.getByText("900101-1******")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "주민등록번호 보기" }));
    expect(await screen.findByText("9001011234567")).toBeInTheDocument();
  });

  it("지급명세 카드에는 세액 칸이 없다는 경고를 보여준다", async () => {
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByText(/세액 칸이 없습니다/);
  });

  it("실명 미등록 행도 표기명(별칭)을 괄호로 보여줘 누군지 알 수 있게 한다", async () => {
    // 활동명으로 성명 칸을 대신 채우진 않지만("실명 미등록"은 그대로 유지), 경고가
    // "누구를 고쳐야 하는지"를 말해줘야 실행 가능하다 — 구 WithholdingReportDialog가
    // 지키던 계약을 카드로 옮겨서도 지킨다.
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("tax-filing-log")) {
        return { ok: true, json: async () => ({ month: "2026-07", completed: [] }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          ...REPORT,
          rows: [{ ...REPORT.rows[0], sellerRealName: null, sellerAlias: "닉네임셀러" }],
          warnings: ["실명 미등록 셀러 1명 — 확인 필요"],
        }),
      } as Response;
    }) as never;

    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByText("실명 미등록");
    expect(screen.getByText("(닉네임셀러)")).toBeInTheDocument();
  });

  it("완료 체크를 누르면 POST로 완료 처리를 요청한다", async () => {
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByRole("heading", { name: /원천세 신고/ });

    const checkbox = screen.getByRole("checkbox", { name: "원천세 신고 완료" });
    fireEvent.click(checkbox);

    await waitFor(() => {
      const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const postCall = calls.find(
        (call) => call[1]?.method === "POST" && String(call[0]).includes("tax-filing-log"),
      );
      expect(postCall).toBeTruthy();
      expect(JSON.parse(postCall![1].body)).toEqual({ month: "2026-07", kind: "WITHHOLDING_RETURN" });
    });
  });

  it("이미 완료된 절차는 체크박스가 체크된 상태로 시작하고, 다시 누르면 DELETE를 보낸다", async () => {
    mockFetch({ completed: [{ kind: "SIMPLIFIED_STATEMENT", completedAt: "2026-08-01T00:00:00.000Z" }] });
    render(<WithholdingFilingCards month="2026-07" />);
    await screen.findByText(/지급명세 제출/);

    const checkbox = await screen.findByRole("checkbox", { name: "지급명세 제출 완료" });
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    await waitFor(() => {
      const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const deleteCall = calls.find(
        (call) => call[1]?.method === "DELETE" && String(call[0]).includes("tax-filing-log"),
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it("신고 대상(개인 셀러 지급)이 없는 달은 카드를 내지 않고 안내 문구만 보여준다", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("tax-filing-log")) {
        return { ok: true, json: async () => ({ month: "2026-07", completed: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ ...REPORT, rows: [], totals: { ...REPORT.totals, sellerCount: 0 } }) } as Response;
    }) as never;

    render(<WithholdingFilingCards month="2026-07" />);
    expect(await screen.findByText(/신고 대상 없음/)).toBeInTheDocument();
    expect(screen.queryByText("원천세 신고")).not.toBeInTheDocument();
  });

  it("경고(실명·주민번호 미등록 등)를 카드 위에 보여준다", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("tax-filing-log")) {
        return { ok: true, json: async () => ({ month: "2026-07", completed: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ ...REPORT, warnings: ["실명 미등록 셀러 1명 — 확인 필요"] }) } as Response;
    }) as never;

    render(<WithholdingFilingCards month="2026-07" />);
    expect(await screen.findByText(/실명 미등록 셀러 1명/)).toBeInTheDocument();
  });

  it("조회 실패 시 오류를 표시한다", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "조회 실패" }) }) as Response) as never;
    render(<WithholdingFilingCards month="2026-07" />);
    expect(await screen.findByText(/조회 실패/)).toBeInTheDocument();
  });
});

// D-day 배지 톤 — 실제 "오늘" 날짜에 의존하면 스위트가 며칠 뒤 다른 결과를 내는
// 시한폭탄이 된다(docs/agents/dev-qa.md 실사고). 그래서 시스템 시계를
// vi.setSystemTime 으로 못박고, 기한도 실제 라이브러리 함수(withholdingDueDate)로
// 그 시계 기준 상대 오프셋만큼 떨어진 날짜를 계산한다 — 두 값이 항상 같은 기준
// (모킹된 "지금")으로 함께 움직이므로 실행 시점과 무관하게 결정적이다.
describe("원천징수 절차 3카드 — D-day 톤(제출처 색과 분리)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("기한이 오늘이면 D-day 배지가 urgent 톤이다", async () => {
    const due = withholdingDueDate(REPORT.month); // "2026-08-10" — 원천세·지방소득세 공유 기한
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(`${due}T00:00:00+09:00`));

    render(<WithholdingFilingCards month={REPORT.month} />);
    const heading = await screen.findByRole("heading", { name: /원천세 신고/ });
    const dDayEl = heading.closest("div")?.parentElement?.querySelector(".text-status-urgent-text");
    expect(dDayEl).toHaveTextContent("D-day");
  });

  it("기한이 3일 남았으면 caution 톤이다", async () => {
    const due = withholdingDueDate(REPORT.month);
    const threeDaysBefore = new Date(`${due}T00:00:00+09:00`);
    threeDaysBefore.setDate(threeDaysBefore.getDate() - 3);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(threeDaysBefore);

    render(<WithholdingFilingCards month={REPORT.month} />);
    const heading = await screen.findByRole("heading", { name: /원천세 신고/ });
    const dDayEl = heading.closest("div")?.parentElement?.querySelector(".text-status-caution-text");
    expect(dDayEl).toHaveTextContent("D-3");
  });

  it("기한이 넉넉히(10일) 남았으면 무채색(normal)이다 — urgent·caution 클래스가 없다", async () => {
    const due = withholdingDueDate(REPORT.month);
    const tenDaysBefore = new Date(`${due}T00:00:00+09:00`);
    tenDaysBefore.setDate(tenDaysBefore.getDate() - 10);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(tenDaysBefore);

    render(<WithholdingFilingCards month={REPORT.month} />);
    const heading = await screen.findByRole("heading", { name: /원천세 신고/ });
    const headerBlock = heading.closest("div")?.parentElement as HTMLElement;
    expect(headerBlock.querySelector(".text-status-urgent-text")).toBeNull();
    expect(headerBlock.querySelector(".text-status-caution-text")).toBeNull();
    expect(headerBlock).toHaveTextContent("D-10");
  });
});
