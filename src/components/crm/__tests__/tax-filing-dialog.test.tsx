// @vitest-environment jsdom
// 「세무 처리」 다이얼로그 계약 (2026-08-05, 홈택스 XLSX 생성 재도입 반영).
//
// 이 창의 존재 이유는 "이번 달 남은 세무 처리"를 한 화면에서 보고 처리하는 것이다.
// 2026-08-04 — `tax-invoice-builder.ts`(buildTaxInvoiceRows)가 셀러몰·브랜드몰
// 발행 양쪽 모두 틀린 금액(및 브랜드몰은 틀린 상대)을 낸다는 사실이 드러나 「홈택스
// XLSX」 파일 생성·체크박스·전체 선택을 이 다이얼로그에서 뺐다. 그 빌더가 이 보드가
// 낸 ISSUE 행을 그대로 소비하도록 정정되어(counterpart·amount 재계산 없음) 이
// 커밋에서 버튼을 되살렸다(tax-filing-dialog.tsx 헤더 주석 참조).
//
// 이 파일이 지키는 핵심 계약: ① 체크박스는 `row.selectable && row.xlsxEligible`
// 둘 다인 행에만 생긴다(결번이 섞이면 홈택스가 업로드를 통째로 반려하고, RECEIVE는
// 상대가 이미 발행하므로 우리가 파일을 만들 대상이 아니다) ② POST 본문은 행의
// `campaignIds`(복수) 전체를 담는다 — 그룹 행의 `campaignId`(단수)는 체크리스트
// 앵커일 뿐이라 이것만 보내면 그룹 나머지 멤버가 빠진 채 신고된다 ③ 400 응답의
// `details`를 화면에 남겨 오너가 어느 캠페인을 빼야 하는지 알 수 있게 한다. 그 외에
// 결번 행은 사유와 함께 보이고(숨기지 않음), 발행/수취 합계는 방향별로 분리해서
// 보여주고(합치면 이중 계상으로 보인다), 개별 「완료」는 체크리스트 PATCH 를 그대로
// 탄다.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { TaxFilingDialog } from "../tax-filing-dialog";
import { AUTO_CONFIRM_SEED_LOOKBACK_LABEL } from "@/lib/tax-filing-auto-confirm";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(() => "t1"),
    dismiss: vi.fn(),
  },
}));
// 홈택스 로컬 헬퍼 통신은 모듈 경계에서 끊는다 — 실제 loopback fetch 를 테스트에서
// 돌리지 않고, "다이얼로그가 언제·무엇을 헬퍼로 보내는가"만 검증한다.
const helperHealthMock = vi.fn<() => Promise<boolean>>(async () => true);
const helperIssueMock = vi.fn(async () => ({ status: "FILLED" as const }));
// 깨우기(URL 스킴)도 같은 경계에서 끊는다 — 실제 스킴은 브라우저·OS 소관이라
// 테스트가 재현할 수 없고, 여기서 볼 것은 **언제 깨우고 언제 포기하는가**다.
const helperWakeMock = vi.fn<() => void>();
const helperWaitMock = vi.fn<() => Promise<boolean>>(async () => true);
/** 로그인 완료 대기 — 자동 재개 경로의 유일한 대기 지점. */
const helperLoginWaitMock = vi.fn<() => Promise<boolean>>(async () => true);
vi.mock("@/lib/hometax-helper-client", () => ({
  HOMETAX_HELPER_START_COMMAND: "npm run hometax:helper",
  HOMETAX_HELPER_INSTALL_COMMAND: "bash scripts/hometax-helper/install-url-scheme.sh",
  checkHometaxHelperHealth: (...args: unknown[]) => helperHealthMock(...(args as [])),
  sendInvoiceToHometaxHelper: (...args: unknown[]) =>
    helperIssueMock(...(args as Parameters<typeof helperIssueMock>)),
  wakeHometaxHelper: () => helperWakeMock(),
  waitForHometaxHelper: () => helperWaitMock(),
  waitForHometaxLogin: () => helperLoginWaitMock(),
}));
// 원천징수 탭은 이제 절차 3카드(WithholdingFilingCards)를 직접 그린다 — 이 파일의
// 테스트는 세금계산서 탭 계약만 다루므로, 원천징수 탭이 부르는 두 추가 fetch(리포트·
// 완료 기록)가 흔들리지 않도록 얕은 스텁으로 대체한다.
vi.mock("../withholding-filing-cards", () => ({
  WithholdingFilingCards: () => <div data-testid="withholding-cards" />,
}));

const BOARD = {
  month: "2026-07",
  pendingCount: 3,
  blockedCount: 2,
  // 발행(ISSUE) 100만/10만 · 수취(RECEIVE) 40만/4만 — 방향이 섞이면 여기 숫자가
  // 틀어져 테스트가 잡아낸다.
  totalsByDirection: {
    ISSUE: { supplyAmount: 1000000, taxAmount: 100000 },
    RECEIVE: { supplyAmount: 400000, taxAmount: 40000 },
  },
  warnings: [] as string[],
  rows: [
    {
      campaignId: "c1",
      campaignIds: ["c1"],
      groupId: null,
      sourceField: "sellerInvoiceIssuedAt" as const,
      direction: "ISSUE",
      counterpart: "SELLER",
      counterpartName: "○○커머스",
      campaignLabel: "딜A - 셀러1 1차",
      amount: { supplyAmount: 1000000, taxAmount: 100000 },
      xlsxEligible: true,
      blockingReasons: [],
      selectable: true,
      checklistItemId: "i1",
      // 구역 축(section) 도입(A1) 이후 모든 기존 픽스처는 「진행 중」이다 — 이 파일의
      // 다른 테스트는 전부 방향·결번·선택 게이트를 검증하고 구역 분리와는 무관하므로,
      // 「밀린 정리」 전용 픽스처(SECTION_BOARD)만 따로 둔다.
      section: "IN_PROGRESS" as const,
    },
    {
      campaignId: "c2",
      campaignIds: ["c2"],
      groupId: null,
      sourceField: "sellerInvoiceIssuedAt" as const,
      direction: "RECEIVE",
      counterpart: "SELLER",
      counterpartName: "△△마켓",
      campaignLabel: "딜B - 셀러2 1차",
      amount: { supplyAmount: 400000, taxAmount: 40000 },
      xlsxEligible: false,
      blockingReasons: ["사업자등록번호"],
      selectable: false,
      checklistItemId: null,
      section: "IN_PROGRESS" as const,
    },
    {
      campaignId: "c3",
      campaignIds: ["c3"],
      groupId: null,
      sourceField: "supplierInvoiceIssuedAt" as const,
      direction: "RECEIVE",
      counterpart: "SUPPLIER",
      counterpartName: "□□유통",
      campaignLabel: "딜C - 셀러3 1차",
      amount: { supplyAmount: 300000, taxAmount: 30000 },
      xlsxEligible: false,
      // 공급사(SUPPLIER) 상대는 counterpartBlockingReasons 가 신원을 검증할 수 없어
      // (tax-filing-board.ts 주석 참조) 실제로는 금액 계산 쪽 사유만 남는다 — 결번
      // 판정 자체는 여전히 존재함을 보여주기 위해 그 사유를 흉내낸다.
      blockingReasons: ["실매출(actualSales) 없음"],
      selectable: false,
      checklistItemId: "i3",
      section: "IN_PROGRESS" as const,
    },
    {
      // c4 는 결번이 아닌(selectable: true) RECEIVE 행이다 — "완료" 버튼이
      // checklistItemId 유무로만 갈린다는 것을 c1~c3(결번 또는 checklistItemId 있음)
      // 과 다른 조합으로 한 번 더 확인해 둔다. xlsxEligible 은 다이얼로그가 더는
      // 읽지 않지만(파일 생성 제거) `TaxInvoiceBoardRow` 타입이 요구하는 필드라
      // 값만 채운다.
      campaignId: "c4",
      campaignIds: ["c4"],
      groupId: null,
      sourceField: "sellerInvoiceIssuedAt" as const,
      direction: "RECEIVE",
      counterpart: "SELLER",
      counterpartName: "◇◇스토어",
      campaignLabel: "딜D - 셀러4 1차",
      amount: { supplyAmount: 200000, taxAmount: 20000 },
      xlsxEligible: false,
      blockingReasons: [],
      selectable: true,
      checklistItemId: null,
      section: "IN_PROGRESS" as const,
    },
  ],
};

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => BOARD }) as Response) as never;
});

function renderDialog() {
  return render(
    <TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />,
  );
}

