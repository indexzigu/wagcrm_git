// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignGroupMemberRow, CampaignRow } from "@/lib/crm-types";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

import { CampaignGroupSection } from "../campaign-group-section";

/**
 * 이미 묶인 그룹의 **멤버 목록**이 「이게 같은 묶음인가」를 판단할 축(브랜드·거래처)을
 * 싣는지 본다. 그 정보가 없어서 "같은 셀러·같은 일정인데 브랜드가 달라서 안 묶인다"는
 * 오진이 나왔고, 두 번째 케이스는 표기 조립을 화면이 다시 만들지 않는지를 고정한다.
 */

/** 그룹 소속 경로만 타므로 섹션이 실제로 읽는 필드만 채운다. */
function groupedCampaign(): CampaignRow {
  return {
    id: "c-current",
    sellerId: "s1",
    startDate: "2026-08-18",
    endDate: "2026-08-21",
    groupId: "g1",
  } as unknown as CampaignRow;
}

function member(over: Partial<CampaignGroupMemberRow> = {}): CampaignGroupMemberRow {
  return {
    campaignId: "c-current",
    dealName: "비타민",
    campaignName: null,
    brandName: "뉴트리원",
    partnerName: "뷰티코리아",
    status: "PROPOSAL",
    startDate: "2026-08-18",
    endDate: "2026-08-21",
    roundNumber: null,
    salesChannel: "SELLER_MALL",
    actualSales: null,
    sellerExpense: null,
    settlementItems: [],
    ...over,
  };
}

const fetchMock = vi.fn();
const onGroupMembershipChanged = vi.fn();

function stubDetail(members: CampaignGroupMemberRow[]) {
  fetchMock.mockImplementation((input: unknown) => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

    if (url.includes("/api/campaign-groups/g1")) {
      return json({
        id: "g1",
        sellerId: "s1",
        sellerName: "테스트셀러",
        name: null,
        startDate: "2026-08-18",
        endDate: "2026-08-21",
        memberCount: members.length,
        memberCampaignIds: members.map((m) => m.campaignId),
        members,
      });
    }
    return json(groupedCampaign());
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  onGroupMembershipChanged.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("그룹 멤버 목록 — 브랜드·거래처 표기", () => {
  it("멤버 행에 브랜드와 거래처를 함께 보여준다", async () => {
    stubDetail([member()]);
    render(<CampaignGroupSection campaign={groupedCampaign()} />);

    expect(await screen.findByText("뉴트리원 - 뷰티코리아")).toBeInTheDocument();
  });

  it("브랜드사가 곧 거래처면 하나만 보여준다 — 접기 규칙은 formatDealContextLabel 소유", async () => {
    // 화면이 표기를 직접 이어붙이면 이 케이스에서 "뉴트리원 - 뉴트리원"이 된다.
    // 이 레포가 반복해서 겪은 「정본 함수를 두고 호출부가 손으로 다시 만든다」 형태다.
    stubDetail([member({ brandName: "뉴트리원", partnerName: "뉴트리원" })]);
    render(<CampaignGroupSection campaign={groupedCampaign()} />);

    expect(await screen.findByText("뉴트리원")).toBeInTheDocument();
    expect(screen.queryByText("뉴트리원 - 뉴트리원")).not.toBeInTheDocument();
  });
});

/**
 * 멤버를 빼면 **바뀐 행 전부**가 상위로 올라가는지 본다.
 *
 * 상위 콜백은 행 하나를 교체하는 계약이라 목록이 스스로 따라오지 않는다(섹션의
 * `refreshCampaigns` 주석). 2건짜리 그룹은 하나만 빼도 **해체**되어 남은 캠페인까지
 * 미그룹이 되는데, 현재 캠페인만 갱신하면 남은 행은 새로고침 전까지 보드에 그룹
 * 배지를 그대로 달고 있다. 묶는 쪽의 같은 결함은 이미 고쳐졌고 빼는 쪽만 남아 있었다.
 */

/** 그룹 상세 조회 · 멤버 제외 PATCH · 캠페인 재조회를 URL·method 로 가른다. */
function stubRemoval(members: CampaignGroupMemberRow[], patchResult: unknown) {
  fetchMock.mockImplementation((input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const json = (body: unknown) =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

    if (url.includes("/api/campaign-groups/g1")) {
      if (init?.method === "PATCH") return json(patchResult);
      return json({
        id: "g1",
        sellerId: "s1",
        sellerName: "테스트셀러",
        name: null,
        startDate: "2026-08-18",
        endDate: "2026-08-21",
        memberCount: members.length,
        memberCampaignIds: members.map((m) => m.campaignId),
        members,
      });
    }
    // 재조회는 요청한 id 를 그대로 돌려줘야 전파 단언이 의미를 갖는다.
    const id = url.replace("/api/campaigns/", "");
    return json({ ...groupedCampaign(), id, groupId: null });
  });
}

describe("멤버 제외 후 목록 동기화", () => {
  const sibling = () => member({ campaignId: "c-sibling", dealName: "콜라겐" });
  const third = () => member({ campaignId: "c-third", dealName: "비오틴" });

  function renderSection() {
    render(
      <CampaignGroupSection
        campaign={groupedCampaign()}
        onGroupMembershipChanged={onGroupMembershipChanged}
      />,
    );
  }

  /**
   * ⚠️ **멤버를 3건으로 두는 것이 이 테스트의 요점이다.** 실제 서버는 남는 멤버가
   * 1건 이하일 때만 해체하므로 해체는 늘 2건짜리에서 일어나는데, 2건이면 「제외 전
   * 전원」과 「뺀 멤버 + 현재」가 **같은 집합**이라 단언이 두 갈래를 못 가른다
   * (해체 갈래를 통째로 지워도 초록이다). 3건으로 두면 전원(3) vs 둘(2)로 갈린다.
   */
  it("그룹이 해체되면 제외 전 멤버 전원을 다시 읽어 상위로 올린다", async () => {
    stubRemoval([member(), sibling(), third()], { dissolved: true });
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: "콜라겐 캠페인을 그룹에서 제외" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "제외" }));

    // 해체는 **전원**의 groupId 를 null 로 만든다 — 빠뜨린 행은 새로고침 전까지
    // 보드에 그룹 배지를 그대로 달고 있다(이 티켓의 증상 그대로).
    await waitFor(() => {
      const propagated = onGroupMembershipChanged.mock.calls.map(([row]) => row.id).sort();
      expect(propagated).toEqual(["c-current", "c-sibling", "c-third"]);
    });
  });

  it("그룹이 남으면 제외된 캠페인을 다시 읽는다", async () => {
    // 해체가 아니어도 **뺀 캠페인**의 groupId 는 바뀐다 — 종전에는 현재 캠페인만
    // 갱신해서 뺀 행이 목록에 그룹 소속으로 남았다. 남는 형제(c-third)는 소속이
    // 그대로이므로 갱신 대상이 아니다.
    stubRemoval([member(), sibling(), third()], {
      id: "g1",
      sellerId: "s1",
      sellerName: "테스트셀러",
      name: null,
      startDate: "2026-08-18",
      endDate: "2026-08-21",
      memberCount: 2,
      memberCampaignIds: ["c-current", "c-third"],
      members: [member(), third()],
    });
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: "콜라겐 캠페인을 그룹에서 제외" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "제외" }));

    await waitFor(() => {
      const propagated = onGroupMembershipChanged.mock.calls.map(([row]) => row.id).sort();
      expect(propagated).toEqual(["c-current", "c-sibling"]);
    });
  });
});
