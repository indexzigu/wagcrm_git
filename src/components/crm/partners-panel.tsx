"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw, Trash2, X, HelpCircle, Archive, ExternalLink, FileText, Upload } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DataEmpty } from "@/components/ui/empty";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { partnerTypeLabels, type PartnerSummary, type AssetSection, assetSectionLabels } from "@/lib/crm-types";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { sortLinkedDealsByCreatedAt } from "@/lib/entity-linking";
import { parseOrderExcelRules } from "@/lib/order-converter/excel-rules";
import { OrderTemplateReviewDialog } from "@/components/crm/order-template/order-template-review-dialog";
import { formatDate, formatBytes, formatBusinessNumber } from "@/lib/format";
import { validateBusinessNumber, validatePartnerCreation } from "@/lib/validations/partner-seller";
import { PARTNER_TYPES } from "@/lib/validations/partner";
import type { PartnerType } from "@/lib/validations/partner";

import {
  ActivityTimeline,
} from "./activity-timeline";
import { InlineEditField } from "./inline-edit-field";

import { LinkSearchDialog, type SearchResultItem } from "./link-search-dialog";
import { LinkConfirmDialog } from "./link-confirm-dialog";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { LinkedSellersList } from "./linked-sellers-list";
import { LinkedDealsList } from "./linked-deals-list";

// --- Types ---

export type PartnerPanelData = PartnerSummary;

export type LinkedDeal = {
  id: string;
  dealName: string;
  status: string;
  brandName?: string | null;
  createdAt?: string;
};

type PartnersPanelProps = {
  partner: PartnerPanelData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReferredByClick?: (partnerId: string) => void;
  onUpdated?: (partner: PartnerPanelData) => void;
  onCreated?: (partner: PartnerPanelData) => void;
  onDeleted?: (partnerId: string) => void;
  mode?: "view" | "create";
  onSyncBusinessInfo?: (partnerId: string, force?: boolean) => Promise<any>;
  onUploadBusinessCardOcr?: (partnerId: string, fileBase64: string, mimeType: string) => Promise<any>;
  onSubmitContact?: (partnerId: string, contactData: Record<string, any>) => Promise<any>;
  onUpdateContact?: (partnerId: string, contactId: string, contactData: Record<string, any>) => Promise<any>;
  onDeleteContact?: (partnerId: string, contactId: string) => Promise<any>;
  onPatchPartner?: (partnerId: string, field: string, value: string | number) => Promise<any>;
};

// --- Constants ---

const PARTNER_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "BRAND", label: "브랜드" },
  { value: "VENDOR", label: "벤더" },
  { value: "AGENCY", label: "대행사" },
  { value: "AGENT", label: "에이전시" },
  { value: "SELLER", label: "셀러" },
];

// --- Hooks ---

function useDesktop() {
  const [isDesktop, setIsDesktop] = useState(true);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const sync = () => setIsDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return isDesktop;
}

// --- Main Component ---

const defaultSyncBusinessInfo = async (partnerId: string, force = false) => {
  const response = await fetch(`/api/partners/${partnerId}/business-info?force=${force}`);
  if (!response.ok) throw new Error("동기화 실패");
  return response.json();
};

const defaultUploadBusinessCardOcr = async (partnerId: string, fileBase64: string, mimeType: string) => {
  const response = await fetch(`/api/partners/${partnerId}/business-info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileBase64, mimeType }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "OCR 실패");
  }
  return response.json();
};

const defaultSubmitContact = async (partnerId: string, contactData: Record<string, any>) => {
  const response = await fetch(`/api/partners/${partnerId}/contacts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(contactData),
  });
  if (!response.ok) throw new Error("담당자 추가 실패");
  return response.json();
};

