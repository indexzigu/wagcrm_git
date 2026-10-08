"use client";

/**
 * 월별 정산 줄 1개의 펼침 편집기(T-240) — `monthly-settlement-panel.tsx` 가 줄마다 그린다.
 *
 * 저장 모델(ss-ux-designer 검토 2026-10-08): 금액·날짜·계산서 칸은 **초안 + [저장]**(거래액·요율·
 * 수수료액·공급가액/세액·지급액 폴백이 얽혀 있어 칸마다 저장하면 반쪽 상태가 서버에 쓰인다), 체크리스트
 * 4칸은 **즉시 저장**(형제 `InvoiceSlotBox` 의 체크와 같은 관례). 초안은 패널이 줄 id 로 들고 있어
 * 접어도 사라지지 않는다.
 *
 * 금액 규칙은 `src/lib/monthly-settlement.ts` 가 소유한다 — 여기서 식을 다시 쓰지 않는다.
 */
import { useEffect, useId, useRef } from "react";
import { Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  computeMonthlyCommission,
  formatMonthlyLineLabel,
  MONTHLY_CHECKLIST_ITEMS,
  splitMonthlyCommission,
  type MonthlyChecklistKey,
  type MonthlySettlementLine,
} from "@/lib/monthly-settlement";

/** 초안 칸 — 입력 그대로의 문자열. 빈칸 = 미입력(null). 수수료액 빈칸 = 자동(거래액 × 요율). */
export const MONTHLY_DRAFT_FIELDS = [
  "periodStart",
  "periodEnd",
  "quantity",
  "transactionAmount",
  "commissionRate",
  "commissionAmount",
  "salesInvoiceIssuedAt",
  "salesInvoiceNo",
  "salesInvoiceItemName",
  "purchaseInvoiceReceivedAt",
  "goodsAmount",
  "paymentAmount",
  "paymentDueDate",
  "paymentPaidAt",
  "memo",
] as const;

export type MonthlyDraftField = (typeof MONTHLY_DRAFT_FIELDS)[number];
export type MonthlyLineDraft = Record<MonthlyDraftField, string>;

const NUMBER_FIELDS = new Set<MonthlyDraftField>([
  "quantity",
  "transactionAmount",
  "commissionRate",
  "commissionAmount",
  "goodsAmount",
  "paymentAmount",
]);

/** 천 단위 구분으로 보이는 칸(금액·수량) — 접힌 행 머리의 「150,000원」과 같은 표기로 맞춘다. */
const GROUPED_FIELDS = new Set<MonthlyDraftField>(["quantity", "transactionAmount", "commissionAmount", "goodsAmount", "paymentAmount"]);

/** 숫자로 읽히면 천 단위 구분을 붙이고, 아니면 입력 그대로 둔다(저장 시 오류로 잡는다). */
export function formatGroupedNumber(raw: string): string {
  const parsed = parseNumber(raw);
  return typeof parsed === "number" ? parsed.toLocaleString("ko-KR") : raw;
}

/** 오류 문구에 쓰는 칸 이름 — 어느 칸이 틀렸는지 말해야 긴 폼에서 찾을 수 있다. */
const NUMBER_FIELD_LABELS: Partial<Record<MonthlyDraftField, string>> = {
  quantity: "주문수량",
  transactionAmount: "거래액",
  commissionRate: "수수료율",
  commissionAmount: "수수료액",
  goodsAmount: "물품대금",
  paymentAmount: "지급액",
};

export function toMonthlyLineDraft(line: MonthlySettlementLine): MonthlyLineDraft {
  const draft = {} as MonthlyLineDraft;
  for (const field of MONTHLY_DRAFT_FIELDS) {
    const value = line[field];
    draft[field] = value == null ? "" : GROUPED_FIELDS.has(field) ? Number(value).toLocaleString("ko-KR") : String(value);
  }
  // 저장된 수수료액이 자동 계산값과 같으면 빈칸(자동)으로 보여 준다 — 거래액을 고치면 따라온다.
  if (line.commissionAmount != null && line.commissionAmount === computeMonthlyCommission(line.transactionAmount, line.commissionRate)) {
    draft.commissionAmount = "";
  }
  return draft;
}

