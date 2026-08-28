"use client";

import { useState, useCallback } from "react";
import Papa from "papaparse";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type EntityType = "partners" | "sellers" | "deals";

interface CSVImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: EntityType;
  onImportComplete?: (result: { createdCount: number; skippedCount: number }) => void;
}

type ImportStep = "upload" | "mapping" | "validation" | "result";

const SYSTEM_FIELDS: Record<EntityType, { value: string; label: string }[]> = {
  partners: [
    { value: "name", label: "이름" },
    { value: "type", label: "유형 (BRAND/VENDOR/AGENCY/AGENT/SELLER)" },
    { value: "contactInfo", label: "연락처" },
    { value: "bankAccount", label: "계좌정보" },
    { value: "companyStatus", label: "회사 상태" },
    { value: "companyRole", label: "회사 역할" },
    { value: "notes", label: "메모" },
  ],
  sellers: [
    { value: "name", label: "이름" },
    { value: "snsType", label: "SNS 유형 (INSTAGRAM/YOUTUBE)" },
    { value: "snsHandle", label: "SNS 핸들" },
    { value: "currentFollowers", label: "팔로워 수" },
    { value: "category", label: "카테고리" },
    { value: "channelUrl", label: "채널 URL" },
    { value: "email", label: "이메일" },
    { value: "phoneNumber", label: "전화번호" },
    { value: "notes", label: "메모" },
  ],
  deals: [
    { value: "dealName", label: "딜 이름" },
    { value: "partnerId", label: "거래처 ID" },
    { value: "costPrice", label: "공급가" },
    { value: "sellingPrice", label: "판매가" },
    { value: "brandName", label: "브랜드명" },
    { value: "partnerCompanyName", label: "거래처 회사명" },
    { value: "status", label: "상태" },
    { value: "sourcingMemo", label: "소싱 메모" },
  ],
};

const ENTITY_LABELS: Record<EntityType, string> = {
  partners: "거래처",
  sellers: "셀러",
  deals: "딜",
};

