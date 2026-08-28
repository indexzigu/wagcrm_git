"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createPartnerSchema,
  PARTNER_TYPES,
} from "@/lib/validations/partner";
import type { PartnerType } from "@/lib/validations/partner";
import { partnerTypeLabels } from "@/lib/crm-types";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import { formatBusinessNumber } from "@/lib/format";

// --- Types ---

type PartnerCreationFormProps = {
  onSuccess?: () => void;
  onCancel?: () => void;
};

type FormState = {
  name: string;
  type: PartnerType | "";
  status: string;
  businessNumber: string;
  companyStatus: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  representativeEmail: string;
  bankAccount: string;
};

const INITIAL_FORM: FormState = {
  name: "",
  type: "",
  status: "거래중",
  businessNumber: "",
  companyStatus: "",
  contactName: "",
  contactPhone: "",
  contactEmail: "",
  representativeEmail: "",
  bankAccount: "",
};

// --- Component ---

export function PartnerCreationForm({
  onSuccess,
  onCancel,
}: PartnerCreationFormProps) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const resetForm = useCallback(() => {
    setForm(INITIAL_FORM);
    setErrors({});
  }, []);

  const handleSubmit = useCallback(async () => {
    setErrors({});

    // Build contact info string from individual fields
    const contactParts: string[] = [];
    if (form.contactName) contactParts.push(form.contactName);
    if (form.contactPhone) contactParts.push(form.contactPhone);
    if (form.contactEmail) contactParts.push(form.contactEmail);
    const contactInfo = contactParts.length > 0 ? contactParts.join(" / ") : undefined;

    const data = {
      name: form.name,
      type: form.type || undefined,
      status: form.status || undefined,
      businessNumber: form.businessNumber || undefined,
      companyStatus: form.companyStatus || undefined,
      contactInfo,
      representativeEmail: form.representativeEmail || form.contactEmail || undefined,
      bankAccount: form.bankAccount || undefined,
    };

    const result = createPartnerSchema.safeParse(data);
    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0]?.toString();
        if (key && !fieldErrors[key]) {
          fieldErrors[key] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return;
    }

    setSubmitting(true);
    const promise = fetch("/api/partners", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result.data),
    }).then(async (res) => {
      if (!res.ok) {
        const errorData = await res.json().catch(() => null);
        const message =
          errorData?.error && typeof errorData.error === "string"
            ? errorData.error
            : "저장에 실패했습니다. 다시 시도해주세요.";
        throw new Error(message);
      }
      resetForm();
      onSuccess?.();
      return res.json();
    }).finally(() => {
      setSubmitting(false);
    });

    withMutationFeedback(promise).catch(() => {});

    await promise.catch(() => {});
  }, [form, resetForm, onSuccess]);

  return (
    <div className="flex flex-col gap-5">
      <FieldGroup>
      <FieldSet>
        <FieldLegend>핵심 식별 정보</FieldLegend>
        <FormField label="이름" required error={errors.name}>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="거래처 이름"
            aria-invalid={!!errors.name}
          />
        </FormField>

        <FormField label="유형" required error={errors.type}>
          <Select
            value={form.type}
            onValueChange={(value) =>
              setForm({ ...form, type: value as PartnerType })
            }
          >
            <SelectTrigger className="w-full" aria-invalid={!!errors.type}>
              <SelectValue placeholder="유형 선택" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {PARTNER_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {partnerTypeLabels[type]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </FormField>
      </FieldSet>

      <FieldSet>
        <FieldLegend>운영 보강 정보</FieldLegend>
        <FormField label="거래 상태" error={errors.status}>
          <Select
            value={form.status}
            onValueChange={(value) => setForm({ ...form, status: value })}
          >
            <SelectTrigger className="w-full" aria-invalid={!!errors.status}>
              <SelectValue placeholder="상태 선택" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {["거래중", "거래보류", "응답없음", "거래중단"].map((status) => (
                  <SelectItem key={status} value={status}>
                    {status}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </FormField>

        <FormField label="사업자번호" error={errors.businessNumber}>
          <Input
            value={formatBusinessNumber(form.businessNumber)}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
              setForm({ ...form, businessNumber: digits });
            }}
            placeholder="10자리 숫자"
            maxLength={12}
            inputMode="numeric"
            aria-invalid={!!errors.businessNumber}
          />
        </FormField>

        <FormField label="사업자 상태" error={errors.companyStatus}>
          <Input
            value={form.companyStatus}
            onChange={(e) => setForm({ ...form, companyStatus: e.target.value })}
            placeholder="계속사업자, 휴업 등"
            aria-invalid={!!errors.companyStatus}
          />
        </FormField>

        <FormField label="담당자명">
          <Input
            value={form.contactName}
            onChange={(e) => setForm({ ...form, contactName: e.target.value })}
            placeholder="담당자 이름"
          />
        </FormField>

        <FormField label="전화번호">
          <Input
            value={form.contactPhone}
            onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
            placeholder="010-0000-0000"
          />
        </FormField>

        <FormField label="이메일">
          <Input
            type="email"
            value={form.contactEmail}
            onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
            placeholder="email@example.com"
          />
        </FormField>

        <FormField label="대표 이메일" error={errors.representativeEmail} description="세금계산서와 정산 연락에 우선 사용됩니다.">
          <Input
            type="email"
            value={form.representativeEmail}
            onChange={(e) => setForm({ ...form, representativeEmail: e.target.value })}
            placeholder="tax@example.com"
            aria-invalid={!!errors.representativeEmail}
          />
        </FormField>

        <FormField label="은행 계좌">
          <Input
            value={form.bankAccount}
            onChange={(e) => setForm({ ...form, bankAccount: e.target.value })}
            placeholder="은행명 계좌번호 (예: 국민 000-000-000)"
          />
        </FormField>
      </FieldSet>
      </FieldGroup>

      {/* 액션 버튼 */}
      <div className="flex items-center justify-end gap-3 border-t border-border/70 pt-4">
        {onCancel && (
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={submitting}
          >
            취소
          </Button>
        )}
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={submitting}
        >
          {submitting ? "저장 중..." : "저장"}
        </Button>
      </div>
    </div>
  );
}

// --- FormField Helper ---

function FormField({
  label,
  required,
  error,
  description,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Field data-invalid={!!error}>
      <FieldLabel className="text-xs font-medium text-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </FieldLabel>
      {children}
      {description && <FieldDescription className="text-xs">{description}</FieldDescription>}
      <FieldError className="text-xs">{error}</FieldError>
    </Field>
  );
}
