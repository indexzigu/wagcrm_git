import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_STATUS_ORDER,
  getNextCampaignStatus,
  getWorkspaceStatuses,
  isSellerInvoiceLabel,
  isSupplierInvoiceLabel,
  SETTLEMENT_CHECKLIST_TEMPLATES,
  setChecklistItemChecked,
  summarizeChecklist,
  type CampaignChecklistItemRow,
} from "../campaign-checklist";
import type { AppPrismaClient } from "../prisma-client";
import type { CampaignStatus } from "../crm-types";

function item(
  id: string,
  status: CampaignStatus,
  checked: boolean,
  isRequired = true,
): CampaignChecklistItemRow {
  const now = new Date("2026-05-19T00:00:00.000Z");
  return {
    id,
    campaignId: "campaign-1",
    templateId: null,
    status,
    label: `item ${id}`,
    sortOrder: Number(id.replace(/\D/g, "")) || 0,
    isRequired,
    isChecked: checked,
    completedAt: checked ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("campaign checklist workflow helpers", () => {
  it("returns the next campaign status in canonical workflow order", () => {
    expect(CAMPAIGN_STATUS_ORDER.map(getNextCampaignStatus)).toEqual([
      "PREPARATION",
      "ACTIVE",
      "CLOSED",
      "SETTLEMENT_WAIT",
      null,
      "COMPLETED",
      null,
      null,
    ]);
  });

  it("maps workspace filters to the single shared campaign status axis", () => {
    expect(getWorkspaceStatuses("outreach")).toBeNull();
    expect(getWorkspaceStatuses("pipeline")).toEqual([
      "PREPARATION",
      "ACTIVE",
      "CLOSED",
      "SETTLEMENT_WAIT",
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
    ]);
    expect(getWorkspaceStatuses("settlement")).toEqual([
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
    ]);
    expect(getWorkspaceStatuses("unknown")).toBeNull();
  });

  it("summarizes only the current status checklist and ignores optional unfinished items for completion", () => {
    const summary = summarizeChecklist(
      [
        item("1", "PREPARATION", true),
        item("2", "PREPARATION", true),
        item("3", "PREPARATION", false, false),
        item("4", "ACTIVE", false),
      ],
      "PREPARATION",
    );

    expect(summary).toMatchObject({
      status: "PREPARATION",
      checkedCount: 2,
      totalCount: 3,
      requiredCheckedCount: 2,
      requiredTotalCount: 2,
      nextItemLabel: "item 3",
      isComplete: true,
    });
  });

  it("does not mark a status complete when it has no required checklist items", () => {
    expect(summarizeChecklist([], "ACTIVE").isComplete).toBe(false);
    expect(
      summarizeChecklist([item("1", "ACTIVE", false, false)], "ACTIVE").isComplete,
    ).toBe(false);
  });
});

/**
 * in-memory 가짜 Prisma — `setChecklistItemChecked`가 실제로 태우는 호출만
 * (`campaignChecklistItem`·`salesCampaign`·`campaignGroup`) 흉내낸다. 여러 캠페인·
 * 여러 항목을 등록할 수 있어 정산 그룹 형제 캐스케이드(여러 멤버 캠페인이 같은
 * groupId 를 공유)도 표현할 수 있다.
 *
 * 완료 전이(다음 상태로 넘어가는 분기) 자체를 확인하는 테스트가 아니면, 각 캠페인에
 * 항상 미체크 형제 항목을 하나 남겨 `summarizeChecklist().isComplete`가 false 로
 * 고정되게 한다(전이 로직이 `ensureCampaignChecklistForStatus`까지 타면서 캐스케이드
 * 검증과 무관한 코드 경로를 추가로 요구하게 되는 것을 피한다).
 */
function createFakeChecklistPrisma(options: {
  campaigns: Array<{ id: string; groupId: string | null; status?: string }>;
  items: Array<{
    id: string;
    campaignId: string;
    label: string;
    status?: string;
    isRequired?: boolean;
    isChecked?: boolean;
  }>;
  groups?: Array<{
    id: string;
    supplierInvoiceIssuedAt?: Date | null;
    sellerInvoiceIssuedAt?: Date | null;
  }>;
}) {
  const now = new Date("2026-05-19T00:00:00.000Z");
  const itemRows: Array<Record<string, unknown>> = options.items.map((i) => ({
    id: i.id,
    campaignId: i.campaignId,
    status: i.status ?? "SETTLEMENT_IN_PROGRESS",
    label: i.label,
    sortOrder: 0,
    isRequired: i.isRequired ?? true,
    isChecked: i.isChecked ?? false,
    completedAt: i.isChecked ? now : null,
    createdAt: now,
    updatedAt: now,
  }));

  const campaignStates = new Map<string, Record<string, unknown>>(
    options.campaigns.map((c) => [
      c.id,
      { id: c.id, status: c.status ?? "SETTLEMENT_IN_PROGRESS", groupId: c.groupId },
    ]),
  );
  const groupStates = new Map<string, Record<string, unknown>>(
    (options.groups ?? []).map((g) => [
      g.id,
      {
        id: g.id,
        supplierInvoiceIssuedAt: g.supplierInvoiceIssuedAt ?? null,
        sellerInvoiceIssuedAt: g.sellerInvoiceIssuedAt ?? null,
      },
    ]),
  );

  // 형제 캐스케이드가 실제로 다음 상태(COMPLETED 등)까지 전이시키는 케이스를 검증
  // 하려면 `ensureCampaignChecklistForStatus`(다음 상태 체크리스트 생성)가 타는
  // `campaignChecklistTemplate`·`campaignChecklistItem.createMany`도 최소한으로
  // 흉내내야 한다 — 없으면 전이 자체가 예외로 끊긴다.
  const templateRows: Array<Record<string, unknown>> = [];
  // Finding 3 계측 — `ensureDefaultChecklistTemplates`가 실제로 몇 번 "한 바퀴" 도는지
  // 세기 위한 카운터. upsert 호출 수 자체는 템플릿 총 개수(약 36건)에 좌우돼 매직넘버가
  // 되므로, 대신 "한 바퀴"(모든 (status,label) 조합을 1회씩 도는 것)가 몇 회
  // 반복됐는지를 같은 (status,label) 키가 다시 나타나는 횟수로 센다.
  const upsertKeySeenCount = new Map<string, number>();

  const tx = {
    campaignChecklistItem: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        itemRows.find((i) => i.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const found = itemRows.find((i) => i.id === where.id);
        if (!found) throw new Error("not found");
        Object.assign(found, data);
        return { ...found };
      },
      findMany: async ({
        where,
      }: {
        where: { campaignId?: string | { in: string[] }; status: string };
      }) =>
        itemRows.filter((i) => {
          if (i.status !== where.status) return false;
          if (!where.campaignId) return true;
          if (typeof where.campaignId === "string") return i.campaignId === where.campaignId;
          return where.campaignId.in.includes(i.campaignId as string);
        }),
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const d of data) {
          itemRows.push({
            id: `auto-${itemRows.length}`,
            isChecked: false,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
            ...d,
          });
        }
        return { count: data.length };
      },
    },
    campaignChecklistTemplate: {
      // 개명된 기본 템플릿 은퇴(`RETIRED_CHECKLIST_TEMPLATE_LABELS`)가 쓰는 경로.
      // 실제 Prisma 와 같은 시맨틱: 조건에 맞는 행만 갱신하고 갱신 건수를 돌려준다.
      updateMany: async ({
        where,
        data,
      }: {
        where: { status: string; label: string; isActive?: boolean };
        data: { isActive: boolean };
      }) => {
        const matched = templateRows.filter(
          (t) =>
            t.status === where.status &&
            t.label === where.label &&
            (where.isActive === undefined || t.isActive === where.isActive),
        );
        for (const row of matched) row.isActive = data.isActive;
        return { count: matched.length };
      },
      upsert: async ({
        where,
        create,
      }: {
        where: { status_label: { status: string; label: string } };
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      }) => {
        const { status, label } = where.status_label;
        const key = `${status}::${label}`;
        upsertKeySeenCount.set(key, (upsertKeySeenCount.get(key) ?? 0) + 1);
        let found = templateRows.find((t) => t.status === status && t.label === label);
        if (!found) {
          found = { id: `tmpl-${templateRows.length}`, ...create };
          templateRows.push(found);
        }
        return { ...found };
      },
      findMany: async ({ where }: { where: { status: string; isActive: boolean } }) =>
        templateRows
          .filter((t) => t.status === where.status && t.isActive === where.isActive)
          .map((t) => ({ ...t })),
    },
    salesCampaign: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = campaignStates.get(where.id);
        return found ? { ...found } : null;
      },
      findMany: async ({
        where,
      }: {
        where: { groupId: string; id?: { not: string } };
      }) =>
        [...campaignStates.values()]
          .filter((c) => c.groupId === where.groupId)
          .filter((c) => !where.id?.not || c.id !== where.id.not)
          .map((c) => ({ ...c })),
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const found = campaignStates.get(where.id);
        if (!found) throw new Error("CAMPAIGN_NOT_FOUND");
        Object.assign(found, data);
        return { ...found };
      },
    },
    campaignGroup: {
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const found = groupStates.get(where.id);
        if (!found) throw new Error("GROUP_NOT_FOUND");
        Object.assign(found, data);
        return { ...found };
      },
    },
  };

  const prisma = {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
  } as unknown as AppPrismaClient;

  return { prisma, campaignStates, groupStates, itemRows, upsertKeySeenCount };
}