export function CSVImportDialog({
  open,
  onOpenChange,
  entityType,
  onImportComplete,
}: CSVImportDialogProps) {
  const [step, setStep] = useState<ImportStep>("upload");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [validationResult, setValidationResult] = useState<{
    validCount: number;
    errorCount: number;
    rowErrors: { row: number; errors: Record<string, string[]> }[];
    validRows: Record<string, unknown>[];
  } | null>(null);
  const [importResult, setImportResult] = useState<{
    createdCount: number;
    skippedCount: number;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStep("upload");
    setCsvHeaders([]);
    setCsvRows([]);
    setMapping({});
    setValidationResult(null);
    setImportResult(null);
    setIsLoading(false);
    setError(null);
  }, []);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (file.size > 10 * 1024 * 1024) {
        setError("파일 크기는 10MB 이하여야 합니다");
        return;
      }

      setError(null);

      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        encoding: "UTF-8",
        complete: (results) => {
          const headers = results.meta.fields || [];
          const rows = results.data as Record<string, string>[];

          setCsvHeaders(headers);
          setCsvRows(rows);

          // Auto-suggest mappings
          const systemFields = SYSTEM_FIELDS[entityType];
          const autoMapping: Record<string, string> = {};

          for (const header of headers) {
            const normalized = header.toLowerCase().replace(/[\s_-]/g, "");
            const match = systemFields.find((f) => {
              const fieldNorm = f.value.toLowerCase().replace(/[\s_-]/g, "");
              const labelNorm = f.label.toLowerCase().replace(/[\s_-]/g, "");
              return (
                fieldNorm === normalized ||
                labelNorm.includes(normalized) ||
                normalized.includes(fieldNorm)
              );
            });
            if (match) {
              autoMapping[header] = match.value;
            }
          }

          setMapping(autoMapping);
          setStep("mapping");
        },
        error: () => {
          setError("CSV 파일을 읽을 수 없습니다. UTF-8 인코딩인지 확인해주세요.");
        },
      });
    },
    [entityType]
  );

  const handleValidate = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/import/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, mapping, rows: csvRows }),
      });

      if (!res.ok) {
        throw new Error("Validation request failed");
      }

      const data = await res.json();
      setValidationResult(data);
      setStep("validation");
    } catch {
      setError("검증 중 오류가 발생했습니다");
    } finally {
      setIsLoading(false);
    }
  };

  const handleExecute = async () => {
    if (!validationResult) return;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entityType,
          validRows: validationResult.validRows,
        }),
      });

      if (!res.ok) {
        throw new Error("Import execution failed");
      }

      const data = await res.json();
      setImportResult(data);
      setStep("result");
      onImportComplete?.(data);
    } catch {
      setError("가져오기 실행 중 오류가 발생했습니다");
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {ENTITY_LABELS[entityType]} CSV 가져오기
          </DialogTitle>
          <DialogDescription>
            CSV 파일을 업로드해 {ENTITY_LABELS[entityType]} 데이터를 일괄 등록하거나 갱신합니다.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Step 1: Upload */}
        {step === "upload" && (
          <FieldGroup>
            <Field>
              <FieldLabel>CSV 파일</FieldLabel>
              <FieldDescription>
                UTF-8 인코딩, 최대 10MB까지 지원합니다.
              </FieldDescription>
              <input
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="block w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-4 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/80"
              />
            </Field>
          </FieldGroup>
        )}

        {/* Step 2: Column Mapping */}
        {step === "mapping" && (
          <div className="flex flex-col gap-4">
            <Alert>
              <AlertTitle>컬럼 매핑</AlertTitle>
              <AlertDescription>
                CSV 컬럼을 시스템 필드에 매핑해주세요. {csvRows.length}행이 감지되었습니다.
              </AlertDescription>
            </Alert>

            {/* Preview */}
            <div className="max-h-32 overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/50">
                    {csvHeaders.map((h) => (
                      <th key={h} className="px-2 py-1 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvRows.slice(0, 3).map((row, i) => (
                    <tr key={i} className="border-t">
                      {csvHeaders.map((h) => (
                        <td key={h} className="max-w-[120px] truncate px-2 py-1">
                          {row[h] || "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mapping UI */}
            <FieldGroup className="gap-2">
              {csvHeaders.map((header) => (
                <Field key={header} orientation="horizontal" className="items-center gap-3">
                  <FieldLabel className="w-40 truncate">
                    {header}
                  </FieldLabel>
                  <span className="text-muted-foreground text-xs">→</span>
                  <Select
                    value={mapping[header] || "_skip"}
                    onValueChange={(value) =>
                      setMapping((prev) => ({
                        ...prev,
                        [header]: value === "_skip" ? "" : value,
                      }))
                    }
                  >
                    <SelectTrigger className="h-8 w-52 text-sm">
                      <SelectValue placeholder="건너뛰기" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="_skip">건너뛰기</SelectItem>
                        {SYSTEM_FIELDS[entityType].map((field) => (
                          <SelectItem key={field.value} value={field.value}>
                            {field.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              ))}
            </FieldGroup>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("upload")}>
                이전
              </Button>
              <Button onClick={handleValidate} disabled={isLoading}>
                {isLoading ? "검증 중..." : "검증하기"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 3: Validation Results */}
        {step === "validation" && validationResult && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3">
              <Alert>
                <AlertTitle>유효</AlertTitle>
                <AlertDescription>
                  <Badge variant="secondary">{validationResult.validCount}건</Badge>
                </AlertDescription>
              </Alert>
              <Alert variant={validationResult.errorCount > 0 ? "destructive" : "default"}>
                <AlertTitle>오류</AlertTitle>
                <AlertDescription>
                  <Badge variant="secondary">{validationResult.errorCount}건</Badge>
                </AlertDescription>
              </Alert>
            </div>

            {validationResult.rowErrors.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-muted/50">
                      <th className="px-2 py-1 text-left">행</th>
                      <th className="px-2 py-1 text-left">오류</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validationResult.rowErrors.slice(0, 20).map((err) => (
                      <tr key={err.row} className="border-t">
                        <td className="px-2 py-1">{err.row}</td>
                        <td className="px-2 py-1">
                          {Object.entries(err.errors)
                            .map(([field, msgs]) => `${field}: ${msgs.join(", ")}`)
                            .join("; ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <FieldDescription>
              유효한 {validationResult.validCount}건만 가져옵니다.
              오류가 있는 행은 건너뜁니다.
            </FieldDescription>

            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("mapping")}>
                이전
              </Button>
              <Button
                onClick={handleExecute}
                disabled={isLoading || validationResult.validCount === 0}
              >
                {isLoading
                  ? "가져오는 중..."
                  : `${validationResult.validCount}건 가져오기`}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 4: Result */}
        {step === "result" && importResult && (
          <div className="flex flex-col gap-4">
            <Alert>
              <AlertTitle>가져오기 완료</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">생성 {importResult.createdCount}건</Badge>
                <Badge variant="secondary">건너뜀 {importResult.skippedCount}건</Badge>
              </AlertDescription>
            </Alert>

            <DialogFooter>
              <Button onClick={handleClose}>닫기</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