const defaultUpdateContact = async (partnerId: string, contactId: string, contactData: Record<string, any>) => {
  const response = await fetch(`/api/partners/contacts/${contactId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(contactData),
  });
  if (!response.ok) throw new Error("담당자 수정 실패");
  return response.json();
};

const defaultDeleteContact = async (partnerId: string, contactId: string) => {
  const response = await fetch(`/api/partners/contacts/${contactId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error("담당자 삭제 실패");
  return response.json();
};

const defaultPatchPartner = async (partnerId: string, field: string, value: string | number) => {
  const response = await fetch(`/api/partners/${partnerId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: value || null }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "수정 실패");
  }
  return response.json();
};

export function PartnersPanel({
  partner,
  open,
  onOpenChange,
  onUpdated,
  onCreated,
  onDeleted,
  mode = "view",
  onSyncBusinessInfo,
  onUploadBusinessCardOcr,
  onSubmitContact,
  onUpdateContact,
  onDeleteContact,
  onPatchPartner,
}: PartnersPanelProps) {
  const router = useRouter();
  const isDesktop = useDesktop();
  const syncBusinessInfoFn = onSyncBusinessInfo ?? defaultSyncBusinessInfo;
  const uploadBusinessCardOcrFn = onUploadBusinessCardOcr ?? defaultUploadBusinessCardOcr;
  const submitContactFn = onSubmitContact ?? defaultSubmitContact;
  const updateContactFn = onUpdateContact ?? defaultUpdateContact;
  const deleteContactFn = onDeleteContact ?? defaultDeleteContact;
  const patchPartnerFn = onPatchPartner ?? defaultPatchPartner;
  const [linkedDeals, setLinkedDeals] = useState<LinkedDeal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);
  const [dealsError, setDealsError] = useState<string>();
  const [contacts, setContacts] = useState<NonNullable<PartnerPanelData["contacts"]>>(partner?.contacts ?? []);
  const [addingContact, setAddingContact] = useState(false);
  const [linkSearchOpen, setLinkSearchOpen] = useState(false);
  const [changeSearchOpen, setChangeSearchOpen] = useState(false);
  const [pendingDealChange, setPendingDealChange] = useState<LinkedDeal | null>(null);
  const [pendingLinkTarget, setPendingLinkTarget] = useState<SearchResultItem | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [orderRulesReviewOpen, setOrderRulesReviewOpen] = useState(false); // F4 Phase 2 열 매핑 검수

  // --- Linked sellers state ---
  type LinkedSeller = {
    id: string;
    name: string;
    snsType: string | null;
    snsHandle: string | null;
  };
  const [linkedSellers, setLinkedSellers] = useState<LinkedSeller[]>([]);
  const [sellerLinkSearchOpen, setSellerLinkSearchOpen] = useState(false);
  const [sellerConfirmOpen, setSellerConfirmOpen] = useState(false);
  const [sellerConfirmLoading, setSellerConfirmLoading] = useState(false);
  const [pendingSellerLink, setPendingSellerLink] = useState<{
    sellerId: string;
    sellerName: string;
    previousPartnerName?: string;
  } | null>(null);

  // --- Create mode state ---
  type CreateFormState = {
    name: string;
    type: PartnerType | "";
    status: "거래중" | "거래중단" | "거래보류" | "응답없음";
    businessNumber: string;
    contactInfo: string;
    representativeEmail: string;
    bankAccount: string;
  };

  const INITIAL_CREATE_FORM: CreateFormState = {
    name: "",
    type: "",
    status: "거래중",
    businessNumber: "",
    contactInfo: "",
    representativeEmail: "",
    bankAccount: "",
  };

  const [createForm, setCreateForm] = useState<CreateFormState>(INITIAL_CREATE_FORM);
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({});
  const [createSubmitting, setCreateSubmitting] = useState(false);
  // 사업자번호 사전조회 상태 (create mode)
  const [bizPreview, setBizPreview] = useState<{
    companyStatus: string;
    companyRole: string;
    ceoName?: string | null;
    address?: string | null;
  } | null>(null);
  const [bizPreviewing, setBizPreviewing] = useState(false);
  // view mode 동기화 상태
  const [isSyncing, setIsSyncing] = useState(false);
  const [isUploadingBiz, setIsUploadingBiz] = useState(false);

  const handleBizLicenseUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploadingBiz(true);
    try {
      // 파일명 자동 변형: [사업자명]_사업자등록증.[확장자]
      // OS 파일명으로 사용할 수 없는 특수문자 정규화
      const sanitizedPartnerName = (partner?.name || "사업자").replace(/[\/\\:*?"<>|]/g, "_");
      const fileExtension = file.name.split(".").pop() || "jpg";
      const renamedFileName = `${sanitizedPartnerName}_사업자등록증.${fileExtension}`;
      const renamedFile = new File([file], renamedFileName, { type: file.type });

      // 1단계: API /api/assets 에 업로드 (Prisma Asset 레코드 생성)
      const formData = new FormData();
      formData.append("file", renamedFile);
      formData.append("entityType", "PARTNER");
      formData.append("entityId", partner!.id);
      formData.append("section", "ETC");
      formData.append("fileName", renamedFileName);
      formData.append("mimeType", file.type);
      formData.append("sizeBytes", String(file.size));

      const uploadRes = await fetch("/api/assets", {
        method: "POST",
        body: formData,
      });

      if (!uploadRes.ok) {
        throw new Error("파일 업로드에 실패했습니다.");
      }

      // 2단계: 파일을 base64로 읽기
      const fileBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
          const result = reader.result as string;
          const base64Data = result.split(",")[1];
          resolve(base64Data);
        };
        reader.onerror = (error) => reject(error);
      });

      // 3단계: Gemini OCR 처리
      const data = await uploadBusinessCardOcrFn(partner!.id, fileBase64, file.type);
      if (data.success && data.partner) {
        toast.success("사업자 정보가 자동으로 업데이트되었습니다.");
        onUpdated?.({
          ...partner!,
          ...data.partner,
        });
      } else {
        throw new Error("정보 추출 실패");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "사업자등록증 처리 중 오류가 발생했습니다.");
    } finally {
      setIsUploadingBiz(false);
      e.target.value = "";
    }
  };

  // Reset create form when panel opens in create mode
  useEffect(() => {
    if (open && mode === "create") {
      // Intentional reset for create-mode reentry.
      setCreateForm(INITIAL_CREATE_FORM);
      setCreateErrors({});
      setCreateSubmitting(false);
      setBizPreview(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  // Sync contacts state when partner prop changes
  useEffect(() => {
    // Local optimistic contact edits are scoped to the active partner payload.
    setContacts(partner?.contacts ?? []);
  }, [partner?.contacts]);

  const fetchLinkedDeals = useCallback(async (activePartner: PartnerPanelData) => {
    setLoadingDeals(true);
    setDealsError(undefined);
    try {
      const res = await fetch(`/api/deals?partnerId=${activePartner.id}&sortBy=createdAt&sortDir=desc`);
      if (!res.ok) {
        throw new Error("연결된 딜을 불러오지 못했습니다.");
      }
      const data = await res.json();
      const deals = Array.isArray(data) ? data : data.deals ?? [];
      setLinkedDeals(
        sortLinkedDealsByCreatedAt(deals.map((d: Record<string, unknown>) => {
          return {
            id: d.id as string,
            dealName: d.dealName as string,
            status: d.status as string,
            brandName: (d.brandName as string | null | undefined) ?? null,
            createdAt: typeof d.createdAt === "string" ? d.createdAt : undefined,
          };
        })),
      );
    } catch (error) {
      setLinkedDeals([]);
      setDealsError(
        error instanceof Error ? error.message : "연결된 딜을 불러오지 못했습니다.",
      );
    } finally {
      setLoadingDeals(false);
    }
  }, []);

  const fetchLinkedSellers = useCallback(async (activePartner: PartnerPanelData) => {
    try {
      const res = await fetch(`/api/sellers?agencyId=${activePartner.id}`);
      if (!res.ok) return;
      const data = await res.json();
      const sellers = Array.isArray(data) ? data : data.sellers ?? [];
      setLinkedSellers(
        sellers.map((s: Record<string, unknown>) => ({
          id: String(s.id),
          name: String(s.name ?? ""),
          snsType: s.snsType ? String(s.snsType) : null,
          snsHandle: s.snsHandle ? String(s.snsHandle) : null,
        }))
      );
    } catch {
      setLinkedSellers([]);
    }
  }, []);

  // Fetch linked deals and linked sellers when panel opens
  useEffect(() => {
    let cancelled = false;

    async function fetchPanelData() {
      if (!open || !partner) {
        if (!cancelled) {
          setLinkedDeals([]);
          setLinkedSellers([]);
          setDealsError(undefined);
        }
        return;
      }

      void fetchLinkedDeals(partner).catch(() => undefined);
      void fetchLinkedSellers(partner).catch(() => undefined);
    }

    void fetchPanelData();
    return () => {
      cancelled = true;
    };
  }, [fetchLinkedDeals, fetchLinkedSellers, open, partner]);

  // --- Contact handlers ---
  async function patchContact(contactId: string, field: string, value: string) {
    const prevContacts = [...contacts];
    // Optimistically update local state
    setContacts((prev) =>
      prev.map((c) =>
        c.id === contactId ? { ...c, [field]: value || null } : c
      )
    );

    try {
      const updated = await updateContactFn(partner!.id, contactId, { [field]: value || null });
      // Update with server response
      setContacts((prev) =>
        prev.map((c) => (c.id === contactId ? { ...c, ...updated } : c))
      );
      onUpdated?.({ ...partner!, contacts });
    } catch {
      // Rollback on failure
      setContacts(prevContacts);
      toast.error("담당자 정보 저장에 실패했습니다.");
    }
  }

  async function handleAddContact() {
    if (!partner) return;
    setAddingContact(true);
    try {
      const newContact = await submitContactFn(partner.id, { name: "새 담당자" });
      setContacts((prev) => [...prev, newContact]);
      onUpdated?.({ ...partner, contacts: [...contacts, newContact] });
      toast.success("담당자가 추가되었습니다.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "담당자 추가에 실패했습니다."
      );
    } finally {
      setAddingContact(false);
    }
  }

  async function handleDeleteContact(contactId: string) {
    if (!partner) return;
    const prevContacts = [...contacts];
    // Optimistically remove
    setContacts((prev) => prev.filter((c) => c.id !== contactId));

    try {
      await deleteContactFn(partner.id, contactId);
      const updatedContacts = prevContacts.filter((c) => c.id !== contactId);
      onUpdated?.({ ...partner, contacts: updatedContacts });
      toast.success("담당자가 삭제되었습니다.");
    } catch (error) {
      // Rollback on failure
      setContacts(prevContacts);
      toast.error(
        error instanceof Error ? error.message : "담당자 삭제에 실패했습니다."
      );
    }
  }

  // --- Create mode submit handler ---
  const handleCreateSubmit = useCallback(async () => {
    setCreateErrors({});

    // Validate using validatePartnerCreation
    const validation = validatePartnerCreation({
      name: createForm.name,
      type: createForm.type,
    });

    // Also validate business number if provided
    const bnValidation = validateBusinessNumber(createForm.businessNumber);
    if (!bnValidation.valid && bnValidation.error) {
      validation.valid = false;
      validation.errors.businessNumber = bnValidation.error;
    }

    if (!validation.valid) {
      setCreateErrors(validation.errors);
      return;
    }

    setCreateSubmitting(true);
    try {
      const body: Record<string, string | undefined> = {
        name: createForm.name.trim(),
        type: createForm.type || undefined,
        status: createForm.status,
      };
      if (createForm.businessNumber) body.businessNumber = createForm.businessNumber;
      if (createForm.contactInfo) body.contactInfo = createForm.contactInfo;
      if (createForm.representativeEmail) body.representativeEmail = createForm.representativeEmail;
      if (createForm.bankAccount) body.bankAccount = createForm.bankAccount;

      // 사업자번호 조회 결과가 있으면 그대로 이관
      if (bizPreview) {
        if (bizPreview.companyStatus) body.companyStatus = bizPreview.companyStatus;
        if (bizPreview.companyRole) body.companyRole = bizPreview.companyRole;
        if (bizPreview.ceoName) body.ceoName = bizPreview.ceoName;
        if (bizPreview.address) body.address = bizPreview.address;
      }

      const response = await fetch("/api/partners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        const message =
          errorData?.error && typeof errorData.error === "string"
            ? errorData.error
            : "저장에 실패했습니다. 다시 시도해주세요.";
        toast.error(message);
        return;
      }

      const created = await response.json();
      // 사업자번호가 있는 경우 생성 직후 자동으로 사업자 정보 조회
      if (createForm.businessNumber && created.id) {
        try {
          await fetch(`/api/partners/${created.id}/business-info?force=true`);
          // 조회 결과는 상세 패널 오픈 시 서버에서 반영됨
        } catch {
          // 자동 조회 실패해도 거래처 생성 자체는 성공
        }
      }
      toast.success("거래처가 등록되었습니다.");
      const createdPartner: PartnerPanelData = {
        id: created.id,
        name: created.name,
        type: created.type,
        status: created.status ?? null,
        contactInfo: created.contactInfo ?? null,
        bankAccount: created.bankAccount ?? null,
        businessNumber: created.businessNumber ?? null,
        companyStatus: created.companyStatus ?? null,
        companyRole: created.companyRole ?? null,
        ceoName: created.ceoName ?? null,
        address: created.address ?? null,
        bizSyncedAt: created.bizSyncedAt ?? null,
      };
      onCreated?.(createdPartner);
    } catch {
      toast.error("서버 오류가 발생했습니다. 다시 시도해주세요.");
    } finally {
      setCreateSubmitting(false);
    }
    // bizPreview 누락은 stale closure 버그였다 — 사업자번호 조회 버튼은 createForm 을
    // 건드리지 않고 bizPreview 만 세팅하므로, 조회 직후 곧바로 등록하면 이 콜백이
    // 조회 전(=null) 값을 붙잡아 companyStatus·ceoName·address 가 POST 본문에서 빠졌다.
  }, [createForm, bizPreview, onCreated]);

  // --- Create mode body ---
  if (mode === "create") {
    const createBody = (
      <div className="flex flex-col gap-5">
        <FieldGroup>
          <FieldSet>
            <FieldLegend>핵심 식별 정보</FieldLegend>
            <Field data-invalid={!!createErrors.name}>
              <FieldLabel>
                이름 <span className="text-destructive">*</span>
              </FieldLabel>
              <Input
                value={createForm.name}
                onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                placeholder="거래처 이름 (1~50자)"
                maxLength={50}
                aria-invalid={!!createErrors.name}
              />
              <FieldError>{createErrors.name}</FieldError>
            </Field>

            <Field data-invalid={!!createErrors.type}>
              <FieldLabel>
                유형 <span className="text-destructive">*</span>
              </FieldLabel>
              <Select
                value={createForm.type}
                onValueChange={(value) =>
                  setCreateForm({ ...createForm, type: value as PartnerType })
                }
              >
                <SelectTrigger className="w-full" aria-invalid={!!createErrors.type}>
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
              <FieldError>{createErrors.type}</FieldError>
            </Field>

            <Field>
              <FieldLabel>
                상태 <span className="text-destructive">*</span>
              </FieldLabel>
              <Select
                value={createForm.status}
                onValueChange={(value) =>
                  setCreateForm({ ...createForm, status: value as CreateFormState["status"] })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="상태 선택" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="거래중">거래중</SelectItem>
                    <SelectItem value="거래중단">거래중단</SelectItem>
                    <SelectItem value="거래보류">거래보류</SelectItem>
                    <SelectItem value="응답없음">응답없음</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldSet>

          <FieldSet>
            <FieldLegend>운영 보강 정보</FieldLegend>
            <Field data-invalid={!!createErrors.businessNumber}>
              <FieldLabel>사업자번호</FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  value={formatBusinessNumber(createForm.businessNumber)}
                  onChange={(e) => {
                    // Only allow digits, max 10
                    const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
                    setCreateForm({ ...createForm, businessNumber: digits });
                    setBizPreview(null);
                  }}
                  placeholder="10자리 숫자"
                  maxLength={12}
                  inputMode="numeric"
                  className="flex-1"
                  aria-invalid={!!createErrors.businessNumber}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 text-xs"
                  disabled={createForm.businessNumber.length !== 10 || bizPreviewing}
                  onClick={async () => {
                    const bn = createForm.businessNumber;
                    if (bn.length !== 10) return;
                    setBizPreviewing(true);
                    setBizPreview(null);
                    try {
                      // 임시로 저장 없이 국세청 API를 직접 호출할 수 없으므로
                      // 빈 거래처를 만들어서 조회 후 결과를 프리뷰에 표시
                      const tempRes = await fetch("/api/partners", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          name: "__biz_preview_temp__",
                          type: "BRAND",
                          businessNumber: bn,
                        }),
                      });
                      if (!tempRes.ok) throw new Error();
                      const temp = await tempRes.json();
                      const infoRes = await fetch(`/api/partners/${temp.id}/business-info?force=true`);
                      const info = await infoRes.json();
                      // 임시 거래처 삭제
                      await fetch(`/api/partners/${temp.id}`, { method: "DELETE" }).catch(() => null);
                      if (info.companyStatus) {
                        setBizPreview({
                          companyStatus: info.companyStatus,
                          companyRole: info.companyRole ?? "",
                          ceoName: info.ceoName,
                          address: info.address,
                        });
                      } else {
                        toast.error("사업자 정보를 조회하지 못했습니다.");
                      }
                    } catch {
                      toast.error("사업자 정보 조회에 실패했습니다.");
                    } finally {
                      setBizPreviewing(false);
                    }
                  }}
                >
                  {bizPreviewing ? (
                    <RefreshCw className="size-3.5 animate-spin" />
                  ) : (
                    "조회"
                  )}
                </Button>
              </div>
              <FieldError>{createErrors.businessNumber}</FieldError>
              {bizPreview && (
                <Alert>
                  <AlertTitle>
                    조회 성공 · {bizPreview.companyStatus}
                    {bizPreview.companyRole ? ` · ${bizPreview.companyRole}` : ""}
                  </AlertTitle>
                  {(bizPreview.ceoName || bizPreview.address) && (
                    <AlertDescription className="flex flex-col gap-1 text-xs">
                      {bizPreview.ceoName && (
                        <span>대표자: {bizPreview.ceoName}</span>
                      )}
                      {bizPreview.address && (
                        <span>주소: {bizPreview.address}</span>
                      )}
                    </AlertDescription>
                  )}
                </Alert>
              )}
            </Field>

            <Field>
              <FieldLabel>연락처</FieldLabel>
              <Input
                value={createForm.contactInfo}
                onChange={(e) => setCreateForm({ ...createForm, contactInfo: e.target.value })}
                placeholder="연락처 정보"
              />
            </Field>

            <Field>
              <FieldLabel>대표 이메일</FieldLabel>
              <Input
                type="email"
                value={createForm.representativeEmail}
                onChange={(e) => setCreateForm({ ...createForm, representativeEmail: e.target.value })}
                placeholder="세금계산서/정산 연락 이메일"
              />
              <FieldDescription className="text-xs">
                세금계산서와 정산 연락에 우선 사용됩니다.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel>계좌정보</FieldLabel>
              <Input
                value={createForm.bankAccount}
                onChange={(e) => setCreateForm({ ...createForm, bankAccount: e.target.value })}
                placeholder="은행명 계좌번호 (예: 국민 000-000-000)"
              />
            </Field>
          </FieldSet>
        </FieldGroup>

        <div className="flex items-center justify-end gap-3 border-t border-border/70 pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
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

    const createPanel = isDesktop ? (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0 overflow-hidden flex flex-col max-h-[85vh]">
          <DialogHeader className="shrink-0 border-b border-border/70 px-6 py-5">
            <DialogTitle>신규 거래처 등록</DialogTitle>
            <DialogDescription>
              영업과 정산에서 사용할 거래처 식별 정보를 등록합니다.
            </DialogDescription>
          </DialogHeader>
          {/* scrollbar-gutter: 내용이 85vh를 넘겨 스크롤바가 등장할 때 폭 흔들림 방지(PR #57 관례). */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-7 [scrollbar-gutter:stable]">{createBody}</div>
        </DialogContent>
      </Dialog>
    ) : (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[88vh] px-5 pb-5 duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]">
          <DrawerHeader className="flex-row items-center justify-between px-0">
            <div>
              <DrawerTitle>신규 거래처 등록</DrawerTitle>
              <DrawerDescription>
                영업과 정산에서 사용할 거래처 식별 정보를 등록합니다.
              </DrawerDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onOpenChange(false)}
            >
              <X />
            </Button>
          </DrawerHeader>
          {createBody}
        </DrawerContent>
      </Drawer>
    );

    return createPanel;
  }

  if (!partner) return null;



  async function patchPartner(field: string, value: string | number) {
    const updated = await patchPartnerFn(partner!.id, field, value);
    onUpdated?.({ ...partner!, ...updated });
  }

  async function applyDealPartnerChange(dealId: string, nextPartnerId: string) {
    const res = await fetch(`/api/links/deal/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partnerId: nextPartnerId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error ?? "딜 연결 변경에 실패했습니다.");
    }
    if (data?.logWarning) {
      toast.warning(data.logWarning);
    }
    return data;
  }

  async function handleLinkDealSelection(item: SearchResultItem) {
    if (!partner) return;
    const needsConfirm = linkedDeals.some((deal) => deal.id === item.id) === false;
    if (!needsConfirm) return;
    setPendingLinkTarget(item);
    setConfirmOpen(true);
  }

  async function handleConfirmLinkDeal() {
    if (!partner || !pendingLinkTarget) return;
    setConfirmLoading(true);
    try {
      await applyDealPartnerChange(pendingLinkTarget.id, partner.id);
      toast.success("딜이 연결되었습니다.");
      await fetchLinkedDeals(partner);
      onUpdated?.({
        ...partner,
        dealCount: linkedDeals.length + 1,
      });
      setConfirmOpen(false);
      setPendingLinkTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "딜 연결에 실패했습니다.");
    } finally {
      setConfirmLoading(false);
    }
  }

  async function handleChangeDealPartner(item: SearchResultItem) {
    if (!pendingDealChange || !partner) return;
    try {
      await applyDealPartnerChange(pendingDealChange.id, item.id);
      toast.success("딜 연결이 변경되었습니다.");
      setLinkedDeals((current) => current.filter((deal) => deal.id !== pendingDealChange.id));
      onUpdated?.({
        ...partner,
        dealCount: Math.max((partner.dealCount ?? linkedDeals.length) - 1, 0),
      });
      setChangeSearchOpen(false);
      setPendingDealChange(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "딜 연결 변경에 실패했습니다.");
    }
  }

  async function handleDeletePartner() {
    if (!partner) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/partners/${partner.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("거래처가 삭제되었습니다.");
        setDeleteDialogOpen(false);
        onOpenChange(false);
        onDeleted?.(partner.id);
      } else {
        const data = await res.json().catch(() => null);
        const message =
          data?.error && typeof data.error === "string"
            ? data.error
            : "삭제에 실패했습니다.";
        toast.error(message);
      }
    } catch {
      toast.error("삭제에 실패했습니다.");
    } finally {
      setDeleteLoading(false);
    }
  }

  // --- Seller link handlers ---
  async function handleSellerLinkSelection(item: SearchResultItem) {
    if (!partner) return;
    try {
      const res = await fetch("/api/links/seller-partner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerId: item.id, partnerId: partner.id }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? "셀러 연결에 실패했습니다.");
        return;
      }

      const data = await res.json();

      if (data.previousPartnerId) {
        // Seller was linked to another partner — show confirmation
        // The API already changed the link, so we need to handle cancel by reverting
        // First, find the previous partner name from the search result metadata
        const previousPartnerName = item.metadata?.agencyName || "다른 거래처";
        setPendingSellerLink({
          sellerId: item.id,
          sellerName: item.label,
          previousPartnerName,
        });
        setSellerConfirmOpen(true);
        // Optimistically add to list (will revert on cancel)
        setLinkedSellers((prev) => [
          ...prev,
          {
            id: item.id,
            name: item.label,
            snsType: item.sublabel?.split(" · ")[0] ?? null,
            snsHandle: item.sublabel?.split(" · ")[1] ?? null,
          },
        ]);
      } else {
        // No previous link — just add to list
        toast.success("셀러가 연결되었습니다.");
        setLinkedSellers((prev) => [
          ...prev,
          {
            id: item.id,
            name: item.label,
            snsType: item.sublabel?.split(" · ")[0] ?? null,
            snsHandle: item.sublabel?.split(" · ")[1] ?? null,
          },
        ]);
      }
    } catch {
      toast.error("셀러 연결에 실패했습니다.");
    }
  }

  async function handleSellerConfirmOk() {
    // The link was already changed by the POST call — just close the dialog
    setSellerConfirmOpen(false);
    setPendingSellerLink(null);
    toast.success("셀러 연결이 변경되었습니다.");
  }

  async function handleSellerConfirmCancel() {
    // Revert the link by calling DELETE
    if (!pendingSellerLink) {
      setSellerConfirmOpen(false);
      return;
    }
    setSellerConfirmLoading(true);
    try {
      await fetch("/api/links/seller-partner", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerId: pendingSellerLink.sellerId }),
      });
      // Remove from local list
      setLinkedSellers((prev) =>
        prev.filter((s) => s.id !== pendingSellerLink.sellerId)
      );
    } catch {
      toast.error("연결 취소에 실패했습니다.");
    } finally {
      setSellerConfirmLoading(false);
      setSellerConfirmOpen(false);
      setPendingSellerLink(null);
    }
  }

  const body = (
    /* Radix ScrollArea 대신 네이티브 스크롤 — Radix 는 네이티브 스크롤바를 숨겨
       비오버레이 스크롤바(Windows) 환경에서 "잘렸는데 스크롤바 없는" 상태가 된다
       (PR #57 근본원인). 상세 Sheet 는 side=right 라 h-full(확정 높이)이므로 이
       h-full 스크롤러가 정상 해소된다(seller-detail-content 의 검증된 패턴). */
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="space-y-6 overflow-hidden p-1 pr-3">
        {/* Partner Details — 회사 정보 섹션 */}
        <div className="space-y-1 rounded-lg border border-border/70 bg-card p-4">
          <h3 className="mb-2 text-xs font-semibold text-foreground">회사 정보</h3>

          {/* Editable fields */}
          <InlineEditField
            label="이름"
            value={partner.name}
            fieldType="text"
            onSave={(v) => patchPartner("name", v)}
          />
          <InlineEditField
            label="유형"
            value={partner.type}
            fieldType="select"
            options={PARTNER_TYPE_OPTIONS}
            onSave={(v) => patchPartner("type", v)}
          />
          <InlineEditField
            label="거래처 상태"
            value={partner.status ?? ""}
            fieldType="select"
            options={[
              { value: "거래중", label: "거래중" },
              { value: "거래중단", label: "거래중단" },
              { value: "거래보류", label: "거래보류" },
              { value: "응답없음", label: "응답없음" },
            ]}
            onSave={(v) => patchPartner("status", v)}
          />
          <InlineEditField
            label="사업자번호"
            value={partner.businessNumber ?? ""}
            displayValue={partner.businessNumber ? formatBusinessNumber(partner.businessNumber) : ""}
            fieldType="text"
            validate={(v) => {
              // Strip non-digits for validation
              const digitsOnly = v.replace(/\D/g, "");
              const result = validateBusinessNumber(digitsOnly);
              return result.valid ? null : (result.error ?? "사업자번호는 10자리 숫자여야 합니다.");
            }}
            onSave={async (v) => {
              const strVal = String(v);
              const digitsOnly = strVal.replace(/\D/g, "").slice(0, 10);
              await patchPartner("businessNumber", digitsOnly);
            }}
            actionButton={
              partner.businessNumber && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 rounded-md hover:bg-slate-100"
                  disabled={isSyncing}
                  onClick={async (e) => {
                    e.stopPropagation();
                    setIsSyncing(true);
                    try {
                      const info = await syncBusinessInfoFn(partner!.id, true);
                      if (info.skipped) {
                        toast.info("최근 7일 이내에 동기화되었습니다. force 옵션으로 재조회합니다.");
                        return;
                      }
                      onUpdated?.({
                        ...partner!,
                        companyStatus: info.companyStatus ?? partner!.companyStatus,
                        companyRole: info.companyRole ?? partner!.companyRole,
                        ceoName: info.ceoName ?? partner!.ceoName,
                        address: info.address ?? partner!.address,
                        businessType: info.businessType ?? partner!.businessType,
                        businessItem: info.businessItem ?? partner!.businessItem,
                        name: info.name ?? partner!.name,
                        bizSyncedAt: info.bizSyncedAt ? String(info.bizSyncedAt) : partner!.bizSyncedAt,
                      });
                      const syncDetails = [
                        info.businessType || info.businessItem
                          ? `${[info.businessType ? "업태" : null, info.businessItem ? "종목" : null].filter(Boolean).join("·")} 포함`
                          : null,
                        info.bizCompanyName && info.bizCompanyName !== (info.name ?? partner!.name)
                          ? `조회된 상호: ${info.bizCompanyName} (거래처명 유지)`
                          : null,
                      ].filter(Boolean);
                      // 토스트는 항상 1개 — 부가 정보는 description 한 줄로 합침(중복 토스트 방지)
                      toast.success("사업자 정보가 동기화되었습니다.", {
                        description: syncDetails.length > 0 ? syncDetails.join(" · ") : undefined,
                      });
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "동기화에 실패했습니다.");
                    } finally {
                      setIsSyncing(false);
                    }
                  }}
                  title="사업자 정보 동기화"
                >
                  <RefreshCw className={`size-3 text-muted-foreground ${isSyncing ? "animate-spin" : ""}`} />
                </Button>
              )
            }
          />

          {/* 사업자등록증 업로드 필드 */}
          <div className="flex flex-col gap-1.5 px-2 py-2.5 bg-slate-50/50 rounded-lg border border-slate-100 mt-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">사업자등록증 업로드</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="text-muted-foreground hover:text-foreground cursor-pointer select-none">
                      <HelpCircle className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="start" className="max-w-[240px] text-[11px] bg-slate-900 text-white border-0 px-2.5 py-1.5 rounded-lg shadow-overlay leading-normal">
                    이미지나 PDF 파일을 업로드하면 사업자 정보가 자동으로 추출되어 업데이트됩니다.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="file"
                id="biz-license-upload"
                accept="image/*,application/pdf"
                className="hidden"
                disabled={isUploadingBiz}
                onChange={handleBizLicenseUpload}
              />
              <label
                htmlFor="biz-license-upload"
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 h-8 px-3 rounded-md border border-dashed border-slate-300 bg-white text-xs font-semibold cursor-pointer text-slate-700 hover:bg-slate-50 transition-colors select-none",
                  isUploadingBiz && "opacity-50 cursor-not-allowed"
                )}
              >
                {isUploadingBiz ? (
                  <>
                    <RefreshCw className="size-3.5 animate-spin text-muted-foreground" />
                    <span>업로드 및 분석 중...</span>
                  </>
                ) : (
                  <>
                    <Plus className="size-3.5 text-muted-foreground" />
                    <span>사업자등록증 파일 업로드</span>
                  </>
                )}
              </label>
            </div>
          </div>

          <InlineEditField
            label="대표자명"
            value={partner.ceoName ?? ""}
            fieldType="text"
            onSave={(v) => patchPartner("ceoName", v)}
          />
          <InlineEditField
            label="업태"
            value={partner.businessType ?? ""}
            fieldType="text"
            onSave={(v) => patchPartner("businessType", v)}
          />
          <InlineEditField
            label="종목"
            value={partner.businessItem ?? ""}
            fieldType="text"
            onSave={(v) => patchPartner("businessItem", v)}
          />
          <InlineEditField
            label="대표이메일"
            value={partner.representativeEmail ?? ""}
            fieldType="text"
            onSave={(v) => patchPartner("representativeEmail", v)}
          />
          <InlineEditField
            label="사업장 주소"
            value={partner.address ?? ""}
            fieldType="text"
            onSave={(v) => patchPartner("address", v)}
          />
          <InlineEditField
            label="납세자 상태"
            value={partner.companyStatus ?? ""}
            fieldType="text"
            onSave={(v) => patchPartner("companyStatus", v)}
          />
          <InlineEditField
            label="과세 유형"
            value={partner.companyRole ?? ""}
            fieldType="text"
            onSave={(v) => patchPartner("companyRole", v)}
          />
          <InlineEditField
            label="연락처"
            value={partner.contactInfo ?? ""}
            fieldType="text"
            onSave={(v) => patchPartner("contactInfo", v)}
          />
          <InlineEditField
            label="계좌정보"
            value={partner.bankAccount ?? ""}
            fieldType="text"
            onSave={(v) => patchPartner("bankAccount", v)}
          />
        </div>

        {/* 담당자 정보 섹션 */}
        <div className="space-y-3 rounded-lg border border-border/70 bg-card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">
              담당자 정보
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({contacts.length}명)
              </span>
            </h3>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={handleAddContact}
              disabled={addingContact}
            >
              <Plus className="mr-1 size-3.5" />
              담당자 추가
            </Button>
          </div>
          <Separator />
          {contacts.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-xs text-muted-foreground">등록된 담당자가 없습니다.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {contacts.map((contact) => (
                <div
                  key={contact.id}
                  className="relative rounded-lg border border-border/70 bg-white/80 px-3 py-3"
                >
                  <button
                    type="button"
                    className="absolute right-2 top-2 rounded-md p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                    onClick={() => handleDeleteContact(contact.id)}
                    aria-label={`${contact.name} 삭제`}
                  >
                    <X className="size-3.5" />
                  </button>
                  <div className="space-y-0.5 pr-6">
                    <InlineEditField
                      label="이름"
                      value={contact.name}
                      fieldType="text"
                      onSave={(v) => patchContact(contact.id, "name", String(v))}
                    />
                    <InlineEditField
                      label="역할"
                      value={contact.role ?? ""}
                      fieldType="text"
                      onSave={(v) => patchContact(contact.id, "role", String(v))}
                    />
                    <InlineEditField
                      label="전화번호"
                      value={contact.phoneNumber ?? ""}
                      fieldType="text"
                      onSave={(v) => patchContact(contact.id, "phoneNumber", String(v))}
                    />
                    <InlineEditField
                      label="이메일"
                      value={contact.email ?? ""}
                      fieldType="text"
                      onSave={(v) => patchContact(contact.id, "email", String(v))}
                    />
                    <InlineEditField
                      label="메모"
                      value={contact.notes ?? ""}
                      fieldType="text"
                      onSave={(v) => patchContact(contact.id, "notes", String(v))}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 연결된 셀러 섹션 */}
        <div className="rounded-lg border border-border/70 bg-card p-4">
          <LinkedSellersList
            sellers={linkedSellers.map((s) => ({
              id: s.id,
              name: s.name,
              snsType: s.snsType,
              snsHandle: s.snsHandle,
              socialNetworks: [{ network: s.snsType ?? "", handle: s.snsHandle ?? "", url: "" }]
            }))}
            loading={false}
            emptyMessage="연결된 셀러가 없습니다"
            onLinkClick={() => setSellerLinkSearchOpen(true)}
            onEntityClick={(entityId) => {
              router.push(`/sellers?sellerId=${entityId}&from=partners&partnerId=${partner.id}`);
              onOpenChange(false);
            }}
          />
        </div>

        <div className="rounded-lg border border-border/70 bg-card p-4">
          <LinkedDealsList
            deals={linkedDeals.map((d) => ({
              id: d.id,
              dealName: d.dealName,
              brandName: d.brandName,
              status: d.status,
              createdAt: d.createdAt ?? ""
            }))}
            loading={loadingDeals}
            error={dealsError}
            emptyMessage="연결된 딜이 없습니다"
            onLinkClick={() => setLinkSearchOpen(true)}
            onUnlinkClick={async (entityId) => {
              try {
                const res = await fetch(`/api/links/deal/${entityId}`, {
                  method: "DELETE",
                });
                if (!res.ok) {
                  const data = await res.json().catch(() => null);
                  throw new Error(data?.error ?? "딜 연결 해제에 실패했습니다.");
                }
                toast.success("딜 연결이 해제되었습니다.");
                await fetchLinkedDeals(partner);
                onUpdated?.({
                  ...partner,
                  dealCount: Math.max((partner.dealCount ?? linkedDeals.length) - 1, 0),
                });
              } catch (error) {
                toast.error(
                  error instanceof Error ? error.message : "딜 연결 해제에 실패했습니다."
                );
              }
            }}
            onEntityClick={(entityId) => {
              router.push(`/deals?dealId=${entityId}&from=partners&partnerId=${partner.id}`);
              onOpenChange(false);
            }}
            onRetry={() => void fetchLinkedDeals(partner)}
          />
        </div>

        <Separator />

        {/* 발주 설정 섹션 (F4-② 딜 온보딩 제로코드화) — 공급사(BRAND/VENDOR) 또는 이미 설정된 거래처에만 노출. 첨부 자료 바로 위 */}
        {(partner.type === "BRAND" || partner.type === "VENDOR" || partner.orderTemplateSlug) && (
          <>
            <div className="space-y-1 rounded-lg border border-border/70 bg-card p-4">
              <h3 className="mb-0.5 text-xs font-semibold text-foreground">발주 설정</h3>
              <p className="mb-2 text-[11px] leading-normal text-muted-foreground">
                이 거래처(공급사)에 발주서를 보낼 이메일을 넣어두면 <b className="font-semibold text-foreground/80">발주 브랜드로 등록</b>되어, 주문관리 캠페인 등록의 &lsquo;거래처 양식&rsquo;에 나타나고 캠페인이 이 수신 이메일을 상속받습니다. (발주 코드는 자동 부여, 이름은 거래처명 사용.)
              </p>
              <InlineEditField
                label="기본 수신 이메일"
                value={partner.orderToEmail ?? ""}
                description="발주서를 받을 공급사 이메일(To). 입력하면 이 거래처가 발주 브랜드로 등록됩니다. 캠페인이 이 값을 상속하고, 공급사 회신 송장 매칭도 이 이메일의 도메인 기준입니다. 예: order@example.com"
                descriptionAsTooltip
                fieldType="text"
                onSave={(v) => patchPartner("orderToEmail", String(v).trim())}
              />
              <InlineEditField
                label="보조 수신 이메일"
                value={partner.orderCcEmail ?? ""}
                description="발주서 참조(CC). 선택 사항. 예: cc@example.com"
                descriptionAsTooltip
                fieldType="text"
                onSave={(v) => patchPartner("orderCcEmail", String(v).trim())}
              />
              <Separator className="my-2" />

              {/* F4 Phase 2: 열 매핑 규칙 상태 요약 + 검수 진입점 */}
              {(() => {
                const rules = parseOrderExcelRules(partner.orderExcelRules ?? null);
                return (
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <p className="text-xs font-medium text-foreground">
                        {rules ? "발주서 열 매핑 확정됨" : "발주서 열 매핑 미설정"}
                      </p>
                      <p className="text-[11px] leading-normal text-muted-foreground">
                        {rules
                          ? `열 ${rules.columns.length}개 · ${rules.write.mode === "fill-template" ? "양식 채움" : "신규 생성"}${rules.analyzedAt ? ` · ${formatDate(rules.analyzedAt)} 분석` : ""}`
                          : "아래 '첨부 자료'에 발주서 양식을 올린 뒤 분석·확정하면 캠페인 발주서가 그 매핑대로 생성됩니다."}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => setOrderRulesReviewOpen(true)}
                    >
                      {rules ? "재검수" : "발주서 양식 분석"}
                    </Button>
                  </div>
                );
              })()}
            </div>

            <OrderTemplateReviewDialog
              open={orderRulesReviewOpen}
              onOpenChange={setOrderRulesReviewOpen}
              partnerId={partner.id}
              partnerName={partner.name}
              activeRules={parseOrderExcelRules(partner.orderExcelRules ?? null)}
              onRulesSaved={(rules) => onUpdated?.({ ...partner, orderExcelRules: rules })}
            />

            <Separator />
          </>
        )}

        {/* 첨부 자료 */}
        <PartnerAssetSection partnerId={partner.id} />

        <Separator />

        {/* Activity Timeline */}
        <div className="rounded-lg border border-border/70 bg-card px-4">
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="activity" className="border-b-0">
              <AccordionTrigger className="py-4 text-xs font-semibold text-foreground hover:no-underline">
                활동 기록
              </AccordionTrigger>
              <AccordionContent className="pb-4">
                <ActivityTimeline
                  entityType="PARTNER"
                  entityId={partner.id}
                />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        {/* 등록일 */}
        <p className="text-xs text-muted-foreground">
          등록일: {partner.createdAt ? formatDate(partner.createdAt) : "-"}
        </p>

        {/* 거래처 삭제 */}
        <Separator />
        <div className="flex justify-end pb-4">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="mr-1.5 size-4" />
            거래처 삭제
          </Button>
        </div>
      </div>
    </div>
  );

  const panel = isDesktop ? (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          style={{ width: "min(540px, 96vw)", maxWidth: "min(540px, 96vw)" }}
          className="flex flex-col overflow-hidden border-l border-border/70 bg-[linear-gradient(180deg,#ffffff,#f8fafc)] p-0"
        >
          <SheetHeader className="shrink-0 border-b border-border/70 px-6 py-5">
            <SheetTitle>거래처 상세</SheetTitle>
            <SheetDescription>
              거래처 정보, 연결된 딜, 활동 기록을 확인합니다.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-hidden px-6 py-5">{body}</div>
        </SheetContent>
      </Sheet>
    ) : (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[88vh] px-5 pb-5 duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]">
        <DrawerHeader className="flex-row items-center justify-between px-0">
          <div>
            <DrawerTitle>거래처 상세</DrawerTitle>
            <DrawerDescription>
              거래처 정보, 연결된 딜, 활동 기록을 확인합니다.
            </DrawerDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </DrawerHeader>
        {body}
      </DrawerContent>
    </Drawer>
  );

  return (
    <>
      {panel}
      <LinkSearchDialog
        open={linkSearchOpen}
        onOpenChange={setLinkSearchOpen}
        entityType="deal"
        searchEndpoint="/api/search/deals"
        searchParams={{ excludePartnerId: partner.id }}
        title="연결할 딜 검색"
        placeholder="딜명 또는 브랜드명 검색"
        onSelect={(item) => {
          void handleLinkDealSelection(item);
        }}
      />
      <LinkSearchDialog
        open={changeSearchOpen}
        onOpenChange={(nextOpen) => {
          setChangeSearchOpen(nextOpen);
          if (!nextOpen) {
            setPendingDealChange(null);
          }
        }}
        entityType="partner"
        searchEndpoint="/api/search/partners"
        excludeIds={[partner.id]}
        title="다른 거래처 검색"
        placeholder="거래처명 검색"
        onSelect={(item) => {
          void handleChangeDealPartner(item);
        }}
      />
      <LinkConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        message={
          pendingLinkTarget
            ? `"${pendingLinkTarget.label}" 딜을 현재 거래처에 연결하시겠습니까? 기존 거래처 연결은 새 거래처로 변경됩니다.`
            : "연결을 진행하시겠습니까?"
        }
        onConfirm={() => void handleConfirmLinkDeal()}
        onCancel={() => {
          setConfirmOpen(false);
          setPendingLinkTarget(null);
        }}
        loading={confirmLoading}
      />
      <DeleteConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        entityName={partner.name}
        entityType="거래처"
        onConfirm={handleDeletePartner}
        loading={deleteLoading}
      />
      <LinkSearchDialog
        open={sellerLinkSearchOpen}
        onOpenChange={setSellerLinkSearchOpen}
        entityType="seller"
        searchEndpoint="/api/search/sellers"
        excludeIds={linkedSellers.map((s) => s.id)}
        title="연결할 셀러 검색"
        placeholder="셀러명 또는 SNS 핸들 검색"
        onSelect={(item) => {
          void handleSellerLinkSelection(item);
        }}
      />
      <LinkConfirmDialog
        open={sellerConfirmOpen}
        onOpenChange={setSellerConfirmOpen}
        message={
          pendingSellerLink
            ? `이 셀러는 현재 '${pendingSellerLink.previousPartnerName}' 거래처에 연결되어 있습니다. 연결을 변경하시겠습니까?`
            : "연결을 변경하시겠습니까?"
        }
        onConfirm={() => void handleSellerConfirmOk()}
        onCancel={() => void handleSellerConfirmCancel()}
        loading={sellerConfirmLoading}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// PartnerAssetSection — 거래처 상세 패널 내 파일 업로드·목록 섹션
// ---------------------------------------------------------------------------

const PARTNER_ASSET_SECTIONS: { value: AssetSection; label: string }[] = [
  { value: "PRODUCT_INTRO", label: assetSectionLabels["PRODUCT_INTRO"] },
  { value: "PRICE_TABLE", label: assetSectionLabels["PRICE_TABLE"] },
  { value: "CONTRACT_SETTLEMENT", label: assetSectionLabels["CONTRACT_SETTLEMENT"] },
  { value: "ORDER_TEMPLATE", label: assetSectionLabels["ORDER_TEMPLATE"] },
  { value: "ETC", label: assetSectionLabels["ETC"] },
];

type AssetItem = {
  id: string;
  fileName: string;
  section: string;
  sizeBytes: number;
  externalUrl?: string | null;
  archivedAt?: string | null;
};

function PartnerAssetSection({ partnerId }: { partnerId: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<AssetSection>("CONTRACT_SETTLEMENT");
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/assets?entityType=PARTNER&entityId=${encodeURIComponent(partnerId)}`)
      .then((r) => r.json())
      .then((data: { assets?: AssetItem[] }) => {
        if (data.assets) setAssets(data.assets);
      })
      .catch(() => undefined);
  }, [partnerId]);

  async function handleUpload(file: File) {
    setBusy(true);
    setErrorMsg(null);
    const formData = new FormData();
    formData.set("entityType", "PARTNER");
    formData.set("entityId", partnerId);
    formData.set("section", section);
    formData.set("file", file);
    const res = await fetch("/api/assets", { method: "POST", body: formData });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErrorMsg((data as { error?: string }).error ?? "업로드 실패");
      return;
    }
    const typed = data as { asset?: AssetItem };
    if (typed.asset) setAssets((prev) => [typed.asset!, ...prev]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleArchive(assetId: string) {
    const res = await fetch(`/api/assets/${assetId}`, { method: "PATCH" });
    if (!res.ok) return;
    const data = (await res.json()) as { asset: AssetItem };
    setAssets((prev) => prev.map((a) => (a.id === assetId ? data.asset : a)));
  }

  async function handleOpen(assetId: string) {
    const res = await fetch(`/api/assets/${assetId}?download=1`);
    const data = (await res.json()) as { downloadUrl?: string };
    if (data.downloadUrl) window.open(data.downloadUrl, "_blank", "noreferrer");
  }

  const visibleAssets = assets.filter((a) => !a.archivedAt);

  return (
    <section className="rounded-lg border border-border/70 bg-card p-4">
      <h3 className="text-xs font-semibold text-foreground">첨부 자료</h3>
      <p className="mt-1 text-xs text-muted-foreground">계약서, 거래처 서류 등 관련 파일을 첨부합니다.</p>

      <div className="mt-3 flex gap-2">
        <div className="flex-1">
          <select
            value={section}
            onChange={(e) => setSection(e.target.value as AssetSection)}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-ring"
          >
            {PARTNER_ASSET_SECTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <label
          className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-input px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary ${
            busy ? "pointer-events-none opacity-50" : ""
          }`}
        >
          <Upload className="size-3.5" />
          {busy ? "업로드 중..." : "파일 선택"}
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            accept=".pdf,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.doc,.docx"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
        </label>
      </div>
      {errorMsg ? <p className="mt-1.5 text-xs text-destructive">{errorMsg}</p> : null}

      {visibleAssets.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {visibleAssets.map((asset) => (
            <li
              key={asset.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-white/80 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{asset.fileName}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {assetSectionLabels[asset.section as AssetSection]} · {formatBytes(asset.sizeBytes)}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 gap-0.5">
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                  onClick={() => void handleOpen(asset.id)}
                  title="열기"
                >
                  <ExternalLink className="size-3" />
                </button>
                <button
                  type="button"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-slate-100 hover:text-foreground"
                  onClick={() => void handleArchive(asset.id)}
                  title="보관"
                >
                  <Archive className="size-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <DataEmpty title="첨부된 파일이 없습니다." className="mt-3 py-4" />
      )}
    </section>
  );
}
