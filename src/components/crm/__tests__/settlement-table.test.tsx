import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SettlementTable } from "../settlement-table";
import type { CampaignRow } from "@/lib/crm-types";

/**
 * 정산일정·계산서 배지를 **접근 가능한 이름**으로 찾아 배지 요소(색·레이아웃 클래스를 든
 * 바깥 span)를 돌려준다.
 *
 * 2026-08-26 아이콘화 이후 배지에는 **보이는 글자가 없다**(글리프 2개 + `sr-only`).
 * 그래서 `getByText("공급사 지급").className` 같은 종전 형태는 두 가지로 깨진다 —
 * ①이름이 `"공급사 지급 완료"` 라 정확 일치가 안 되고 ②일치시켜도 잡히는 노드가
 * `sr-only` span 이라 className 단언이 `"sr-only"` 를 검사하는 **무의미한 초록**이 된다.
 *
 * ⛔ 그 상황을 `toContain` 범위를 넓히거나 단언을 지워서 넘기지 말 것 — 이 파일이 지키는
 * 것은 "완료면 성공색, 미완료면 회색" 이라는 **색 계약**이고, 그건 배지 요소에만 있다.
 * 낭독 문구(`완료`/`미완료`)까지 함께 고정되므로 종전보다 강한 단언이다.
 */
function slotBadge(accessibleName: string): HTMLElement {
  const srOnly = screen.getByText(accessibleName);
  const badge = srOnly.parentElement;
  if (!badge) throw new Error(`배지 요소를 찾지 못했다: ${accessibleName}`);
  return badge;
}

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const campaign: CampaignRow = {
  id: "camp-1",
  dealId: "deal-1",
  sellerId: "seller-1",
  campaignName: null,
  salesCode: null,
  dealName: "글로우 앰플 4차",
  partnerName: "코링코",
  sellerName: "미나",
  snsType: "INSTAGRAM",
  snsHandle: "@mina",
  startDate: "2026-01-01",
  endDate: "2026-01-31",
  salesChannel: "OWN_MALL",
  baseNaverLink: "",
  generatedTrackingLink: "",
  actualSales: 500000,
  settlementSales: 300000,
  operatingProfit: 120000,
  totalMarginRate: 30,
  sellerMarginRate: 10,
  netMarginRate: 20,
  status: "SETTLEMENT_IN_PROGRESS",
  isManualMargin: false,
  assignedTo: null,
  updatedAt: "2026-01-10T00:00:00Z",
  deal: {
    brandName: "브랜드A",
    costPrice: 1000,
    sellingPrice: 2000,
  },
  followerHistory: [],
  activityHistory: [],
  notes: [],
};