function parseNumber(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : "invalid";
}

/** 초안 → PATCH 본문. 숫자로 못 읽는 칸이 있으면 그 칸 이름을 돌려준다(저장하지 않는다). */
export function buildMonthlyLinePatch(
  draft: MonthlyLineDraft,
): { ok: true; body: Record<string, unknown> } | { ok: false; invalidField: MonthlyDraftField } {
  const body: Record<string, unknown> = {};
  for (const field of MONTHLY_DRAFT_FIELDS) {
    if (!NUMBER_FIELDS.has(field)) {
      body[field] = draft[field].trim() === "" ? null : draft[field].trim();
      continue;
    }
    const parsed = parseNumber(draft[field]);
    if (parsed === "invalid") return { ok: false, invalidField: field };
    body[field] = parsed;
  }
  if (body.commissionAmount == null) {
    body.commissionAmount = computeMonthlyCommission(
      body.transactionAmount as number | null,
      body.commissionRate as number | null,
    );
  }
  return { ok: true, body };
}

/** 화면에 보일 수수료액·공급가액·세액(초안 기준) — 빈칸이면 자동 계산값. */
export function resolveDraftCommission(draft: MonthlyLineDraft) {
  const tx = parseNumber(draft.transactionAmount);
  const rate = parseNumber(draft.commissionRate);
  const manual = parseNumber(draft.commissionAmount);
  const auto = computeMonthlyCommission(
    typeof tx === "number" ? tx : null,
    typeof rate === "number" ? rate : null,
  );
  const commission = typeof manual === "number" ? manual : auto;
  return { commission, auto, isManual: typeof manual === "number", ...splitMonthlyCommission(commission) };
}

const INPUT_CLASS =
  "h-7 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2 text-xs text-slate-800 outline-none transition-colors placeholder:text-slate-500 focus:border-primary focus:ring-1 focus:ring-focus-ring aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/40";
