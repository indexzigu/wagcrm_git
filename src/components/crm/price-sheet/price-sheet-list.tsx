"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CrmShell } from "@/components/crm/crm-shell";
import { Card } from "@/components/ui/card";
import { SearchableDropdown } from "@/components/crm/searchable-dropdown";
import { PriceSheetStatusBadge } from "./status-badge";
import { UploadCloudIcon, FileSpreadsheetIcon, ImageIcon, FileTextIcon, PresentationIcon } from "lucide-react";

const NONE_PARTNER_OPTION = { id: "__none__", name: "지정 안 함" };

type PriceSheetListItem = {
  id: string;
  partnerId: string | null;
  partner?: { id: string; name: string } | null;
  sourceFormat: string;
  extractPath: string;
  status: string;
  detectedTables: number;
  createdAt: string;
};

type PartnerOption = { id: string; name: string };

const FORMAT_ICON: Record<string, React.ElementType> = {
  XLSX: FileSpreadsheetIcon,
  CSV: FileSpreadsheetIcon,
  PPTX: PresentationIcon,
  PDF: FileTextIcon,
  IMAGE: ImageIcon,
};

const ACCEPTED_EXTENSIONS = ".xlsx,.xls,.csv,.pptx,.pdf,.png,.jpg,.jpeg,.webp";

export function PriceSheetList() {
  const router = useRouter();
  const [sheets, setSheets] = React.useState<PriceSheetListItem[]>([]);
  const [partners, setPartners] = React.useState<PartnerOption[]>([]);
  const [selectedPartnerId, setSelectedPartnerId] = React.useState<string>("__none__");
  const [loading, setLoading] = React.useState(true);
  const [uploading, setUploading] = React.useState(false);
  const [dragActive, setDragActive] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const loadSheets = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/price-sheets");
      const data = await res.json();
      setSheets(data.priceSheets ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadSheets();
    fetch("/api/partners")
      .then((res) => res.json())
      .then((data) => setPartners(data.partners ?? []))
      .catch(() => setPartners([]));
  }, [loadSheets]);

  const handleUpload = React.useCallback(
    async (file: File) => {
      setError(null);
      setUploading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        if (selectedPartnerId !== "__none__") {
          formData.append("partnerId", selectedPartnerId);
        }
        const res = await fetch("/api/price-sheets", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "업로드에 실패했습니다.");
          return;
        }
        router.push(`/assets/price-sheets/${data.priceSheet.id}`);
      } catch {
        setError("업로드 중 오류가 발생했습니다.");
      } finally {
        setUploading(false);
      }
    },
    [selectedPartnerId, router]
  );

  const onDrop = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleUpload(file);
    },
    [handleUpload]
  );

  return (
    <CrmShell
      title={
        <div className="flex flex-col gap-1">
          <Link
            href="/assets"
            className="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            ← 자료 목록
          </Link>
          <span>가격표 인제스트</span>
        </div>
      }
      description="브랜드사 가격표(xlsx/이미지/pdf/pptx)를 업로드해 구조화 추출하고 딜에 반영합니다."
    >
      <div className="flex flex-col gap-6 p-6 md:p-8">
        <Card className="p-6">
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-foreground">거래처 (선택)</span>
              <div className="w-64">
                <SearchableDropdown
                  items={[NONE_PARTNER_OPTION, ...partners]}
                  value={selectedPartnerId}
                  onValueChange={setSelectedPartnerId}
                  getSearchableText={(partner) => partner.name}
                  getLabel={(partner) => partner.name}
                  getValue={(partner) => partner.id}
                  placeholder="거래처 선택 (미지정 가능)"
                  emptyMessage="검색 결과 없음"
                />
              </div>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
                dragActive ? "border-primary bg-primary/5" : "border-border/60 bg-muted/20"
              }`}
            >
              <UploadCloudIcon className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">
                {uploading ? "업로드 중..." : "파일을 드래그하거나 클릭해서 업로드"}
              </p>
              <p className="text-xs text-muted-foreground">xlsx, csv, pptx, pdf, png, jpg (최대 20MB)</p>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_EXTENSIONS}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleUpload(file);
                  e.target.value = "";
                }}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        </Card>

        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-foreground">업로드 목록</h2>
          {loading ? (
            <p className="text-sm text-muted-foreground">불러오는 중...</p>
          ) : sheets.length === 0 ? (
            <p className="text-sm text-muted-foreground">업로드된 가격표가 없습니다.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {sheets.map((sheet) => {
                const Icon = FORMAT_ICON[sheet.sourceFormat] ?? FileTextIcon;
                return (
                  <Link key={sheet.id} href={`/assets/price-sheets/${sheet.id}`}>
                    <Card className="flex flex-row items-center gap-4 p-4 transition-colors hover:bg-muted/30">
                      <Icon className="size-5 shrink-0 text-muted-foreground" />
                      <div className="flex flex-1 flex-col gap-0.5">
                        <span className="text-sm font-medium text-foreground">
                          {sheet.partner?.name ?? "거래처 미지정"} · {sheet.sourceFormat}
                          {sheet.detectedTables > 1 ? ` · 표 ${sheet.detectedTables}개` : ""}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(sheet.createdAt).toLocaleString("ko-KR")} · 경로 {sheet.extractPath}
                        </span>
                      </div>
                      <PriceSheetStatusBadge status={sheet.status} />
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </CrmShell>
  );
}