describe("setChecklistItemChecked — 정산 그룹 캐스케이드 (2026-08-04)", () => {
  // 세무 처리 보드(campaign-row.ts)는 그룹에 속한 캠페인의 발행일을 캠페인 자체가
  // 아니라 그룹에서 읽는다(group 이 있으면 항상 그룹 값을 쓴다). 체크리스트 체크가
  // 캠페인 자체 필드만 갱신하면 그 값을 읽기 경로가 영원히 보지 못해, 「완료」를
  // 눌러도 보드의 같은 행이 그대로 남는다 — 이 테스트가 그 상태 변화(캠페인이 아니라
  // 그룹 필드가 실제로 바뀌는지)를 고정한다. PATCH 가 200 을 반환하는 것만으로는
  // 이 사고를 못 잡는다(PATCH 자체는 항상 성공했다) — 그래서 그룹 필드 값을 직접
  // 검증한다.
  it("그룹에 속한 캠페인의 공급사 발행 체크는 그룹 필드를 갱신하고, 캠페인 자체 필드는 건드리지 않는다", async () => {
    const { prisma, campaignStates, groupStates } = createFakeChecklistPrisma({
      campaigns: [{ id: "c1", groupId: "g1" }],
      items: [
        { id: "item-1", campaignId: "c1", label: "공급사 매입 세금계산서 발행" },
        { id: "item-1-sibling", campaignId: "c1", label: "대금 지급 및 입금 완료" },
      ],
      groups: [{ id: "g1", supplierInvoiceIssuedAt: null }],
    });

    await setChecklistItemChecked(prisma, "item-1", true);

    expect(groupStates.get("g1")?.supplierInvoiceIssuedAt).toBeInstanceOf(Date);
    // 캠페인 자체 필드는 애초에 갱신 데이터에 없어야 한다 — 세팅됐다면 두 곳에
    // 중복으로 쓴 것이고, 그룹 값이 null 로 남아 있는 한 읽기 경로는 여전히 이
    // 의무가 미완료라고 본다(이번 사고의 재현 조건).
    expect(campaignStates.get("c1")?.supplierInvoiceIssuedAt).toBeUndefined();
  });

  it("체크 해제(isChecked=false)도 같은 규칙으로 그룹 필드를 null 로 되돌린다", async () => {
    const { prisma, groupStates } = createFakeChecklistPrisma({
      campaigns: [{ id: "c1", groupId: "g1" }],
      items: [
        { id: "item-1", campaignId: "c1", label: "공급사 매입 세금계산서 발행", isChecked: true },
        { id: "item-1-sibling", campaignId: "c1", label: "대금 지급 및 입금 완료" },
      ],
      groups: [{ id: "g1", supplierInvoiceIssuedAt: new Date("2026-07-25") }],
    });

    await setChecklistItemChecked(prisma, "item-1", false);

    expect(groupStates.get("g1")?.supplierInvoiceIssuedAt).toBeNull();
  });

  it("그룹에 속하지 않은 캠페인은 여전히 캠페인 자체 필드를 갱신한다(회귀 방지)", async () => {
    const { prisma, campaignStates } = createFakeChecklistPrisma({
      campaigns: [{ id: "c2", groupId: null }],
      items: [
        { id: "item-1", campaignId: "c2", label: "셀러 수수료 확정 및 계산서 수취" },
        { id: "item-1-sibling", campaignId: "c2", label: "대금 지급 및 입금 완료" },
      ],
    });

    await setChecklistItemChecked(prisma, "item-1", true);

    expect(campaignStates.get("c2")?.sellerInvoiceIssuedAt).toBeInstanceOf(Date);
  });
});

