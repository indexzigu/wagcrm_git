"use client";

import { useState, useCallback, useEffect } from "react";

import { Badge } from "@/components/ui/badge";
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
import { Separator } from "@/components/ui/separator";
import { SNS_TYPES } from "@/lib/validations/seller";
import { validateSellerCreation } from "@/lib/validations/partner-seller";
import { parseChannelUrl } from "@/lib/channel-url";
import { type SnsType, snsTypeLabels, acquisitionChannelLabels, type SellerSummary } from "@/lib/crm-types";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";

// --- Types ---

export type SellerCreationFormProps = {
  onSuccess?: () => void;
  onCancel?: () => void;
  onCreated?: (seller: SellerSummary) => void;
};

type CreateFormState = {
  channelUrl: string;
  name: string;
  alias: string;
  snsType: SnsType | "";
  snsHandle: string;
  // F6 outcome 적립: 유입 경로는 등록 시점에 가장 정확하다 (소급 불가)
  acquisitionChannel: string;
  // F3 웜 리드 인테이크: 소개 유입이면 소개자를 등록 시점에 캡처
  referredById: string;
};

const INITIAL_CREATE_FORM: CreateFormState = {
  channelUrl: "",
  name: "",
  alias: "",
  snsType: "",
  snsHandle: "",
  acquisitionChannel: "",
  referredById: "",
};

// --- Component ---