describe("세무 처리 다이얼로그", () => {
  it("세금계산서 탭에 발행·수취 행을 각자 상대 이름으로 보여준다", async () => {
    renderDialog();
    expect(await screen.findByText("○○커머스")).toBeInTheDocument();
    expect(screen.getByText("△△마켓")).toBeInTheDocument();
    expect(screen.getByText("□□유통")).toBeInTheDocument();
  });

  it("선택 가능(selectable && xlsxEligible)한 행에만 체크박스를 제공한다", async () => {
    renderDialog();
    await screen.findByText("△△마켓");
    // 선택 가능(selectable && xlsxEligible)한 행 1개(c1) + 전체 선택 1개. c2·c3(결번),
    // c4(결번은 아니지만 RECEIVE 라 xlsxEligible: false)는 전부 체크박스가 없다.
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  });

  it("결번이 아닌 RECEIVE 행도 xlsxEligible 이 아니면 체크박스를 제공하지 않는다", async () => {
    renderDialog();
    await screen.findByText("◇◇스토어");
    // c4 는 selectable: true 이지만 xlsxEligible: false 다 — selectable 가드만으로는
    // 이 행이 걸러지지 않으므로, xlsxEligible 가드가 실제로 동작함을 이 행 하나로
    // 단독 검증한다.
    expect(
      screen.queryByRole("checkbox", { name: "◇◇스토어 · 딜D - 셀러4 1차 선택" }),
    ).not.toBeInTheDocument();
  });

  it("홈택스 XLSX 버튼과 전체 선택 컨트롤을 제공한다", async () => {
    renderDialog();
    await screen.findByText("○○커머스");
    // 전체 선택 라벨은 선택 가능(selectable && xlsxEligible)한 행 수를 함께 보여준다
    // (BOARD 는 c1 하나만 해당) — 결번을 자동으로 뺀 뒤의 분모를 오너가 계산하지
    // 않아도 되게 하는 것이 이 숫자의 목적이다.
    expect(screen.getByText("전체 선택(발행 · 1건)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /홈택스 XLSX/ })).toBeInTheDocument();
  });

  it("결번 사유를 행에 표시한다", async () => {
    renderDialog();
    expect(await screen.findByText(/사업자등록번호/)).toBeInTheDocument();
  });

  it("결번 행도(공급사 상대 등 신원 검증이 안 되는 행 포함) 금액은 항상 계산된 숫자로 표시한다", async () => {
    // 한때 우리몰 공급사 수취처럼 금액 기준 자체가 미확정인 행이 있어 "금액 기준
    // 확인 필요" 문구로 숫자를 대신했다 — 그 기준이 오너 확정되며 장치를 제거했으므로,
    // 결번(selectable: false)이라도 공급가액·세액은 항상 숫자로 나와야 한다.
    renderDialog();
    await screen.findByText("□□유통");
    expect(screen.getByText("300,000")).toBeInTheDocument();
    expect(screen.getByText("30,000")).toBeInTheDocument();
    expect(screen.queryByText("금액 기준 확인 필요")).not.toBeInTheDocument();
  });

  it("RECEIVE 행도 체크리스트 항목이 있으면 완료 버튼을 제공한다", async () => {
    renderDialog();
    await screen.findByText("□□유통");
    // c3(RECEIVE, checklistItemId: i3)의 완료 버튼 + c1(ISSUE, checklistItemId: i1)의
    // 완료 버튼 = 2개. c2 는 checklistItemId 가 null 이라 완료 버튼이 없다.
    expect(screen.getAllByRole("button", { name: "완료" })).toHaveLength(2);
  });

  it("합계를 발행/수취 방향별로 따로 표시한다", async () => {
    renderDialog();
    await screen.findByText("○○커머스");
    // 행 셀에도 같은 숫자가 나타나므로 전역 조회로는 합계 계산이 실제로 도는지
    // 증명하지 못한다. 공급가액·세액·방향 세 축이 서로 자리를 바꿔도(라벨 오배선)
    // 전역 텍스트 존재 확인만으로는 통과하므로, 방향×금액 조합마다 개별 testid로
    // 조회해 자리를 못 바꾸게 고정한다.
    expect(screen.getByTestId("tax-filing-total-issue-supply")).toHaveTextContent("1,000,000");
    expect(screen.getByTestId("tax-filing-total-issue-tax")).toHaveTextContent("100,000");
    expect(screen.getByTestId("tax-filing-total-receive-supply")).toHaveTextContent("400,000");
    expect(screen.getByTestId("tax-filing-total-receive-tax")).toHaveTextContent("40,000");
  });

  it("조회 실패 시 오류를 표시하고 빈 목록을 그리지 않는다", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "조회 실패" }),
    }) as Response) as never;
    renderDialog();
    expect(await screen.findByText(/조회 실패/)).toBeInTheDocument();
  });

  it("같은 캠페인의 두 수취 의무(공급사·셀러)가 같은 방향(RECEIVE)이라도 행 key 가 충돌하지 않는다", async () => {
    // 우리몰은 supplierInvoiceIssuedAt·sellerInvoiceIssuedAt 의무가 둘 다 RECEIVE라
    // `campaignId:direction`만으로는 같은 섹션 안에서 두 행이 같은 key
    // (`c5:RECEIVE`)로 충돌한다 — React 가 중복 key 경고를 내고 리렌더마다 두 행이
    // 언마운트/재마운트된다. 기존 픽스처는 campaignId 가 전부 달라 이 조합이 한 번도
    // 나오지 않았으므로, 같은 campaignId·같은 direction·다른 counterpart 조합을
    // 추가해 재현한다.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...BOARD,
        rows: [
          ...BOARD.rows,
          {
            campaignId: "c5",
            campaignIds: ["c5"],
            groupId: null,
            sourceField: "supplierInvoiceIssuedAt" as const,
            direction: "RECEIVE",
            counterpart: "SUPPLIER",
            counterpartName: "공급사X",
            campaignLabel: "딜E - 셀러5 1차",
            amount: { supplyAmount: 111, taxAmount: 11 },
            xlsxEligible: false,
            blockingReasons: [],
            selectable: true,
            checklistItemId: null,
            section: "IN_PROGRESS" as const,
          },
          {
            campaignId: "c5",
            campaignIds: ["c5"],
            groupId: null,
            sourceField: "sellerInvoiceIssuedAt" as const,
            direction: "RECEIVE",
            counterpart: "SELLER",
            counterpartName: "셀러Y",
            campaignLabel: "딜E - 셀러5 1차",
            amount: { supplyAmount: 222, taxAmount: 22 },
            xlsxEligible: false,
            blockingReasons: [],
            selectable: true,
            checklistItemId: null,
            section: "IN_PROGRESS" as const,
          },
        ],
      }),
    }) as Response) as never;

    renderDialog();
    expect(await screen.findByText("공급사X")).toBeInTheDocument();
    expect(screen.getByText("셀러Y")).toBeInTheDocument();

    const hasDuplicateKeyWarning = consoleError.mock.calls.some((call) =>
      call.some(
        (arg) => typeof arg === "string" && arg.includes("two children with the same key"),
      ),
    );
    expect(hasDuplicateKeyWarning).toBe(false);
    consoleError.mockRestore();
  });
});

