// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignRow } from "@/lib/crm-types";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { CampaignGroupSection } from "../campaign-group-section";

/** 무그룹 경로만 타므로 섹션이 실제로 읽는 필드만 채운다. */
function ungroupedCampaign(): CampaignRow {
  return {
    id: "c-current",
    sellerId: "s1",
    startDate: "2026-08-18",
    endDate: "2026-08-21",
    groupId: null,
  } as unknown as CampaignRow;
}

function candidate(over: Record<string, unknown> = {}) {
  return {
    campaignId: "c-other",
    dealName: "콜라겐",
    brandName: "센토메가",
    partnerName: "뷰티코리아",
    status: "PROPOSAL",
    roundNumber: 7,
    startDate: "2026-08-18",
    endDate: "2026-08-21",
    ...over,
  };
}

const fetchMock = vi.fn();

/** suggest(기존 그룹)·combinable(미그룹 캠페인)·POST 생성·현재 캠페인 재조회를 URL로 가른다. */
function stubFetch(options: {
  groups?: unknown[];
  candidates?: unknown[];
  alreadyGroupedCount?: number;
}) {
  fetchMock.mockImplementation((input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

    if (url.includes("/api/campaign-groups/suggest")) {
      return json({ groups: options.groups ?? [] });
    }
    if (url.includes("/api/campaign-groups/combinable")) {
      return json({
        candidates: options.candidates ?? [],
        alreadyGroupedCount: options.alreadyGroupedCount ?? 0,
      });
    }
    if (url === "/api/campaign-groups" && init?.method === "POST") {
      return json({ id: "g-new", members: [] });
    }
    return json(ungroupedCampaign());
  });
}

async function openDialog() {
  render(<CampaignGroupSection campaign={ungroupedCampaign()} />);
  fireEvent.click(screen.getByRole("button", { name: "그룹으로 묶기" }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("그룹으로 묶기 다이얼로그", () => {
  it("미그룹 후보를 고르면 현재 캠페인을 포함해 그룹 생성을 요청한다", async () => {
    stubFetch({ candidates: [candidate()] });
    await openDialog();

    await waitFor(() => expect(screen.getByText("콜라겐")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox"));

    const submit = screen.getByRole("button", { name: "선택한 1건과 묶기" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/campaign-groups" && init?.method === "POST",
      );
      expect(post).toBeDefined();
      // 서버는 최소 2건을 요구한다 — 현재 캠페인이 반드시 함께 나가야 성립한다.
      expect(JSON.parse(post![1].body)).toEqual({
        campaignIds: ["c-current", "c-other"],
      });
    });

    // 묶인 캠페인 **전부**를 다시 읽어야 한다 — 상위 목록은 행 하나씩만 교체하므로,
    // 현재 캠페인만 갱신하면 나머지 행이 새로고침 전까지 미그룹으로 남아 보드의
    // 그룹 배지가 방금 묶은 것을 안 묶인 것처럼 보여준다.
    await waitFor(() => {
      const refreshed = fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.startsWith("/api/campaigns/"));
      expect(refreshed).toEqual(
        expect.arrayContaining(["/api/campaigns/c-current", "/api/campaigns/c-other"]),
      );
    });
  });

  it("아무것도 고르지 않으면 확정 버튼이 눌리지 않는다", async () => {
    stubFetch({ candidates: [candidate()] });
    await openDialog();

    await waitFor(() => expect(screen.getByText("콜라겐")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "선택한 0건과 묶기" })).toBeDisabled();
  });

  it("합류 후보는 묶기 후보와 같은 날짜 규칙을 태운다(근접 창만큼 넓힌 범위)", async () => {
    // 안 넓히면 창 안이지만 겹치지 않는 그룹이 합류 목록에서 빠지는데, 그 멤버는
    // alreadyGroupedCount 에는 잡혀 "이미 묶여 있다"만 뜨는 막다른 길이 된다.
    stubFetch({ candidates: [candidate()] });
    await openDialog();

    await waitFor(() => expect(screen.getByText("콜라겐")).toBeInTheDocument());

    const urlOf = (fragment: string) =>
      new URL(
        String(fetchMock.mock.calls.find(([u]) => String(u).includes(fragment))![0]),
        "http://localhost",
      ).searchParams;

    const join = urlOf("/api/campaign-groups/suggest");
    const combine = urlOf("/api/campaign-groups/combinable");

    // 캠페인 기간은 2026-08-18 ~ 2026-08-21, 근접 창은 3일.
    expect(combine.get("startDate")).toBe("2026-08-18");
    expect(combine.get("endDate")).toBe("2026-08-21");
    expect(join.get("startDate")).toBe("2026-08-15");
    expect(join.get("endDate")).toBe("2026-08-24");
  });

  it("후보가 전부 다른 그룹 소속이면 그 사실을 문구로 말한다", async () => {
    // 종전 문구는 두 상황을 "없습니다" 하나로 뭉갰고, 그게 이 기능이 고치는 결함이다.
    stubFetch({ candidates: [], alreadyGroupedCount: 2 });
    await openDialog();

    await waitFor(() =>
      expect(
        screen.getByText("일정이 가까운 캠페인은 이미 다른 그룹에 속해 있습니다."),
      ).toBeInTheDocument(),
    );
  });

  it("일정이 가까운 캠페인 자체가 없으면 다른 문구로 말한다", async () => {
    stubFetch({ candidates: [], alreadyGroupedCount: 0 });
    await openDialog();

    await waitFor(() =>
      expect(screen.getByText("일정이 가까운 다른 캠페인이 없습니다.")).toBeInTheDocument(),
    );
  });
});
