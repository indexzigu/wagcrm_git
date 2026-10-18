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
  { key: "settlement-delayed", label: "정산 지연", count: 1, tone: "urgent", href: "/settlement?campaign=c-1", detail: null },
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
    expect(count("정산 지연")).toHaveClass("text-status-urgent-text");
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

  // 리뷰(2026-10-18 interfaces MEDIUM): 건수 배지가 단위 없이 숫자만 읽혔다 — 「…5건 12」.
  it("행 링크 이름은 「라벨 N건」을 먼저 말한다 — 배지 숫자를 단위 없이 읽지 않는다", () => {
    render(<TodayWorkCard rows={rows} loading={false} failedSources={[]} onRetry={() => {}} orderSync={fresh} />);
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAccessibleName("발주 대기 12건, 결제 후 2일 이상 5건");
    expect(links[1]).toHaveAccessibleName("정산 지연 1건");
  });

  // ss-ux P1-1(2026-10-18): 동기화가 낡았는데 주문 행이 지금 일처럼 위험·주의색으로 떠 있었다.
  it("주문 동기화가 낡았으면 주문 행은 무채색 + 「N일 전 기준」 — 주문 밖 행은 그대로", () => {
    render(
      <TodayWorkCard rows={rows} loading={false} failedSources={[]} onRetry={() => {}} orderSync={{ kind: "stale", daysAgo: 3 }} />,
    );
    const order = screen.getByText("발주 대기").closest("a")!;
    const badge = within(order).getByText("12", { selector: '[data-slot="today-work-count"]' });
    expect(badge).not.toHaveClass("text-status-caution-text");
    expect(within(order).getByText("3일 전 기준 · 결제 후 2일 이상 5건")).toHaveClass("text-muted-foreground");
    // 정산 지연은 주문 동기화와 무관 — 위험색 유지.
    const settle = screen.getByText("정산 지연").closest("a")!;
    expect(within(settle).getByText("1", { selector: '[data-slot="today-work-count"]' })).toHaveClass("text-status-urgent-text");
  });

  it("주문 스냅샷이 아직 없으면(동기화대기) 주문 행 색을 거둔다 — 경과일이 없으니 접두는 붙이지 않는다", () => {
    render(<TodayWorkCard rows={rows} loading={false} failedSources={[]} onRetry={() => {}} orderSync={{ kind: "waiting" }} />);
    const order = screen.getByText("발주 대기").closest("a")!;
    expect(within(order).getByText("12", { selector: '[data-slot="today-work-count"]' })).not.toHaveClass("text-status-caution-text");
    expect(within(order).getByText("결제 후 2일 이상 5건")).toHaveClass("text-muted-foreground");
  });

  // 리뷰(2026-10-18 HIGH): 320px 에서 헤더 한 줄이 넘쳐 「마지막 동기화 N일 전」이 카드 밖으로 잘렸다.
  it("헤더는 줄을 바꿀 수 있다 — 동기화 안내를 한 줄에 가두지 않는다", () => {
    render(
      <TodayWorkCard rows={rows} loading={false} failedSources={[]} onRetry={() => {}} orderSync={{ kind: "stale", daysAgo: 2 }} />,
    );
    const heading = screen.getByRole("heading", { name: "오늘 처리할 일" });
    expect(heading.parentElement).toHaveClass("flex-wrap");
    expect(screen.getByText("마지막 동기화 2일 전")).not.toHaveClass("shrink-0");
  });

  // 크론 자가 복구 2단계(2026-10-18): 오너 조치를 기다리는 자동화 작업이 한 줄로 뜬다.
  it("자동화 작업 조치대기 줄 — 주의색 세부는 줄을 바꾸고, 주문 동기화가 낡아도 색을 거두지 않는다", () => {
    const automation: TodayWorkRow = {
      key: "automation-waiting",
      label: "자동화 작업 조치대기",
      count: 2,
      tone: "caution",
      href: "/settings/integrations#automation-status",
      detail: "네이버 발주 동기화 외 1건",
    };
    render(
      <TodayWorkCard rows={[automation]} loading={false} failedSources={[]} onRetry={() => {}} orderSync={{ kind: "stale", daysAgo: 3 }} />,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/settings/integrations#automation-status");
    expect(link).toHaveAccessibleName("자동화 작업 조치대기 2건, 네이버 발주 동기화 외 1건");
    const detail = screen.getByText("네이버 발주 동기화 외 1건");
    expect(detail).toHaveClass("text-status-caution-text", "break-keep");
    expect(within(link).getByText("2", { selector: '[data-slot="today-work-count"]' })).toHaveClass("text-status-caution-text");
  });

  it("처음 불러오는 중에는 헤더 한 줄 + 스켈레톤 — 「없다」고 하지 않는다", () => {
    const { container } = render(<TodayWorkCard rows={[]} loading failedSources={[]} onRetry={() => {}} orderSync={{ kind: "loading" }} />);
    expect(screen.getByText("오늘 처리할 일")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText("오늘 처리할 일이 없습니다")).not.toBeInTheDocument();
  });
});