// 두 구역 렌더 — 2026-08-09. 세금계산서 탭이 캠페인 상태 축으로 바뀌면서(A1~A3) 서버가
// 각 행에 section("IN_PROGRESS" | "BACKLOG")을 실어 보낸다. 「밀린 정리」(BACKLOG)는
// 정산 완료로 표시됐는데 계산서 의무가 남은, 지워지지 않는 행이라 「진행 중」 목록과
// 섞으면 오너가 목록 전체를 습관적으로 무시하게 된다(설계 §2) — 그래서 접힌 별도
// 구역으로 나눈다. 이 블록은 그 분리와, 세금계산서 탭이 이제 월 무관(캠페인 상태 축)
// 이라 대상월 선택기를 숨기는 계약을 고정한다(route.ts 헤더 주석 — 원천징수만 지급월
// 축이다).
describe("세무 처리 다이얼로그 — 진행 중/밀린 정리 두 구역", () => {
  const SECTION_BOARD = {
    ...BOARD,
    pendingCount: 1,
    backlogCount: 2,
    rows: [
      {
        campaignId: "s-progress",
        campaignIds: ["s-progress"],
        groupId: null,
        sourceField: "sellerInvoiceIssuedAt" as const,
        direction: "ISSUE",
        counterpart: "SELLER",
        counterpartName: "진행셀러몰",
        campaignLabel: "딜S - 셀러S 1차",
        amount: { supplyAmount: 100000, taxAmount: 10000 },
        xlsxEligible: true,
        blockingReasons: [],
        selectable: true,
        checklistItemId: "i-s-progress",
        section: "IN_PROGRESS" as const,
      },
      {
        // 결번(selectable: false)인 밀린 건 — 접힌 머리글이 결번 수까지 말하는지를
        // 이 행 하나로 확인한다.
        campaignId: "s-backlog",
        campaignIds: ["s-backlog"],
        groupId: null,
        sourceField: "sellerInvoiceIssuedAt" as const,
        direction: "ISSUE",
        counterpart: "SELLER",
        counterpartName: "밀린셀러몰",
        campaignLabel: "딜T - 셀러T 1차",
        amount: { supplyAmount: 50000, taxAmount: 5000 },
        xlsxEligible: true,
        blockingReasons: ["사업자등록번호"],
        selectable: false,
        checklistItemId: null,
        section: "BACKLOG" as const,
      },
      {
        // 결번이 아닌(selectable && xlsxEligible) 밀린 건 — 「구역은 표시 축이지
        // 기능 축이 아니다」(브리프 하드 제약)를 고정하는 데 쓴다. 이 행이
        // selectableRows·downloadXlsx 에서 빠지면(누군가 board?.rows 를
        // inProgressRows 로 잘못 바꾸면) 화면에는 아무 신호가 안 남고 XLSX 파일만
        // 조용히 한 건 줄어든다 — 그 회귀를 여기서 잡는다.
        campaignId: "s-backlog-eligible",
        campaignIds: ["s-backlog-eligible"],
        groupId: null,
        sourceField: "sellerInvoiceIssuedAt" as const,
        direction: "ISSUE",
        counterpart: "SELLER",
        counterpartName: "밀린정상셀러몰",
        campaignLabel: "딜U - 셀러U 1차",
        amount: { supplyAmount: 70000, taxAmount: 7000 },
        xlsxEligible: true,
        blockingReasons: [],
        selectable: true,
        checklistItemId: null,
        section: "BACKLOG" as const,
      },
    ],
  };

  it("밀린 정리 구역은 접힌 채로 시작하고 건수를 머리글에 적는다", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => SECTION_BOARD }) as Response) as never;
    renderDialog();

    // 구역 머리글로 특정한다 — 푸터의 합계도 스코프를 「(진행 중)」으로 밝히므로
    // 느슨한 /진행 중/ 은 두 곳을 함께 집는다.
    expect(await screen.findByText(/진행 중 · 발행/)).toBeInTheDocument();
    const backlogHeader = await screen.findByRole("button", { name: /밀린 정리 2건/ });
    expect(backlogHeader).toHaveAttribute("aria-expanded", "false");
    // 접힌 상태에서도 결번 수를 말한다 — 열지 않아도 규모를 알 수 있어야 한다.
    // (2건 중 결번은 s-backlog 하나뿐 — s-backlog-eligible 은 결번이 아니다.)
    expect(within(backlogHeader).getByText(/결번 1건/)).toBeInTheDocument();
    // 접힌 동안은 밀린 건의 상대 이름이 DOM에 없다(진짜로 숨겨졌는지 확인).
    expect(screen.queryByText("밀린셀러몰")).not.toBeInTheDocument();
    expect(screen.queryByText("밀린정상셀러몰")).not.toBeInTheDocument();
  });

  it("구역은 표시 축이지 기능 축이 아니다 — 전체 선택·XLSX 는 밀린 건도 그대로 센다(브리프 하드 제약)", async () => {
    // 이 테스트가 없으면 누군가 selectableRows/downloadXlsx 의 소스를
    // `board?.rows` 에서 `inProgressRows` 로 바꿔도 이 파일의 다른 54개 테스트가
    // 전부 초록으로 남는다 — 밀린 건이 XLSX 에서 조용히 빠지는 회귀가 화면에
    // 아무 신호를 안 남기기 때문(리뷰 지적, 2026-08-09).
    const calls: Array<{ url: string; body?: string }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes("tax-filing-board")) {
        return { ok: true, json: async () => SECTION_BOARD } as Response;
      }
      return { ok: true, blob: async () => new Blob(["x"]) } as unknown as Response;
    }) as never;

    renderDialog();
    await screen.findByText("진행셀러몰");

    // ① 전체 선택 라벨의 건수가 밀린 건(s-backlog-eligible)까지 센다 — 결번인
    // s-backlog 는 selectable: false 라 분모에서 계속 빠진다.
    expect(screen.getByText(/전체 선택\(발행 · 2건/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /홈택스 XLSX/ }));

    // ② 전체 선택 후 POST 본문에 밀린 건의 campaignIds 가 담긴다.
    await waitFor(() => {
      const post = calls.find((call) => call.url.includes("/api/settlement/tax-invoice"));
      expect(post).toBeDefined();
      expect(post!.body).toContain("s-progress");
      expect(post!.body).toContain("s-backlog-eligible");
      expect(post!.body).not.toContain('"s-backlog"');
    });
  });

  // 「전체 선택」(밀린 건 포함)과 「발행·수취 합계」(IN_PROGRESS 전용)는 같은 푸터 바에
  // 나란히 서지만 **모집단이 다르다.** 행위는 설계가 못박은 그대로 두고(구역은 표시 축이지
  // 기능 축이 아니다 · 합계는 IN_PROGRESS 전용 — 오너가 그 숫자로 홈택스를 대사한다),
  // 화면이 그 차이를 말하게 한다. 이 계약이 없으면 오너는 두 줄을 같은 모집단으로 읽는다.
  it("전체 선택과 합계가 다른 모집단이라는 사실을 화면이 말한다", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => SECTION_BOARD }) as Response) as never;
    renderDialog();
    await screen.findByText("진행셀러몰");

    // ① 전체 선택 분모에 섞인 밀린 건 수를 병기한다(s-backlog-eligible 1건 —
    //    결번인 s-backlog 는 애초에 분모에 없다).
    expect(screen.getByText("전체 선택(발행 · 2건, 밀린 정리 1건 포함)")).toBeInTheDocument();
    // ② 합계 쪽은 자기 스코프(진행 중)를 라벨에 박는다.
    expect(screen.getByTestId("tax-filing-totals-issue")).toHaveTextContent("발행 합계(진행 중)");
    expect(screen.getByTestId("tax-filing-totals-receive")).toHaveTextContent("수취 합계(진행 중)");
  });

  it("밀린 건이 분모에 없으면 병기하지 않는다 — 0건 괄호는 상시 노이즈가 되어 신호를 죽인다", async () => {
    // 기본 BOARD 는 전부 IN_PROGRESS 다.
    renderDialog();
    await screen.findByText("○○커머스");
    expect(screen.getByText("전체 선택(발행 · 1건)")).toBeInTheDocument();
    expect(screen.queryByText(/밀린 정리 .*건 포함/)).not.toBeInTheDocument();
  });

  it("밀린 정리 머리글을 누르면 펼쳐져 안의 행을 보여준다", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => SECTION_BOARD }) as Response) as never;
    renderDialog();

    const backlogHeader = await screen.findByRole("button", { name: /밀린 정리/ });
    fireEvent.click(backlogHeader);

    expect(backlogHeader).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("밀린셀러몰")).toBeInTheDocument();
  });

  it("밀린 건이 없으면 밀린 정리 구역 자체를 그리지 않는다", async () => {
    // 기본 BOARD 는 전부 IN_PROGRESS 라 BACKLOG 행이 0건이다.
    renderDialog();
    await screen.findByText("○○커머스");
    expect(screen.queryByText(/밀린 정리/)).not.toBeInTheDocument();
  });

  it("세금계산서 탭에서는 대상월 선택기를 숨긴다 — 캠페인 상태 축이라 월을 바꿔도 목록이 안 변하기 때문", async () => {
    renderDialog();
    await screen.findByText("○○커머스");
    expect(screen.queryByLabelText("대상월")).not.toBeInTheDocument();
  });

  it("원천징수 탭으로 옮기면 대상월 선택기가 다시 보인다", async () => {
    renderDialog();
    await screen.findByText("○○커머스");
    // Radix Tabs 는 탭 전환을 onClick 이 아니라 onMouseDown 으로 건다(react-tabs
    // 소스 확인) — fireEvent.click 만으로는 활성 탭이 안 바뀐다.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "원천징수" }));
    expect(await screen.findByLabelText("대상월")).toBeInTheDocument();
  });
});