describe("SettlementTable", () => {
  it("shows labeled deal, seller, and brand identities", () => {
    render(
      <SettlementTable
        campaigns={[campaign]}
        onSelectCampaign={vi.fn()}
        onRefresh={vi.fn(async () => {})}
        loading={false}
        selectedIds={[]}
        onToggleRow={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );

    expect(screen.getAllByText("브랜드").length).toBeGreaterThan(0);
    expect(screen.getByText("글로우 앰플 4차 - 미나")).toBeInTheDocument();
    expect(screen.getByText("브랜드A")).toBeInTheDocument();
  });

  it("정산일정 배지가 텍스트를 박스 중앙에 두고 셀 본문이 사다리 값을 쓴다", () => {
    render(
      <SettlementTable
        campaigns={[campaign]}
        onSelectCampaign={vi.fn()}
        onRefresh={vi.fn(async () => {})}
        loading={false}
        selectedIds={[]}
        onToggleRow={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );

    // 픽스처는 자사몰 — 첫 줄 배지는 「공급사 지급」이다(입금 줄 없음, #452).
    const scheduleBadge = slotBadge("공급사 지급 미완료");
    // h-4 + leading-none 조합은 inline-flex + items-center 가 없으면 줄 상자(10px)가
    // 박스(16px) 위쪽에 붙어 남는 6px 이 전부 아래로 간다 — 오너 신고 정렬 결함의 원인.
    expect(scheduleBadge.className).toContain("inline-flex");
    expect(scheduleBadge.className).toContain("items-center");

    // P8 데이터 그리드 3단 사다리: 셀 본문은 text-xs, text-[11px] 은 이탈값.
    const scheduleCell = scheduleBadge.closest("td");
    expect(scheduleCell?.className).toContain("text-xs");
    expect(scheduleCell?.className).not.toContain("text-[11px]");
  });
});

// 기존 픽스처는 `sellerTaxType` 이 없어 **개인 셀러로 판정된다**(사업자번호가 없으면
// 개인 — `isIndividualSeller` 기본값). 법인 케이스는 별도 픽스처가 필요하다.
const businessCampaign: CampaignRow = {
  ...campaign,
  sellerTaxType: "BUSINESS",
  sellerCompanyBusinessNumber: "0000000000",
};

const renderTable = (rows: CampaignRow[]) =>
  render(
    <SettlementTable
      campaigns={rows}
      onSelectCampaign={vi.fn()}
      onRefresh={vi.fn(async () => {})}
      loading={false}
      selectedIds={[]}
      onToggleRow={vi.fn()}
      onToggleAll={vi.fn()}
    />,
  );

describe("SettlementTable 계산서 열", () => {
  it("채널별로 상대와 방향을 판정표에서 파생한다", () => {
    const own = renderTable([{ ...businessCampaign, salesChannel: "OWN_MALL" }]);
    expect(slotBadge("공급사 수취 미완료")).toBeInTheDocument();
    expect(slotBadge("셀러 수취 미완료")).toBeInTheDocument();
    own.unmount();

    const brand = renderTable([{ ...businessCampaign, salesChannel: "BRAND_MALL" }]);
    expect(slotBadge("공급사 발행 미완료")).toBeInTheDocument();
    expect(slotBadge("셀러 수취 미완료")).toBeInTheDocument();
    brand.unmount();

    renderTable([{ ...businessCampaign, salesChannel: "SELLER_MALL" }]);
    expect(slotBadge("공급사 수취 미완료")).toBeInTheDocument();
    expect(slotBadge("셀러 발행 미완료")).toBeInTheDocument();
  });

  it("처리된 슬롯만 완료 색을 받고 미처리는 무채색이다", () => {
    renderTable([
      {
        ...businessCampaign,
        salesChannel: "SELLER_MALL",
        supplierInvoiceIssuedAt: "2026-08-05",
        sellerInvoiceIssuedAt: null,
      },
    ]);

    expect(slotBadge("공급사 수취 완료").className).toContain("bg-status-success-bg");
    expect(slotBadge("셀러 발행 미완료").className).toContain("bg-slate-100");
    expect(screen.getByText("26-08-05")).toBeInTheDocument();
  });

  it("개인 셀러의 셀러 칸은 「해당 없음」이고 사유가 이름과 title 양쪽에 실린다", () => {
    renderTable([{ ...campaign, salesChannel: "SELLER_MALL", sellerTaxType: "INDIVIDUAL" }]);

    // 2026-08-26 아이콘화로 두 가지가 강해졌다:
    // ① 상대가 살아났다 — 종전 표기는 맨 "해당 없음" 이라 **어느 쪽이** 해당 없는지 배지만
    //    봐서는 알 수 없었다(글리프는 이제 셀러 아이콘 + 대시다).
    // ② 사유가 **접근 가능한 이름**에 들어갔다 — 종전에는 `title` 로만 붙어 화면리더
    //    사용자에게 전달되는 경로가 아예 없었다.
    // ⛔ 사유를 이름에서 빼고 title 로만 되돌리지 말 것.
    const badge = slotBadge("셀러 발행 해당 없음 개인 셀러(원천징수 대상)");
    // title 은 `aria-hidden` 안쪽 span 이 진다(바깥에 두면 이름 사본이 낭독된다).
    const hoverTarget = badge.querySelector("[aria-hidden='true']");
    expect(hoverTarget?.getAttribute("title")).toBe("셀러 발행 해당 없음 개인 셀러(원천징수 대상)");
    // 공급사 의무는 셀러 세무 유형과 무관하다 — 사라지면 안 된다.
    expect(slotBadge("공급사 수취 미완료")).toBeInTheDocument();
  });

  it("⛔ 의무가 없어도 값이 있으면 날짜를 계속 보여준다", () => {
    // 2026-08-07 설계 §4-2 회귀 방어선 — 기록이 화면에서 사라지면 오너가 해제할
    // 경로도 없어진다. 프로덕션에 이런 레거시 행이 실재한다.
    renderTable([
      {
        ...campaign,
        salesChannel: "SELLER_MALL",
        sellerTaxType: "INDIVIDUAL",
        sellerInvoiceIssuedAt: "2026-08-06",
      },
    ]);

    expect(slotBadge("셀러 발행 해당 없음 개인 셀러(원천징수 대상)")).toBeInTheDocument();
    expect(screen.getByText("26-08-06")).toBeInTheDocument();
  });

  it("「다음 업무」 열이 사라지고 정산일정 열은 심각도 축을 얹지 않는다", () => {
    // 종전에는 이 칸이 지연 경고를 소유했다. 2026-08-25 오너 결정으로 제거했다 —
    // 이 표의 모집단이 `endDate` 월 필터라 판정식과 축이 같아 과거 달에서는 전 행이
    // 켜졌고(변별력 0), 판정이 같은 칸의 예정일 대신 종료일+14 를 봤다. 정산 지연의
    // 정본은 `buildOverdueSettlementItems`(대시보드 아젠다) 하나다.
    // 아래는 그 재유입 방어선이다 — 임계를 확실히 넘긴 과거 종료일 + 입금·지급 미완이라
    // 구 판정이라면 반드시 켜졌을 행이다.
    renderTable([
      {
        ...businessCampaign,
        endDate: "2020-01-01",
        isDepositReceived: false,
        isPayoutCompleted: false,
      },
    ]);

    expect(screen.queryByText("다음 업무")).not.toBeInTheDocument();
    expect(screen.getByText("계산서")).toBeInTheDocument();

    const scheduleCell = slotBadge("공급사 지급 미완료").closest("td");
    expect(scheduleCell).not.toBeNull();
    expect(scheduleCell!.textContent).not.toMatch(/지연/);
    // 진행 축(지급 배지와 날짜)은 그대로 남는다 — 칸을 통째로 비운 것이 아니다.
    expect(slotBadge("셀러 지급 미완료").closest("td")).toBe(scheduleCell);
  });

  it("정산일정 줄도 채널 슬롯에서 파생한다 — 자사몰은 지급 두 줄, 입금 줄 없음(#452)", () => {
    const own = renderTable([
      {
        ...businessCampaign,
        salesChannel: "OWN_MALL",
        expectedSupplierPayoutDate: "2026-08-21",
        expectedPayoutDate: "2026-08-22",
      },
    ]);
    expect(slotBadge("공급사 지급 미완료")).toBeInTheDocument();
    expect(slotBadge("셀러 지급 미완료")).toBeInTheDocument();
    // ⚠️ 문서 전체에서 /입금/ 을 찾지 말 것 — 표 아래 **범례**가 채널과 무관하게 기호 뜻을
    // 전부 설명하므로 「입금」 낱말은 항상 화면에 있다(정적 범례가 맞다). 이 계약이 지키는
    // 것은 「자사몰 **행**에 입금 줄이 없다」이므로 배지의 접근 가능한 이름으로 좁힌다
    // (배지 이름은 항상 완료/미완료로 끝나고 범례 항목은 낱말 하나뿐이라 갈린다).
    expect(screen.queryByText(/입금\s+(완료|미완료)/)).not.toBeInTheDocument();
    // 공급사 줄은 전용 필드를, 셀러 줄은 기존 payout 필드를 읽는다(카드와 같은 매핑).
    expect(screen.getByText("26-08-21")).toBeInTheDocument();
    expect(screen.getByText("26-08-22")).toBeInTheDocument();
    own.unmount();

    const brand = renderTable([{ ...businessCampaign, salesChannel: "BRAND_MALL" }]);
    expect(slotBadge("공급사 입금 미완료")).toBeInTheDocument();
    expect(slotBadge("셀러 지급 미완료")).toBeInTheDocument();
    brand.unmount();

    renderTable([{ ...businessCampaign, salesChannel: "SELLER_MALL" }]);
    expect(slotBadge("셀러 입금 미완료")).toBeInTheDocument();
    expect(slotBadge("공급사 지급 미완료")).toBeInTheDocument();
  });

  it("자사몰 지급 배지의 완료 색은 각 레그의 플래그를 따로 따른다", () => {
    renderTable([
      {
        ...businessCampaign,
        salesChannel: "OWN_MALL",
        isSupplierPayoutCompleted: true,
        supplierPayoutCompletedAt: "2026-08-20",
        isPayoutCompleted: false,
      },
    ]);
    expect(slotBadge("공급사 지급 완료").className).toContain("bg-status-success-bg");
    expect(slotBadge("셀러 지급 미완료").className).toContain("bg-slate-100");
  });

  it("계산서 열이 정산일정 바로 오른쪽에 온다", () => {
    renderTable([businessCampaign]);

    const headers = Array.from(document.querySelectorAll("thead th")).map(
      (th) => th.textContent?.trim() ?? "",
    );
    expect(headers.indexOf("계산서")).toBe(headers.indexOf("정산일정") + 1);
    expect(headers.indexOf("총 거래액")).toBe(headers.indexOf("계산서") + 1);

    // table-fixed 라 colgroup 개수가 열 개수와 어긋나면 폭이 통째로 밀린다.
    expect(document.querySelectorAll("colgroup col")).toHaveLength(headers.length);
  });

  it("⛔ 목록이 채널→상대 매핑을 손으로 다시 만들지 않는다", () => {
    // 행위 테스트로는 못 잡는다 — 하드코딩해도 화면은 똑같이 나온다. 판정은
    // tax-filing-board 의 표에서만 나와야 하고, 화면이 사본을 만들면 표를 고쳐도
    // 목록만 조용히 낡는다(이 레포가 세 번 겪은 부류).
    const source = readFileSync(
      path.join(process.cwd(), "src/components/crm/settlement-table.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // 주석의 경고문이 자기 자신을 위반으로 잡는다

    expect(source).toContain("resolveCampaignInvoiceSlots");
    // 정산일정 줄도 같은 규약이다(#452) — 입금/지급 하드코딩이 되살아나면 카드와 갈린다.
    expect(source).toContain("resolveCampaignMoneySlots");
    expect(source).not.toMatch(/OWN_MALL|BRAND_MALL|SELLER_MALL/);
    expect(source).not.toMatch(/"공급사 (수취|발행)"|"셀러 (수취|발행)"/);
    expect(source).not.toMatch(/expectedDepositDate|expectedPayoutDate/);
  });
});
