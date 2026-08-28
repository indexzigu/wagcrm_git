import type { CampaignStatus } from "./crm-types";
import type { AppPrismaClient } from "./prisma-client";

export type ChecklistStatus = CampaignStatus;

/**
 * 세금계산서 체크리스트 라벨 판정 — 캠페인 마스터의 발행일 동기화와 세무 처리 보드가
 * 공유하는 SSOT. 복제하면 문구가 바뀔 때 한쪽만 따라간다.
 *
 * ⛔ **방향 단어("발행"/"수취")를 판정에 쓰지 않는다.** 방향은 채널이 정하고
 * (`TAX_INVOICE_OBLIGATION_TABLE`), 라벨이 말하는 것은 **상대**뿐이다. 종전 매퍼는
 * 둘을 섞어 써서(`"수수료 청구" && "발행"` → 공급사 필드) 셀러몰 정정 후 라벨을
 * 반대 필드로 보냈다.
 */

/** 옛 셀러몰 라벨(「확정 매출 기준 수수료 청구 세금계산서 발행」)에는 상대 단어가
 *  없다. 이미 생성된 체크리스트 행이 프로덕션에 남아 있으므로 계속 셀러로 잡는다 —
 *  이 하위호환 절을 "정리"하며 지우면 진행 중인 셀러몰 캠페인의 체크가 필드 동기화를
 *  잃는다. */
const LEGACY_SELLER_INVOICE_MARK = "수수료 청구";

export function isSellerInvoiceLabel(label: string): boolean {
  if (!label.includes("계산서")) return false;
  return label.includes("셀러") || label.includes(LEGACY_SELLER_INVOICE_MARK);
}

export function isSupplierInvoiceLabel(label: string): boolean {
  if (!label.includes("계산서")) return false;
  // 셀러 판정이 이긴다 — 신규 셀러몰 라벨은 "셀러"와 옛 표지를 둘 다 갖는다.
  if (isSellerInvoiceLabel(label)) return false;
  return label.includes("공급사");
}

export type CampaignChecklistItemRow = {
  id: string;
  campaignId: string;
  templateId: string | null;
  status: string;
  label: string;
  sortOrder: number;
  isRequired: boolean;
  isChecked: boolean;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ChecklistSummary = {
  status: ChecklistStatus;
  checkedCount: number;
  totalCount: number;
  requiredCheckedCount: number;
  requiredTotalCount: number;
  nextItemLabel: string | null;
  isComplete: boolean;
};

type ChecklistDb = Pick<
  AppPrismaClient,
  "campaignChecklistTemplate" | "campaignChecklistItem" | "salesCampaign"
>;

export const CAMPAIGN_STATUS_ORDER: CampaignStatus[] = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
  "DROPPED",
];

export const WORKSPACE_STATUS_GROUPS = {
  pipeline: [
    "PREPARATION",
    "ACTIVE",
    "CLOSED",
    "SETTLEMENT_WAIT",
    "SETTLEMENT_IN_PROGRESS",
    "COMPLETED",
  ],
  settlement: ["SETTLEMENT_IN_PROGRESS", "COMPLETED"],
} as const satisfies Record<string, readonly CampaignStatus[]>;