// 홈택스 XLSX 생성 — 2026-08-05 재도입. 이 블록은 선택 집합이 실제로 POST 본문을
// 만드는 경로를 고정한다: xlsxEligible 이 selectable 과 독립적으로 게이트를 걸고,
// 결번 행은 자동 선택되지 않으며, 그룹 행은 campaignId(단수, 체크리스트 앵커)가
// 아니라 campaignIds(복수, 실제 멤버 전원)를 보낸다. 마지막 계약이 가장 중요하다 —
// 단수를 보내면 그룹의 나머지 멤버가 빠진 채로 신고돼도 화면에 아무 신호가 없다.
describe("세무 처리 다이얼로그 — 홈택스 XLSX 생성", () => {
  function captureFetch(): Array<{ url: string; body?: string }> {
    const calls: Array<{ url: string; body?: string }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes("tax-filing-board")) {
        return { ok: true, json: async () => BOARD } as Response;
      }
      return { ok: true, blob: async () => new Blob(["x"]) } as unknown as Response;
    }) as never;
    return calls;
  }

  it("선택된 행만 XLSX 요청 본문에 담는다(결번 c2는 제외)", async () => {
    const calls = captureFetch();
    renderDialog();
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: /홈택스 XLSX/ }));

    await waitFor(() => {
      const post = calls.find((call) => call.url.includes("/api/settlement/tax-invoice"));
      expect(post).toBeDefined();
      expect(post!.body).toContain("c1");
      expect(post!.body).not.toContain("c2");
    });
  });

  it("RECEIVE 행은 결번이 아니어도 XLSX 요청 본문에 절대 들어가지 않는다 — xlsxEligible 을 selectable 과 독립적으로 검증한다", async () => {
    // c4 는 selectable: true(결번 아님)인 RECEIVE 행이다 — selectable 가드만 있고
    // xlsxEligible 가드가 빠지는 회귀가 생기면 이 행이 본문에 들어가므로, 그 경로를
    // c3(결번인 RECEIVE)와 별도로 고정한다. c3 도 함께 확인해 두 축(결번 여부와
    // xlsxEligible)이 둘 다 RECEIVE 를 막는지 본다.
    const calls = captureFetch();
    renderDialog();
    await screen.findByText("◇◇스토어");
    fireEvent.click(screen.getByRole("button", { name: /홈택스 XLSX/ }));

    await waitFor(() => {
      const post = calls.find((call) => call.url.includes("/api/settlement/tax-invoice"));
      expect(post).toBeDefined();
      expect(post!.body).not.toContain("c3");
      expect(post!.body).not.toContain("c4");
    });
  });

  it("결번(selectable: false)인 ISSUE 행은 xlsxEligible 이어도 자동 선택되지 않아 XLSX 요청 본문에 들어가지 않는다", async () => {
    // c1 은 정상, c-blocked 는 xlsxEligible: true 이지만 결번(selectable: false)이다 —
    // xlsxEligible 만 보고 selectable 을 확인하지 않는 회귀가 생기면 이 결번 캠페인이
    // 자동 선택되어 본문에 들어간다. 이 경우 홈택스가 업로드 전체를 반려한다.
    const BLOCKED_ISSUE_BOARD = {
      ...BOARD,
      rows: [
        ...BOARD.rows,
        {
          campaignId: "c-blocked",
          campaignIds: ["c-blocked"],
          groupId: null,
          sourceField: "sellerInvoiceIssuedAt" as const,
          direction: "ISSUE",
          counterpart: "SELLER",
          counterpartName: "결번셀러몰",
          campaignLabel: "딜Z - 셀러Z 1차",
          amount: { supplyAmount: 500000, taxAmount: 50000 },
          xlsxEligible: true,
          blockingReasons: ["사업자등록번호"],
          selectable: false,
          checklistItemId: null,
          section: "IN_PROGRESS" as const,
        },
      ],
    };
    const calls: Array<{ url: string; body?: string }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes("tax-filing-board")) {
        return { ok: true, json: async () => BLOCKED_ISSUE_BOARD } as Response;
      }
      return { ok: true, blob: async () => new Blob(["x"]) } as unknown as Response;
    }) as never;

    renderDialog();
    await screen.findByText("결번셀러몰");
    // 결번 행은 체크박스 자체가 없다 — 결번 사유로 "결번셀러몰" 행에는 selectable
    // 게이트만 걸려 있음을 먼저 확인한다.
    expect(
      screen.queryByRole("checkbox", { name: "결번셀러몰 · 딜Z - 셀러Z 1차 선택" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /홈택스 XLSX/ }));

    await waitFor(() => {
      const post = calls.find((call) => call.url.includes("/api/settlement/tax-invoice"));
      expect(post).toBeDefined();
      expect(post!.body).toContain("c1");
      expect(post!.body).not.toContain("c-blocked");
    });
  });

  it("정산 그룹 행은 campaignId(단수, 체크리스트 앵커)가 아니라 campaignIds(복수, 멤버 전원)를 XLSX 요청 본문에 담는다", async () => {
    // 3인 그룹 — 대표(앵커) 하나만 보내면 나머지 두 멤버의 몫이 신고에서 빠진 채로
    // 조용히 통과한다(이 사고는 화면에 아무 신호가 없다). campaignId(단수)는
    // "gAnchor" 하나뿐이지만 campaignIds(복수)에는 세 멤버가 전부 있다 — 이 테스트는
    // 본문에 세 멤버가 전부 있는지, 그리고 groupId 자체는 본문에 들어가지 않는지를
    // 함께 확인한다.
    const GROUP_BOARD = {
      ...BOARD,
      rows: [
        {
          campaignId: "gAnchor",
          campaignIds: ["gAnchor", "gSiblingA", "gSiblingB"],
          groupId: "group-xyz",
          sourceField: "sellerInvoiceIssuedAt" as const,
          direction: "ISSUE",
          counterpart: "SELLER",
          counterpartName: "그룹셀러몰",
          campaignLabel: "딜G - 셀러G 외 2건",
          amount: { supplyAmount: 900000, taxAmount: 90000 },
          xlsxEligible: true,
          blockingReasons: [],
          selectable: true,
          checklistItemId: "i-group",
          section: "IN_PROGRESS" as const,
        },
      ],
    };
    const calls: Array<{ url: string; body?: string }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes("tax-filing-board")) {
        return { ok: true, json: async () => GROUP_BOARD } as Response;
      }
      return { ok: true, blob: async () => new Blob(["x"]) } as unknown as Response;
    }) as never;

    renderDialog();
    await screen.findByText("그룹셀러몰");
    fireEvent.click(screen.getByRole("button", { name: /홈택스 XLSX/ }));

    await waitFor(() => {
      const post = calls.find((call) => call.url.includes("/api/settlement/tax-invoice"));
      expect(post).toBeDefined();
      const body = JSON.parse(post!.body ?? "{}") as { campaignIds: string[] };
      expect(body.campaignIds).toEqual(
        expect.arrayContaining(["gAnchor", "gSiblingA", "gSiblingB"]),
      );
      expect(body.campaignIds).toHaveLength(3);
    });
  });

  it("400 응답의 details 를 화면에 남겨 어느 캠페인을 빼야 하는지 보여준다", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("tax-filing-board")) {
        return { ok: true, json: async () => BOARD } as Response;
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: "Validation failed",
          details: [
            { campaignId: "c1", campaignName: "딜A - 셀러1 1차", missingFields: ["사업자등록번호"] },
          ],
        }),
      } as Response;
    }) as never;

    renderDialog();
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: /홈택스 XLSX/ }));

    // 캠페인명·결번 사유는 BOARD의 다른 행에도 등장할 수 있으므로(예: c1의 캠페인명
    // 표시, c2의 「사업자등록번호」 결번 사유) 전역 조회 대신 400 상세 목록
    // (`data-testid="tax-invoice-errors"`) 안에서만 조회해 오검출을 막는다.
    const errorList = await screen.findByTestId("tax-invoice-errors");
    expect(within(errorList).getByText(/딜A - 셀러1 1차/)).toBeInTheDocument();
    expect(within(errorList).getByText(/사업자등록번호/)).toBeInTheDocument();
  });

  it("400 상세의 「선택 해제」를 누르면 해당 행만 선택에서 빠지고, 이후 XLSX 요청 본문에 그 캠페인이 들어가지 않는다", async () => {
    // 두 번째 ISSUE 행(c7)을 함께 선택 가능하게 둬서, 「선택 해제」가 전체 선택을
    // 지우는 게 아니라 지목된 행 하나만 지우는지를 구분해서 검증한다. 첫 번째 XLSX
    // 요청은 c1이 결번이라고 반려되고(POST #1), 「선택 해제」로 c1을 빼고 다시
    // 요청하면(POST #2) c1은 빠지고 c7은 그대로 들어가야 한다.
    const TWO_ISSUE_BOARD = {
      ...BOARD,
      rows: [
        BOARD.rows[0],
        {
          campaignId: "c7",
          campaignIds: ["c7"],
          groupId: null,
          sourceField: "sellerInvoiceIssuedAt" as const,
          direction: "ISSUE",
          counterpart: "SELLER",
          counterpartName: "정상셀러몰",
          campaignLabel: "딜H - 셀러7 1차",
          amount: { supplyAmount: 300000, taxAmount: 30000 },
          xlsxEligible: true,
          blockingReasons: [],
          selectable: true,
          checklistItemId: null,
          section: "IN_PROGRESS" as const,
        },
      ],
    };

    let postCount = 0;
    const calls: Array<{ url: string; body?: string }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes("tax-filing-board")) {
        return { ok: true, json: async () => TWO_ISSUE_BOARD } as Response;
      }
      postCount += 1;
      if (postCount === 1) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: "Validation failed",
            details: [
              { campaignId: "c1", campaignName: "딜A - 셀러1 1차", missingFields: ["사업자등록번호"] },
            ],
          }),
        } as Response;
      }
      return { ok: true, blob: async () => new Blob(["x"]) } as unknown as Response;
    }) as never;

    renderDialog();
    await screen.findByText("정상셀러몰");
    fireEvent.click(screen.getByRole("button", { name: /홈택스 XLSX/ }));

    const errorList = await screen.findByTestId("tax-invoice-errors");
    fireEvent.click(within(errorList).getByRole("button", { name: "선택 해제" }));

    fireEvent.click(screen.getByRole("button", { name: /홈택스 XLSX/ }));

    await waitFor(() => {
      const posts = calls.filter((call) => call.url.includes("/api/settlement/tax-invoice"));
      expect(posts).toHaveLength(2);
      expect(posts[1].body).not.toContain("c1");
      expect(posts[1].body).toContain("c7");
    });
  });

  it("400 상세가 그룹의 **멤버** id 를 가리켜도 그 그룹 행 전체가 선택에서 빠진다", async () => {
    // 위 테스트는 전부 미그룹 행이라 `campaignIds`가 `[campaignId]` 와 같다 —
    // `row.campaignId === error.campaignId` 로 비교하는 순진한 구현도 통과한다.
    // 그룹 행은 앵커(단수)와 멤버 전원(복수)이 갈리므로, 라우트가 반환한 상세가
    // **앵커가 아닌 멤버**를 가리킬 때만 `campaignIds.includes()` 여부가 드러난다.
    // 여기서 실패하면 오너는 반려된 그룹을 화면에서 뺄 방법이 없다.
    const GROUP_BOARD = {
      ...BOARD,
      rows: [
        {
          ...BOARD.rows[0],
          campaignId: "g-anchor",
          campaignIds: ["g-anchor", "g-member2", "g-member3"],
          groupId: "grp1",
          campaignLabel: "딜A - 셀러1 1차 외 2건",
          counterpartName: "정상셀러몰",
        },
      ],
    };

    const calls: Array<{ url: string; body?: string }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes("tax-filing-board")) {
        return { ok: true, json: async () => GROUP_BOARD } as Response;
      }
      if (calls.filter((c) => c.url.includes("/api/settlement/tax-invoice")).length === 1) {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: "Validation failed",
            // 앵커가 아니라 **멤버** id 를 가리킨다.
            details: [
              { campaignId: "g-member3", campaignName: "딜C - 셀러1 3차", missingFields: ["사업자등록번호"] },
            ],
          }),
        } as Response;
      }
      return { ok: true, blob: async () => new Blob(["x"]) } as unknown as Response;
    }) as never;

    renderDialog();
    await screen.findByText("정상셀러몰");
    fireEvent.click(screen.getByRole("button", { name: /홈택스 XLSX/ }));

    const errorList = await screen.findByTestId("tax-invoice-errors");
    fireEvent.click(within(errorList).getByRole("button", { name: "선택 해제" }));

    fireEvent.click(screen.getByRole("button", { name: /홈택스 XLSX/ }));

    await waitFor(() => {
      const posts = calls.filter((call) => call.url.includes("/api/settlement/tax-invoice"));
      // 두 번째 요청은 아예 나가지 않는다(선택이 비었으므로) — 그룹 행이 통째로 빠진 것.
      expect(posts).toHaveLength(1);
    });
  });

  it("대상월을 바꿔 다시 조회하면 이전 월의 400 상세를 더는 보여주지 않는다", async () => {
    // 대상월 Input 은 다이얼로그를 닫지 않고도 바꿀 수 있다 — 이전 월에서 실패한
    // XLSX 생성의 결번 상세가 지워지지 않으면, 방금 불러온 새 월의 보드 위에
    // "지난 조회의" 상세가 겹쳐 보여 오너가 지금 월의 문제로 오독한다.
    let boardCalls = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("tax-filing-board")) {
        boardCalls += 1;
        return { ok: true, json: async () => BOARD } as Response;
      }
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: "Validation failed",
          details: [
            { campaignId: "c1", campaignName: "딜A - 셀러1 1차", missingFields: ["사업자등록번호"] },
          ],
        }),
      } as Response;
    }) as never;

    const { rerender } = render(
      <TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />,
    );
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: /홈택스 XLSX/ }));
    await screen.findByTestId("tax-invoice-errors");

    rerender(
      <TaxFilingDialog open month="2026-08" onOpenChange={() => {}} onMonthChange={() => {}} />,
    );

    await waitFor(() => expect(boardCalls).toBeGreaterThan(1));
    expect(screen.queryByTestId("tax-invoice-errors")).not.toBeInTheDocument();
  });
});