describe("setChecklistItemChecked — 그룹 형제 체크리스트 항목 캐스케이드(2026-08-04 재검토)", () => {
  // 세무 처리 보드(tax-filing-board.ts)가 그룹당 한 행만 내도록 고쳐지면서, 「완료」는
  // 대표 멤버 한 명의 체크리스트 항목만 PATCH 한다. 그룹 공유 필드(위 describe)는
  // 그 한 번의 쓰기로 전 멤버에 반영되지만, 형제 멤버 자신의 체크리스트 항목(별개
  // DB 행)은 아무도 체크하지 않으면 영원히 isChecked=false 로 남아 그 멤버의 상태
  // 전이가 막힌다 — 이 블록이 그 stranding 을 재현·수정 확인한다.
  it("대표 멤버의 항목을 체크하면 형제 멤버의 같은 라벨 항목도 함께 체크된다", async () => {
    const { prisma, itemRows } = createFakeChecklistPrisma({
      campaigns: [
        { id: "m1", groupId: "g1" },
        { id: "m2", groupId: "g1" },
        { id: "m3", groupId: "g1" },
      ],
      items: [
        { id: "m1-invoice", campaignId: "m1", label: "확정 매출 기준 수수료 청구 세금계산서 발행" },
        { id: "m1-sibling", campaignId: "m1", label: "대금 입금 일정 확정" },
        { id: "m2-invoice", campaignId: "m2", label: "확정 매출 기준 수수료 청구 세금계산서 발행" },
        { id: "m2-sibling", campaignId: "m2", label: "대금 입금 일정 확정" },
        { id: "m3-invoice", campaignId: "m3", label: "확정 매출 기준 수수료 청구 세금계산서 발행" },
        { id: "m3-sibling", campaignId: "m3", label: "대금 입금 일정 확정" },
      ],
      groups: [{ id: "g1", supplierInvoiceIssuedAt: null }],
    });

    await setChecklistItemChecked(prisma, "m1-invoice", true);

    const m2Item = itemRows.find((i) => i.id === "m2-invoice");
    const m3Item = itemRows.find((i) => i.id === "m3-invoice");
    expect(m2Item?.isChecked).toBe(true);
    expect(m2Item?.completedAt).toBeInstanceOf(Date);
    expect(m3Item?.isChecked).toBe(true);
    // 형제의 다른 라벨 항목(대금 입금 일정 확정)은 건드리지 않는다 — 라벨이 다르면
    // 이 의무와 무관하다.
    expect(itemRows.find((i) => i.id === "m2-sibling")?.isChecked).toBe(false);
  });

  it("형제 항목까지 체크되면 형제 캠페인도 각자 다음 상태로 전이한다(stranding 해소 확인)", async () => {
    const { prisma, campaignStates } = createFakeChecklistPrisma({
      campaigns: [
        { id: "m1", groupId: "g1" },
        { id: "m2", groupId: "g1" },
      ],
      items: [
        // m1: 발행 항목만 남음(체크하면 그룹 필드에서 전이 완료).
        { id: "m1-invoice", campaignId: "m1", label: "확정 매출 기준 수수료 청구 세금계산서 발행" },
        // m2: 발행 항목 외 나머지 필수 항목은 이미 체크됨 — 발행 항목만 형제
        // 캐스케이드로 체크되면 m2 도 완료 조건을 채운다.
        { id: "m2-invoice", campaignId: "m2", label: "확정 매출 기준 수수료 청구 세금계산서 발행" },
        { id: "m2-schedule", campaignId: "m2", label: "대금 입금 일정 확정", isChecked: true },
        { id: "m2-final", campaignId: "m2", label: "수수료 입금 완료", isChecked: true },
      ],
      groups: [{ id: "g1", supplierInvoiceIssuedAt: null }],
    });

    await setChecklistItemChecked(prisma, "m1-invoice", true);

    // m2 는 형제 캐스케이드로 발행 항목까지 체크되어 필수 항목이 전부 체크됐으므로
    // SETTLEMENT_IN_PROGRESS 에서 다음 상태(COMPLETED)로 전이해야 한다.
    expect(campaignStates.get("m2")?.status).toBe("COMPLETED");
  });

  it("이미 체크된 형제 항목은 건드리지 않는다(멱등)", async () => {
    const { prisma, itemRows } = createFakeChecklistPrisma({
      campaigns: [
        { id: "m1", groupId: "g1" },
        { id: "m2", groupId: "g1" },
      ],
      items: [
        { id: "m1-invoice", campaignId: "m1", label: "확정 매출 기준 수수료 청구 세금계산서 발행" },
        {
          id: "m2-invoice",
          campaignId: "m2",
          label: "확정 매출 기준 수수료 청구 세금계산서 발행",
          isChecked: true,
        },
      ],
      groups: [{ id: "g1", supplierInvoiceIssuedAt: null }],
    });

    await setChecklistItemChecked(prisma, "m1-invoice", true);

    // 이미 체크돼 있었으므로 건드리지 않아야 한다 — completedAt 이 픽스처가 심어 둔
    // 원래 시각(2026-05-19) 그대로 유지되면(재갱신됐다면 다른 시각으로 바뀐다는 뜻은
    // 아니지만, 최소한 update() 호출 자체를 건너뛰었다는 증거로 원래 값을 그대로
    // 검증한다) 멱등성이 지켜진 것이다.
    const m2Item = itemRows.find((i) => i.id === "m2-invoice");
    expect(m2Item?.isChecked).toBe(true);
    expect(m2Item?.completedAt).toEqual(new Date("2026-05-19T00:00:00.000Z"));
  });

  it("발행 항목을 체크(→상태 전이)한 뒤 같은 항목을 다시 해제하면 그룹 필드도 형제 항목도 함께 되돌아간다(우회 취소)", async () => {
    // 작은 수정 사항 — 해제(uncheck) 캐스케이드는 코드 검토상 체크 캐스케이드와
    // 대칭이라 정확해 보이지만, 이 경로가 실제로 그룹 필드에 채워진 발행일을 N개
    // 캠페인에서 동시에 지우는 경로라 회귀 테스트가 없다는 점 자체가 위험이었다.
    const { prisma, groupStates, itemRows } = createFakeChecklistPrisma({
      campaigns: [
        { id: "m1", groupId: "g1" },
        { id: "m2", groupId: "g1" },
      ],
      items: [
        { id: "m1-invoice", campaignId: "m1", label: "확정 매출 기준 수수료 청구 세금계산서 발행", isChecked: true },
        { id: "m1-sibling", campaignId: "m1", label: "대금 입금 일정 확정", isChecked: true },
        { id: "m2-invoice", campaignId: "m2", label: "확정 매출 기준 수수료 청구 세금계산서 발행", isChecked: true },
        { id: "m2-sibling", campaignId: "m2", label: "대금 입금 일정 확정", isChecked: true },
      ],
      groups: [{ id: "g1", sellerInvoiceIssuedAt: new Date("2026-07-25") }],
    });

    await setChecklistItemChecked(prisma, "m1-invoice", false);

    // 그룹 공유 필드가 null 로 되돌아간다 — 체크 방향과 대칭.
    // 「확정 매출 기준 수수료 청구 세금계산서 발행」은 옛 셀러몰 라벨이라 상대 기준
    // 매퍼에서 셀러 필드로 잡힌다(하위호환 마크 "수수료 청구").
    expect(groupStates.get("g1")?.sellerInvoiceIssuedAt).toBeNull();
    // 형제(m2)의 같은 라벨 항목도 함께 해제된다 — 그룹 필드만 지워지고 형제 자신의
    // 체크리스트 행이 체크된 채로 남으면, 다음에 형제 쪽에서 다시 체크하려 해도
    // "이미 체크됨"으로 보여 해제-재체크 자체가 안 되는 상태가 된다.
    const m2Item = itemRows.find((i) => i.id === "m2-invoice");
    expect(m2Item?.isChecked).toBe(false);
    expect(m2Item?.completedAt).toBeNull();
    // 라벨이 다른 형제 항목(대금 입금 일정 확정)은 그대로 체크된 채여야 한다.
    expect(itemRows.find((i) => i.id === "m2-sibling")?.isChecked).toBe(true);
  });

  it("그룹에 속하지 않은 캠페인은 형제 동기화 자체를 건너뛴다(회귀 방지)", async () => {
    const { prisma, itemRows } = createFakeChecklistPrisma({
      campaigns: [{ id: "solo", groupId: null }],
      items: [
        { id: "solo-invoice", campaignId: "solo", label: "공급사 매입 세금계산서 발행" },
        { id: "solo-sibling", campaignId: "solo", label: "대금 지급 및 입금 완료" },
      ],
    });

    await expect(setChecklistItemChecked(prisma, "solo-invoice", true)).resolves.toBeDefined();
    expect(itemRows.find((i) => i.id === "solo-invoice")?.isChecked).toBe(true);
  });
});

