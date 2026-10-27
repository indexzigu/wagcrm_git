"use client";

/**
 * 승인 전에 **실제로 저장될 값**을 그대로 보여준다.
 *
 * ⚠️ 이 컴포넌트가 없던 동안 생성 기안의 승인 화면에는 제목 한 줄만 떴다. 판매가가
 * 1,000원이든 999,000원이든 카드가 같았다는 뜻이고, 그러면 승인 게이트는 무엇을
 * 승인하는지 모른 채 누르는 버튼이 된다. 제안서 사진에서 숫자를 잘못 읽는 것이
 * 이 경로의 주된 실패 방식이므로, **가격과 옵션 줄이 이 화면의 판단 가치**다
 * (`docs/agents/product-ux.md` Decision-Value Priority).
 *
 * 그래서 옵션 줄을 접거나 개수로 줄이지 않는다. 길면 스크롤하되 감추지는 않는다 —
 * 감춘 줄에 틀린 값이 있으면 이 화면을 만든 이유가 사라진다.
 */

import {
  formatSettlementAmountKrw,
  isSettlementAmountField,
  SETTLEMENT_AMOUNT_FIELD_LABELS,
} from "@/lib/settlement-amount-fields";
import {
  RECORD_ENTITY_LABELS,
  formatRecordValue,
  isRecordEntityType,
  recordFieldLabel,
} from "@/lib/record-update-labels";
import { displayLabel } from "@/lib/display-label";
import { plannedOptionDealName } from "@/lib/deal-display";
import { campaignStatusLabels, partnerTypeLabels } from "@/lib/crm-types";
import { FIELD_LABELS } from "@/lib/field-labels";
import { readCalendarInboundRef, type CalendarInboundRef } from "@/lib/calendar-inbound/ref";
import type { ProposalArgLabels } from "@/lib/agent/resolve-entity-label";
import { AlertTriangleIcon, ExternalLinkIcon } from "lucide-react";