export const EXECUTION_CHECKLIST_GROUPS = {
  PREPARATION: [
    {
      title: "일정/조건 확정",
      items: ["행사 일정 확정", "기본 딜 조건 확인"],
    },
    {
      title: "상품/가격 확인",
      items: ["상품 구성 확인", "행사가격 및 공급가 확인"],
    },
    {
      title: "링크/트래킹 세팅",
      items: ["판매 링크 준비", "트래킹 링크 생성 및 검수"],
    },
    {
      title: "콘텐츠/운영자료 확인",
      items: ["셀러 전달 자료 확인", "콘텐츠 업로드 일정 확인"],
    },
    {
      title: "오픈 전 점검",
      items: ["오픈 전 최종 점검"],
    },
  ],
  ACTIVE: [
    {
      title: "링크/노출 확인",
      items: ["판매 링크 정상 노출 확인", "셀러 채널 노출 확인"],
    },
    {
      title: "매출 업데이트",
      items: ["실매출 업데이트", "주문 수 및 판매 수량 확인"],
    },
    {
      title: "문의/이슈 대응",
      items: ["문의 및 이슈 확인"],
    },
    {
      title: "일정/연장 여부 확인",
      items: ["행사 종료 일정 확인", "연장 여부 확인"],
    },
    {
      title: "종료 준비",
      items: ["마감 전 최종 공지 확인"],
    },
  ],
  CLOSED: [
    {
      title: "판매 종료 확인",
      items: ["판매 종료 확인", "판매 링크 종료 확인"],
    },
    {
      title: "최종 매출/주문 수 입력",
      items: ["최종 실매출 입력", "최종 주문 수 입력"],
    },
    {
      title: "비용/수수료 확인",
      items: ["운영 비용 확인", "수수료 기준 확인"],
    },
    {
      title: "운영 메모 정리",
      items: ["운영 이슈 및 특이사항 정리"],
    },
    {
      title: "정산 대기 전환 준비",
      items: ["반품기간 및 예상 입금일 확인"],
    },
  ],
  SETTLEMENT_WAIT: [
    {
      title: "반품 기간 확인",
      items: ["반품 가능 기간 확인", "반품기한 만료 확인"],
    },
    // 「몰 정산금」은 자사몰에만 있는 개념인데 3채널 전부에 붙어 있었다(브랜드몰은 공급사,
    // 셀러몰은 셀러가 입금한다). 게다가 자사몰은 그 입금이 캠페인 기간 동안 **일별**이라
    // 「예정일」이라는 단어 자체가 실효가 없다 — 채널 중립 문구로 통일한다(오너 확정
    // 2026-08-25). 아래 `RETIRED_CHECKLIST_TEMPLATE_LABELS` 가 구 라벨을 함께 은퇴시킨다.
    {
      title: "정산금 입금 확인",
      items: ["정산금 입금 일정 확인", "정산금 입금 여부 확인"],
    },
    {
      title: "최종 정산 기준 금액 확인",
      items: ["확정 매출 및 공제 금액 확인"],
    },
    {
      title: "정산 관리 이관",
      items: ["정산 진행 시작 가능 여부 확인"],
    },
  ],
} as const satisfies Partial<
  Record<CampaignStatus, ReadonlyArray<{ title: string; items: readonly string[] }>>
>;

function executionTemplates(status: keyof typeof EXECUTION_CHECKLIST_GROUPS) {
  return EXECUTION_CHECKLIST_GROUPS[status].flatMap((group) =>
    group.items.map((label) => ({ label })),
  );
}

export const DEFAULT_CAMPAIGN_CHECKLIST_TEMPLATES: Record<
  CampaignStatus,
  Array<{ label: string; isRequired?: boolean }>
> = {
  PROPOSAL: [
    { label: "제안 대상 셀러 확인" },
    { label: "제안 조건/상품 메모 정리" },
    { label: "셀러 제안 발송" },
  ],
  PREPARATION: executionTemplates("PREPARATION"),
  ACTIVE: executionTemplates("ACTIVE"),
  CLOSED: executionTemplates("CLOSED"),
  SETTLEMENT_WAIT: executionTemplates("SETTLEMENT_WAIT"),
  SETTLEMENT_IN_PROGRESS: [], // Generated dynamically based on salesChannel
  COMPLETED: [{ label: "완료 내역 검토", isRequired: false }],
  DROPPED: [{ label: "드랍 사유 및 후속 조치 기록", isRequired: false }],
};

export function getNextCampaignStatus(status: CampaignStatus): CampaignStatus | null {
  if (status === "SETTLEMENT_WAIT" || status === "COMPLETED" || status === "DROPPED") {
    return null;
  }
  const index = CAMPAIGN_STATUS_ORDER.indexOf(status);
  if (index < 0 || index >= CAMPAIGN_STATUS_ORDER.length - 1) return null;
  return CAMPAIGN_STATUS_ORDER[index + 1];
}

export function getWorkspaceStatuses(workspace: string | null): CampaignStatus[] | null {
  if (!workspace) return null;
  if (workspace in WORKSPACE_STATUS_GROUPS) {
    return [...WORKSPACE_STATUS_GROUPS[workspace as keyof typeof WORKSPACE_STATUS_GROUPS]];
  }
  return null;
}

