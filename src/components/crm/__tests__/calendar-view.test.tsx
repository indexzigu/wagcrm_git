import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { CalendarView, type CalendarCampaign } from "../calendar-view";

function campaign(over: Partial<CalendarCampaign> & { id: string }): CalendarCampaign {
  return {
    dealName: `딜-${over.id}`,
    sellerName: "가온",
    sellerId: "s1",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-05T00:00:00.000Z",
    status: "ACTIVE",
    ...over,
  } as CalendarCampaign;
}

function conflictBarCount(container: HTMLElement): number {
  // 충돌 링은 하드코딩 red에서 시맨틱 토큰으로 이관됨(ring-status-urgent/50).
  return container.querySelectorAll('[class*="ring-status-urgent"]').length;
}

describe("CalendarView 일정 충돌 감지 (CG-3 그룹 억제)", () => {
  it("같은 셀러의 겹치는 무그룹 캠페인은 충돌로 표시한다", () => {
    const { container } = render(
      <CalendarView
        month="2026-07"
        campaigns={[campaign({ id: "a" }), campaign({ id: "b" })]}
      />,
    );
    expect(conflictBarCount(container)).toBeGreaterThan(0);
  });

  it("같은 그룹(조합 캠페인) 멤버끼리는 충돌로 표시하지 않는다", () => {
    const { container } = render(
      <CalendarView
        month="2026-07"
        campaigns={[
          campaign({ id: "a", groupId: "g1" }),
          campaign({ id: "b", groupId: "g1" }),
        ]}
      />,
    );
    expect(conflictBarCount(container)).toBe(0);
  });

  it("그룹이 서로 다르면 겹칠 때 여전히 충돌이다", () => {
    const { container } = render(
      <CalendarView
        month="2026-07"
        campaigns={[
          campaign({ id: "a", groupId: "g1" }),
          campaign({ id: "b", groupId: "g2" }),
        ]}
      />,
    );
    expect(conflictBarCount(container)).toBeGreaterThan(0);
  });

  it("그룹 멤버와 무그룹 캠페인이 겹치면 충돌이다", () => {
    const { container } = render(
      <CalendarView
        month="2026-07"
        campaigns={[
          campaign({ id: "a", groupId: "g1" }),
          campaign({ id: "b", groupId: null }),
        ]}
      />,
    );
    expect(conflictBarCount(container)).toBeGreaterThan(0);
  });
});

describe("CalendarView 그룹 병합 (A-1 핵심)", () => {
  it("같은 그룹 멤버 2건 이상은 그룹 바 1개로 병합하고 개별 딜은 따로 렌더하지 않는다", () => {
    const { queryByText, getAllByText } = render(
      <CalendarView
        month="2026-07"
        campaigns={[
          campaign({ id: "a", groupId: "g1", dealName: "비타슈넬", sellerName: "별이" }),
          campaign({ id: "b", groupId: "g1", dealName: "칼마디", sellerName: "별이" }),
        ]}
      />,
    );
    // 그룹 라벨(대표딜 외 N · 셀러)로 병합 — "외 1"이 노출된다
    expect(getAllByText(/외 1 · 별이/).length).toBeGreaterThan(0);
    // 흡수된 멤버(칼마디)는 개별 바로 렌더되지 않는다
    expect(queryByText(/^칼마디$/)).toBeNull();
  });
});

