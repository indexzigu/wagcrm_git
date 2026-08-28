"use client";

import { useState, useCallback } from "react";
import { z } from "zod";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { EntityIdentity } from "@/components/crm/entity-identity";
import { EntityLinkSelectField } from "@/components/crm/entity-link-select-field";
import { LinkSearchDialog } from "@/components/crm/link-search-dialog";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";

// --- Validation Schema ---

const dealFormSchema = z.object({
  dealName: z
    .string()
    .min(1, "딜 이름은 필수입니다")
    .max(100, "딜 이름은 100자를 초과할 수 없습니다"),
  partnerId: z.string().min(1, "거래처 선택은 필수입니다"),
  brandName: z.string().min(1, "브랜드명은 필수입니다"),
});

export type DealCreationFormProps = {
  onSuccess?: () => void;
  onCancel?: () => void;
};

// --- Component ---

export function DealCreationForm({ onSuccess, onCancel }: DealCreationFormProps) {
  // Form state
  const [dealName, setDealName] = useState("");
  const [brandName, setBrandName] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [partnerType, setPartnerType] = useState("");

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Submission state
  const [submitting, setSubmitting] = useState(false);

  // Duplicate deal name detection
  const [duplicateWarning, setDuplicateWarning] = useState<string[] | null>(null);
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false);

  const [isPartnerSearchOpen, setIsPartnerSearchOpen] = useState(false);

  const resetForm = useCallback(() => {
    setDealName("");
    setBrandName("");
    setPartnerId("");
    setPartnerName("");
    setPartnerType("");
    setErrors({});
    setDuplicateWarning(null);
    setDuplicateConfirmed(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    setErrors({});

    // Client-side Zod validation
    const result = dealFormSchema.safeParse({
      dealName,
      partnerId,
      brandName,
    });
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

    // Duplicate deal name check (skip if already confirmed)
    if (!duplicateConfirmed) {
      try {
        const checkRes = await fetch(
          `/api/deals?q=${encodeURIComponent(result.data.dealName.trim())}`
        );
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          const existingDeals = (checkData.deals ?? []) as Array<{ dealName: string }>;
          const trimmedName = result.data.dealName.trim().toLowerCase();
          const similar = existingDeals
            .filter((d) => {
              const existing = d.dealName.toLowerCase();
              return existing === trimmedName || existing.includes(trimmedName) || trimmedName.includes(existing);
            })
            .map((d) => d.dealName);

          if (similar.length > 0) {
            setDuplicateWarning(similar);
            return;
          }
        }
      } catch {
        // 중복 검출 실패 시 저장 진행 허용
      }
    }

    setSubmitting(true);
    const payload = {
      dealName: result.data.dealName,
      partnerId: result.data.partnerId,
      brandName: result.data.brandName,
      baseMarginPolicy: { byChannel: {} },
    };

    const promise = fetch("/api/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async (res) => {
      if (!res.ok) throw new Error("저장에 실패했습니다. 다시 시도해주세요.");
      resetForm();
      onSuccess?.();
      return res.json();
    }).finally(() => {
      setSubmitting(false);
    });

    withMutationFeedback(promise).catch(() => {});

    await promise.catch(() => {});
  }, [brandName, dealName, partnerId, resetForm, duplicateConfirmed, onSuccess]);

  return (
    <div className="flex flex-col gap-5">
      <FieldGroup>
        <FieldSet>
          <Field data-invalid={!!errors.dealName}>
            <FieldLabel className="text-xs font-medium text-foreground">
              딜명<span className="ml-0.5 text-destructive">*</span>
            </FieldLabel>
            <Input
              value={dealName}
              onChange={(e) => {
                setDealName(e.target.value);
                // 이름 변경 시 중복 경고 초기화
                if (duplicateWarning) {
                  setDuplicateWarning(null);
                  setDuplicateConfirmed(false);
                }
              }}
              placeholder="딜/상품 이름 (최대 100자)"
              maxLength={100}
              aria-invalid={!!errors.dealName}
              aria-describedby={errors.dealName ? "dealName-error" : undefined}
            />
            <FieldError id="dealName-error" className="text-xs">{errors.dealName}</FieldError>
          </Field>

          <EntityLinkSelectField
            label="거래처"
            required
            selected={!!partnerId}
            emptyText="선택된 거래처가 없습니다."
            actionLabel="거래처 검색 선택"
            changeLabel="거래처 변경"
            error={errors.partnerId}
            onOpen={() => setIsPartnerSearchOpen(true)}
            selectedContent={
              <EntityIdentity
                variant="heading"
                parts={[
                  { label: "거래처", value: partnerName || "로딩 중..." },
                  ...(partnerType ? [{ label: "유형", value: partnerType }] : []),
                ]}
              />
            }
          />

          <Field data-invalid={!!errors.brandName}>
            <FieldLabel className="text-xs font-medium text-foreground">
              브랜드명<span className="ml-0.5 text-destructive">*</span>
            </FieldLabel>
            <Input
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              placeholder="브랜드명"
              aria-invalid={!!errors.brandName}
            />
            <FieldDescription className="text-xs">
              거래처 선택 시 자동 입력되며 영업/캠페인 식별 라벨에 사용됩니다.
            </FieldDescription>
            <FieldError className="text-xs">{errors.brandName}</FieldError>
          </Field>
        </FieldSet>
      </FieldGroup>

      {/* 중복 딜 이름 경고 */}
      {duplicateWarning && duplicateWarning.length > 0 && (
        <Alert className="border-amber-200 bg-amber-50 text-amber-900">
          <AlertDescription className="text-xs">
            <p className="font-medium mb-1">유사한 딜이 이미 존재합니다:</p>
            <ul className="list-disc pl-4 mb-2 space-y-0.5">
              {duplicateWarning.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <p>동일한 딜이 아닌지 확인한 뒤 진행해 주세요.</p>
          </AlertDescription>
        </Alert>
      )}

      {/* 버튼 영역 */}
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
        {duplicateWarning && !duplicateConfirmed ? (
          <Button
            size="sm"
            variant="outline"
            className="border-amber-300 text-amber-700 hover:bg-amber-50"
            onClick={() => {
              setDuplicateConfirmed(true);
              setDuplicateWarning(null);
            }}
          >
            계속 진행
          </Button>
        ) : (
          <Button size="sm" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "저장 중..." : "저장"}
          </Button>
        )}
      </div>
      <LinkSearchDialog
        open={isPartnerSearchOpen}
        onOpenChange={setIsPartnerSearchOpen}
        entityType="partner"
        searchEndpoint="/api/search/partners"
        onSelect={(partner) => {
          setPartnerId(partner.id);
          setPartnerName(partner.label);
          setPartnerType(partner.metadata?.type ?? partner.sublabel ?? "");
          if (!brandName.trim()) {
            setBrandName(partner.label);
          }
          setErrors((prev) => {
            const next = { ...prev };
            delete next.partnerId;
            return next;
          });
        }}
        title="거래처 검색 선택"
        placeholder="검색할 거래처 이름을 입력하세요"
      />
    </div>
  );
}