describe("setChecklistItemChecked — Finding 3: 형제 캐스케이드가 전역 템플릿을 반복 재시딩하지 않는다", () => {
  // 실사고 재현 조건: 4인 그룹에서 발행 항목이 전원의 마지막 미체크 필수 항목이면
  // (이 보드가 존재하는 이유 자체가 그 상태를 쫓는 것이라 상시 발생하는 정상 케이스),
  // 대표를 체크하면 형제 3명도 각자 SETTLEMENT_IN_PROGRESS → COMPLETED 로 전이한다.
  // 그 전이마다 `ensureCampaignChecklistForStatus`(비-SETTLEMENT_IN_PROGRESS 분기)가
  // `ensureDefaultChecklistTemplates`(전역 템플릿 upsert, 여기서는 (status,label) 키
  // 기준)를 다시 태우면, 같은 키가 멤버 수만큼 반복해서 upsert 된다 — 실제 Prisma
  // 트랜잭션에서는 이게 순차 라운드트립을 3~4배로 불려 5000ms 기본 타임아웃(P2028)을
  // 넘길 수 있다. 이 테스트는 그 반복 횟수(=재시딩이 "한 바퀴" 몇 번 돌았는지)를 고정한다.
  it("4인 그룹 전원이 같은 트랜잭션에서 전이해도 전역 템플릿은 한 바퀴만 재시딘다", async () => {
    const { prisma, campaignStates, upsertKeySeenCount } = createFakeChecklistPrisma({
      campaigns: [
        { id: "m1", groupId: "g1" },
        { id: "m2", groupId: "g1" },
        { id: "m3", groupId: "g1" },
        { id: "m4", groupId: "g1" },
      ],
      items: [
        // 전원 발행 항목이 마지막 미체크 필수 항목 — 나머지는 이미 체크됨.
        { id: "m1-invoice", campaignId: "m1", label: "확정 매출 기준 수수료 청구 세금계산서 발행" },
        { id: "m1-schedule", campaignId: "m1", label: "대금 입금 일정 확정", isChecked: true },
        { id: "m1-final", campaignId: "m1", label: "수수료 입금 완료", isChecked: true },
        { id: "m2-invoice", campaignId: "m2", label: "확정 매출 기준 수수료 청구 세금계산서 발행" },
        { id: "m2-schedule", campaignId: "m2", label: "대금 입금 일정 확정", isChecked: true },
        { id: "m2-final", campaignId: "m2", label: "수수료 입금 완료", isChecked: true },
        { id: "m3-invoice", campaignId: "m3", label: "확정 매출 기준 수수료 청구 세금계산서 발행" },
        { id: "m3-schedule", campaignId: "m3", label: "대금 입금 일정 확정", isChecked: true },
        { id: "m3-final", campaignId: "m3", label: "수수료 입금 완료", isChecked: true },
        { id: "m4-invoice", campaignId: "m4", label: "확정 매출 기준 수수료 청구 세금계산서 발행" },
        { id: "m4-schedule", campaignId: "m4", label: "대금 입금 일정 확정", isChecked: true },
        { id: "m4-final", campaignId: "m4", label: "수수료 입금 완료", isChecked: true },
      ],
      groups: [{ id: "g1", supplierInvoiceIssuedAt: null }],
    });

    await setChecklistItemChecked(prisma, "m1-invoice", true);

    // 전제 확인 — 실제로 4명 전원이 COMPLETED 로 전이했다(이 회귀가 실제로 발생하는
    // 조건을 재현했는지 검증). 이게 거짓이면 아래 카운트 단정이 무의미하다.
    for (const id of ["m1", "m2", "m3", "m4"]) {
      expect(campaignStates.get(id)?.status).toBe("COMPLETED");
    }

    // 핵심 단정 — 어떤 (status,label) 키도 2회 이상 upsert 되지 않았다. 고쳐지기
    // 전이었다면 최대값이 멤버 수(4)에 가까웠을 것이다(대표 1 + 형제 3).
    const maxSeen = Math.max(...upsertKeySeenCount.values());
    expect(maxSeen).toBe(1);
  });
});

