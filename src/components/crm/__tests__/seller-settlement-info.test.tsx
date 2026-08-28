// @vitest-environment jsdom
// 셀러 상세 「정산 정보」 섹션 계약 (2026-07-24).
//
// 이 섹션은 거래처 연결 유무로 정산 신원의 출처를 가른다:
//   연결 있음 → 거래처 정보를 읽기 전용 표시(사업자)
//   연결 없음 → 주민등록번호·계좌를 직접 입력(개인 원천징수 대상)
// 주민번호는 기본 마스킹이고, 목록 페이로드가 아니라 단건 엔드포인트로만 가져온다.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SellerDetailContent } from "../seller-detail-content";
import type { SellerSummary } from "@/lib/crm-types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("../seller-growth-chart", () => ({ SellerGrowthChart: () => <div /> }));
vi.mock("../seller-er-chart", () => ({ SellerErChart: () => <div /> }));
vi.mock("../seller-analysis/SellerAiAnalysis", () => ({ SellerAiAnalysis: () => <div /> }));

const RESIDENT = "900101-1234567";

function makeSeller(overrides: Partial<SellerSummary> = {}): SellerSummary {
  return {
    id: "s1",
    name: "김철수",
    alias: "달콤한하루",
    snsType: "INSTAGRAM",
    snsHandle: "handle",
    currentFollowers: 1000,
    campaignCount: 0,
    ...overrides,
  } as SellerSummary;
}