export function summarizeChecklist(
  items: CampaignChecklistItemRow[] | undefined,
  status: CampaignStatus,
): ChecklistSummary {
  const currentItems = (items ?? [])
    .filter((item) => item.status === status)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const requiredItems = currentItems.filter((item) => item.isRequired);
  const checkedCount = currentItems.filter((item) => item.isChecked).length;
  const requiredCheckedCount = requiredItems.filter((item) => item.isChecked).length;
  const nextItem = currentItems.find((item) => !item.isChecked);

  return {
    status,
    checkedCount,
    totalCount: currentItems.length,
    requiredCheckedCount,
    requiredTotalCount: requiredItems.length,
    nextItemLabel: nextItem?.label ?? null,
    isComplete:
      requiredItems.length > 0 &&
      requiredItems.every((item) => item.isChecked),
  };
}

/**
 * 🪤 **기본 템플릿 라벨을 고치면 구 라벨 행이 살아남는다.**
 *
 * `ensureDefaultChecklistTemplates` 의 upsert 키가 `(status, label)` 이라, 라벨을 바꾸면
 * 새 행이 생기고 **구 행은 `isActive: true` 인 채로 남는다** — 그 뒤 SETTLEMENT_WAIT 에
 * 진입하는 캠페인은 구·신 항목을 **둘 다** 받는다(4항목이 6항목이 된다). 그래서 라벨
 * 개정은 반드시 은퇴 목록과 짝으로 한다.
 *
 * ⛔ **「기본 집합에 없는 행을 전부 끄기」로 일반화하지 말 것** — 오너가
 * `POST /api/campaign-checklist/templates` 로 직접 추가한 커스텀 항목이 함께 꺼진다.
 * 은퇴는 **우리가 실제로 개명한 라벨만** 이름으로 지목한다(감사 가능한 목록).
 *
 * ⚠️ 은퇴는 **템플릿만** 끈다 — 이미 만들어진 `CampaignChecklistItem` 행은 그대로 남아
 * 진행 중인 캠페인의 체크 이력이 사라지지 않는다.
 */
const RETIRED_CHECKLIST_TEMPLATE_LABELS: ReadonlyArray<{ status: CampaignStatus; label: string }> = [
  // 2026-08-25 — 채널 중립 문구로 개명(「몰 정산금 …」 → 「정산금 …」).
  { status: "SETTLEMENT_WAIT", label: "몰 정산금 입금 예정일 확인" },
  { status: "SETTLEMENT_WAIT", label: "몰 정산금 입금 여부 확인" },
];

export async function ensureDefaultChecklistTemplates(prisma: ChecklistDb) {
  for (const status of CAMPAIGN_STATUS_ORDER) {
    const templates = DEFAULT_CAMPAIGN_CHECKLIST_TEMPLATES[status];
    for (const [index, template] of templates.entries()) {
      await prisma.campaignChecklistTemplate.upsert({
        where: { status_label: { status, label: template.label } },
        update: {
          sortOrder: index,
          isRequired: template.isRequired ?? true,
          isActive: true,
        },
        create: {
          status,
          label: template.label,
          sortOrder: index,
          isRequired: template.isRequired ?? true,
          isActive: true,
        },
      });
    }
  }

  // 개명으로 고아가 된 구 라벨을 끈다. `updateMany` 라 행이 없으면 무해한 no-op 이고,
  // 이미 꺼져 있으면 그대로다(멱등).
  for (const retired of RETIRED_CHECKLIST_TEMPLATE_LABELS) {
    await prisma.campaignChecklistTemplate.updateMany({
      where: { status: retired.status, label: retired.label, isActive: true },
      data: { isActive: false },
    });
  }
}

/**
 * `ensureCampaignChecklistForStatus` 호출 여러 건이 한 `$transaction` 안에서 겹칠 때
 * `ensureDefaultChecklistTemplates`(전역 템플릿 upsert ~36건)를 한 번만 태우기 위한
 * 공유 플래그. Finding 3(2026-08-04 재검토) — `setChecklistItemChecked`가 정산 그룹
 * 형제 캠페인마다 이 함수를 다시 부르면서(`syncGroupSiblingChecklistItems`) 매번
 * 이 재시딩을 반복해, 4인 그룹이면 ~170회의 순차 라운드트립이 5000ms 기본
 * 트랜잭션 타임아웃(P2028)을 넘길 수 있었다. 템플릿은 전역·멱등이라 트랜잭션
 * 하나당 한 번이면 충분하다 — 참조를 넘기지 않는 기존 호출부(단발 API 라우트 등)는
 * 이 최적화 없이 항상 재시딩한다(동작 변화 없음, 하위 호환).
 */
