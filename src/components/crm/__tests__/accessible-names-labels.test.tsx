// @vitest-environment jsdom
/**
 * 접근 이름·라벨 연결 회귀 테스트 (interfaces 점검 묶음 G3, 2026-09-24).
 *
 * 화면낭독기는 라벨이 컨트롤에 **연결돼 있어야** 그 글자를 이름으로 읽는다 — 라벨이 옆에 떠 있기만
 * 하면 「편집 텍스트」「콤보 상자」「버튼」으로만 읽혀 무슨 칸인지 모른다. 여기서는 소스 문자열이 아니라
 * 실제 렌더 결과의 접근 이름(getByRole name / getByLabelText)으로 고정한다.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CSV 파서는 파일을 비동기로 읽는다 — 매핑 단계 렌더만 필요하므로 즉시 완료시킨다.
// 헤더에 공백을 넣어 id 로 쓰면 aria-labelledby 가 깨지는 경우를 함께 막는다.
vi.mock("papaparse", () => ({
  default: {
    parse: (_file: File, opts: { complete: (r: unknown) => void }) =>
      opts.complete({
        meta: { fields: ["이름", "메모 칸"] },
        data: [{ 이름: "가", "메모 칸": "나" }],
      }),
  },
}));

// 채널 수수료 화면은 앱 셸 안에 산다 — 셸(사이드바·세션)은 이 테스트의 관심 밖이다.
vi.mock("../crm-shell", () => ({
  CrmShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { InlineEditField } from "../inline-edit-field";
import { FilterPopover } from "../filter-popover";
import { CSVImportDialog } from "../csv-import-dialog";
import { SellerCreationForm } from "../seller-creation-form";
import { DealCreationForm } from "../deal-creation-form";
import { ChannelFeesClient } from "../channel-fees-client";
import { StepMetricCard } from "../step-metric-card";
import CampaignEditModal from "../shipping/modals/CampaignEditModal";
import CampaignCreateModal from "../shipping/modals/CampaignCreateModal";
import ProductSelectModal from "../shipping/modals/ProductSelectModal";
import EmailSendModal from "../shipping/modals/EmailSendModal";

// 등록 폼·주문 모달은 마운트 때 목록을 불러온다 — 빈 응답으로 고정(외부 부수효과 경로는 누르지 않는다).
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InlineEditField — 편집기·셀렉트가 필드 제목을 이름으로 쓴다", () => {
  it("편집 모드 입력칸의 이름이 라벨이다", () => {
    render(<InlineEditField label="판매가" value="50000" fieldType="number" onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "판매가 수정" }));
    expect(screen.getByRole("spinbutton", { name: "판매가" })).toHaveValue(50000);
  });

  it("select 필드의 콤보 상자 이름 = 라벨 + 현재 값", () => {
    render(
      <InlineEditField
        label="진행 상태"
        value="A"
        fieldType="select"
        options={[
          { value: "A", label: "진행 중" },
          { value: "B", label: "종료" },
        ]}
        onSave={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveAccessibleName("진행 상태 진행 중");
  });

  it("searchable-select 트리거 이름 = 라벨 + 현재 값", () => {
    render(
      <InlineEditField
        label="소개자"
        value="s1"
        fieldType="searchable-select"
        options={[{ value: "s1", label: "셀러 하나" }]}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "소개자 셀러 하나" })).toBeInTheDocument();
  });
});

describe("FilterPopover — 필터 라벨이 컨트롤에 연결된다", () => {
  it("셀렉트·날짜 입력이 각 필드 라벨로 읽힌다", () => {
    render(
      <FilterPopover
        filterConfig={[
          { key: "type", label: "유형", type: "select", options: [{ value: "x", label: "엑스" }] },
          { key: "from", label: "시작일", type: "date" },
        ]}
        filters={{}}
        onFilterChange={vi.fn()}
        onClearAll={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /필터/ }));
    expect(screen.getByRole("combobox", { name: /^유형/ })).toBeInTheDocument();
    expect(screen.getByLabelText("시작일")).toHaveAttribute("type", "date");
  });
});

describe("CSVImportDialog — 매핑 셀렉트가 CSV 열 이름으로 읽힌다", () => {
  it("각 셀렉트 이름이 「열 이름 + 현재 매핑」이다(「건너뛰기」만으로 읽히지 않는다)", () => {
    render(<CSVImportDialog open onOpenChange={() => {}} entityType="partners" />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(["x"], "a.csv", { type: "text/csv" })] },
    });
    const combos = within(screen.getByRole("dialog")).getAllByRole("combobox");
    expect(combos).toHaveLength(2);
    expect(combos[0]).toHaveAccessibleName(expect.stringMatching(/^이름 /));
    expect(combos[1]).toHaveAccessibleName(expect.stringMatching(/^메모 칸 /));
  });
});

describe("등록 폼 — placeholder 대신 라벨이 이름이 된다", () => {
  it("SellerCreationForm 입력·셀렉트가 보이는 라벨로 읽힌다", () => {
    render(<SellerCreationForm />);
    expect(screen.getByLabelText("표시명")).toHaveAttribute("name", "name");
    expect(screen.getByLabelText("별칭 (선택)")).toHaveAttribute("name", "alias");
    expect(screen.getByLabelText("SNS 핸들")).toHaveAttribute("name", "snsHandle");
    expect(screen.getByRole("combobox", { name: /^SNS 유형/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^유입 경로 \(선택\)/ })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^소개자 \(선택\)/ })).toBeInTheDocument();
  });

  it("DealCreationForm 딜명·브랜드명이 라벨로 읽힌다", () => {
    render(<DealCreationForm />);
    expect(screen.getByRole("textbox", { name: /^딜명/ })).toHaveAttribute("maxlength", "100");
    expect(screen.getByRole("textbox", { name: /^브랜드명/ })).toBeInTheDocument();
  });
});

describe("ChannelFeesClient — 채널마다 반복되는 라벨을 채널 그룹으로 구분한다", () => {
  it("각 입력이 자기 라벨로 읽히고 채널명 그룹 안에 있다", () => {
    render(
      <ChannelFeesClient
        initialChannels={[
          { id: "1", channel: "CH_A", label: "채널 A", feeRate: 1, paymentRate: 2, notes: null },
          { id: "2", channel: "CH_B", label: "채널 B", feeRate: 3, paymentRate: 4, notes: null },
        ]}
      />,
    );
    const groupB = screen.getByRole("group", { name: "채널 B" });
    expect(within(groupB).getByLabelText("스토어 수수료 (%)")).toHaveValue(3);
    expect(within(groupB).getByLabelText("결제 수수료 (%)")).toHaveValue(4);
    expect(within(groupB).getByLabelText("비고")).toBeInTheDocument();
  });
});

describe("StepMetricCard — 단계 막대 버튼에 단계 이름과 선택 상태가 있다", () => {
  it("버튼마다 「지표: 단계」 이름이 있고 현재 단계만 눌림 상태다", () => {
    render(
      <StepMetricCard label="활성도" value="2.보통" levels={["1.낮음", "2.보통", "3.높음"]} onSave={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "활성도: 보통" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "활성도: 높음" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("주문 관리 모달 — 아이콘 버튼·라벨·매핑 표 입력에 이름이 있다", () => {
  const campaign = {
    id: "order-1",
    name: "테스트 주문 캠페인",
    template: "brand",
    sellerName: "테스트 셀러",
    toEmail: "ops@example.com",
    ccEmail: "",
    tasks: [],
    mappings: [],
    salesCampaigns: [],
    dailyStats: [],
    insights: null,
  } as any; // 모달별 필드가 달라 최소 픽스처

  it("CampaignEditModal: 라벨이 입력에 연결되고 매핑 행 입력·삭제 버튼이 행 번호로 읽힌다", () => {
    render(<CampaignEditModal campaign={campaign} onClose={vi.fn()} onSubmit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByLabelText("셀러명")).toHaveValue("테스트 셀러");
    expect(screen.getByLabelText("수신 이메일 주소")).toHaveValue("ops@example.com");
    expect(screen.getByLabelText("참조 이메일 주소")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "1행 상품명" })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "1행 단가" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "1행 캠페인(딜)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1행 삭제" })).toBeInTheDocument();
  });

  it("CampaignCreateModal: 닫기 버튼과 입력 라벨이 이름을 가진다", () => {
    render(
      <CampaignCreateModal selectedProduct={{ name: "상품" }} onClose={vi.fn()} onReselectProduct={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "닫기" })).toBeInTheDocument();
    expect(screen.getByLabelText("셀러명 (메일 본문 식별용)")).toBeInTheDocument();
    expect(screen.getByLabelText("수신 이메일 주소")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1행 삭제" })).toBeInTheDocument();
  });

  it("ProductSelectModal: 닫기 버튼이 이름을 가진다", () => {
    render(
      <ProductSelectModal
        isOpen
        naverProducts={[]}
        isFetchingNaver={false}
        onFetchProducts={vi.fn()}
        onSelectProduct={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "닫기" })).toBeInTheDocument();
  });

  it("EmailSendModal: 입력 라벨이 연결된다", () => {
    render(<EmailSendModal campaignId="order-1" onClose={vi.fn()} onSuccess={vi.fn()} addToast={vi.fn()} />);
    expect(screen.getByLabelText("발주서 파일명")).toBeInTheDocument();
    expect(screen.getByLabelText("메일 제목")).toBeInTheDocument();
    expect(screen.getByLabelText("메일 본문")).toBeInTheDocument();
  });
});