// 수취 메일함 확인 스캔 — 2026-08-04 도입. 이 블록은 엔진(tax-invoice-mail/*)의 판정을
// 보드 행에 증거로 잇는 계약을 고정한다: 자동으로 돌지 않고, 완료를 대신 찍지 않으며,
// VERIFIED 만 "확인됨"으로 읽히고, 스캔이 놓친 부분(상한·비밀번호·미수취)이 화면에 남는다.
describe("세무 처리 다이얼로그 — 수취 메일함 확인", () => {
  const BOARD_WITH_RECEIVE = {
    ...BOARD,
    rows: [
      {
        campaignId: "camp-verified",
        campaignIds: ["camp-verified"],
        groupId: null,
        sourceField: "supplierInvoiceIssuedAt" as const,
        direction: "RECEIVE",
        counterpart: "SUPPLIER",
        counterpartName: "확인됨공급사",
        campaignLabel: "딜V - 셀러V 1차",
        amount: { supplyAmount: 700000, taxAmount: 70000 },
        xlsxEligible: false,
        blockingReasons: [],
        selectable: true,
        checklistItemId: null,
        section: "IN_PROGRESS" as const,
      },
      {
        campaignId: "camp-mismatch",
        campaignIds: ["camp-mismatch"],
        groupId: null,
        sourceField: "sellerInvoiceIssuedAt" as const,
        direction: "RECEIVE",
        counterpart: "SELLER",
        counterpartName: "불일치셀러",
        campaignLabel: "딜M - 셀러M 1차",
        amount: { supplyAmount: 200000, taxAmount: 20000 },
        xlsxEligible: false,
        blockingReasons: [],
        selectable: true,
        checklistItemId: null,
        section: "IN_PROGRESS" as const,
      },
      {
        // 스캔의 unseenExpected 에만 있는 건 — 아래 「메일 없음」 문구 계약이 이 행으로 걸린다.
        campaignId: "camp-unseen",
        campaignIds: ["camp-unseen"],
        groupId: null,
        sourceField: "supplierInvoiceIssuedAt" as const,
        direction: "RECEIVE",
        counterpart: "SUPPLIER",
        // 미수취 목록 항목(`counterpartLabel: "미수취공급사"`)과 **다른** 문자열을 쓴다 —
        // 같으면 기존 테스트의 단일 매칭 단언이 행/목록 양쪽에 걸려 깨진다.
        counterpartName: "메일없음공급사",
        campaignLabel: "딜B - 셀러B 1차",
        amount: { supplyAmount: 90000, taxAmount: 9000 },
        xlsxEligible: false,
        blockingReasons: [],
        selectable: true,
        checklistItemId: null,
        section: "IN_PROGRESS" as const,
      },
    ],
  };

  const RECEIPT_SCAN_RESPONSE = {
    scan: {
      box: "세금계산서",
      headerScanned: 12,
      candidates: 4,
      skippedByFilter: 8,
      truncated: 1,
      sinceDays: 90,
    },
    summary: {
      verified: 1,
      needsReview: 1,
      notOurs: 0,
      issuedByUs: 0,
      expectedTotal: 3,
      unseenExpected: 1,
      passwordProtected: 1,
      attachmentCensus: { ETAX_XML: 1, "NTS_SECURE_MAIL_HTML(암호)": 1 },
    },
    results: [
      {
        mail: { uid: 1, subject: "세금계산서", fromAddress: "a@example.com", receivedAt: "2026-07-20", hasAttachmentEvidence: true },
        verdict: {
          status: "VERIFIED",
          confidence: "ATTACHMENT",
          matchedKey: "camp-verified:SUPPLIER_GOODS",
          candidateKeys: ["camp-verified:SUPPLIER_GOODS"],
          reasons: [],
          observed: {
            issueId: "1".repeat(24),
            writtenDate: "2026-07-18",
            counterpartBusinessNumber: "4445566666",
            totalAmount: 700000,
            expectedTotalAmount: 700000,
            amountDelta: 0,
          },
        },
      },
      {
        mail: { uid: 2, subject: "세금계산서", fromAddress: "b@example.com", receivedAt: "2026-07-21", hasAttachmentEvidence: true },
        verdict: {
          status: "NEEDS_REVIEW",
          confidence: "ATTACHMENT",
          matchedKey: "camp-mismatch:SELLER_COMMISSION",
          candidateKeys: ["camp-mismatch:SELLER_COMMISSION"],
          reasons: [{ code: "AMOUNT_MISMATCH", message: "금액이 다릅니다. 계산서 150,000원 vs 정산 200,000원 (차이 -50,000원)." }],
          observed: {
            issueId: "2".repeat(24),
            writtenDate: "2026-07-19",
            counterpartBusinessNumber: "1112233333",
            totalAmount: 150000,
            expectedTotalAmount: 200000,
            amountDelta: -50000,
          },
        },
      },
    ],
    unseenExpected: [
      {
        key: "camp-unseen:SUPPLIER_GOODS",
        campaignId: "camp-unseen",
        campaignLabel: "딜U - 셀러U 1차",
        channel: "SELLER_MALL",
        slot: "SUPPLIER_GOODS",
        counterpartLabel: "미수취공급사",
        expectedTotalAmount: 90000,
        amountBasis: "물품비",
        trackingField: null,
        alreadyMarkedAt: null,
      },
    ],
  };

  function mockBoardThenReceipts() {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("tax-invoice-receipts")) {
        return { ok: true, json: async () => RECEIPT_SCAN_RESPONSE } as Response;
      }
      return { ok: true, json: async () => BOARD_WITH_RECEIVE } as Response;
    }) as never;
  }

  it("다이얼로그를 열기만 해도 메일함을 스캔하지 않는다(IMAP 은 오너가 눌러야 돈다)", async () => {
    mockBoardThenReceipts();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("확인됨공급사");
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const calledReceipts = fetchMock.mock.calls.some((call) => String(call[0]).includes("tax-invoice-receipts"));
    expect(calledReceipts).toBe(false);
  });

  it("버튼을 누르면 스캔이 돌고, VERIFIED 건은 승인번호·작성일자·금액을 보여준다", async () => {
    mockBoardThenReceipts();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("확인됨공급사");

    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    expect(await screen.findByText("확인됨")).toBeInTheDocument();
    expect(screen.getByText(/승인번호 1{24}/)).toBeInTheDocument();
    expect(screen.getByText(/작성일자 2026-07-18/)).toBeInTheDocument();
  });

  it("NEEDS_REVIEW 건은 '확인 필요' 한 마디가 아니라 사유(금액 불일치 등)를 그대로 보여준다", async () => {
    mockBoardThenReceipts();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("불일치셀러");

    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    expect(await screen.findByText("확인 필요")).toBeInTheDocument();
    expect(
      screen.getByText("금액이 다릅니다. 계산서 150,000원 vs 정산 200,000원 (차이 -50,000원)."),
    ).toBeInTheDocument();
  });

  it("정산 그룹 행은 대표 캠페인 키 하나로 그룹 전체 확인 여부를 판정한다 — 나머지 멤버의 개별 키가 없어도 확인됨으로 읽는다(오너 확정 2026-08-04, 그룹당 계산서 1장)", async () => {
    const GROUP_BOARD = {
      ...BOARD,
      rows: [
        {
          campaignId: "campAnchor",
          campaignIds: ["campAnchor", "campSibling1", "campSibling2"],
          groupId: "group1",
          sourceField: "supplierInvoiceIssuedAt" as const,
          direction: "RECEIVE",
          counterpart: "SUPPLIER",
          counterpartName: "그룹공급사",
          campaignLabel: "딜G - 셀러G 외 2건",
          amount: { supplyAmount: 1500000, taxAmount: 150000 },
          xlsxEligible: false,
          blockingReasons: [],
          selectable: true,
          checklistItemId: null,
          section: "IN_PROGRESS" as const,
        },
      ],
    };
    const GROUP_RECEIPT_SCAN = {
      scan: { box: "세금계산서", headerScanned: 1, candidates: 1, truncated: 0, sinceDays: 90 },
      summary: {
        verified: 1,
        needsReview: 0,
        notOurs: 0,
        issuedByUs: 0,
        expectedTotal: 1,
        unseenExpected: 0,
        passwordProtected: 0,
        attachmentCensus: {},
      },
      results: [
        {
          mail: { uid: 1, subject: "세금계산서", fromAddress: "g@example.com", receivedAt: "2026-07-22", hasAttachmentEvidence: true },
          verdict: {
            status: "VERIFIED",
            confidence: "ATTACHMENT",
            // 대표(anchor=campAnchor) 키만 매칭됐다 — campSibling1·campSibling2 는 이
            // 스캔 결과에 아무 흔적이 없다. 엔진이 그룹 전체를 한 장으로 합쳤다는 뜻이다.
            matchedKey: "campAnchor:SUPPLIER_GOODS",
            candidateKeys: ["campAnchor:SUPPLIER_GOODS"],
            reasons: [],
            observed: {
              issueId: "3".repeat(24),
              writtenDate: "2026-07-20",
              counterpartBusinessNumber: "5556667777",
              totalAmount: 1500000,
              expectedTotalAmount: 1500000,
              amountDelta: 0,
            },
          },
        },
      ],
      unseenExpected: [],
    };

    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("tax-invoice-receipts")) return { ok: true, json: async () => GROUP_RECEIPT_SCAN } as Response;
      return { ok: true, json: async () => GROUP_BOARD } as Response;
    }) as never;

    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("그룹공급사");

    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    // 대표 키가 매칭됐으므로 실제 계산서 1장의 값(승인번호 등)이 그대로 나온다 — 그룹
    // 3건이라 detail 을 비우는 건 "상대 불일치로 캠페인별 후퇴"했을 때뿐이다.
    expect(await screen.findByText("확인됨")).toBeInTheDocument();
    expect(screen.getByText(/승인번호 3{24}/)).toBeInTheDocument();
  });

  /**
   * ⛔ 스캔에서 계산서를 못 본 건을 **「미수취」로 단정하지 않는다.**
   *
   * 실측(2026-08-06): 오너가 실물 매입 계산서를 제시한 건에 대해, 그 국세청 메일이 편지함
   * **15개 폴더 전수** 대조에서 발견되지 않았다 — 발행처가 이메일을 안 보냈거나 다른 주소로
   * 갔거나 삭제된 경우다. 즉 메일 커버리지는 100% 가 아니고, 스캔이 말할 수 있는 사실은
   * 「메일에 없다」까지다. 세무 신고 판단에 쓰는 화면에서 그 둘을 같은 말로 쓰면,
   * 실제로는 받은 계산서를 안 받았다고 읽게 된다.
   */
  it("메일에서 못 본 건을 미수취로 단정하지 않는다", async () => {
    mockBoardThenReceipts();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("확인됨공급사");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    expect(await screen.findByText("메일 없음")).toBeInTheDocument();
    expect(screen.getByText("미수취 단정 아님")).toBeInTheDocument();
    // 음성 대조군 — 단정형 문구가 되살아나면 실패한다.
    expect(screen.queryByText("미수취(스캔에 없음)")).not.toBeInTheDocument();
  });

  it("상한 초과·비밀번호 미해독 건수를 노출해 '전부 확인했다'는 오독을 막는다", async () => {
    mockBoardThenReceipts();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("확인됨공급사");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    expect(await screen.findByText(/상한에 걸려 이번 스캔에서 못 봤습니다/)).toBeInTheDocument();
    expect(screen.getByText(/비밀번호로 열지 못한 메일 1건/)).toBeInTheDocument();
    // 관문에서 걸러 **본문을 열지도 않은** 통수. 이 수치가 없던 탓에 화면이
    // 「필터가 먼저 버렸다」와 「폴더에 없다」를 구분하지 못했다(2026-08-05 실사고).
    // 기간을 늘릴수록 커지는 값이라 요약 문장 끝이 아니라 자기 줄에 세운다.
    expect(screen.getByText(/관문에서 걸러 본문을 열지도 않은 메일 8건/)).toBeInTheDocument();
  });

  it("어느 편지함 한 곳만 봤는지를 오독 없이 말한다(그 계정엔 편지함이 여럿이다)", async () => {
    mockBoardThenReceipts();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("확인됨공급사");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    const line = await screen.findByText(/「세금계산서」 편지함/);
    expect(line.textContent).toContain("한 곳만");
    expect(line.textContent).toContain("다른 편지함은 보지 않습니다");
    expect(line.textContent).toContain("최근 90일");
  });

  it("조회 기간을 고르면 그 값을 sinceDays 로 실어 보낸다(기본 90일 창 밖의 과거 건을 볼 수단)", async () => {
    mockBoardThenReceipts();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("확인됨공급사");

    fireEvent.click(screen.getByRole("combobox", { name: "메일함 조회 기간" }));
    fireEvent.click(await screen.findByRole("option", { name: "최근 365일(최대)" }));
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => {
      const receiptCall = fetchMock.mock.calls
        .map((call) => String(call[0]))
        .find((url) => url.includes("tax-invoice-receipts"));
      expect(receiptCall).toContain("sinceDays=365");
    });
  });

  it("선택한 기간과 결과의 기간이 다르면 결과가 낡았다고 알린다(선택만으로는 스캔이 돌지 않는다)", async () => {
    mockBoardThenReceipts();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("확인됨공급사");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));
    await screen.findByText(/「세금계산서」 편지함/);

    fireEvent.click(screen.getByRole("combobox", { name: "메일함 조회 기간" }));
    fireEvent.click(await screen.findByRole("option", { name: "최근 180일" }));

    expect(await screen.findByText(/이 결과는 90일 조회분입니다/)).toBeInTheDocument();
  });

  it("상한(365일)으로 조회한 결과에는 「그보다 과거는 이 도구로 확인할 수 없다」를 명시한다", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("tax-invoice-receipts")) {
        return {
          ok: true,
          json: async () => ({
            ...RECEIPT_SCAN_RESPONSE,
            scan: { ...RECEIPT_SCAN_RESPONSE.scan, sinceDays: 365 },
          }),
        } as Response;
      }
      return { ok: true, json: async () => BOARD_WITH_RECEIVE } as Response;
    }) as never;

    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("확인됨공급사");
    fireEvent.click(screen.getByRole("combobox", { name: "메일함 조회 기간" }));
    fireEvent.click(await screen.findByRole("option", { name: "최근 365일(최대)" }));
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    expect(
      await screen.findByText(/365일이 이 도구의 상한입니다/),
    ).toBeInTheDocument();
  });

  it("미수취 목록을 건수뿐 아니라 항목(상대·캠페인·금액)으로도 보여준다", async () => {
    mockBoardThenReceipts();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("확인됨공급사");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    await screen.findByText(/미수취 목록/);
    expect(screen.getByText(/미수취공급사/)).toBeInTheDocument();
    expect(screen.getByText(/딜U - 셀러U 1차/)).toBeInTheDocument();
  });

  it("첨부 형식 분포를 화면에서 읽을 수 있는 자리에 남긴다", async () => {
    mockBoardThenReceipts();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("확인됨공급사");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    await screen.findByText(/첨부 형식 분포/);
    expect(screen.getByText(/ETAX_XML: 1건/)).toBeInTheDocument();
  });

  it("스캔 실패는 삼키지 않고 오류를 표시한다", async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("tax-invoice-receipts")) {
        return { ok: false, status: 502, json: async () => ({ error: "메일함 조회에 실패했습니다." }) } as Response;
      }
      return { ok: true, json: async () => BOARD_WITH_RECEIVE } as Response;
    }) as never;

    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("확인됨공급사");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    expect(await screen.findByText("메일함 조회에 실패했습니다.")).toBeInTheDocument();
  });

  it("다이얼로그를 닫았다가 다시 열면 이전 스캔 결과를 들고 있지 않는다(새 스캔 전엔 오래된 확인 표시가 없다)", async () => {
    mockBoardThenReceipts();
    const { rerender } = render(
      <TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />,
    );
    await screen.findByText("확인됨공급사");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));
    await screen.findByText("확인됨");

    rerender(<TaxFilingDialog open={false} month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    rerender(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);

    await screen.findByText("확인됨공급사");
    await waitFor(() => expect(screen.queryByText("확인됨")).not.toBeInTheDocument());
  });
});

