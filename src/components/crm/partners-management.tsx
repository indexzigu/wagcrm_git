"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useFilterParams } from "@/hooks/use-filter-params";
import { PlusIcon, SearchIcon, Loader2, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataEmpty } from "@/components/ui/empty";
import { usePartners } from "@/hooks/usePartners";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  partnerTypeLabels,
  type DashboardData,
  type PartnerSummary,
} from "@/lib/crm-types";
import { formatLastContact } from "@/lib/partner-seller-display";
import { formatBusinessNumber } from "@/lib/format";
import { CrmShell } from "./crm-shell";
import { DataSourceBanner } from "./data-source-banner";
import { InlineDataGrid, type GridColumn } from "./inline-data-grid";
import { PartnersPanel } from "./partners-panel";

type PartnerRow = PartnerSummary;

type PartnersManagementProps = {
  initialPartners: PartnerRow[];
  dataSource?: DashboardData["dataSource"];
  dataSourceMessage?: string;
};

const partnerColumns: GridColumn<PartnerRow>[] = [
  { key: "name", label: "이름", width: 200 },
  {
    key: "type",
    label: "유형",
    width: 100,
    render: (row) => <span>{partnerTypeLabels[row.type] || row.type}</span>,
  },
  {
    key: "status",
    label: "상태",
    width: 100,
    render: (row) => {
      const status = row.status;
      if (!status) return <span className="text-muted-foreground">-</span>;
      let badgeStyles = "bg-slate-50 text-slate-700 ring-slate-600/10";
      if (status === "거래중") {
        badgeStyles = "bg-emerald-50 text-emerald-700 ring-emerald-600/20";
      } else if (status === "거래중단") {
        badgeStyles = "bg-red-50 text-red-700 ring-red-600/10";
      } else if (status === "거래보류") {
        badgeStyles = "bg-amber-50 text-amber-700 ring-amber-600/15";
      }
      return (
        <span
          className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${badgeStyles}`}
        >
          {status}
        </span>
      );
    },
  },
  {
    key: "companyStatus",
    label: "사업자 상태",
    width: 120,
    render: (row) => {
      const status = row.companyStatus;
      if (!status) return <span className="text-muted-foreground">-</span>;
      const isNormal = status === "계속사업자";
      return (
        <span
          className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
            isNormal
              ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
              : "bg-red-50 text-red-700 ring-red-600/10"
          }`}
        >
          {status}
        </span>
      );
    },
  },
  {
    key: "dealCount",
    label: "연결된 딜",
    width: 100,
    render: (row) => (
      <span className="font-semibold text-amber-600 tabular-nums">
        {row.dealCount ?? 0}개
      </span>
    ),
  },
  {
    key: "businessNumber",
    label: "사업자번호",
    width: 130,
    render: (row) => (
      <span className="text-xs text-muted-foreground tabular-nums">
        {row.businessNumber ? formatBusinessNumber(row.businessNumber) : "-"}
      </span>
    ),
  },
  {
    key: "contactInfo",
    label: "대표 담당자",
    width: 240,
    render: (row) => {
      const firstContact = row.contacts?.[0];
      if (!firstContact) return <span className="text-muted-foreground">-</span>;
      const contactDetail = firstContact.phoneNumber || firstContact.email || "";
      return (
        <span className="text-xs">
          <span className="font-medium text-foreground">{firstContact.name}</span>
          {contactDetail && (
            <span className="ml-1 text-muted-foreground">({contactDetail})</span>
          )}
        </span>
      );
    },
  },
  {
    key: "lastContactAt",
    label: "최근 컨택",
    width: 120,
    render: (row) => {
      const value = row.lastContactAt;
      if (!value) return <span className="text-muted-foreground">-</span>;
      const d = new Date(value);
      return <span className="text-xs tabular-nums">{formatLastContact(d)}</span>;
    },
  },
];