/** settlement-info 단건 엔드포인트 + 그 외 fetch 를 스텁한다. */
function stubFetch(settlement: {
  realName?: string | null;
  residentNumber: string | null;
  accountNumber: string | null;
}) {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/settlement-info")) {
      return { ok: true, json: async () => ({ ...settlement, hasLinkedPartner: false }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("정산 정보 섹션 — 거래처 미연결(개인)", () => {
  it("실명·주민등록번호·정산 계좌번호 입력란이 노출된다", async () => {
    stubFetch({ residentNumber: null, accountNumber: null });
    render(<SellerDetailContent seller={makeSeller()} onClose={() => {}} />);

    expect(await screen.findByText("정산 정보")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("실명")).toBeInTheDocument();
      expect(screen.getByText("주민등록번호")).toBeInTheDocument();
      expect(screen.getByText("정산 계좌번호")).toBeInTheDocument();
    });
  });

  // 2026-08-04: 신고 서식의 소득자 성명은 법적 실명이라, 활동명이 들어가는 상단 「이름」과
  // 별개 값이어야 한다. 두 칸이 같은 값을 보여주면 미입력이 눈에 띄지 않는다.
  it("실명 미입력은 상단 「이름」(활동명 자리)으로 메우지 않고 빈칸으로 둔다", async () => {
    stubFetch({ realName: null, residentNumber: null, accountNumber: null });
    render(<SellerDetailContent seller={makeSeller({ name: "달콤한하루" })} onClose={() => {}} />);

    const label = await screen.findByText("실명");
    const field = label.closest("[class*='rounded-md']");
    expect(field?.textContent).toContain("-");
    expect(field?.textContent).not.toContain("달콤한하루");
  });

  it("저장된 실명은 그대로 표시한다", async () => {
    stubFetch({ realName: "홍길동", residentNumber: null, accountNumber: null });
    render(<SellerDetailContent seller={makeSeller()} onClose={() => {}} />);
    expect(await screen.findByText("홍길동")).toBeInTheDocument();
  });

  it("개인(원천징수 3.3%) 처리 대상임을 안내한다", async () => {
    stubFetch({ residentNumber: null, accountNumber: null });
    render(<SellerDetailContent seller={makeSeller()} onClose={() => {}} />);
    expect(await screen.findByText(/개인\(원천징수 3\.3%\)/)).toBeInTheDocument();
  });

  it("주민등록번호는 기본 마스킹이고 '보기'를 눌러야 펼쳐진다", async () => {
    stubFetch({ residentNumber: RESIDENT, accountNumber: null });
    render(<SellerDetailContent seller={makeSeller()} onClose={() => {}} />);

    // 기본 상태: 마스킹된 형태만 보이고 원본은 화면에 없다
    expect(await screen.findByText("900101-1******")).toBeInTheDocument();
    expect(screen.queryByText(RESIDENT)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "주민등록번호 보기" }));
    expect(await screen.findByText(RESIDENT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "주민등록번호 가리기" }));
    await waitFor(() => expect(screen.queryByText(RESIDENT)).not.toBeInTheDocument());
  });

  it("필드 제목(라벨)은 말줄임도 줄바꿈도 하지 않는다", async () => {
    // 필드 제목은 그 칸이 무슨 값인지 알려주는 유일한 단서다 — "주민등록…"으로 잘리면
    // 식별이 안 되고, 두 줄로 줄바꿈되면 고정 높이 행을 넘쳐 툴팁 아이콘과 겹친다(실사고).
    stubFetch({ residentNumber: RESIDENT, accountNumber: null });
    render(<SellerDetailContent seller={makeSeller()} onClose={() => {}} />);

    const label = await screen.findByText("주민등록번호");
    expect(label.className).not.toContain("truncate");
    expect(label.className).toContain("whitespace-nowrap");
    expect(label.textContent).toBe("주민등록번호");
  });

  it("주민등록번호 값은 말줄임(truncate) 처리하지 않는다", async () => {
    // 13자리를 홈택스에 그대로 옮겨 적는 값이라, 한 자리만 잘려도 못 쓴다 —
    // 펼쳐 보는 목적 자체가 사라진다. 공유 컴포넌트 기본값(truncate)의 예외.
    stubFetch({ residentNumber: RESIDENT, accountNumber: null });
    render(<SellerDetailContent seller={makeSeller()} onClose={() => {}} />);

    const masked = await screen.findByText("900101-1******");
    expect(masked.className).not.toContain("truncate");
    expect(masked.className).toContain("whitespace-nowrap");

    // 펼친 뒤에도 동일하게 전체가 보여야 한다
    fireEvent.click(screen.getByRole("button", { name: "주민등록번호 보기" }));
    const revealed = await screen.findByText(RESIDENT);
    expect(revealed.className).not.toContain("truncate");
    expect(revealed.textContent).toBe(RESIDENT);
  });

  it("값이 없으면 '보기' 토글 자체가 없다", async () => {
    stubFetch({ residentNumber: null, accountNumber: null });
    render(<SellerDetailContent seller={makeSeller()} onClose={() => {}} />);
    await screen.findByText("주민등록번호");
    expect(screen.queryByRole("button", { name: /주민등록번호 보기/ })).not.toBeInTheDocument();
  });

  it("주민등록번호를 목록 데이터가 아니라 단건 엔드포인트에서 가져온다", async () => {
    const calls = stubFetch({ residentNumber: RESIDENT, accountNumber: null });
    render(<SellerDetailContent seller={makeSeller()} onClose={() => {}} />);
    await waitFor(() =>
      expect(calls.some((u) => u.includes("/api/sellers/s1/settlement-info"))).toBe(true),
    );
  });
});

describe("정산 정보 섹션 — 거래처 연결(사업자)", () => {
  it("입력란 대신 거래처 신원을 읽기 전용으로 보여준다", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/settlement-info")) {
        return {
          ok: true,
          json: async () => ({ residentNumber: null, accountNumber: null, hasLinkedPartner: true }),
        } as Response;
      }
      if (url.includes("/api/partners")) {
        return {
          ok: true,
          json: async () => [
            { id: "p1", name: "테스트상사", type: "SELLER", ceoName: "대표자", businessNumber: "1234567890" },
          ],
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    render(<SellerDetailContent seller={makeSeller({ agencyId: "p1", agencyName: "테스트상사" })} onClose={() => {}} />);

    expect(await screen.findByText("테스트상사")).toBeInTheDocument();
    // 사업자는 주민등록번호 입력면을 갖지 않는다
    expect(screen.queryByText("주민등록번호")).not.toBeInTheDocument();
  });
});