export type TemplatesEnsuredRef = { done: boolean };

/** 정산 진행 체크리스트 템플릿 1행 — 채널 분기 3종이 공유하는 모양. */
export type SettlementChecklistTemplate = {
  label: string;
  isRequired: boolean;
  sortOrder: number;
};

/**
 * 채널별 정산 체크리스트 템플릿 (`SETTLEMENT_IN_PROGRESS` 전용).
 *
 * ⚠️ **모듈 레벨로 꺼내 둔 이유는 테스트가 라벨을 실제로 잠글 수 있게 하기 위해서다.**
 * 함수 안 지역 변수였을 때, 라벨 잠금 테스트는 손으로 친 리터럴을 자기들끼리 비교하고
 * 있었다 — 소스 라벨에 오타가 나도 초록으로 남는 구조였다(2026-08-09 전수 리뷰 지적).
 * 이제 `campaign-checklist.test.ts` 가 이 상수를 직접 읽어 대조한다.
 *
 * ⛔ 라벨은 계약이다 — `isSupplierInvoiceLabel`·`isSellerInvoiceLabel` 이 이 문자열로
 * 계산서 발행일 필드를 가르고, 정산 백필 스크립트도 같은 문자열을 앵커로 쓴다.
 */
export const SETTLEMENT_CHECKLIST_TEMPLATES = {
  OWN_MALL: [
    { label: "공급사 매입 세금계산서 수취", isRequired: true, sortOrder: 0 },
    { label: "셀러 수수료 확정 및 계산서 수취", isRequired: true, sortOrder: 1 },
    { label: "지급 및 입금 일정 확정", isRequired: true, sortOrder: 2 },
    { label: "대금 지급 및 입금 완료", isRequired: true, sortOrder: 3 },
  ],
  BRAND_MALL: [
    { label: "공급사 총 수수료 매출 세금계산서 발행", isRequired: true, sortOrder: 0 },
    { label: "셀러 수수료 매입 세금계산서 수취", isRequired: true, sortOrder: 1 },
    { label: "대금 입/출금 일정 확정", isRequired: true, sortOrder: 2 },
    { label: "대금 입/출금 및 회계 마감 완료", isRequired: true, sortOrder: 3 },
  ],
  // SELLER_MALL(UNSPECIFIED 포함) — 2026-08-07 오너 정정으로 공급사 물품대금 수취
  // 항목이 신설됐다. 종전 3항목에는 그 자리가 아예 없어서, 셀러몰의 공급사 수취
  // 의무를 오너가 체크할 방법이 없었다(수취 메일 대조 엔진도 그 이유로 추적을
  // 포기하고 있었다 — `expected-receivables.ts`).
  SELLER_MALL: [
    { label: "공급사 물품대금 세금계산서 수취", isRequired: true, sortOrder: 0 },
    { label: "셀러 수수료 청구 세금계산서 발행", isRequired: true, sortOrder: 1 },
    { label: "대금 입금 일정 확정", isRequired: true, sortOrder: 2 },
    { label: "수수료 입금 완료", isRequired: true, sortOrder: 3 },
    // 셀러몰 자금 흐름의 **마지막** 단계다(우리→브랜드사 물품대금 지급, 설계 §1).
    // 종전 템플릿엔 이 자리가 없어 추적이 끊겼다. ⛔ 라벨에 「계산서」를 넣지 말 것 —
    // 넣으면 체크 시 발행일 자동 연동이 발화해 받지도 않은 계산서가 완료로 굳는다.
    { label: "공급사 물품대금 지급 완료", isRequired: true, sortOrder: 4 },
  ],
} satisfies Record<string, SettlementChecklistTemplate[]>;