describe("라벨↔필드 매퍼 — 상대(공급사/셀러)만 본다", () => {
  // 방향 단어("발행"/"수취")로 판정하면 셀러몰 정정 후 라벨이 반대 필드로 간다.
  // 방향은 채널이 정하는 것이지 라벨 문구가 정하는 것이 아니다.
  const SUPPLIER_LABELS = [
    "공급사 매입 세금계산서 발행", // 우리몰
    "공급사 총 수수료 매출 세금계산서 발행", // 브랜드몰
    "공급사 물품대금 세금계산서 수취", // 셀러몰(신규)
  ];
  const SELLER_LABELS = [
    "셀러 수수료 확정 및 계산서 수취", // 우리몰
    "셀러 수수료 매입 세금계산서 수취", // 브랜드몰
    "셀러 수수료 청구 세금계산서 발행", // 셀러몰(신규)
    "확정 매출 기준 수수료 청구 세금계산서 발행", // 셀러몰(옛 라벨 — 이미 생성된 행)
  ];
  const NON_INVOICE_LABELS = [
    "대금 입금 일정 확정",
    "수수료 입금 완료",
    "대금 입/출금 및 회계 마감 완료",
    "지급 및 입금 일정 확정",
  ];

  it.each(SUPPLIER_LABELS)("공급사 라벨: %s", (label) => {
    expect(isSupplierInvoiceLabel(label)).toBe(true);
    expect(isSellerInvoiceLabel(label)).toBe(false);
  });

  it.each(SELLER_LABELS)("셀러 라벨: %s", (label) => {
    expect(isSellerInvoiceLabel(label)).toBe(true);
    expect(isSupplierInvoiceLabel(label)).toBe(false);
  });

  it.each(NON_INVOICE_LABELS)("계산서 항목이 아닌 라벨은 어느 쪽도 아니다: %s", (label) => {
    expect(isSupplierInvoiceLabel(label)).toBe(false);
    expect(isSellerInvoiceLabel(label)).toBe(false);
  });
});