export function SellerCreationForm({
  onSuccess,
  onCancel,
  onCreated,
}: SellerCreationFormProps) {
  const [createForm, setCreateForm] = useState<CreateFormState>(INITIAL_CREATE_FORM);
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({});
  const [createSubmitting, setCreateSubmitting] = useState(false);
  // F3: 소개자 선택 옵션 — 소개 유입일 때만 필요하므로 REFERRAL 선택 시 지연 로드
  const [referrerOptions, setReferrerOptions] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    if (createForm.acquisitionChannel !== "REFERRAL" || referrerOptions.length > 0) return;
    let cancelled = false;
    fetch("/api/sellers")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`목록 조회 실패 (${res.status})`))))
      .then((data) => {
        if (cancelled) return;
        const list: Array<{ id: string; name: string; alias?: string | null }> = Array.isArray(data?.sellers)
          ? data.sellers
          : [];
        setReferrerOptions(list.map((s) => ({ id: s.id, label: s.alias || s.name })));
      })
      .catch((e) => console.warn("[seller-create] 소개자 옵션 로드 실패:", e));
    return () => {
      cancelled = true;
    };
  }, [createForm.acquisitionChannel, referrerOptions.length]);

  const handleCreateSubmit = useCallback(async () => {
    setCreateErrors({});

    const validation = validateSellerCreation({
      channelUrl: createForm.channelUrl.trim() || undefined,
      name: createForm.name || undefined,
      snsType: createForm.snsType || undefined,
      snsHandle: createForm.snsHandle || undefined,
    });

    if (!validation.valid) {
      setCreateErrors(validation.errors);
      return;
    }

    setCreateSubmitting(true);
      const body: Record<string, string | number | undefined> = {};
      const normalizedChannelUrl = createForm.channelUrl.trim();
      if (normalizedChannelUrl) body.channelUrl = normalizedChannelUrl;
      if (createForm.name) body.name = createForm.name.trim();
      if (createForm.alias) body.alias = createForm.alias.trim();
      if (createForm.snsType) body.snsType = createForm.snsType;
      if (createForm.snsHandle) body.snsHandle = createForm.snsHandle.trim();
      if (createForm.acquisitionChannel) body.acquisitionChannel = createForm.acquisitionChannel;
      // 소개 유입일 때만 소개자를 함께 전송
      if (createForm.acquisitionChannel === "REFERRAL" && createForm.referredById) {
        body.referredById = createForm.referredById;
      }

      // URL-only create path: derive required fields from channel URL.
      if (normalizedChannelUrl && (!body.name || !body.snsType || !body.snsHandle)) {
        const parsedChannel = parseChannelUrl(normalizedChannelUrl);
        if (!parsedChannel) {
          setCreateErrors({
            channelUrl:
              "지원하지 않는 채널 URL 형식입니다. Instagram, YouTube 또는 X URL을 입력해주세요.",
          });
          return;
        }

        if (!body.snsType) body.snsType = parsedChannel.snsType;
        if (!body.snsHandle) body.snsHandle = parsedChannel.snsHandle;
        if (!body.name) body.name = parsedChannel.snsHandle;
      }

      body.currentFollowers = 0;

      const promise = fetch("/api/sellers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (res) => {
        if (!res.ok) {
          const errorData = await res.json().catch(() => null);
          if (res.status === 409) {
            const message =
              errorData?.error && typeof errorData.error === "string"
                ? errorData.error
                : "이미 존재하는 셀러입니다";
            setCreateErrors({ snsHandle: message });
            throw new Error(message);
          }
          const message =
            errorData?.error && typeof errorData.error === "string"
              ? errorData.error
              : "저장에 실패했습니다. 다시 시도해주세요.";
          throw new Error(message);
        }
        return res.json();
      }).then((created) => {
        // 등록 직후 백그라운드 보강은 SNS 유형별로 한 경로만 쏜다(code-reviewer MEDIUM — 두 라우트가
        // 각자 seller.name을 쓰는 경합 + 외부 스크랩 비용 2배 방지):
        // · 인스타 → 최초 AI 분석 자동 실행(오너 확정 2026-07-23). analyze 라우트가 채널 스크랩과
        //   객관 지표 반영(팔로워·bio·프로필 이미지·이름)을 channel-info와 동일 규약으로 포함한다.
        // · 그 외(유튜브·X) → 기존 channel-info 강제 스크랩(분석 라우트가 비인스타를 400으로 거부).
        // fire-and-forget: 60~300초 걸리는 요청이라 등록 UX를 붙잡지 않고, 실패해도 등록은 유효
        // (목록의 "분석" 버튼·상세 갱신/재분석으로 언제든 수동 재시도 가능).
        const isInstagram = (created.snsType || "").toUpperCase() === "INSTAGRAM";
        if (isInstagram) {
          void fetch(`/api/sellers/${created.id}/analyze`, { method: "POST" }).catch((e) =>
            console.warn("신규 셀러 최초 AI 분석 트리거 실패(수동 분석으로 대체 가능):", e)
          );
        } else if (created.channelUrl) {
          void fetch(
            `/api/sellers/${created.id}/channel-info?force=true&url=${encodeURIComponent(created.channelUrl)}`
          ).catch((e) => console.error("신규 셀러 백그라운드 스크래핑 트리거 실패:", e));
        }

        const createdSeller: SellerSummary = {
          id: created.id,
          name: created.name,
          alias: created.alias ?? null,
          snsType: created.snsType,
          snsHandle: created.snsHandle,
          currentFollowers: created.currentFollowers ?? 0,
          category: created.category ?? null,
          channelUrl: created.channelUrl ?? null,
          createdAt: created.createdAt,
        };

        onCreated?.(createdSeller);
        onSuccess?.();
        return created;
      }).finally(() => {
        setCreateSubmitting(false);
      });

      withMutationFeedback(promise).catch(() => {});

      await promise.catch(() => {});
  }, [createForm, onCreated, onSuccess]);

  return (
    <div className="flex flex-col gap-6">
      <FieldGroup>
      <FieldSet>
        <FieldLegend>채널 URL로 등록</FieldLegend>
        <FieldDescription>
          채널 URL을 입력하면 SNS 정보가 자동으로 적용되고, 인스타그램 계정은 등록 직후 AI 분석이
          자동 실행됩니다.
        </FieldDescription>

        <Field data-invalid={!!createErrors.channelUrl}>
          <FieldLabel htmlFor="channelUrl">
            채널 URL
          </FieldLabel>
          <Input
            id="channelUrl"
            type="url"
            name="channelUrl"
            placeholder="https://instagram.com/handle"
            value={createForm.channelUrl}
            onChange={(e) => setCreateForm({ ...createForm, channelUrl: e.target.value })}
            aria-invalid={!!createErrors.channelUrl}
          />
          <FieldError>{createErrors.channelUrl}</FieldError>
        </Field>
      </FieldSet>

      <Separator />

      <FieldSet>
        <FieldLegend className="flex w-full items-center justify-between gap-3">
          <span>직접 입력</span>
          <Badge variant="secondary">별칭 우선 표시</Badge>
        </FieldLegend>
        <FieldDescription>
          또는 이름 + SNS유형 + SNS핸들을 직접 입력하세요.
        </FieldDescription>

        <Field data-invalid={!!createErrors.name}>
          <FieldLabel>
            표시명
          </FieldLabel>
          <Input
            name="name"
            value={createForm.name}
            onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
            placeholder="셀러 이름"
            aria-invalid={!!createErrors.name}
          />
          <FieldError>{createErrors.name}</FieldError>
        </Field>

        <Field>
          <FieldLabel>
            별칭 (선택)
          </FieldLabel>
          <Input
            name="alias"
            value={createForm.alias}
            onChange={(e) => setCreateForm({ ...createForm, alias: e.target.value })}
            placeholder="목록에 표시할 별칭"
          />
          <FieldDescription>캠페인명과 목록에는 별칭이 있으면 실명보다 먼저 표시됩니다.</FieldDescription>
        </Field>

        <Field data-invalid={!!createErrors.snsType}>
          <FieldLabel>
            SNS 유형
          </FieldLabel>
          <Select
            value={createForm.snsType}
            onValueChange={(value) =>
              setCreateForm({ ...createForm, snsType: value as SnsType })
            }
          >
            <SelectTrigger className="w-full" aria-invalid={!!createErrors.snsType}>
              <SelectValue placeholder="SNS 유형 선택" />
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
          <FieldError>{createErrors.snsType}</FieldError>
        </Field>

        <Field data-invalid={!!createErrors.snsHandle}>
          <FieldLabel>
            SNS 핸들
          </FieldLabel>
          <Input
            name="snsHandle"
            value={createForm.snsHandle}
            onChange={(e) => setCreateForm({ ...createForm, snsHandle: e.target.value })}
            placeholder="@handle"
            aria-invalid={!!createErrors.snsHandle}
          />
          <FieldError>{createErrors.snsHandle}</FieldError>
        </Field>

        <Field>
          <FieldLabel>
            유입 경로 (선택)
          </FieldLabel>
          <Select
            value={createForm.acquisitionChannel}
            onValueChange={(value) =>
              setCreateForm({
                ...createForm,
                acquisitionChannel: value,
                // 소개가 아니게 바뀌면 소개자 선택도 함께 해제 — 비활성 셀렉트에 낡은 값이 남지 않게
                ...(value !== "REFERRAL" ? { referredById: "" } : {}),
              })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="유입 경로 선택" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {Object.entries(acquisitionChannelLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        {/* 소개자 필드는 조건부 마운트하지 않고 자리를 예약한다(상시 렌더 + 비활성) —
            중앙 정렬 다이얼로그는 내용 높이가 바뀌면 전체가 재정렬되어 화면이 튄다(오너 지적 2026-07-23). */}
        <Field data-disabled={createForm.acquisitionChannel !== "REFERRAL" || undefined}>
          <FieldLabel>소개자 (선택)</FieldLabel>
          <Select
            value={createForm.referredById}
            onValueChange={(value) => setCreateForm({ ...createForm, referredById: value })}
            disabled={createForm.acquisitionChannel !== "REFERRAL"}
          >
            <SelectTrigger className="w-full">
              <SelectValue
                placeholder={
                  createForm.acquisitionChannel === "REFERRAL"
                    ? "소개해준 셀러 선택"
                    : "유입 경로가 '소개'일 때 지정"
                }
              />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {referrerOptions.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            소개자를 지정하면 소개 네트워크에 커넥터로 집계됩니다.
          </FieldDescription>
        </Field>
      </FieldSet>

      {/* 안내 각주 — 섹션 제목(FieldLegend)이 아니다: 입력할 것이 없는 순수 안내문이라
          "채널 URL로 등록"·"직접 입력"과 같은 위계로 두면 빈 섹션처럼 읽힌다(오너 지적 2026-07-23). */}
      <p className="rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        팔로워·카테고리·연결 회사/대행사는 생성 후 상세 패널에서 보강합니다.
      </p>
      </FieldGroup>

      {/* 저장 버튼 */}
      <div className="flex items-center justify-end gap-3 border-t border-border/70 pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onCancel?.()}
          disabled={createSubmitting}
        >
          취소
        </Button>
        <Button
          size="sm"
          onClick={() => void handleCreateSubmit()}
          disabled={createSubmitting}
        >
          {createSubmitting ? "저장 중..." : "저장"}
        </Button>
      </div>
    </div>
  );
}