describe("CalendarView 스팬바 가로 기하 (컨테이너 넘침 방지)", () => {
  /** "calc(57.1429% + 2px)" · "42.8571%" → { pct, px } */
  function parseLength(value: string): { pct: number; px: number } {
    const pct = /(-?[\d.]+)%/.exec(value);
    const px = /([+-])\s*([\d.]+)px/.exec(value);
    return {
      pct: pct ? Number.parseFloat(pct[1]) : 0,
      px: px ? (px[1] === "-" ? -1 : 1) * Number.parseFloat(px[2]) : 0,
    };
  }

  function spanBars(container: HTMLElement): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[class*="pointer-events-auto"][class*="absolute"]',
      ),
    );
  }

  // 마지막 열(토요일)까지 닿는 바 — 넘침이 발생하는 유일한 구간이다.
  function renderFullWeek() {
    return render(
      <CalendarView
        month="2026-07"
        campaigns={[
          campaign({
            id: "full",
            startDate: "2026-07-05T00:00:00.000Z",
            endDate: "2026-07-11T00:00:00.000Z",
          }),
        ]}
      />,
    );
  }

  it("좌우 거터를 margin 으로 주지 않는다 — % 폭에 더해져 마지막 열에서 컨테이너를 넘친다", () => {
    const { container } = renderFullWeek();
    const bars = spanBars(container);
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.className).not.toMatch(/(^|\s)m[xlr]-/);
    }
  });

  /**
   * 자금 마커 서브로우는 최대 3개 + "+N" 을 한 줄에 담는데, 자식이 전부
   * shrink-0 이고 행에 넘침 차단이 없었다. 좁은 폭에서 3개+"+N"(약 58px)이
   * 셀 내용 폭(375px 뷰포트 기준 37px)을 넘으면 **옆 날짜 칸으로 흘러나가**
   * 마커가 다른 날짜에 달린 것처럼 보였다(실측: 셀 밖 15px, 부모 밖 21.42px).
   */
  function renderOverflowingMarkers() {
    // 같은 날짜에 입금 예정 4건 → 표시 3 + "+1"
    return render(
      <CalendarView
        month="2026-07"
        campaigns={["m1", "m2", "m3", "m4"].map((id) =>
          campaign({
            id,
            expectedDepositDate: "2026-07-15T00:00:00.000Z",
          }),
        )}
      />,
    );
  }

  it("자금 마커가 4건이면 3개 + \"+1\" 로 접힌다 (픽스처 전제 확인)", () => {
    const { getByText } = renderOverflowingMarkers();
    expect(getByText("+1")).toBeTruthy();
  });

  it("자금 마커 행은 넘침을 가둬 옆 날짜 칸을 침범하지 않는다", () => {
    const { getByText } = renderOverflowingMarkers();
    const row = getByText("+1").closest("div.flex");
    expect(row).toBeTruthy();
    expect(row!.className).toMatch(/overflow-hidden/);
  });

  it("\"+N\" 은 shrink-0 이라 마커에 밀려 사라지지 않는다", () => {
    const { getByText } = renderOverflowingMarkers();
    expect(getByText("+1").className).toMatch(/shrink-0/);
  });

  it("바의 오른쪽 끝이 트랙(100%)을 넘지 않는다", () => {
    const { container } = renderFullWeek();
    const bars = spanBars(container);
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      const left = parseLength(bar.style.left);
      const width = parseLength(bar.style.width);
      // 백분율 합이 100 을 넘지 않고, px 보정도 안쪽(≤0)이어야 한다.
      expect(left.pct + width.pct).toBeLessThanOrEqual(100 + 1e-6);
      expect(left.px + width.px).toBeLessThanOrEqual(0);
    }
  });
});

