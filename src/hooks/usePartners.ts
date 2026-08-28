import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PartnerSummary } from "@/lib/crm-types";
import { withMutationFeedback } from "@/lib/use-mutation-feedback";
import { queryKeys } from "@/lib/query-keys";

export type PartnerRow = PartnerSummary;

async function fetchPartners(): Promise<PartnerRow[]> {
  const response = await fetch("/api/partners");
  if (!response.ok) throw new Error("거래처 목록을 불러오지 못했습니다");
  const data = await response.json();
  return (data.partners ?? data) as PartnerRow[];
}

export function usePartners(initialPartners: PartnerRow[]) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.partners(),
    queryFn: fetchPartners,
    initialData: initialPartners,
    staleTime: 5 * 60 * 1000, // warm(5m) — 서버 cache-policy warm 투영
  });

  const partners = query.data ?? initialPartners;

  const setPartners = useCallback(
    (updater: PartnerRow[] | ((prev: PartnerRow[]) => PartnerRow[])) => {
      queryClient.setQueryData<PartnerRow[]>(queryKeys.partners(), (prev) => {
        const base = prev ?? initialPartners;
        return typeof updater === "function"
          ? (updater as (prev: PartnerRow[]) => PartnerRow[])(base)
          : updater;
      });
    },
    [queryClient, initialPartners]
  );

  const [selectedPartner, setSelectedPartner] = useState<PartnerRow | null>(null);
  const [partnerPanelMode, setPartnerPanelMode] = useState<"view" | "create">("view");

  // 순수 상태 동기화 헬퍼 — 토스트를 띄우지 않는다. 여러 액션(동기화·OCR·필드수정)의
  // 하위 단계로 반복 호출되므로 여기서 토스트하면 액션마다 토스트가 중복된다.
  // 사용자 피드백 토스트는 각 액션의 단일 소유 지점에서만 띄운다.
  const handlePartnerUpdated = useCallback((updated: Partial<PartnerRow> & { id: string }) => {
    setPartners((prev) =>
      prev.map((partner) => (partner.id === updated.id ? { ...partner, ...updated } : partner))
    );
    setSelectedPartner((prev) => (prev?.id === updated.id ? { ...prev, ...updated } : prev));
  }, [setPartners]);

  const handleInlinePatch = useCallback(async (id: string, patch: Record<string, unknown>) => {
    return withMutationFeedback(
      (async () => {
        const response = await fetch(`/api/partners/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!response.ok) throw new Error("거래처 수정에 실패했습니다");
        const updated = (await response.json()) as PartnerRow;
        setPartners((previous) =>
          previous.map((row) => (row.id === id ? { ...row, ...updated } : row))
        );
        return updated;
      })(),
      "거래처 정보가 수정되었습니다."
    ).catch(() => null);
  }, [setPartners]);

  const updatePartnerField = useCallback(async (
    partnerId: string,
    fieldOrData: string | Record<string, any>,
    value?: any
  ): Promise<PartnerRow> => {
    const body = typeof fieldOrData === "string"
      ? { [fieldOrData]: value || null }
      : fieldOrData;

    const response = await fetch(`/api/partners/${partnerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error ?? "저장 실패");
    }
    const updated = (await response.json()) as PartnerRow;
    handlePartnerUpdated(updated);
    // 인라인 저장 성공은 무음 — InlineEditField의 낙관적 값 갱신이 피드백이고,
    // 실패 토스트는 InlineEditField(withMutationFeedback)가 소유한다. 셀러(PR #36)와 동일 계약.
    return updated;
  }, [handlePartnerUpdated]);

  const handlePartnerCreated = useCallback((created: PartnerRow) => {
    setPartners((prev) => [created, ...prev]);
    setPartnerPanelMode("view");
    setSelectedPartner(created);
    // 토스트는 액션 지점(패널 생성 제출)에서 단일 노출.
  }, [setPartners]);

  const handlePartnerDeleted = useCallback((partnerId: string) => {
    setPartners((prev) => prev.filter((p) => p.id !== partnerId));
    setSelectedPartner(null);
    // 토스트는 액션 지점(패널 삭제 핸들러)에서 단일 노출.
  }, [setPartners]);

  const syncBusinessInfo = useCallback(async (partnerId: string, force = false) => {
    const response = await fetch(`/api/partners/${partnerId}/business-info?force=${force}`);
    if (!response.ok) {
      throw new Error("사업자등록 정보 동기화에 실패했습니다.");
    }
    const result = await response.json();
    if (result.error) {
      throw new Error(result.error);
    }

    // 로컬 상태 동기화 (업태·종목·상호 포함 — 패널 onUpdated와 동일 필드셋)
    handlePartnerUpdated({
      id: partnerId,
      companyStatus: result.companyStatus,
      companyRole: result.companyRole,
      ceoName: result.ceoName,
      address: result.address,
      businessType: result.businessType,
      businessItem: result.businessItem,
      name: result.name ?? undefined,
      bizSyncedAt: result.bizSyncedAt ? String(result.bizSyncedAt) : undefined,
    });
    // 토스트는 액션 지점(패널 동기화 버튼)에서 업태·종목 상세를 포함해 단일 노출.
    return result;
  }, [handlePartnerUpdated]);

  const uploadBusinessCardOcr = useCallback(async (partnerId: string, fileBase64: string, mimeType: string) => {
    const response = await fetch(`/api/partners/${partnerId}/business-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileBase64, mimeType }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || "사업자등록증 OCR 분석에 실패했습니다.");
    }
    const result = await response.json();
    if (result.partner) {
      handlePartnerUpdated(result.partner);
    }
    // 토스트는 액션 지점(패널 사업자등록증 업로드 핸들러)에서 단일 노출.
    return result;
  }, [handlePartnerUpdated]);

  const submitContact = useCallback(async (partnerId: string, contactData: Record<string, any>) => {
    const response = await fetch(`/api/partners/${partnerId}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contactData),
    });
    if (!response.ok) {
      throw new Error("담당자 추가에 실패했습니다.");
    }
    const newContact = await response.json();

    setPartners((prev) =>
      prev.map((partner) => {
        if (partner.id === partnerId) {
          const contacts = partner.contacts ?? [];
          return { ...partner, contacts: [...contacts, newContact] };
        }
        return partner;
      })
    );
    setSelectedPartner((prev) => {
      if (prev?.id === partnerId) {
        const contacts = prev.contacts ?? [];
        return { ...prev, contacts: [...contacts, newContact] };
      }
      return prev;
    });
    // 토스트는 액션 지점(패널 담당자 추가 핸들러)에서 단일 노출.
    return newContact;
  }, [setPartners]);

  const updateContact = useCallback(async (partnerId: string, contactId: string, contactData: Record<string, any>) => {
    const response = await fetch(`/api/partners/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contactData),
    });
    if (!response.ok) {
      throw new Error("담당자 정보 수정에 실패했습니다.");
    }
    const updatedContact = await response.json();

    setPartners((prev) =>
      prev.map((partner) => {
        if (partner.id === partnerId) {
          const contacts = partner.contacts ?? [];
          return {
            ...partner,
            contacts: contacts.map((c) => (c.id === contactId ? updatedContact : c)),
          };
        }
        return partner;
      })
    );
    setSelectedPartner((prev) => {
      if (prev?.id === partnerId) {
        const contacts = prev.contacts ?? [];
        return {
          ...prev,
          contacts: contacts.map((c) => (c.id === contactId ? updatedContact : c)),
        };
      }
      return prev;
    });
    // 담당자 인라인 수정 성공은 무음 — 패널 patchContact의 낙관적 갱신이 피드백이고,
    // 실패 토스트는 patchContact가 소유(rollback + toast.error). 필드 인라인 저장과 동일 계약.
    return updatedContact;
  }, [setPartners]);

  const deleteContact = useCallback(async (partnerId: string, contactId: string) => {
    const response = await fetch(`/api/partners/contacts/${contactId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error("담당자 삭제에 실패했습니다.");
    }

    setPartners((prev) =>
      prev.map((partner) => {
        if (partner.id === partnerId) {
          const contacts = partner.contacts ?? [];
          return {
            ...partner,
            contacts: contacts.filter((c) => c.id !== contactId),
          };
        }
        return partner;
      })
    );
    setSelectedPartner((prev) => {
      if (prev?.id === partnerId) {
        const contacts = prev.contacts ?? [];
        return {
          ...prev,
          contacts: contacts.filter((c) => c.id !== contactId),
        };
      }
      return prev;
    });
    // 토스트는 액션 지점(패널 담당자 삭제 핸들러)에서 단일 노출.
  }, [setPartners]);

  return {
    partners,
    setPartners,
    selectedPartner,
    setSelectedPartner,
    partnerPanelMode,
    setPartnerPanelMode,
    handleInlinePatch,
    updatePartnerField,
    handlePartnerUpdated,
    handlePartnerCreated,
    handlePartnerDeleted,
    syncBusinessInfo,
    uploadBusinessCardOcr,
    submitContact,
    updateContact,
    deleteContact,
  };
}
