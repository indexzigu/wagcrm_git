"use client";

import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
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
import { XIcon } from "lucide-react";
import { SNS_TYPES } from "@/lib/validations/seller";
import { snsTypeLabels } from "@/lib/crm-types";
import type { PartnerSummary, SnsType } from "@/lib/crm-types";
import { SearchableDropdown } from "./searchable-dropdown";

type QuickAddInlineFormProps = {
  entityType: "deal" | "seller";
  open: boolean;
  onClose: () => void;
  onCreated: (entity: { id: string; label: string }) => void;
  /** Available partners for deal creation (partner select) */
  partners?: PartnerSummary[];
};

export function QuickAddInlineForm({
  entityType,
  open,
  onClose,
  onCreated,
  partners = [],
}: QuickAddInlineFormProps) {
  if (!open) return null;

  return entityType === "seller" ? (
    <SellerQuickForm onClose={onClose} onCreated={onCreated} />
  ) : (
    <DealQuickForm onClose={onClose} onCreated={onCreated} partners={partners} />
  );
}

// --- Seller Quick Add Form ---

function SellerQuickForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (entity: { id: string; label: string }) => void;
}) {
  const [name, setName] = useState("");
  const [snsType, setSnsType] = useState<SnsType>("INSTAGRAM");
  const [snsHandle, setSnsHandle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    if (!name.trim()) return "셀러 이름은 필수입니다";
    if (!snsHandle.trim()) return "SNS 핸들은 필수입니다";
    return null;
  }

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/sellers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          snsType,
          snsHandle: snsHandle.trim(),
          currentFollowers: 0,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error?.toString() ?? "셀러 생성에 실패했습니다");
        setSaving(false);
        return;
      }

      const seller = await response.json();
      onCreated({
        id: seller.id,
        label: `${seller.name} @${seller.snsHandle}`,
      });
    } catch {
      setError("네트워크 오류가 발생했습니다");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">셀러 빠른 추가</span>
          <span className="text-xs text-muted-foreground">상세 평가는 생성 후 셀러 상세에서 보강합니다.</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="빠른 추가 닫기"
        >
          <XIcon />
        </Button>
      </div>

      <FieldGroup className="gap-3">
        <Field data-invalid={error === "셀러 이름은 필수입니다"}>
          <FieldLabel className="text-xs">표시명 <span className="text-destructive">*</span></FieldLabel>
          <Input
            placeholder="셀러 이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 text-sm"
            aria-invalid={error === "셀러 이름은 필수입니다"}
          />
          <FieldError className="text-xs">{error === "셀러 이름은 필수입니다" ? error : undefined}</FieldError>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field>
            <FieldLabel className="text-xs">SNS 유형 <span className="text-destructive">*</span></FieldLabel>
            <Select
              value={snsType}
              onValueChange={(v) => setSnsType(v as SnsType)}
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SNS_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {snsTypeLabels[type]}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field data-invalid={error === "SNS 핸들은 필수입니다"}>
            <FieldLabel className="text-xs">SNS 핸들 <span className="text-destructive">*</span></FieldLabel>
            <Input
              placeholder="@handle"
              value={snsHandle}
              onChange={(e) => setSnsHandle(e.target.value)}
              className="h-8 text-sm"
              aria-invalid={error === "SNS 핸들은 필수입니다"}
            />
            <FieldError className="text-xs">{error === "SNS 핸들은 필수입니다" ? error : undefined}</FieldError>
          </Field>
        </div>
      </FieldGroup>

      {error && error !== "셀러 이름은 필수입니다" && error !== "SNS 핸들은 필수입니다" ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          취소
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={saving}>
          {saving ? "저장 중..." : "추가"}
        </Button>
      </div>
    </div>
  );
}

// --- Deal Quick Add Form ---

function DealQuickForm({
  onClose,
  onCreated,
  partners,
}: {
  onClose: () => void;
  onCreated: (entity: { id: string; label: string }) => void;
  partners: PartnerSummary[];
}) {
  const [dealName, setDealName] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [costPrice, setCostPrice] = useState("0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function validate(): string | null {
    if (!dealName.trim()) return "딜 이름은 필수입니다";
    if (!partnerId) return "거래처를 선택해주세요";
    const cost = Number(costPrice);
    if (isNaN(cost) || cost < 0) return "공급가는 0 이상이어야 합니다";
    return null;
  }

  async function handleSubmit() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/deals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealName: dealName.trim(),
          partnerId,
          costPrice: Number(costPrice),
          sellingPrice: 0,
          baseMarginPolicy: {
            byChannel: {},
          },
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error?.toString() ?? "딜 생성에 실패했습니다");
        setSaving(false);
        return;
      }

      const deal = await response.json();
      onCreated({
        id: deal.id,
        label: deal.dealName,
      });
    } catch {
      setError("네트워크 오류가 발생했습니다");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">딜 빠른 추가</span>
          <span className="text-xs text-muted-foreground">마진 정책과 옵션 품목은 생성 후 딜 상세에서 보강합니다.</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="빠른 추가 닫기"
        >
          <XIcon />
        </Button>
      </div>

      <FieldGroup className="gap-3">
        <Field data-invalid={error === "딜 이름은 필수입니다"}>
          <FieldLabel className="text-xs">딜명 <span className="text-destructive">*</span></FieldLabel>
          <Input
            placeholder="딜 이름"
            value={dealName}
            onChange={(e) => setDealName(e.target.value)}
            className="h-8 text-sm"
            aria-invalid={error === "딜 이름은 필수입니다"}
          />
          <FieldError className="text-xs">{error === "딜 이름은 필수입니다" ? error : undefined}</FieldError>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field data-invalid={error === "거래처를 선택해주세요"}>
            <FieldLabel className="text-xs">거래처 <span className="text-destructive">*</span></FieldLabel>
            <SearchableDropdown
              items={partners}
              value={partnerId || null}
              onValueChange={setPartnerId}
              getSearchableText={(partner) => partner.name}
              getLabel={(partner) => partner.name}
              getValue={(partner) => partner.id}
              placeholder="선택"
              emptyMessage="검색 결과 없음"
            />
            <FieldError className="text-xs">{error === "거래처를 선택해주세요" ? error : undefined}</FieldError>
          </Field>
          <Field data-invalid={error === "공급가는 0 이상이어야 합니다"}>
            <FieldLabel className="text-xs">공급가 <span className="text-destructive">*</span></FieldLabel>
            <Input
              inputMode="numeric"
              placeholder="0"
              value={costPrice}
              onChange={(e) => setCostPrice(e.target.value)}
              className="h-8 text-sm"
              aria-invalid={error === "공급가는 0 이상이어야 합니다"}
            />
            <FieldDescription className="text-xs">원 단위</FieldDescription>
            <FieldError className="text-xs">{error === "공급가는 0 이상이어야 합니다" ? error : undefined}</FieldError>
          </Field>
        </div>
      </FieldGroup>

      {error &&
      error !== "딜 이름은 필수입니다" &&
      error !== "거래처를 선택해주세요" &&
      error !== "공급가는 0 이상이어야 합니다" ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          취소
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={saving}>
          {saving ? "저장 중..." : "추가"}
        </Button>
      </div>
    </div>
  );
}