// 「홈택스 발행」(로컬 헬퍼) — 행 1건을 헬퍼로 보내 건별발급 폼을 채우는 경로.
// 지키는 계약: ① 버튼은 XLSX 체크박스와 같은 게이트(selectable && xlsxEligible,
// ISSUE 섹션 전용)에만 생긴다 — RECEIVE 행에 생기면 상대의 계산서를 중복 발행하게
// 된다. ② 페이로드는 XLSX 와 같은 API 의 format:"json" 에서 받고, 본문은 행의
// campaignIds(복수)다(그룹 부분 전송 방지 — XLSX 경로와 같은 이유). ③ 헬퍼가
// 꺼져 있으면(health false) 발행 데이터를 아예 만들지 않는다.
describe("세무 처리 다이얼로그 — 홈택스 발행(로컬 헬퍼)", () => {
  const HELPER_INVOICE = { invoiceType: "01", totalSupplyAmount: 1000000 };

  beforeEach(() => {
    helperHealthMock.mockClear();
    helperHealthMock.mockResolvedValue(true);
    helperIssueMock.mockClear();
    helperIssueMock.mockResolvedValue({ status: "FILLED" });
    helperWakeMock.mockClear();
    helperWaitMock.mockClear();
    helperWaitMock.mockResolvedValue(true);
    helperLoginWaitMock.mockClear();
    helperLoginWaitMock.mockResolvedValue(true);
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/settlement/tax-invoice") && init?.method === "POST") {
        return { ok: true, json: async () => ({ rows: [HELPER_INVOICE] }) } as Response;
      }
      return { ok: true, json: async () => BOARD } as Response;
    }) as never;
  });

  it("버튼은 발행(ISSUE)·선택 가능 행에만 생긴다", async () => {
    renderDialog();
    await screen.findByText("○○커머스");
    // BOARD 에서 selectable && xlsxEligible 인 행은 c1 하나뿐이다 — 결번(c2·c3)과
    // RECEIVE(c4)에는 버튼이 없어야 한다.
    expect(screen.getAllByRole("button", { name: "홈택스 발행" })).toHaveLength(1);
  });

  it("클릭하면 같은 API(format:json)에서 행의 campaignIds 로 페이로드를 받아 헬퍼로 보낸다", async () => {
    renderDialog();
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "홈택스 발행" }));

    await waitFor(() => expect(helperIssueMock).toHaveBeenCalledTimes(1));
    expect(helperIssueMock).toHaveBeenCalledWith(HELPER_INVOICE);

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const postCall = fetchMock.mock.calls.find(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      campaignIds: ["c1"],
      format: "json",
    });
  });

  it("헬퍼가 켜져 있으면 깨우지 않는다 — 스킴을 매번 열면 확인창·재기동이 소음이 된다", async () => {
    renderDialog();
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "홈택스 발행" }));

    await waitFor(() => expect(helperIssueMock).toHaveBeenCalledTimes(1));
    expect(helperWakeMock).not.toHaveBeenCalled();
  });

  it("헬퍼가 꺼져 있으면 URL 스킴으로 깨운 뒤 기다렸다가 이어서 보낸다", async () => {
    // 온디맨드 전환의 핵심 경로다 — 헬퍼는 유휴 시 스스로 내려가므로, 꺼져 있는 것이
    // **정상 상태**이고 버튼 한 번으로 깨어나 발행까지 이어져야 한다.
    helperHealthMock.mockResolvedValueOnce(false);
    renderDialog();
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "홈택스 발행" }));

    await waitFor(() => expect(helperIssueMock).toHaveBeenCalledTimes(1));
    expect(helperWakeMock).toHaveBeenCalledTimes(1);
    expect(helperWaitMock).toHaveBeenCalledTimes(1);
  });

  it("로그인이 필요하면 기다렸다가 **자동으로 이어서** 다시 보낸다", async () => {
    // 오너가 인증서 비밀번호를 누르는 동안 기다렸다가 재개하는 경로. 이것이 없으면
    // 오너가 로그인을 끝낸 뒤 버튼을 한 번 더 눌러야 한다.
    helperIssueMock
      .mockResolvedValueOnce({ status: "NEED_LOGIN" } as never)
      .mockResolvedValueOnce({ status: "FILLED" });
    renderDialog();
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "홈택스 발행" }));

    await waitFor(() => expect(helperIssueMock).toHaveBeenCalledTimes(2));
    expect(helperLoginWaitMock).toHaveBeenCalledTimes(1);
  });

  it("⛔ 로그인 대기는 발행을 반복해서 쏘는 방식이 아니다 — 대기 실패면 재시도하지 않는다", async () => {
    // 재시도로 기다리면 매번 로그인 단계를 다시 클릭해 **오너가 누르던 인증서 창이
    // 초기화된다.** 그래서 대기는 읽기 전용 조회로 하고, 실패하면 그냥 멈춘다.
    helperIssueMock.mockResolvedValue({ status: "NEED_LOGIN" } as never);
    helperLoginWaitMock.mockResolvedValue(false);
    renderDialog();
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "홈택스 발행" }));

    await waitFor(() => expect(helperLoginWaitMock).toHaveBeenCalledTimes(1));
    expect(helperIssueMock).toHaveBeenCalledTimes(1);
  });

  it("로그인 후에도 다시 NEED_LOGIN 이면 한 번만 재시도하고 멈춘다", async () => {
    helperIssueMock.mockResolvedValue({ status: "NEED_LOGIN" } as never);
    renderDialog();
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "홈택스 발행" }));

    await waitFor(() => expect(helperIssueMock).toHaveBeenCalledTimes(2));
    // 무한 재시도 금지 — 반복해서 쏘면 오너 창만 계속 흔든다.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(helperIssueMock).toHaveBeenCalledTimes(2);
  });

  it("깨우기가 실패하면(스킴 미설치 등) 발행 데이터를 만들지 않는다", async () => {
    helperHealthMock.mockResolvedValue(false);
    helperWaitMock.mockResolvedValue(false);
    renderDialog();
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "홈택스 발행" }));

    await waitFor(() => expect(helperWaitMock).toHaveBeenCalledTimes(1));
    expect(helperIssueMock).not.toHaveBeenCalled();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const postCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// 자동 확정 표식 — 사람이 눌렀는지 크론이 찍었는지를 구분한다
