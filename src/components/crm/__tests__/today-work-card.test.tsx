// @vitest-environment jsdom
/**
 * 홈 「오늘 처리할 일」 카드 — 표시 계약.
 *
 * 행 = 라벨(좌) · 건수 배지(우, 심각도 색) · 행 전체가 그 일을 처리하는 화면으로 가는 링크.
 * 전부 0건이면 한 줄 「오늘 처리할 일이 없습니다」로 접힌다. 단, 주문 동기화가 낡았거나 없으면
 * 「없다」고 말하지 않는다(0 을 믿을 수 없다 — 종전 「오늘 처리할 주문」 카드 규칙 승계).
 * 원천 하나라도 불러오지 못하면 빈 상태로 위장하지 않고 오류와 다시 불러오기를 낸다.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TodayWorkCard } from "../today-work-card";
import type { TodayWorkRow } from "@/lib/today-work";

const rows: TodayWorkRow[] = [
  { key: "orders-pending", label: "발주 대기", count: 12, tone: "caution", href: "/order-converter", detail: "결제 후 2일 이상 5건" },
  { key: "settlement-delayed", label: "지연된 정산", count: 1, tone: "urgent", href: "/settlement?campaign=c-1", detail: null },
  { key: "approvals-pending", label: "승인대기", count: 3, tone: "info", href: "/approvals", detail: null },
];

const fresh = { kind: "fresh" as const, label: "10분 전" };

describe("TodayWorkCard", () => {
  it("행마다 그 일을 처리하는 화면으로 가는 링크 하나 — 라벨과 건수가 이름이다", () => {
    render(<TodayWorkCard rows={rows} loading={false} failedSources={[]} onRetry={() => {}} orderSync={fresh} />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/order-converter", "/settlement?campaign=c-1", "/approvals"]);
    expect(links[0]).toHaveAccessibleName(expect.stringContaining("발주 대기"));
    expect(links[0]).toHaveAccessibleName(expect.stringContaining("12"));
  });

  it("건수 배지는 심각도 색을 탄다 — 위험·주의·정보", () => {
    render(<TodayWorkCard rows={rows} loading={false} failedSources={[]} onRetry={() => {}} orderSync={fresh} />);
    const count = (label: string) =>
      within(screen.getByText(label).closest("a")!).getByText(/^\d[\d,]*$/, { selector: '[data-slot="today-work-count"]' });
    expect(count("발주 대기")).toHaveClass("text-status-caution-text");
    expect(count("지연된 정산")).toHaveClass("text-status-urgent-text");
    expect(count("승인대기")).toHaveClass("text-status-info");
  });

  it("세부 한 줄은 그 행의 심각도 글자색으로 말한다", () => {
    render(<TodayWorkCard rows={rows} loading={false} failedSources={[]} onRetry={() => {}} orderSync={fresh} />);
    expect(screen.getByText("결제 후 2일 이상 5건")).toHaveClass("text-status-caution-text");
  });

  it("전부 0건이면 한 줄 「오늘 처리할 일이 없습니다」로 접힌다(행·링크 없음)", () => {
    render(<TodayWorkCard rows={[]} loading={false} failedSources={[]} onRetry={() => {}} orderSync={fresh} />);
    expect(screen.getByText("오늘 처리할 일이 없습니다")).toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("주문 동기화가 낡았으면 0건이어도 「없다」고 하지 않고 「주문 확인불가」를 주의색으로 낸다", () => {
    render(
      <TodayWorkCard rows={[]} loading={false} failedSources={[]} onRetry={() => {}} orderSync={{ kind: "stale", daysAgo: 2 }} />,
    );
    expect(screen.queryByText("오늘 처리할 일이 없습니다")).not.toBeInTheDocument();
    const flag = screen.getByText("주문 확인불가").parentElement!;
    expect(flag).toHaveClass("text-status-caution-text");
    expect(screen.getByText("마지막 동기화 2일 전")).toHaveClass("text-status-caution-text");
  });

  it("주문 스냅샷이 없으면 「주문 동기화대기」 — 「없다」고 하지 않는다", () => {
    render(<TodayWorkCard rows={[]} loading={false} failedSources={[]} onRetry={() => {}} orderSync={{ kind: "waiting" }} />);
    expect(screen.getByText("주문 동기화대기")).toBeInTheDocument();
    expect(screen.queryByText("오늘 처리할 일이 없습니다")).not.toBeInTheDocument();
  });

  it("불러오지 못한 원천이 있으면 오류와 다시 불러오기를 낸다(빈 상태로 위장하지 않는다)", () => {
    const onRetry = vi.fn();
    render(<TodayWorkCard rows={[]} loading={false} failedSources={["주문", "승인대기"]} onRetry={onRetry} orderSync={null} />);
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("주문·승인대기 건수를 불러오지 못했습니다.")).toBeInTheDocument();
    within(alert).getByRole("button", { name: "다시 불러오기" }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("오늘 처리할 일이 없습니다")).not.toBeInTheDocument();
  });

  it("처음 불러오는 중에는 헤더 한 줄 + 스켈레톤 — 「없다」고 하지 않는다", () => {
    const { container } = render(<TodayWorkCard rows={[]} loading failedSources={[]} onRetry={() => {}} orderSync={{ kind: "loading" }} />);
    expect(screen.getByText("오늘 처리할 일")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("오늘 처리할 일이 없습니다")).not.toBeInTheDocument();
  });
});