// 직접 넣는 공급가(costPrice)와 자동 계산 공급가(supplyPrice)는 운영상 같은 돈이다(오너 확정 2026-10-15) — 둘 다
// 「공급가」. 한 줄에 둘이 **함께** 있을 때만 계산 칸을 「공급가(계산값)」로 가른다(활동 기록 FIELD_LABELS 와 같은 이름).
const MONEY_FIELDS = [
  ["costPrice", "공급가"],
  ["supplyPrice", "공급가"],
  ["sellingPrice", "판매가"],
  ["listPrice", "정상가"],
  ["shippingFee", "배송비"],
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asMoney(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toLocaleString("ko-KR")}원`
    : null;
}

function asRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
    : [];
}

/** 값이 없는 칸은 빈칸으로 두지 않고 아예 뺀다. 빈 라벨은 읽는 사람의 시간만 쓴다. */
function Rows({ rows }: { rows: readonly (readonly [string, string | null])[] }) {
  const filled = rows.filter((row): row is readonly [string, string] => row[1] !== null);
  if (filled.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {filled.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          {/* 공백 없는 긴 값(대표 이메일 등)이 `1fr` 트랙을 밀어 카드를 가로로 벌리는 것을 막는다. */}
          <dd className="min-w-0 break-words text-foreground tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="font-medium text-foreground">{children}</p>;
}

// 반환 타입을 적어 라벨을 `string` 으로 넓힌다. `as const` 가 만든 리터럴 유니온을
// 그대로 두면 아래 걸러내기의 타입 술어가 원소 타입에 안 맞는다.
function moneyRows(source: Record<string, unknown>): readonly (readonly [string, string | null])[] {
  const bothSupplyPrices = asMoney(source.costPrice) !== null && asMoney(source.supplyPrice) !== null;
  return MONEY_FIELDS.map(([key, label]) =>
    [key === "supplyPrice" && bothSupplyPrices ? FIELD_LABELS.supplyPrice : label, asMoney(source[key])] as const,
  );
}

function unitLabel(source: Record<string, unknown>): string | null {
  const unit = asText(source.unit);
  const quantity = typeof source.unitQuantity === "number" ? source.unitQuantity : null;
  if (unit && quantity !== null) return `${quantity.toLocaleString("ko-KR")}${unit}`;
  return unit ?? (quantity !== null ? quantity.toLocaleString("ko-KR") : null);
}

function PartnerBlock({ partner }: { partner: Record<string, unknown> }) {
  const type = asText(partner.type);
  return (
    <Rows
      rows={[
        ["거래처명", asText(partner.name)],
        ["구분", type ? (displayLabel(partnerTypeLabels, type)) : null],
        ["사업자번호", asText(partner.businessNumber)],
        ["대표자", asText(partner.ceoName)],
        ["업태", asText(partner.businessType)],
        ["종목", asText(partner.businessItem)],
        ["대표 이메일", asText(partner.representativeEmail)],
        ["주소", asText(partner.address)],
        ["메모", asText(partner.notes)],
      ]}
    />
  );
}

function ContactList({ contacts }: { contacts: Record<string, unknown>[] }) {
  if (contacts.length === 0) return null;
  return (
    <div className="space-y-1">
      <SectionTitle>담당자 {contacts.length}명</SectionTitle>
      <ul className="space-y-1">
        {contacts.map((contact, index) => {
          const role = asText(contact.role);
          const reach = [asText(contact.phoneNumber), asText(contact.email)].filter(Boolean);
          return (
            <li key={index} className="text-foreground">
              {asText(contact.name) ?? "이름없음"}
              {role ? <span className="text-muted-foreground"> ({role})</span> : null}
              {reach.length > 0 ? (
                <span className="text-muted-foreground"> · {reach.join(" · ")}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function OptionList({ options }: { options: Record<string, unknown>[] }) {
  if (options.length === 0) return null;
  return (
    <div className="space-y-1">
      <SectionTitle>옵션 {options.length}건</SectionTitle>
      {/* 길어지면 감추지 않고 스크롤한다. 감춘 줄의 틀린 값은 잡을 방법이 없다. */}
      <ul className="max-h-64 space-y-1.5 overflow-y-auto">
        {options.map((option, index) => {
          const prices = moneyRows(option).filter(
            (row): row is readonly [string, string] => row[1] !== null,
          );
          const unit = unitLabel(option);
          const memo = asText(option.sourcingMemo);
          return (
            <li key={index} className="space-y-0.5">
              <p className="text-foreground">
                {asText(option.dealName) ?? "이름없음"}
                {unit ? <span className="text-muted-foreground"> · {unit}</span> : null}
              </p>
              {/* 가격은 흐리게 두지 않는다 — 사진에서 잘못 읽히는 값이 바로 이것이라
                  옵션명보다 약하게 보이면 이 화면을 만든 이유가 없어진다. */}
              {prices.length > 0 && (
                <p className="text-foreground tabular-nums">
                  {prices.map(([label, value]) => `${label} ${value}`).join(" · ")}
                </p>
              )}
              {memo ? <p className="text-muted-foreground">{memo}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CreatePartnerPreview({ args }: { args: Record<string, unknown> }) {
  const partner = asRecord(args.partner);
  if (!partner) return null;
  return (
    <>
      <PartnerBlock partner={partner} />
      <ContactList contacts={asRecordList(args.contacts)} />
    </>
  );
}

function CreateDealPreview({ args }: { args: Record<string, unknown> }) {
  const mainDeal = asRecord(args.mainDeal);
  if (!mainDeal) return null;
  const newPartner = asRecord(args.partner);
  return (
    <>
      {/* 이미 등록된 거래처는 여기서 다시 적지 않는다. 그 경우 기안에 대상 엔티티가
          달리고 카드의 배지가 **해석된 상호**를 이미 보여준다(`resolveEntityLabel`).
          여기에 `partnerId` 를 찍으면 같은 정보를 내부 id 로 한 번 더 보여주는 셈인데,
          승인자는 그 문자열로 "맞는 거래처인가"를 판단할 수 없다 — 값 없는 칸을 빼는
          이 컴포넌트의 규칙을 어기면서 의미 없는 값을 채우는 자리가 된다. */}
      {newPartner && (
        <div className="space-y-1">
          <SectionTitle>거래처도 새로 등록됩니다</SectionTitle>
          <PartnerBlock partner={newPartner} />
        </div>
      )}
      <div className="space-y-1">
        <SectionTitle>판매 조건</SectionTitle>
        <Rows
          rows={[
            ["판매 조건 이름", asText(mainDeal.dealName)],
            ["브랜드", asText(mainDeal.brandName)],
            ["단위", unitLabel(mainDeal)],
            ...moneyRows(mainDeal),
            ["메모", asText(mainDeal.sourcingMemo)],
          ]}
        />
      </div>
      <OptionList options={asRecordList(args.optionDeals)} />
    </>
  );
}

/** 정수 금액 또는 null(비어 있음). 그 밖의 값은 「모양이 깨진 기안」이라 표시하지 않는다. */
function asAmountOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 정산 금액 수정 — **무엇을 무엇으로** 바꾸는지가 이 기안의 판단 가치 전부다.
 *
 * 「지금 값」은 기안자가 본 값이고 실행기는 실제 값이 이것과 같을 때만 고친다 — 그래서 이
 * 값을 숨기면 승인자는 무엇 위에 덮어쓰는지 모른다. `null` 은 「비어 있음」으로 적는다
 * (0원과 다르다 — 물품대금의 0 은 다른 캠페인 계산서에 합산됐다는 표시다).
 */
function UpdateSettlementAmountPreview({ args }: { args: Record<string, unknown> }) {
  const field = args.field;
  const expected = asAmountOrNull(args.expectedCurrentKrw);
  const next = asAmountOrNull(args.newAmountKrw);
  if (!isSettlementAmountField(field) || expected === undefined || next === undefined || next === null) {
    return null;
  }
  return (
    <Rows
      rows={[
        ["항목", SETTLEMENT_AMOUNT_FIELD_LABELS[field]],
        ["지금 값", formatSettlementAmountKrw(expected)],
        ["바꿀 값", formatSettlementAmountKrw(next)],
        ["메모", asText(args.memo)],
      ]}
    />
  );
}

/** 기록 수정의 값 한 칸 — 계약이 받는 스칼라만. 그 밖은 「모양이 깨진 기안」이다. */
function isRecordScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/**
 * 기록 수정 — 칸마다 **지금 값 → 바꿀 값**. 「지금 값」은 기안자가 본 값이고 실행기는 실제 값이 이것과
 * 같을 때만 고친다. 칸 이름은 화면 이름 표에서, 표에 없으면 칸 이름 그대로 보인다.
 * 칸을 접거나 개수로 줄이지 않는다(머리 주석 — 감춘 줄에 틀린 값이 있으면 이 화면의 의미가 사라진다).
 * 대상 칸은 종류(「캠페인」)가 아니라 서버가 푼 그 대상의 이름을 보인다 — 종류만으로는 어느 캠페인인지
 * 판단할 수 없다. 이름을 못 풀었으면 칸을 뺀다(값 없는 칸은 빼는 이 컴포넌트의 규칙).
 */
function UpdateRecordPreview({
  args,
  targetEntityName,
}: {
  args: Record<string, unknown>;
  targetEntityName: string | null | undefined;
}) {
  const entityType = args.entityType;
  const changes = asRecord(args.changes);
  const expected = asRecord(args.expected);
  if (!isRecordEntityType(entityType) || !changes || !expected) return null;
  const fields = Object.keys(changes);
  if (
    fields.length === 0 ||
    fields.some((field) => !Object.hasOwn(expected, field) || !isRecordScalar(changes[field]) || !isRecordScalar(expected[field]))
  ) {
    return null;
  }
  return (
    <>
      <Rows
        rows={[
          [RECORD_ENTITY_LABELS[entityType], targetEntityName && targetEntityName.trim() !== "" ? targetEntityName : null],
          ["메모", asText(args.memo)],
        ]}
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {fields.map((field) => (
          <div key={field} className="contents">
            <dt className="text-muted-foreground">{recordFieldLabel(entityType, field)}</dt>
            <dd className="min-w-0 break-words text-foreground tabular-nums">
              {formatRecordValue(entityType, field, expected[field])} → {formatRecordValue(entityType, field, changes[field])}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** 코드 한 칸. 빈 문자열은 「코드가 비어 있다」는 값이라 빈칸으로 두지 않고 말로 적는다. */
function mappingCodeText(code: string): string {
  return code === "" ? "(빈 코드)" : code;
}

interface MappingRow {
  optionName: string;
  productName: string | null;
  nextCode: string;
  nextPrice: number;
  /** 새 줄이면 null. 고칠 줄이면 기안자가 본 지금 값. */
  current: { code: string | null; price: number | null } | null;
}

/** 줄 하나를 읽는다. 모양이 깨졌으면 null — 하나라도 깨지면 표 전체를 그리지 않는다(아래). */
function readMappingRow(raw: unknown): MappingRow | null {
  const row = asRecord(raw);
  if (!row) return null;
  const optionName = asText(row.optionName);
  const nextCode = typeof row.brandCode === "string" ? row.brandCode : null;
  const nextPrice = typeof row.price === "number" && Number.isFinite(row.price) ? row.price : null;
  if (optionName === null || nextCode === null || nextPrice === null) return null;
  const expectedCode = typeof row.expectedBrandCode === "string" ? row.expectedBrandCode : null;
  const expectedPrice =
    typeof row.expectedPrice === "number" && Number.isFinite(row.expectedPrice) ? row.expectedPrice : null;
  return {
    optionName,
    // 빈 문자열은 「비운다」는 값이라 asText 로 걸러 버리지 않는다.
    productName: typeof row.productName === "string" ? row.productName : null,
    nextCode,
    nextPrice,
    current: expectedCode === null && expectedPrice === null ? null : { code: expectedCode, price: expectedPrice },
  };
}

function mappingProductNameText(row: MappingRow): string {
  if (row.current === null) {
    // 새 줄: 지금 값이 없으니 비움/그대로 구분이 의미 없다.
    return row.productName !== null && row.productName.trim() !== "" ? row.productName : "(없음)";
  }
  // 고칠 줄: 기안에는 지금 상품명이 없다. 새 값만 적고, 비우는 것과 그대로 두는 것은 말로 가른다.
  if (row.productName === null) return "(그대로)";
  return row.productName === "" ? "(비움)" : row.productName;
}

/**
 * 상품 매핑 등록·수정 — 옵션 줄마다 **지금 → 바꿀** 코드·가격. 코드(`brandCode`)가 틀리면 주문 변환이
 * 잘못된 상품으로 나가므로 모든 줄을 접지 않고 그린다(머리 주석). 상품명은 기안에 「지금 값」이 없어
 * 새 값만 보인다.
 */
function UpsertProductMappingsPreview({ args }: { args: Record<string, unknown> }) {
  if (!Array.isArray(args.mappings) || args.mappings.length === 0) return null;
  const rows = args.mappings.map(readMappingRow);
  if (rows.some((row) => row === null)) return null;
  const mappings = rows as MappingRow[];
  const campaign = asText(args.orderCampaignName) ?? asText(args.orderCampaignId);
  const memo = asText(args.memo);
  // 새 줄이 있으면 승인 뒤 캠페인 전체 자동 연결이 돈다(실행기 effects · 화면 저장과 같은 재채점) —
  // 새 줄만이 아니라 기존 줄 연결도 바뀔 수 있으니 승인 전에 알린다. 고치기만 하면 돌지 않는다.
  const hasNewRow = mappings.some((row) => row.current === null);
  return (
    <>
      {campaign && <p className="font-medium text-foreground">주문캠페인: {campaign}</p>}
      {memo && <p className="text-muted-foreground">메모: {memo}</p>}
      {hasNewRow && (
        <p className="text-muted-foreground">
          승인하면 화면 저장과 같이 이 캠페인 전체의 판매 조건 자동 연결이 다시 돕니다(기존 연결이 바뀔 수 있음).
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left tabular-nums">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 pr-3 font-normal">옵션명</th>
              <th className="py-1 pr-3 font-normal">상품명</th>
              <th className="py-1 pr-3 font-normal">지금(코드 / 가격)</th>
              <th className="py-1 font-normal">바꿀(코드 / 가격)</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((row, index) => (
              <tr key={index} className="align-top text-foreground">
                <td className="py-1 pr-3 break-words">{row.optionName}</td>
                <td className="py-1 pr-3 break-words">{mappingProductNameText(row)}</td>
                <td className="py-1 pr-3 break-words">
                  {row.current === null
                    ? "없음(새로 추가)"
                    : `${row.current.code === null ? "—" : mappingCodeText(row.current.code)} / ${asMoney(row.current.price) ?? "—"}`}
                </td>
                <td className="py-1 break-words">{`${mappingCodeText(row.nextCode)} / ${asMoney(row.nextPrice)}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** 「27,000원 · 총수수료율 18%」 — 품목 표의 「총수수료율」과 같은 이름(셀러 수수료율과 가른다). */
function priceWithCommission(price: unknown, commission: unknown): string | null {
  const money = asMoney(price);
  if (money === null) return null;
  return typeof commission === "number" ? `${money} · 총수수료율 ${commission}%` : money;
}

/**
 * 캠페인 품목 추가(T-271) — 어느 캠페인의 어떤 판매 조건 밑에, 무엇을 새로 만들고 무엇을 연결하는지. 판매가가 판단
 * 가치라 새 줄·연결 줄 모두 판매가를 흐리지 않고 보인다(위 옵션 목록과 같은 규칙). 연결 줄은 args 에 id 만 있어 이름·
 * 판매가는 서버가 푼 `argLabels.linkedDeals` 로 보인다 — 못 풀었으면 id 를 내보이지 않고 「이름 확인 불가」로 둔다
 * (승인자는 id 로 판단할 수 없다). 화면 낱말은 품목 표(`campaign-deals-table.tsx`)와 같다: 캠페인 · 품목 · 주문수량.
 */
function AddCampaignItemsPreview({
  args,
  labels,
  targetEntityName,
}: {
  args: Record<string, unknown>;
  labels: ProposalArgLabels | null | undefined;
  targetEntityName: string | null | undefined;
}) {
  const items = asRecordList(args.items);
  if (items.length === 0) return null;
  return (
    <>
      <Rows
        rows={[
          ["캠페인", asText(targetEntityName)],
          ["판매 조건", labels?.deal ?? null],
          ["메모", asText(args.memo)],
        ]}
      />
      <p className="text-muted-foreground">
        승인하면 매출 상세내역에 주문수량 0인 품목이 더해집니다. 기존 품목은 바뀌지 않습니다.
      </p>
      <div className="max-h-64 overflow-x-auto overflow-y-auto">
        <table className="w-full border-collapse text-left tabular-nums">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 pr-3 font-normal">하위품목</th>
              <th className="py-1 pr-3 font-normal">처리</th>
              <th className="py-1 font-normal">판매가</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row, index) => {
              const dealId = asText(row.dealId);
              const linked = dealId ? (labels?.linkedDeals?.[dealId] ?? null) : null;
              const newName = asText(row.dealName);
              const unitQuantity = typeof row.unitQuantity === "number" ? row.unitQuantity : undefined;
              // 새 하위품목은 실행기가 저장할 이름(`plannedOptionDealName` — 판매 조건 화면 규칙)으로 보인다. 판매 조건을 못
              // 풀었거나 단위 수량이 빠졌으면(승인 때 거절된다) 받은 글자 그대로.
              const planned = labels?.deal
                ? plannedOptionDealName({ dealName: labels.deal, unit: labels.dealUnit ?? null }, { dealName: newName ?? "", unitQuantity })
                : null;
              const name = dealId ? (linked?.name ?? "이름 확인 불가") : (planned ?? newName ?? "이름없음");
              const price = dealId
                ? linked && priceWithCommission(linked.sellingPrice, linked.totalCommissionRate)
                : priceWithCommission(row.sellingPrice, row.totalCommissionRate);
              return (
                <tr key={index} className="align-top text-foreground">
                  <td className="py-1 pr-3 break-words">{name}</td>
                  <td className="py-1 pr-3">{dealId ? "기존 하위품목 연결" : "새로 만들기"}</td>
                  <td className="py-1 break-words">{price ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** `YYYY-MM-DD` 두 날 → 「시작 ~ 끝」, 같은 날이면 하루만. */
function periodText(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  return start === end ? start : `${start} ~ ${end}`;
}

/**
 * [캘린더수집] 새 회차 생성 — 누구(셀러)의 어떤 판매 조건으로 언제 여는지. args 에는 id 만 있어 이름은
 * 서버가 푼 `argLabels` 로 보인다(`resolveProposalArgLabels`). 못 풀었으면 그 칸을 id 로 채우지 않고 뺀다 —
 * 승인자는 id 문자열로 「맞는 셀러인가」를 판단할 수 없다(위 판매 조건 미리보기의 거래처 칸과 같은 규칙).
 * 상태는 캠페인 상태 라벨 표의 말(세팅대기)을 그대로 쓴다 — 같은 상태를 화면마다 다른 말로 부르지 않는다.
 */
function CreateCampaignRoundPreview({
  args,
  labels,
}: {
  args: Record<string, unknown>;
  labels: ProposalArgLabels | null | undefined;
}) {
  const period = periodText(asText(args.startDate), asText(args.endDate));
  if (!period) return null;
  return (
    <Rows
      rows={[
        ["셀러", labels?.seller ?? null],
        ["판매 조건", labels?.deal ?? null],
        ["기간", period],
        ["상태", `${campaignStatusLabels.PREPARATION}로 생성`],
      ]}
    />
  );
}

/**
 * [캘린더수집] 이 기안을 만든 구글 캘린더 일정 — 흐린 한 줄 「원본: 제목 · 날짜 · 구글 캘린더에서 보기」.
 * 판단의 주인공은 위의 바뀔 칸이고, 원문은 해석이 맞는지 대조하는 근거라 그 아래에 조용히 둔다.
 * 링크는 `https://` 만 그린다(출처 스키마 `calendarInboundRefSchema` 가 그 밖의 값을 null 로 접는다).
 */
function CalendarOriginLine({ origin }: { origin: CalendarInboundRef }) {
  const parts = [origin.summary.trim(), periodText(origin.startDate, origin.endDate)].filter(
    (part): part is string => !!part,
  );
  return (
    <p className="min-w-0 break-words text-muted-foreground">
      원본: {parts.join(" · ")}
      {origin.htmlLink ? (
        <>
          {" · "}
          <a
            href={origin.htmlLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            구글 캘린더에서 보기
            <ExternalLinkIcon aria-hidden className="size-3" />
          </a>
        </>
      ) : null}
    </p>
  );
}

/**
 * [캘린더수집] 해석하면서 짐작한 것 — 승인 버튼 바로 위에 둔다(누르기 직전에 읽히게). 색은 주의 단계
 * (`status-caution`)를 아이콘에만 싣고 글자는 본문색이다 — 경고마다 빨갛게 칠하면 매번 뜨는 색이라 신호를 잃는다.
 */
function CalendarWarnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-1">
      <SectionTitle>확인할 점</SectionTitle>
      <ul className="space-y-0.5">
        {warnings.map((warning, index) => (
          <li key={`${index}-${warning}`} className="flex items-start gap-1.5 text-foreground">
            <AlertTriangleIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-status-caution" />
            {warning}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 저장될 값의 미리보기. 미리보기를 가진 action 만 그리고, 나머지는 `null` 을 돌려
 * 기존 표시(제목 한 줄)를 그대로 둔다.
 *
 * [캘린더수집] `sourceRef` 에 캘린더 출처(`calendarInbound`)가 있으면 액션과 무관하게 바뀔 칸 아래에 흐린
 * 「원본:」 한 줄과 「확인할 점」을 그 순서로 그린다. 출처 모양은 서버와 같은 리더(`readCalendarInboundRef`)로 읽는다 — sqlite
 * 레인의 문자열 저장도 거기서 푼다.
 */
export function ProposalPayloadPreview({
  action,
  args,
  sourceRef,
  argLabels,
  targetEntityName,
}: {
  action: string | undefined;
  args: Record<string, unknown> | undefined;
  /** 기안 출처 칸 원본(역직렬화 전이어도 된다). */
  sourceRef?: unknown;
  /** 서버가 args 의 id 를 이름으로 푼 것(새 회차 생성 · 캠페인 품목 추가). */
  argLabels?: ProposalArgLabels | null;
  /** 기안 대상의 이름(서버 해석 `targetEntityName`) — 기록 수정의 대상 칸에 쓴다. */
  targetEntityName?: string | null;
}) {
  const origin = readCalendarInboundRef(sourceRef);
  const body = !args ? null :
    action === "create_partner" ? (
      <CreatePartnerPreview args={args} />
    ) : action === "create_deal" ? (
      <CreateDealPreview args={args} />
    ) : action === "update_settlement_amount" ? (
      <UpdateSettlementAmountPreview args={args} />
    ) : action === "update_record" ? (
      <UpdateRecordPreview args={args} targetEntityName={targetEntityName} />
    ) : action === "upsert_product_mappings" ? (
      <UpsertProductMappingsPreview args={args} />
    ) : action === "create_campaign_round" ? (
      <CreateCampaignRoundPreview args={args} labels={argLabels} />
    ) : action === "add_campaign_items" ? (
      <AddCampaignItemsPreview args={args} labels={argLabels} targetEntityName={targetEntityName} />
    ) : null;
  if (!body && !origin) return null;
  return (
    <div className="space-y-3 text-xs">
      {body}
      {origin && <CalendarOriginLine origin={origin} />}
      {origin && <CalendarWarnings warnings={origin.warnings} />}
    </div>
  );
}