// ⚠️ 이 블록은 **소스 상수를 직접 읽는다**(손으로 친 리터럴 사본이 아니다).
// 종전에는 라벨 목록을 테스트 파일에 다시 적어 두고 그것들끼리 비교했다 — 소스 라벨에
// 오타가 나도 초록으로 남는 구조였고, 하필 2026-08-09 변경이 정확히 그 라벨 문자열이었다.
describe("셀러몰 체크리스트 템플릿 · 5항목", () => {
  const SELLER_MALL_TEMPLATE_LABELS = SETTLEMENT_CHECKLIST_TEMPLATES.SELLER_MALL.map(
    (t) => t.label,
  );

  it("소스 템플릿이 5항목이고 라벨·순서가 계약 그대로다", () => {
    // 라벨은 계약이다 — `isSupplierInvoiceLabel`/`isSellerInvoiceLabel` 의 판정과
    // 백필 스크립트의 앵커가 이 문자열에 걸려 있다. 오타·문구 다듬기가 조용히
    // 통과하지 않도록 여기서 전문을 잠근다.
    expect(SELLER_MALL_TEMPLATE_LABELS).toEqual([
      "공급사 물품대금 세금계산서 수취",
      "셀러 수수료 청구 세금계산서 발행",
      "대금 입금 일정 확정",
      "수수료 입금 완료",
      // 2026-08-09 신설 — 셀러몰 자금 흐름의 마지막 단계.
      "공급사 물품대금 지급 완료",
    ]);
    expect(SETTLEMENT_CHECKLIST_TEMPLATES.SELLER_MALL.map((t) => t.sortOrder)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });

  it("두 계산서 항목이 각각 다른 필드로 매핑된다 — 한쪽으로 몰리지 않는다", () => {
    const [supplierLabel, sellerLabel] = SELLER_MALL_TEMPLATE_LABELS;
    expect(isSupplierInvoiceLabel(supplierLabel)).toBe(true);
    expect(isSellerInvoiceLabel(sellerLabel)).toBe(true);
    // 같은 필드로 몰리면 체크 하나가 다른 하나의 날짜를 덮어쓴다.
    expect(isSellerInvoiceLabel(supplierLabel)).toBe(false);
    expect(isSupplierInvoiceLabel(sellerLabel)).toBe(false);
  });

  it("신설 5번째 항목은 계산서 라벨이 아니다 — 체크가 발행일을 대신 찍으면 안 된다", () => {
    const last = SELLER_MALL_TEMPLATE_LABELS[4];
    expect(isSupplierInvoiceLabel(last)).toBe(false);
    expect(isSellerInvoiceLabel(last)).toBe(false);
  });
});

describe("계산서 라벨 매칭 — 방향 단어를 보지 않는다", () => {
  it("우리몰 신규 라벨(수취)을 공급사로 잡는다", () => {
    expect(isSupplierInvoiceLabel("공급사 매입 세금계산서 수취")).toBe(true);
    expect(isSellerInvoiceLabel("공급사 매입 세금계산서 수취")).toBe(false);
  });

  it("우리몰 옛 라벨(발행)도 계속 공급사로 잡는다 — 백필이 부분 적용돼도 안전해야 한다", () => {
    expect(isSupplierInvoiceLabel("공급사 매입 세금계산서 발행")).toBe(true);
  });

  it("셀러몰 신규 지급 항목은 계산서 라벨이 아니다", () => {
    expect(isSupplierInvoiceLabel("공급사 물품대금 지급 완료")).toBe(false);
    expect(isSellerInvoiceLabel("공급사 물품대금 지급 완료")).toBe(false);
  });
});