const READONLY_CLASS =
  "flex h-7 items-center justify-end rounded-lg border border-slate-100 bg-slate-50 px-2 text-xs tabular-nums text-slate-700";

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-xs font-medium text-slate-700">
      {children}
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
  numeric = false,
  grouped = false,
  placeholder,
  invalid = false,
  className,
  name,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  numeric?: boolean;
  /** 칸을 떠날 때 천 단위 구분을 붙인다(금액·수량). */
  grouped?: boolean;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
  name: MonthlyDraftField;
}) {
  const id = useId();
  return (
    <div className={cn("grid min-w-0 gap-1", className)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        type="text"
        inputMode={numeric ? "decimal" : undefined}
        value={value}
        placeholder={placeholder}
        data-field={name}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={grouped ? (event) => onChange(formatGroupedNumber(event.target.value)) : undefined}
        className={cn(INPUT_CLASS, numeric && "text-right tabular-nums")}
      />
    </div>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {/* 초안에 즉시 반영하는 제어 입력이다 — 저장은 [저장]이 하므로 InlineDateField 의 「입력 중
          세그먼트마다 저장되는」 문제가 없다. 그 컴포넌트(blur 커밋)를 쓰면 날짜만 고친 뒤 바로 [저장]을
          누를 때 저장 버튼이 아직 꺼져 있어 첫 클릭이 삼켜지고, Enter 커밋이 재마운트로 포커스를 잃는다
          (ss-ux-designer 검토 2026-10-08). */}
      <input id={id} type="date" value={value} onChange={(event) => onChange(event.target.value)} className={INPUT_CLASS} />
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-sm font-semibold text-foreground">{children}</div>;
}

export type MonthlyLineEditorProps = {
  line: MonthlySettlementLine;
  draft: MonthlyLineDraft;
  isDirty: boolean;
  isSaving: boolean;
  invalidField: MonthlyDraftField | null;
  /** 주문일 기준 참고값(그 달) — 마감 전이면 null. */
  reference: { orders: number; revenue: number } | null;
  pendingCheckKey: MonthlyChecklistKey | null;
  onDraftChange: (field: MonthlyDraftField, value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onToggleCheck: (key: MonthlyChecklistKey, checked: boolean) => void;
};

export function MonthlySettlementLineEditor({
  line,
  draft,
  isDirty,
  isSaving,
  invalidField,
  reference,
  pendingCheckKey,
  onDraftChange,
  onSave,
  onCancel,
  onDelete,
  onToggleCheck,
}: MonthlyLineEditorProps) {
  const commission = resolveDraftCommission(draft);
  const memoId = useId();
  const field = (name: MonthlyDraftField) => ({
    name,
    value: draft[name],
    onChange: (value: string) => onDraftChange(name, value),
    invalid: invalidField === name,
    grouped: GROUPED_FIELDS.has(name),
  });
  // 숫자 오류가 나면 그 칸으로 포커스를 옮긴다 — 알림은 폼 맨 아래라 틀린 칸이 화면 밖일 수 있다.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!invalidField) return;
    rootRef.current?.querySelector<HTMLInputElement>(`[data-field="${invalidField}"]`)?.focus();
  }, [invalidField]);

  return (
    <div ref={rootRef} className="grid gap-4 border-t border-slate-100 px-2 pb-3 pt-3">
      <section className="grid gap-2">
        <SectionTitle>귀속과 거래</SectionTitle>
        <div className="grid grid-cols-4 gap-x-3 gap-y-2">
          <DateField label="귀속 시작" value={draft.periodStart} onChange={(v) => onDraftChange("periodStart", v)} />
          <DateField label="귀속 종료" value={draft.periodEnd} onChange={(v) => onDraftChange("periodEnd", v)} />
          <TextField label="주문수량" numeric {...field("quantity")} />
          <TextField label="수수료율 (%)" numeric {...field("commissionRate")} />
          <TextField label="거래액" numeric className="col-span-2" {...field("transactionAmount")} />
        </div>
        <p className="text-xs text-slate-500">
          {reference ? (
            <>
              주문일 기준 참고값: 거래액 {formatCurrency(reference.revenue)}원 · 주문 {reference.orders}건 (판매관리
              거래액과 다를 수 있음){" "}
              <button
                type="button"
                className="rounded font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus-ring"
                onClick={() => onDraftChange("transactionAmount", reference.revenue.toLocaleString("ko-KR"))}
              >
                참고값 채우기
              </button>
            </>
          ) : (
            "주문일 기준 참고값은 캠페인 마감 후 표시됩니다."
          )}
        </p>
      </section>

      <section className="grid gap-2">
        <SectionTitle>수수료 매출 계산서</SectionTitle>
        <div className="grid grid-cols-3 gap-x-3 gap-y-2">
          <TextField
            label={commission.isManual ? "수수료액 (VAT 포함, 수동)" : "수수료액 (VAT 포함, 자동)"}
            numeric
            placeholder={commission.auto != null ? formatCurrency(commission.auto) : "거래액 × 요율"}
            {...field("commissionAmount")}
          />
          <div className="grid gap-1">
            <span className="text-xs font-medium text-slate-700">공급가액</span>
            <span className={READONLY_CLASS}>{formatCurrency(commission.supplyAmount)}</span>
          </div>
          <div className="grid gap-1">
            <span className="text-xs font-medium text-slate-700">세액</span>
            <span className={READONLY_CLASS}>{formatCurrency(commission.vat)}</span>
          </div>
          <DateField
            label="발행일"
            value={draft.salesInvoiceIssuedAt}
            onChange={(v) => onDraftChange("salesInvoiceIssuedAt", v)}
          />
          <TextField label="승인번호" {...field("salesInvoiceNo")} />
          <div aria-hidden="true" />
          <TextField
            label="품목명"
            className="col-span-3"
            placeholder={`예: ○○ 공동구매 ${formatMonthlyLineLabel(line.yearMonth).replace("분", "")}`}
            {...field("salesInvoiceItemName")}
          />
        </div>
      </section>

      <section className="grid gap-2">
        <SectionTitle>공급사 매입·지급</SectionTitle>
        <div className="grid grid-cols-3 gap-x-3 gap-y-2">
          <DateField
            label="매입 계산서 수취일"
            value={draft.purchaseInvoiceReceivedAt}
            onChange={(v) => onDraftChange("purchaseInvoiceReceivedAt", v)}
          />
          <TextField label="물품대금 (VAT 포함)" numeric {...field("goodsAmount")} />
          <TextField label="지급액" numeric placeholder="비우면 물품대금" {...field("paymentAmount")} />
          <DateField label="지급 기한" value={draft.paymentDueDate} onChange={(v) => onDraftChange("paymentDueDate", v)} />
          <DateField label="지급일" value={draft.paymentPaidAt} onChange={(v) => onDraftChange("paymentPaidAt", v)} />
        </div>
      </section>

      <section className="grid gap-2">
        <SectionTitle>체크리스트</SectionTitle>
        <p className="text-xs text-slate-500">
          체크 4칸이 모든 달에서 켜져야 정산을 완료할 수 있습니다. 위 날짜 입력과는 따로 체크합니다.
        </p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {MONTHLY_CHECKLIST_ITEMS.map((item) => {
            const checkedAt = line[item.key];
            const id = `${line.id}-${item.key}`;
            return (
              <div key={item.key} className="flex min-h-8 items-center gap-2 rounded-lg px-2 py-1">
                {/* 형제 InvoiceSlotBox 와 같은 네이티브 체크박스(ui/ 에 체크박스 프리미티브가 없다). */}
                <input
                  id={id}
                  type="checkbox"
                  checked={checkedAt != null}
                  disabled={pendingCheckKey === item.key}
                  onChange={(event) => onToggleCheck(item.key, event.target.checked)}
                  className="size-3.5 shrink-0 accent-primary"
                />
                <label htmlFor={id} className="min-w-0 flex-1 text-xs text-slate-700">
                  {item.label}
                </label>
                <span className="shrink-0 text-xs tabular-nums text-slate-500">{checkedAt ?? ""}</span>
              </div>
            );
          })}
        </div>
        <div className="grid gap-1">
          <FieldLabel htmlFor={memoId}>메모</FieldLabel>
          <textarea
            id={memoId}
            rows={2}
            value={draft.memo}
            onChange={(event) => onDraftChange("memo", event.target.value)}
            className="w-full resize-y rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-primary focus:ring-1 focus:ring-focus-ring"
          />
        </div>
      </section>

      {invalidField ? (
        <p role="alert" className="text-xs text-status-urgent-text">
          {NUMBER_FIELD_LABELS[invalidField] ?? "입력"}에 숫자가 아닌 값이 있어 저장하지 않았습니다. 숫자만 넣어주세요.
        </p>
      ) : null}

      <div className="flex items-center justify-between border-t border-slate-100 pt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-slate-500 hover:text-status-urgent-text"
          onClick={onDelete}
        >
          <Trash2 data-icon="inline-start" />
          삭제
        </Button>
        <div className="flex items-center gap-2">
          {isDirty ? (
            <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
              변경 취소
            </Button>
          ) : null}
          <Button type="button" size="sm" onClick={onSave} disabled={!isDirty || isSaving}>
            <Check data-icon="inline-start" />
            {isSaving ? "저장 중" : "저장"}
          </Button>
        </div>
      </div>
    </div>
  );
}