export async function ensureCampaignChecklistForStatus(
  prisma: ChecklistDb,
  campaignId: string,
  status: CampaignStatus,
  templatesEnsuredRef?: TemplatesEnsuredRef,
) {
  const existing = await prisma.campaignChecklistItem.findMany({
    where: { campaignId, status },
    orderBy: { sortOrder: "asc" },
  });
  if (existing.length > 0) return existing;

  if (status === "SETTLEMENT_IN_PROGRESS") {
    const campaign = await prisma.salesCampaign.findUnique({
      where: { id: campaignId },
      select: { salesChannel: true }
    });

    const isOwnMall = campaign?.salesChannel.startsWith("OWN_MALL");
    const isBrandMall = campaign?.salesChannel === "BRAND_MALL";

    // 라벨·순서의 정본은 모듈 상단 `SETTLEMENT_CHECKLIST_TEMPLATES` 다(테스트가 그
    // 상수를 직접 읽어 잠근다). 여기서는 채널 판정만 한다.
    const customTemplates: SettlementChecklistTemplate[] = isOwnMall
      ? SETTLEMENT_CHECKLIST_TEMPLATES.OWN_MALL
      : isBrandMall
        ? SETTLEMENT_CHECKLIST_TEMPLATES.BRAND_MALL
        : SETTLEMENT_CHECKLIST_TEMPLATES.SELLER_MALL;

    await prisma.campaignChecklistItem.createMany({
      data: customTemplates.map((template) => ({
        campaignId,
        templateId: null,
        status,
        label: template.label,
        sortOrder: template.sortOrder,
        isRequired: template.isRequired,
        isChecked: false,
      })),
    });
  } else {
    if (!templatesEnsuredRef || !templatesEnsuredRef.done) {
      await ensureDefaultChecklistTemplates(prisma);
      if (templatesEnsuredRef) templatesEnsuredRef.done = true;
    }
    const templates = await prisma.campaignChecklistTemplate.findMany({
      where: { status, isActive: true },
      orderBy: { sortOrder: "asc" },
    });

    if (templates.length > 0) {
      await prisma.campaignChecklistItem.createMany({
        data: templates.map((template) => ({
          campaignId,
          templateId: template.id,
          status,
          label: template.label,
          sortOrder: template.sortOrder,
          isRequired: template.isRequired,
          isChecked: false,
        })),
      });
    }
  }

  return prisma.campaignChecklistItem.findMany({
    where: { campaignId, status },
    orderBy: { sortOrder: "asc" },
  });
}

export async function ensureCampaignChecklistForCurrentStatus(
  prisma: ChecklistDb,
  campaignId: string,
) {
  const campaign = await prisma.salesCampaign.findUnique({
    where: { id: campaignId },
    select: { id: true, status: true },
  });
  if (!campaign) return [];

  return ensureCampaignChecklistForStatus(
    prisma,
    campaign.id,
    campaign.status as CampaignStatus,
  );
}

/**
 * 체크리스트 항목 하나가 체크됨으로써 그 항목의 캠페인이 다음 상태로 전이할 수
 * 있는지 재평가한다. `setChecklistItemChecked` 본체와 아래 형제 동기화
 * (`syncGroupSiblingChecklistItems`) 가 공유한다 — 그룹 형제 캠페인도 "이 상태의
 * 필수 항목이 전부 체크됐는가"를 똑같이 다시 물어야 하기 때문이다.
 */
async function advanceCampaignStatusIfChecklistComplete(
  tx: ChecklistDb,
  checklistItem: CampaignChecklistItemRow,
  templatesEnsuredRef?: TemplatesEnsuredRef,
): Promise<{ campaignStatus: CampaignStatus; transitioned: boolean }> {
  const campaign = await tx.salesCampaign.findUnique({
    where: { id: checklistItem.campaignId },
    select: { id: true, status: true },
  });
  if (!campaign) {
    throw new Error("CAMPAIGN_NOT_FOUND");
  }
  const currentStatus = campaign.status as CampaignStatus;
  if (checklistItem.status !== currentStatus) {
    return { campaignStatus: currentStatus, transitioned: false };
  }

  const items = await tx.campaignChecklistItem.findMany({
    where: { campaignId: checklistItem.campaignId, status: currentStatus },
    orderBy: { sortOrder: "asc" },
  });
  const nextItems = items.map((candidate) =>
    candidate.id === checklistItem.id ? checklistItem : candidate,
  );
  const summary = summarizeChecklist(nextItems, currentStatus);
  const nextStatus = getNextCampaignStatus(currentStatus);

  if (summary.isComplete && nextStatus) {
    const updatedCampaign = await tx.salesCampaign.update({
      where: { id: checklistItem.campaignId },
      data: { status: nextStatus },
      select: { id: true, status: true },
    });
    await ensureCampaignChecklistForStatus(tx, checklistItem.campaignId, nextStatus, templatesEnsuredRef);
    return { campaignStatus: updatedCampaign.status as CampaignStatus, transitioned: true };
  }
  return { campaignStatus: currentStatus, transitioned: false };
}

