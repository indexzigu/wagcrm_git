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

const MONEY_FIELDS = [
  ["costPrice", "원가"],
  ["supplyPrice", "공급가"],
  ["sellingPrice", "판매가"],
  ["listPrice", "정상가"],
  ["shippingFee", "배송비"],
] as const;

const PARTNER_TYPE_LABELS: Record<string, string> = {
  BRAND: "브랜드",
  VENDOR: "공급사",
  AGENCY: "대행사",
  AGENT: "에이전트",
  SELLER: "셀러",
};

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
  return MONEY_FIELDS.map(([key, label]) => [label, asMoney(source[key])] as const);
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
        ["구분", type ? (PARTNER_TYPE_LABELS[type] ?? type) : null],
        ["사업자번호", asText(partner.businessNumber)],
        ["대표자", asText(partner.ceoName)],
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
              {asText(contact.name) ?? "이름 없음"}
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
                {asText(option.dealName) ?? "이름 없음"}
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
        <SectionTitle>딜</SectionTitle>
        <Rows
          rows={[
            ["딜명", asText(mainDeal.dealName)],
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

/**
 * 저장될 값의 미리보기. 미리보기를 가진 action 만 그리고, 나머지는 `null` 을 돌려
 * 기존 표시(제목 한 줄)를 그대로 둔다.
 */
export function ProposalPayloadPreview({
  action,
  args,
}: {
  action: string | undefined;
  args: Record<string, unknown> | undefined;
}) {
  if (!args) return null;
  const body =
    action === "create_partner" ? (
      <CreatePartnerPreview args={args} />
    ) : action === "create_deal" ? (
      <CreateDealPreview args={args} />
    ) : null;
  if (!body) return null;
  return <div className="space-y-3 text-xs">{body}</div>;
}