// ─────────────────────────────────────────────────────────────
//
// 발행 자동 확정 크론(`api/cron/tax-invoice-issue-confirm`)이 발행일을 찍으면 그 의무는
// 보드 행에서 통째로 사라진다(`tax-filing-board.ts` 의 "이미 처리됨 — 행을 만들지
// 않는다"). 그 규칙은 완료의 주체가 오너 한 사람일 때 세운 것이라, 크론이 두 번째
// 주체가 된 뒤로는 **오너가 확인하지 않은 건을 확인했다고 믿게 되는 자리**가 됐다.
// 이 묶음이 그 사각을 메운다.

describe("세무 처리 다이얼로그 — 자동 확정 표식", () => {
  const ENTRY = {
    key: "supplierInvoiceIssuedAt|2026-07-31|문장",
    sourceField: "supplierInvoiceIssuedAt" as const,
    fieldLabel: "공급사/셀러몰 계산서 발행일",
    writtenDate: "2026-07-31",
    confirmedAt: "2026-08-06T01:00:00.000Z",
    campaignLabels: ["딜A - 셀러1 1차", "딜B - 셀러1 2차"],
    detail: "메일 자동 확정 — 공급사/셀러몰 계산서 발행일을 2026-07-31로 기록했습니다(계산서 1장).",
    tolerated: false,
  };
  const TOLERATED = {
    ...ENTRY,
    key: "sellerInvoiceIssuedAt|2026-07-28|흡수",
    sourceField: "sellerInvoiceIssuedAt" as const,
    fieldLabel: "셀러 계산서 발행일",
    campaignLabels: ["딜C - 셀러2 1차"],
    detail: "메일 자동 확정 — 셀러 계산서 발행일을 2026-07-28로 기록했습니다(허용오차 12원 흡수).",
    tolerated: true,
  };

  function renderWith(autoConfirmed: unknown[]) {
    const board = { ...BOARD, autoConfirmed };
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => board }) as Response) as never;
    return render(
      <TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />,
    );
  }

  it("접힌 상태는 요약 한 줄이다 — 오너가 고른 형태(①)이고, 보드 행 수를 늘리지 않는다", async () => {
    renderWith([ENTRY]);
    expect(await screen.findByText(/자동 확정됨 1건/)).toBeInTheDocument();
    expect(screen.getByText("자동 확정")).toBeInTheDocument();
    expect(screen.getByText(/공급사\/셀러몰 계산서 발행일 2026-07-31/)).toBeInTheDocument();
  });

  it("요약 줄이 조회 기간을 밝힌다 — 기간을 말하지 않으면 N 이 무엇의 개수인지 알 수 없다", async () => {
    // 라우트가 seed 조회에 기간 컷을 걸고 있다(없으면 이 카운터가 영구 누적이 된다 —
    // 보드 캠페인 집합이 단조 증가하기 때문). 화면이 그 창을 말하지 않으면 오너는 이
    // 숫자를 「이번 달 자동 확정」으로 읽는다. 라벨과 컷은 같은 상수에서 나온다.
    renderWith([ENTRY]);
    expect(
      await screen.findByText(`${AUTO_CONFIRM_SEED_LOOKBACK_LABEL} 자동 확정됨 1건`, {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(AUTO_CONFIRM_SEED_LOOKBACK_LABEL).toBe("최근 90일");
  });

  it("허용오차 흡수 건은 요약 줄에서 따로 센다 — 완전 일치와 뭉개면 조용한 완화가 된다", async () => {
    renderWith([ENTRY, TOLERATED]);
    expect(await screen.findByText(/자동 확정됨 2건/)).toBeInTheDocument();
    expect(screen.getByText(/허용오차 흡수 1건/)).toBeInTheDocument();
    expect(screen.getByText("허용오차 흡수")).toBeInTheDocument();
  });

  it("흡수 건이 없으면 흡수 카운트를 띄우지 않는다 — 0 을 굳이 보여주지 않는다", async () => {
    renderWith([ENTRY]);
    await screen.findByText(/자동 확정됨 1건/);
    expect(screen.queryByText(/허용오차 흡수/)).not.toBeInTheDocument();
  });

  it("판정 근거(승인번호·장수)를 크론이 만든 문장 그대로 싣는다 — 화면에서 다시 조립하지 않는다", async () => {
    renderWith([ENTRY]);
    expect(await screen.findByText(ENTRY.detail)).toBeInTheDocument();
  });

  it("그룹 확정은 한 줄이고 걸린 캠페인 수를 밝힌다", async () => {
    renderWith([ENTRY]);
    expect(await screen.findByText(/딜A - 셀러1 1차 외 1건/)).toBeInTheDocument();
  });

  it("되돌리는 경로를 알려준다 — 표식만 있고 처방이 없으면 오너가 무엇을 할지 모른다", async () => {
    renderWith([ENTRY]);
    expect(await screen.findByText(/발행 완료 체크를 해제/)).toBeInTheDocument();
  });

  it("⛔ 자동 확정 건을 「발행」 목록에 행으로 되살리지 않는다 — 「홈택스 발행」이 붙으면 중복 발행 경로가 된다", async () => {
    renderWith([ENTRY]);
    await screen.findByText(/자동 확정됨 1건/);
    // BOARD 의 ISSUE 행은 c1 하나뿐이다. 자동 확정 1건이 표에 섞여 들어오면 이 수가 는다.
    expect(screen.getAllByRole("button", { name: "홈택스 발행" })).toHaveLength(1);
  });

  it("자동 확정이 없으면 묶음 자체를 그리지 않는다 — 빈 섹션은 노이즈다", async () => {
    renderWith([]);
    await screen.findByText("○○커머스");
    expect(screen.queryByText(/자동 확정됨/)).not.toBeInTheDocument();
  });

  it("낡은 응답(필드 자체가 없음)에도 깨지지 않는다", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => BOARD }) as Response) as never;
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    expect(await screen.findByText("○○커머스")).toBeInTheDocument();
    expect(screen.queryByText(/자동 확정됨/)).not.toBeInTheDocument();
  });
});