/**
 * 정산 그룹 형제 캠페인의 같은 라벨 체크리스트 항목을 함께 갱신한다.
 *
 * ⛔ 2026-08-04 재검토 지적("형제 항목 stranding"): 그룹의 발행일 공유 필드는 위
 * `setChecklistItemChecked` 본체가 그룹에 한 번만 쓰면 `campaign-row.ts` 폴딩으로
 * 전 멤버에 즉시 반영된다 — 그래서 세무 처리 보드는 형제 멤버에도 더는 해당 행을
 * 보여주지 않는다(이미 처리됨으로 보임). 하지만 그 형제 캠페인 **자신의**
 * `campaignChecklistItem` 행은 별개 레코드라 여전히 `isChecked: false`로 남는다.
 * 아무도 그 항목을 다시 체크할 계기가 없으므로(보드에 행이 없다) 그 형제 캠페인은
 * `summarizeChecklist` 가 "필수 항목 전부 체크"를 영원히 인정하지 못해
 * `SETTLEMENT_IN_PROGRESS`에서 다음 상태로 못 넘어가고 갇힌다 — 실제로는 그룹
 * 전체가 처리됐는데도. 그래서 그룹 캠페인의 발행/수취 항목을 체크(또는 해제)할
 * 때는 형제 캠페인들의 같은 라벨 항목도 함께 같은 값으로 맞추고, 그 형제 각각의
 * 상태 전이도 다시 평가한다.
 *
 * ⚠️ Finding 3(2026-08-04 재검토) — 형제마다 `advanceCampaignStatusIfChecklistComplete`
 * 를 부르고, 그게 상태 전이 시 `ensureCampaignChecklistForStatus`(비-SETTLEMENT_IN_PROGRESS
 * 분기)를 태우면 `ensureDefaultChecklistTemplates`(전역 템플릿 upsert ~36건)가 형제
 * 수만큼 반복된다. 4인 그룹이면 캠페인당 순차 라운드트립이 3~4배로 불어나
 * `$transaction` 기본 타임아웃(5000ms)을 넘길 수 있다 — 원인은 전역·멱등 데이터를
 * 캠페인마다 다시 시딩하는 중복 작업이므로, `templatesEnsuredRef`를 형제 루프 전체에
 * 공유해 트랜잭션당 한 번만 재시딩되게 한다(호출부인 `setChecklistItemChecked`가
 * 만든 참조를 그대로 전달).
 */
async function syncGroupSiblingChecklistItems(
  tx: ChecklistDb,
  params: {
    groupId: string;
    excludeCampaignId: string;
    status: string;
    matchesLabel: (label: string) => boolean;
    isChecked: boolean;
    templatesEnsuredRef: TemplatesEnsuredRef;
  },
): Promise<void> {
  const siblingCampaigns = await tx.salesCampaign.findMany({
    where: { groupId: params.groupId, id: { not: params.excludeCampaignId } },
    select: { id: true },
  });
  if (siblingCampaigns.length === 0) return;

  const siblingCampaignIds = siblingCampaigns.map((c) => c.id);
  const siblingItems = await tx.campaignChecklistItem.findMany({
    where: { campaignId: { in: siblingCampaignIds }, status: params.status },
  });

  for (const siblingItem of siblingItems) {
    if (!params.matchesLabel(siblingItem.label)) continue;
    if (siblingItem.isChecked === params.isChecked) continue; // 이미 같은 상태 — 건드릴 필요 없음

    const updatedSibling = await tx.campaignChecklistItem.update({
      where: { id: siblingItem.id },
      data: {
        isChecked: params.isChecked,
        completedAt: params.isChecked ? new Date() : null,
      },
    });
    await advanceCampaignStatusIfChecklistComplete(tx, updatedSibling, params.templatesEnsuredRef);
  }
}