describe("CalendarView 조합 팝오버 대금 금액 (멤버 합산)", () => {
  /**
   * 조합 캠페인의 정산 금액은 **딜 고유 값**이라 그룹 스칼라가 없다(CG-1 정산 방화벽 —
   * `CampaignGroup` 에 `settlementSales`·`actualPayoutAmount` 컬럼 자체가 없다). 날짜·
   * 플래그처럼 dual-read 로 멤버에 복사되지도 않으므로 **대표 멤버 한 명을 읽으면
   * 3인 조합이 1/3 만 보인다.** 모바일(`mobile-calendar-groups`)·대시보드 지연 정산
   * (`agenda-settlements`)이 이미 합산 규약이므로 같은 조합의 같은 칸이 표면마다 다른
   * 숫자로 뜨던 것을 고정한다.
   */
  function member(id: string, deposit: number, payout: number): CalendarCampaign {
    return campaign({
      id,
      groupId: "g1",
      dealName: id === "m1" ? "비타슈넬" : `딜-${id}`,
      sellerName: "가온",
      // 한 주(7/12~7/18) 안에 들어가는 기간 — 스팬바가 주 경계로 쪼개지지 않아야
      // 트리거가 정확히 1개다.
      startDate: "2026-07-13T00:00:00.000Z",
      endDate: "2026-07-17T00:00:00.000Z",
      // 브랜드몰 = 입금(공급사, 영업수익) + 지급(셀러, 실지급액) — 두 칸 모두 금액이
      // 있는 유일한 채널이라 「합산」을 검증하기에 맞다. 셀러몰 지급은 공급사 물품대금
      // 이라 정의상 「미정」이다(캠페인 단위 값이 아님).
      salesChannel: "BRAND_MALL",
      expectedDepositDate: "2026-07-15T00:00:00.000Z",
      expectedPayoutDate: "2026-07-20T00:00:00.000Z",
      settlementSales: deposit,
      actualPayoutAmount: payout,
    });
  }

  async function openGroupPopover() {
    render(
      <CalendarView
        month="2026-07"
        campaigns={[
          member("m1", 100_000, 10_000),
          member("m2", 200_000, 20_000),
          member("m3", 300_000, 30_000),
        ]}
      />,
    );
    await userEvent.click(screen.getByTitle("비타슈넬 외 2 · 가온"));
  }

  it("3인 조합의 입금 금액은 멤버 합이다", async () => {
    await openGroupPopover();
    expect(await screen.findByText("₩600,000")).toBeTruthy();
  });

  it("3인 조합의 지급 금액은 멤버 합이다", async () => {
    await openGroupPopover();
    expect(await screen.findByText("₩60,000")).toBeTruthy();
  });

  it("대표 멤버 한 명의 금액을 그대로 쓰지 않는다", async () => {
    await openGroupPopover();
    await screen.findByText("₩600,000");
    expect(screen.queryByText("₩100,000")).toBeNull();
  });
});

describe("CalendarView 조합 자금 마커 (도트도 조합당 1개)", () => {
  /**
   * 조합의 입금은 실세계에서 **한 번** 일어나는 사건인데, 마커만 원본 캠페인 배열을
   * 순회해서 3인 조합이 도트 3개로 흩어졌다(바는 이미 그룹 1개였다). 밀도 손해가
   * 실제 판단을 가린다 — 마커 3개 초과 시 「+N」으로 접히므로 한 조합이 그 예산을
   * 혼자 써 버리면 **다른 날짜 건이 안 보인다.**
   */
  function member(id: string, deposit: number): CalendarCampaign {
    return campaign({
      id,
      groupId: "g1",
      dealName: id === "m1" ? "대표딜" : `딜-${id}`,
      sellerName: "가온",
      startDate: "2026-07-13T00:00:00.000Z",
      endDate: "2026-07-17T00:00:00.000Z",
      salesChannel: "SELLER_MALL",
      expectedDepositDate: "2026-07-15T00:00:00.000Z",
      // 셀러몰 입금 = 매출 − 셀러수수료(의무표 기준) → 멤버 입금액이 `deposit` 이 된다.
      actualSales: deposit + 50_000,
      sellerExpense: 50_000,
    });
  }

  function trio() {
    return [member("m1", 100_000), member("m2", 200_000), member("m3", 300_000)];
  }

  function depositMarkers() {
    return screen.getAllByLabelText(/입금\(셀러\)/);
  }

  it("3인 조합의 공유 입금일에는 도트가 하나만 선다", () => {
    render(<CalendarView month="2026-07" campaigns={trio()} />);
    expect(depositMarkers()).toHaveLength(1);
  });

  it("도트 라벨이 조합 하나를 가리킨다 — 멤버 딜명으로 흩어지지 않는다", () => {
    render(<CalendarView month="2026-07" campaigns={trio()} />);
    expect(depositMarkers()[0].getAttribute("aria-label")).toContain("대표딜 외 2");
  });

  it("「+N」 접힘 예산을 한 조합이 혼자 쓰지 않는다", () => {
    // 조합 3인 + 무그룹 2건이 같은 날. 접기 전에는 5건이라 3개 + "+2" 였다.
    render(
      <CalendarView
        month="2026-07"
        campaigns={[
          ...trio(),
          campaign({ id: "solo1", expectedDepositDate: "2026-07-15T00:00:00.000Z" }),
          campaign({ id: "solo2", expectedDepositDate: "2026-07-15T00:00:00.000Z" }),
        ]}
      />,
    );
    expect(depositMarkers()).toHaveLength(3);
    expect(screen.queryByText("+2")).toBeNull();
  });

  it("조합 도트를 누르면 조합 상세가 열린다 — 멤버 한 건이 아니다", async () => {
    render(<CalendarView month="2026-07" campaigns={trio()} />);
    await userEvent.click(depositMarkers()[0]);
    expect(await screen.findByText("조합 3건")).toBeTruthy();
    expect(await screen.findByText("₩600,000")).toBeTruthy();
  });
});