export function PartnersManagement({
  initialPartners,
  dataSource,
  dataSourceMessage,
}: PartnersManagementProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { filters, setFilter } = useFilterParams();
  const query = filters.q || "";

  const {
    partners,
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
  } = usePartners(initialPartners);

  const [localQuery, setLocalQuery] = useState(query);
  const isComposingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local query when URL param changes externally
  useEffect(() => {
    // Intentional state sync: the input keeps an IME-safe local draft while URL params stay canonical.
     
    setLocalQuery(query);
  }, [query]);

  // Debounced search
  const debouncedSetFilter = useCallback(
    (value: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        if (!isComposingRef.current) {
          setFilter("q", value);
        }
      }, 350);
    },
    [setFilter]
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const routeSelectedPartnerId = filters.selectedPartner || filters.partnerId;
  const routeSelectedPartner = useMemo(
    () => partners.find((p) => p.id === routeSelectedPartnerId) ?? null,
    [partners, routeSelectedPartnerId],
  );
  const activePartner = routeSelectedPartner ?? selectedPartner;

  // Sync url partnerId / selectedPartner to open panel
  useEffect(() => {
    if (routeSelectedPartner) {
      // Intentional URL-driven panel sync for deep links.
       
      setSelectedPartner(routeSelectedPartner);
      setPartnerPanelMode("view");
    }
  }, [routeSelectedPartner, setSelectedPartner, setPartnerPanelMode]);

  const partnerStats = useMemo(() => {
    const brandCount = partners.filter((p) => p.type === "BRAND").length;
    const vendorCount = partners.filter((p) => p.type === "VENDOR").length;
    const agencyCount = partners.filter((p) => p.type === "AGENCY").length;
    const agentCount = partners.filter((p) => p.type === "AGENT").length;
    const sellerCount = partners.filter((p) => p.type === "SELLER").length;
    const totalDeals = partners.reduce(
      (sum, p) => sum + (p.dealCount ?? 0),
      0
    );
    return { brandCount, vendorCount, agencyCount, agentCount, sellerCount, totalDeals };
  }, [partners]);

  return (
    <CrmShell>
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-5 pt-5 md:px-8">
        {/* 1줄 통계 요약 바 (유리 박스 외부 상단 배치) */}
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200/60 bg-white/80 px-4 py-2.5 text-xs text-slate-600 shadow-soft-sm backdrop-blur-sm dark:bg-slate-900/60 dark:border-slate-800 dark:text-slate-400 shrink-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-medium">전체 거래처:</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200">{partners.length}개</span>
          </div>
          <span className="hidden md:inline text-slate-200 dark:text-slate-800">|</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-medium">브랜드:</span>
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">{partnerStats.brandCount}</span>
          </div>
          <span className="hidden md:inline text-slate-200 dark:text-slate-800">|</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-medium">벤더 / 대행사 / 셀러:</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200">
              {partnerStats.vendorCount + partnerStats.agencyCount + partnerStats.agentCount + partnerStats.sellerCount}
            </span>
          </div>
          <span className="hidden md:inline text-slate-200 dark:text-slate-800">|</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="font-medium">연결된 딜:</span>
            <span className="font-semibold text-amber-600 dark:text-amber-400">{partnerStats.totalDeals}개</span>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/70 bg-[rgba(255,255,255,0.62)] shadow-ambient backdrop-blur">
          {dataSource === "mock" && dataSourceMessage ? (
            <div className="px-5 pt-5">
              <DataSourceBanner message={dataSourceMessage} />
            </div>
          ) : null}
          <section className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/70 px-5 py-3">
            <div className="flex-1">
              <h2 className="text-sm font-bold text-foreground">거래처 목록</h2>
            </div>
            <InputGroup className="w-48 shrink-0 border border-slate-200 bg-white h-9 rounded-lg shadow-soft-sm">
              <InputGroupAddon>
                {localQuery !== query ? (
                  <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <SearchIcon aria-hidden="true" className="h-4 w-4 text-slate-500" />
                )}
              </InputGroupAddon>
              <InputGroupInput
                value={localQuery}
                onChange={(e) => {
                  const val = e.target.value;
                  setLocalQuery(val);
                  if (!isComposingRef.current) {
                    debouncedSetFilter(val);
                  }
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={(e) => {
                  isComposingRef.current = false;
                  const val = (e.target as HTMLInputElement).value;
                  debouncedSetFilter(val);
                }}
                placeholder="검색"
                aria-label="거래처 검색"
                className="h-full border-0 focus-visible:ring-0 text-xs"
              />
            </InputGroup>
            {/* 검색 상태 스크린리더 고지 (4.1.3) */}
            <span className="sr-only" role="status" aria-live="polite">
              {localQuery !== query ? "검색 중" : `거래처 ${partners.length}개`}
            </span>
            <Button
              size="sm"
              className="shrink-0 rounded-lg h-9 text-xs"
              onClick={() => {
                setSelectedPartner(null);
                setPartnerPanelMode("create");
              }}
            >
              <PlusIcon aria-hidden="true" data-icon="inline-start" />
              신규 거래처
            </Button>
          </section>

          {partners.length === 0 && !query ? (
            <div className="flex h-64 items-center justify-center">
              <DataEmpty
                icon={Building2}
                title="등록된 거래처가 없습니다"
                description="거래처를 추가하여 관리하세요."
              >
                <Button
                  size="sm"
                  onClick={() => {
                    setSelectedPartner(null);
                    setPartnerPanelMode("create");
                  }}
                >
                  <PlusIcon className="mr-1 h-3.5 w-3.5" />
                  신규 거래처 등록
                </Button>
              </DataEmpty>
            </div>
          ) : (
            <InlineDataGrid
              rows={partners}
              columns={partnerColumns}
              globalFilter={query}
              disableInlineEdit
              persistId="partners-grid"
              onRowClick={(row) => {
                setPartnerPanelMode("view");
                setSelectedPartner(row);
              }}
              onPatch={handleInlinePatch}
            />
          )}
        </div>
      </section>

      {/* Side Panels */}
      <PartnersPanel
        partner={activePartner}
        open={activePartner !== null || partnerPanelMode === "create"}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedPartner(null);
            setPartnerPanelMode("view");
            if (routeSelectedPartnerId) {
              const from = searchParams.get("from");
              const dealId = searchParams.get("dealId");
              if (from === "deals" && dealId) {
                router.push(`/deals?dealId=${dealId}`);
              } else {
                const params = new URLSearchParams(searchParams.toString());
                params.delete("selectedPartner");
                params.delete("partnerId");
                params.delete("from");
                params.delete("dealId");
                const queryString = params.toString();
                router.push(`/partners${queryString ? `?${queryString}` : ""}`);
              }
            }
          }
        }}
        mode={partnerPanelMode}
        onUpdated={handlePartnerUpdated}
        onCreated={handlePartnerCreated}
        onDeleted={handlePartnerDeleted}
        onSyncBusinessInfo={syncBusinessInfo}
        onUploadBusinessCardOcr={uploadBusinessCardOcr}
        onSubmitContact={submitContact}
        onUpdateContact={updateContact}
        onDeleteContact={deleteContact}
        onPatchPartner={updatePartnerField}
      />
    </CrmShell>
  );
}
