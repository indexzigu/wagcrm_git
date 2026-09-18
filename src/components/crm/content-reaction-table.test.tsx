// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { ContentEvent } from "@/lib/content-order-correlation";
import type { ReactionRow } from "@/lib/content-reaction";
import {
  ContentReactionTable,
  formatReactionLabel,
  formatReactionOrders,
} from "./content-reaction-table";

const T0 = Date.parse("2026-07-08T20:00:00+09:00");
const event = (id: string, type: ContentEvent["type"]): ContentEvent => ({
  id, source: type === "story" ? "story" : "asset", type,
  postedAt: new Date(T0).toISOString(), dateKey: "2026-07-08",
  thumbnailUrl: null, permalink: null, likeCount: null, commentCount: null, likesHidden: false,
});
const row = (over: Partial<ReactionRow<ContentEvent>> = {}): ReactionRow<ContentEvent> => ({
  key: "a", pivotMs: T0, postedMs: T0, members: [event("a", "reel")],
  before: { orders: 12, revenue: 120000 }, after: { orders: 41, revenue: 410000 },
  afterPartial: false, overlapCount: 0, ...over,
});

describe("문구", () => {
  it("직전 → 직후 건수를 적는다(배수·증감률을 말하지 않는다)", () => {
    expect(formatReactionOrders(row())).toBe("12건 → 41건");
  });
  it("기록 없는 쪽은 0건이 아니라 '기록 없음'이다", () => {
    expect(formatReactionOrders(row({ before: null }))).toBe("기록 없음 → 41건");
    expect(formatReactionOrders(row({ before: null, after: null }))).toBe("기록 없음");
  });
  it("라벨은 첫 콘텐츠의 유형 + 건수다", () => {
    expect(formatReactionLabel(row())).toBe("릴스 1건");
    expect(formatReactionLabel(row({ members: [event("a", "story"), event("b", "story")] }))).toBe("스토리 2건");
    expect(formatReactionLabel(row({ members: [event("a", "story"), event("b", "reel")] }))).toBe("스토리 외 1건");
  });
});

describe("ContentReactionTable", () => {
  it("줄이 없으면 아무것도 렌더하지 않는다", () => {
    const { container } = render(<ContentReactionTable rows={[]} selectedKey={null} onSelect={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("발행 시각·건수·직후 매출·겹침·집계 중을 보여준다", () => {
    render(
      <ContentReactionTable
        rows={[row({ afterPartial: true, overlapCount: 2 })]}
        selectedKey={null}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText("7.8 20:00")).toBeInTheDocument();
    expect(screen.getByText("12건 → 41건")).toBeInTheDocument();
    expect(screen.getByText("410,000원")).toBeInTheDocument();
    expect(screen.getByText("집계 중")).toBeInTheDocument();
    expect(screen.getByText("앞뒤 3시간 안에 다른 콘텐츠 2건")).toBeInTheDocument();
  });

  it("직후가 '기록 없음'이면 진행바를 렌더하지 않는다(폭 0%는 실제 0건과 구분되지 않는다)", () => {
    const { container } = render(
      <ContentReactionTable rows={[row({ after: null })]} selectedKey={null} onSelect={() => {}} />,
    );
    expect(screen.getByText("12건 → 기록 없음")).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden][class*="rounded-full"]')).toBeNull();
  });

  it("줄을 누르면 그 줄을, 고른 줄을 다시 누르면 null 을 넘긴다", () => {
    const onSelect = vi.fn();
    const r = row();
    const { rerender } = render(<ContentReactionTable rows={[r]} selectedKey={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { pressed: false }));
    expect(onSelect).toHaveBeenLastCalledWith(r);
    rerender(<ContentReactionTable rows={[r]} selectedKey="a" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { pressed: true }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});