describe("CalendarView 조합 팝오버 폭 (진입 경로 무관)", () => {
  /**
   * 같은 `GroupPopoverContent` 인데 바에서 열면 w-80, 마커에서 열면 w-72 로 갈리면
   * 멤버 목록·대금 줄의 줄바꿈이 진입 경로에 따라 달라진다. 폭은 **콘텐츠가 정하지
   * 트리거가 정하지 않는다** — 바 쪽이 이미 그 규칙(`kind === "group" ? w-80 : w-72`)을
   * 쓰고 있으므로 마커도 같은 규칙을 상속한다.
   */
  it("조합 마커에서 연 팝오버도 바에서 연 것과 같은 폭이다", async () => {
    render(
      <CalendarView
        month="2026-07"
        campaigns={["g1", "g2", "g3"].map((id) =>
          campaign({
            id,
            groupId: "grp",
            sellerName: "가온",
            startDate: "2026-07-13T00:00:00.000Z",
            endDate: "2026-07-17T00:00:00.000Z",
            salesChannel: "SELLER_MALL",
            expectedDepositDate: "2026-07-15T00:00:00.000Z",
            actualSales: 150_000,
            sellerExpense: 50_000,
          }),
        )}
      />,
    );
    await userEvent.click(screen.getAllByLabelText(/입금\(셀러\)/)[0]);
    const popover = await screen.findByRole("dialog");
    expect(popover.className).toMatch(/\bw-80\b/);
  });
});

describe("CalendarView 팝오버 대금 날짜 (완료면 실제일)", () => {
  /**
   * 오너 지적 2026-07-15 — 완료된 칸은 예정일이 아니라 **실제로 오간 날**을 말해야 한다.
   * 도트가 옮겨간 자리에서 팝오버만 예정일을 계속 말하면 같은 화면 안에서 두 날짜가
   * 어긋난다(판정 SSOT: `resolveMoneySlotEffectiveDate`).
   */
  function paidMember(id: string): CalendarCampaign {
    return campaign({
      id,
      dealName: "비타슈넬",
      startDate: "2026-07-13T00:00:00.000Z",
      endDate: "2026-07-17T00:00:00.000Z",
      salesChannel: "BRAND_MALL",
      expectedPayoutDate: "2026-07-20T00:00:00.000Z",
      payoutCompletedAt: "2026-07-15T00:00:00.000Z",
      isPayoutCompleted: true,
      settlementSales: 100_000,
      actualPayoutAmount: 10_000,
    });
  }

  it("캠페인 팝오버가 실제 지급일을 말한다", async () => {
    render(<CalendarView month="2026-07" campaigns={[paidMember("solo")]} />);
    await userEvent.click(screen.getByTitle("비타슈넬 · 가온"));

    expect(await screen.findByText("26-07-15")).toBeTruthy();
    expect(screen.queryByText("26-07-20")).toBeNull();
  });

  it("조합 팝오버도 같은 규칙이다", async () => {
    render(
      <CalendarView
        month="2026-07"
        campaigns={[
          { ...paidMember("m1"), groupId: "g1" },
          { ...paidMember("m2"), groupId: "g1", dealName: "딜-m2" },
        ]}
      />,
    );
    await userEvent.click(screen.getByTitle("비타슈넬 외 1 · 가온"));

    expect(await screen.findByText("26-07-15")).toBeTruthy();
    expect(screen.queryByText("26-07-20")).toBeNull();
  });
});