/**
 * 그룹 계산서 **유사도 승인 카드**(설계 2026-08-12).
 *
 * 이 카드가 지키는 계약 셋 —
 * ①금액 차이를 **숫자로** 보여준다(「확인 필요」 한 마디로 끝내지 않는다)
 * ②승인은 결정 라우트로 나가고 대상 key 를 담는다(그룹은 대표 키 1개 = 계산서 1장)
 * ③판정 불가 신호를 불일치와 같은 기호로 그리지 않는다.
 */
describe("TaxFilingDialog — 계산서 유사도 승인 카드", () => {
  const SUGGESTION_SCAN = {
    scan: { box: "세금계산서", headerScanned: 3, candidates: 1, skippedByFilter: 0, truncated: 0, sinceDays: 90 },
    summary: {
      verified: 0,
      needsReview: 1,
      notOurs: 0,
      issuedByUs: 0,
      expectedTotal: 1,
      unseenExpected: 0,
      passwordProtected: 0,
      attachmentCensus: {},
      decided: 0,
      suggested: 1,
    },
    results: [
      {
        mail: { uid: 9, subject: "세금계산서", fromAddress: "c@example.com", receivedAt: "2026-07-31", hasAttachmentEvidence: true },
        decision: null,
        suggestion: {
          key: "campAnchor:SELLER_COMMISSION",
          campaignId: "campAnchor",
          campaignLabel: "여름기획 3차 외 2건",
          slot: "SELLER_COMMISSION",
          counterpartLabel: "블루버드컴퍼니",
          trackingField: "sellerInvoiceIssuedAt",
          signals: [
            { kind: "WRITTEN_DATE", result: "MATCH", detail: "작성일자가 정산 기간 안" },
            { kind: "CAMPAIGN_NAME", result: "MATCH", detail: "품목명과 캠페인명 일치" },
            // 판정 불가 — 불일치(X)와 다른 기호로 그려야 한다.
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
          matchedKey: "campAnchor:SELLER_COMMISSION",
          candidateKeys: ["campAnchor:SELLER_COMMISSION"],
          reasons: [{ code: "AMOUNT_MISMATCH", message: "금액이 다릅니다." }],
          observed: {
            issueId: "9".repeat(24),
            writtenDate: "2026-07-31",
            counterpartBusinessNumber: "1112233333",
            totalAmount: 5489000,
            expectedTotalAmount: 5500000,
            amountDelta: -11000,
          },
        },
      },
    ],
    unseenExpected: [],
  };

  function mockScan(scan: unknown = SUGGESTION_SCAN) {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("tax-invoice-receipts")) {
        return { ok: true, json: async () => scan } as Response;
      }
      return { ok: true, json: async () => BOARD } as Response;
    }) as never;
  }

  it("차이 금액과 판정 근거를 숫자로 보여준다", async () => {
    mockScan();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    // 본문은 문장이 아니라 key-value 표다(ss-pattern detail-card) — 대조해야 하는
    // 두 금액이 줄바꿈에 갈리지 않게.
    expect(await screen.findByText("5,500,000원")).toBeInTheDocument();
    expect(screen.getByText("5,489,000원")).toBeInTheDocument();
    expect(screen.getByText("-11,000원")).toBeInTheDocument();
    // 판정 불가는 불일치(X)가 아니라 `-` 로 그린다 — 같은 칸에 두면 오너가 "셀러명이
    // 다르다"로 읽는데, 실제로는 "확인할 수 없었다"이다.
    expect(screen.getByText(/셀러명 - ·/)).toBeInTheDocument();
  });

  it("승인하면 결정 라우트로 대상 key 와 작성일자를 보낸다", async () => {
    mockScan();
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));
    fireEvent.click(await screen.findByRole("button", { name: "승인" }));

    await waitFor(() => {
      const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/decision"));
      expect(call).toBeTruthy();
      const body = JSON.parse(String((call?.[1] as RequestInit).body));
      expect(body.action).toBe("approve");
      // 그룹은 계산서 1장이므로 대표 키 하나만 간다.
      expect(body.targetKeys).toEqual(["campAnchor:SELLER_COMMISSION"]);
      // 수취일시에는 오늘이 아니라 **계산서 작성일자**가 실린다.
      expect(body.writtenDate).toBe("2026-07-31");
    });
  });

  it("결정된 건은 되돌리기만 보여준다", async () => {
    mockScan({
      ...SUGGESTION_SCAN,
      results: [
        {
          ...SUGGESTION_SCAN.results[0],
          suggestion: null,
          decision: {
            decision: "APPROVED",
            matchedKeys: ["campAnchor:SELLER_COMMISSION"],
            amountDelta: -11000,
            decidedAt: "2026-08-12T00:00:00.000Z",
          },
        },
      ],
    });
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    expect(await screen.findByText("승인됨")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "되돌리기" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "승인" })).not.toBeInTheDocument();
  });

  /**
   * ⛔ 작성일자를 못 읽은 계산서는 **승인 버튼 자체를 막는다.**
   *
   * 교차 검증에서 잡힌 결함(2026-08-12): 이름 두 신호만 맞아도 제안이 뜨는데, 승인하면
   * 서버가 결정 행만 남기고 수취일시는 못 써서 화면은 「승인됨」인데 정산 SoT 는 미수취인
   * 상태가 굳었다. 서버는 이제 422 로 거부하고, 화면은 누르기 전에 이유를 말한다.
   */
  it("작성일자를 읽지 못한 건은 승인 버튼을 막고 이유를 말한다", async () => {
    const row = SUGGESTION_SCAN.results[0];
    mockScan({
      ...SUGGESTION_SCAN,
      results: [
        {
          ...row,
          verdict: { ...row.verdict, observed: { ...row.verdict.observed, writtenDate: null } },
        },
      ],
    });
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    expect(await screen.findByText(/작성일자를 읽지 못해 자동 기록할 수 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "승인" })).toBeDisabled();
    // 무관 처리는 여전히 가능해야 한다 — 막힌 것은 기록이지 판단이 아니다.
    expect(screen.getByRole("button", { name: "무관" })).not.toBeDisabled();
  });

  it("제안이 없는 낡은 응답에서는 카드를 그리지 않는다", async () => {
    mockScan({
      ...SUGGESTION_SCAN,
      results: [{ mail: SUGGESTION_SCAN.results[0].mail, verdict: SUGGESTION_SCAN.results[0].verdict }],
    });
    render(<TaxFilingDialog open month="2026-07" onOpenChange={() => {}} onMonthChange={() => {}} />);
    await screen.findByText("○○커머스");
    fireEvent.click(screen.getByRole("button", { name: "메일함에서 확인" }));

    await waitFor(() => {
      expect(screen.queryByText(/계산서로 추정됩니다/)).not.toBeInTheDocument();
    });
  });
});