export async function setChecklistItemChecked(
  prisma: AppPrismaClient,
  itemId: string,
  isChecked: boolean,
) {
  // Finding 3(2026-08-04 재검토) — 이 트랜잭션 안에서 벌어질 수 있는 모든
  // `ensureCampaignChecklistForStatus` 호출(본체 자신의 상태 전이 + 정산 그룹
  // 형제마다의 상태 전이)이 이 참조 하나를 공유한다. 그중 첫 호출만 전역 템플릿을
  // 재시딩하고, 나머지는 건너뛴다 — 재시딩할 대상이 하나도 없으면(아무도 전이하지
  // 않으면) 이 참조는 그냥 쓰이지 않고 끝난다(기존처럼 0회, 회귀 없음).
  const templatesEnsuredRef: TemplatesEnsuredRef = { done: false };

  return prisma.$transaction(async (tx) => {
    const item = await tx.campaignChecklistItem.findUnique({
      where: { id: itemId },
    });
    if (!item) {
      throw new Error("CHECKLIST_ITEM_NOT_FOUND");
    }

    const updatedItem = await tx.campaignChecklistItem.update({
      where: { id: itemId },
      data: {
        isChecked,
        completedAt: isChecked ? new Date() : null,
      },
    });

    const campaign = await tx.salesCampaign.findUnique({
      where: { id: item.campaignId },
      select: { id: true, status: true, groupId: true },
    });
    if (!campaign) {
      throw new Error("CAMPAIGN_NOT_FOUND");
    }

    // 3안. 세금계산서 발행/수취 체크 시 캠페인 마스터(또는 정산 그룹)의 발행 날짜 자동 연동.
    //
    // ⚠️ 정산 그룹에 속한 캠페인은 이 필드를 캠페인 자체가 아니라 그룹에서 읽는다
    // (`campaign-row.ts` — `group?.field === undefined ? campaign.field : group.field`,
    // 그룹이 있으면 필드가 null 이어도 항상 그룹 값을 쓴다). `campaigns/[id]/route.ts`의
    // PATCH 도 그룹 캠페인이면 캠페인 자체 필드는 건드리지 않고 그룹에만 쓴다
    // (`groupSharedEventUpdates`/`!isGrouped` 분기) — 두 쓰기 경로가 같은 규칙을 따라야
    // 읽기 경로와 어긋나지 않는다. 여기서 캠페인 자체 필드만 갱신하면(옛 코드) 그룹
    // 캠페인은 그 값을 영원히 읽지 못해 — 세무 처리 보드에서 「완료」를 눌러도 같은
    // 행이 그대로 남는 사고가 났다(2026-08-04 실사고). 그룹 유무에 따라 쓰는 대상만
    // 갈라 위 규칙과 맞춘다.
    if (item.status === "SETTLEMENT_IN_PROGRESS") {
      const isSupplierInvoice = isSupplierInvoiceLabel(item.label);
      const isSellerInvoice = isSellerInvoiceLabel(item.label);

      if (isSupplierInvoice || isSellerInvoice) {
        const fieldData = isSupplierInvoice
          ? { supplierInvoiceIssuedAt: isChecked ? new Date() : null }
          : { sellerInvoiceIssuedAt: isChecked ? new Date() : null };

        if (campaign.groupId) {
          await tx.campaignGroup.update({
            where: { id: campaign.groupId },
            data: fieldData,
          });
          // 그룹 필드는 이미 갱신됐다 — 이제 형제 캠페인들의 같은 라벨 체크리스트
          // 항목도 맞춰야 그 형제들이 stranding 되지 않는다(위 함수 docstring).
          await syncGroupSiblingChecklistItems(tx, {
            groupId: campaign.groupId,
            excludeCampaignId: item.campaignId,
            status: item.status,
            matchesLabel: isSupplierInvoice ? isSupplierInvoiceLabel : isSellerInvoiceLabel,
            isChecked,
            templatesEnsuredRef,
          });
        } else {
          await tx.salesCampaign.update({
            where: { id: item.campaignId },
            data: fieldData,
          });
        }
      }
    }

    const { campaignStatus, transitioned } = await advanceCampaignStatusIfChecklistComplete(
      tx,
      updatedItem,
      templatesEnsuredRef,
    );

    return { item: updatedItem, campaignStatus, transitioned };
  });
}
