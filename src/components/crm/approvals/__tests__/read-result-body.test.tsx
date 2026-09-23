// @vitest-environment jsdom
/**
 * ReadResultBody — 결재함 상세의 조회 결과 본문 (Plan 2 Task 5).
 *
 * 봇이 남긴 READ 봉투 `{ operation, jobId, query, truncated, data }` 를 받아
 * 세 갈래로 그린다: ①도구 전용 리치 뷰 ②제네릭 표 ③key/value 목록.
 * 갈래를 고르는 판정이 이 파일의 계약이다 — 모양이 어긋난 기록(웹 채팅 시절의
 * toolCalls 배열, 필드가 빠진 옛 기록)도 **무엇이든 보여야** 한다.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ReadResultBody } from "../read-result-body";
import { hasToolResultRenderer } from "../tool-result-views";

function envelope(operation: string, data: unknown, extra: Record<string, unknown> = {}) {
  return { operation, jobId: "job-1", query: {}, truncated: false, data, ...extra };
}

describe("ReadResultBody — 갈래 ① 도구 전용 리치 뷰", () => {
  it("정산 리포트 봉투는 기존 정산 뷰(총매출 스탯 + 딜명 표)로 그린다", () => {
    const data = {
      period: "2026-07",
      summary: {
        totalRevenue: 1000000,
        totalMargin: 200000,
        totalSellerPayouts: 300000,
        campaignCount: 1,
      },
      campaigns: [
        {
          id: "camp1",
          dealName: "딜 A",
          brandName: "브랜드 A",
          sellerName: "셀러 A",
          actualSales: 1000000,
          sellerPayoutAmount: 300000,
          netMarginAmount: 200000,
          state: "confirmed",
          isDepositReceived: true,
          isPayoutCompleted: false,
          depositReceivedAt: null,
          payoutCompletedAt: null,
        },
      ],
      stateCounts: { pending: 0, confirmed: 1, paid: 0 },
    };
    render(<ReadResultBody envelope={envelope("get_settlement_report", data)} />);
    expect(screen.getByText("총매출")).toBeInTheDocument();
    expect(screen.getByText("딜명")).toBeInTheDocument();
    expect(screen.getByText("딜 A")).toBeInTheDocument();
  });

  it("리치 뷰는 bare 로 그린다 — 상세 화면 안에서 카드 속 카드를 만들지 않는다", () => {
    const data = { statusCounts: [{ status: "ACTIVE", count: 2 }], totalCount: 2, campaigns: [] };
    const { container } = render(
      <ReadResultBody envelope={envelope("get_pipeline_status", data)} />
    );
    const wrapper = container.querySelector("[data-slot='read-result-body'] > div");
    expect(wrapper?.className ?? "").not.toContain("border-border");
  });
});

describe("ReadResultBody — 갈래 ② 제네릭 표", () => {
  const workerSearchDeals = {
    items: [
      { id: "d1", dealName: "딜 A", status: "CONFIRMED", updatedAt: "2026-09-01T00:00:00.000Z" },
    ],
    rowLimitReached: false,
  };

  it("워커 봉투(items + rowLimitReached)는 제네릭 표로 그린다", () => {
    render(<ReadResultBody envelope={envelope("search_deals", workerSearchDeals)} />);
    const table = screen.getByRole("table");
    expect(table).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "dealName" })).toBeInTheDocument();
    expect(screen.getByText("딜 A")).toBeInTheDocument();
  });

  it("제네릭 표에는 sr-only 이름표(caption)가 붙는다", () => {
    const { container } = render(
      <ReadResultBody envelope={envelope("search_deals", workerSearchDeals)} />
    );
    const caption = container.querySelector("caption");
    expect(caption).toHaveTextContent("조회 결과 표");
    expect(caption).toHaveClass("sr-only");
  });

  it("열 머리는 scope=col 이고 첫 등장 순서로 키 합집합을 만든다", () => {
    render(
      <ReadResultBody
        envelope={envelope("search_deals", {
          items: [
            { id: "d1", dealName: "딜 A" },
            { id: "d2", memo: "뒤늦게 등장한 키" },
          ],
          rowLimitReached: false,
        })}
      />
    );
    const headers = screen.getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["id", "dealName", "memo"]);
    expect(headers[0]).toHaveAttribute("scope", "col");
  });

  it("ISO 날짜는 연도까지, null 은 -, 중첩 객체는 JSON, 숫자는 천 단위로 보여준다", () => {
    render(
      <ReadResultBody
        envelope={envelope("search_deals", {
          items: [
            {
              updatedAt: "2026-09-22T05:30:00.000Z",
              brandName: null,
              detail: { a: 1 },
              sellingPrice: 1234567,
            },
          ],
          rowLimitReached: false,
        })}
      />
    );
    // 2026-09-22T05:30:00Z = KST 14:30
    expect(screen.getByText("2026-09-22 14:30")).toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
    expect(screen.getByText('{"a":1}')).toBeInTheDocument();
    expect(screen.getByText("1,234,567")).toBeInTheDocument();
  });

  // 감사 표에는 「최근」이라는 전제가 없다 — 작년 행이 올해 행처럼 읽히면 오정보다.
  it("지난해 기록도 자기 연도를 달고 나온다", () => {
    render(
      <ReadResultBody
        envelope={envelope("search_deals", {
          items: [{ updatedAt: "2025-01-02T00:10:00.000Z" }],
          rowLimitReached: false,
        })}
      />
    );
    // 2025-01-02T00:10:00Z = KST 09:10
    expect(screen.getByText("2025-01-02 09:10")).toBeInTheDocument();
  });

  it("열은 **그려지는 행**에서만 뽑는다 — 잘려 나간 행의 키로 빈 열을 만들지 않는다", () => {
    const items: Record<string, unknown>[] = Array.from({ length: 200 }, (_, index) => ({
      id: `row-${index}`,
    }));
    items.push({ id: "row-200", onlyInCutRow: "보이지 않는 행의 키" });
    render(<ReadResultBody envelope={envelope("search_deals", { items, rowLimitReached: false })} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["id"]);
  });

  it("200행을 넘으면 앞 200행만 그리고 그 사실을 적는다", () => {
    const items = Array.from({ length: 201 }, (_, index) => ({ id: `row-${index}` }));
    render(<ReadResultBody envelope={envelope("search_deals", { items, rowLimitReached: false })} />);
    expect(screen.getByText("앞 200행만 표시합니다.")).toBeInTheDocument();
    expect(screen.getByText("row-199")).toBeInTheDocument();
    expect(screen.queryByText("row-200")).not.toBeInTheDocument();
  });
});

describe("ReadResultBody — 갈래 ③ key/value 목록", () => {
  it("리치 뷰 가드를 통과하지 못한 객체는 key/value 로 그린다", () => {
    // `derived` 가 없는 옛 캠페인 재무 기록 — 리치 뷰는 이 모양을 못 그린다(가드 false).
    const { container } = render(
      <ReadResultBody
        envelope={envelope("get_campaign_financials", {
          campaignId: "camp1",
          actualSales: 1000000,
        })}
      />
    );
    expect(container.querySelector("[data-slot='kv-list']")).not.toBeNull();
    expect(screen.getByText("actualSales")).toBeInTheDocument();
    expect(screen.getByText("1,000,000")).toBeInTheDocument();
  });

  it("봉투가 아닌 기록(웹 채팅 시절 toolCalls 배열)도 key/value 로 그린다", () => {
    const { container } = render(
      <ReadResultBody envelope={[{ toolName: "search_deals", ok: true }]} />
    );
    expect(container.querySelector("[data-slot='kv-list']")).not.toBeNull();
    expect(screen.getByText(/search_deals/)).toBeInTheDocument();
  });

  it("데이터가 없으면 그 사실을 문장으로 알린다", () => {
    render(<ReadResultBody envelope={envelope("search_deals", null)} />);
    expect(screen.getByText("저장된 결과가 없습니다.")).toBeInTheDocument();
  });

  it("0건은 key/value 덤프가 아니라 한 문장으로 말한다", () => {
    const { container } = render(
      <ReadResultBody envelope={envelope("search_deals", { items: [], rowLimitReached: false })} />
    );
    expect(screen.getByText("조회 결과가 0건입니다.")).toBeInTheDocument();
    expect(container.querySelector("[data-slot='kv-list']")).toBeNull();
    expect(screen.queryByText("rowLimitReached")).not.toBeInTheDocument();
  });
});

// 저장 상한을 넘긴 기록의 `data` 는 `{ truncated, bytes }` 마커뿐이다 — 그 두 줄은
// 조회 결과가 아니라 저장 사정이고, 그 사정은 머리의 고지 줄이 이미 말한다.
describe("ReadResultBody — 잘린 기록", () => {
  it("truncated 봉투의 본문은 아무것도 그리지 않는다", () => {
    const { container } = render(
      <ReadResultBody
        envelope={{
          operation: "search_deals",
          jobId: "job-1",
          query: {},
          truncated: true,
          data: { truncated: true, bytes: 120000 },
        }}
      />
    );
    expect(container.querySelector("dl")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
    expect(screen.queryByText(/bytes/)).not.toBeInTheDocument();
    expect(screen.queryByText("120,000")).not.toBeInTheDocument();
  });

  it("truncated 가 false 인 봉투는 평소대로 그린다 — 잘림 분기가 삼키지 않는다", () => {
    render(
      <ReadResultBody
        envelope={envelope("search_deals", { items: [{ id: "d1" }], rowLimitReached: false })}
      />
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});

describe("hasToolResultRenderer", () => {
  it("워커 봉투 모양의 search_deals 는 리치 뷰가 그릴 수 없다", () => {
    expect(hasToolResultRenderer("search_deals", { items: [], rowLimitReached: false })).toBe(false);
  });

  it("파이프라인 현황 봉투는 리치 뷰가 그릴 수 있다", () => {
    expect(
      hasToolResultRenderer("get_pipeline_status", { totalCount: 0, statusCounts: [], campaigns: [] })
    ).toBe(true);
  });

  it("등록되지 않은 operation 은 false 다", () => {
    expect(hasToolResultRenderer("brand_new_op", { items: [] })).toBe(false);
  });
});
