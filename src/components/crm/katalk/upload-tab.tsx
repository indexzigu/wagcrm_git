"use client";

import * as React from "react";
import { toast } from "sonner";
import { UploadCloudIcon, FileTextIcon, AlertTriangleIcon, CheckCircle2Icon, InfoIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { SearchableDropdown } from "@/components/crm/searchable-dropdown";
import { useUserRole } from "@/hooks/use-user-role";
import { buildMappingOptions } from "./mapping-options";
import type {
  CampaignOption,
  CommitResult,
  EntityType,
  MappingOption,
  PartnerOption,
  PreviewResult,
  SellerOption,
  UploadFileState,
} from "./types";

const ACCEPTED_EXTENSION = ".txt";
const CONCURRENCY_LIMIT = 2;

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function previewFile(file: File): Promise<PreviewResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("mode", "preview");
  const res = await fetch("/api/kakao-uploads", { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? "미리보기에 실패했습니다.");
  }
  return data as PreviewResult;
}

async function commitFile(
  file: File,
  mapping: { entityType: EntityType | null; entityId: string | null; campaignId: string | null }
): Promise<CommitResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("mode", "commit");
  if (mapping.entityType) formData.append("mappingEntityType", mapping.entityType);
  if (mapping.entityId) formData.append("mappingEntityId", mapping.entityId);
  if (mapping.campaignId) formData.append("mappingCampaignId", mapping.campaignId);
  const res = await fetch("/api/kakao-uploads", { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? "업로드 확정에 실패했습니다.");
  }
  return data as CommitResult;
}

async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function formatPeriod(preview?: PreviewResult): string {
  if (!preview?.periodStart || !preview?.periodEnd) return "-";
  const start = new Date(preview.periodStart).toLocaleDateString("ko-KR");
  const end = new Date(preview.periodEnd).toLocaleDateString("ko-KR");
  return start === end ? start : `${start} ~ ${end}`;
}

export function KatalkUploadTab() {
  const [files, setFiles] = React.useState<UploadFileState[]>([]);
  const [dragActive, setDragActive] = React.useState(false);
  const [partners, setPartners] = React.useState<PartnerOption[]>([]);
  const [sellers, setSellers] = React.useState<SellerOption[]>([]);
  const [campaigns, setCampaigns] = React.useState<CampaignOption[]>([]);
  const [previewing, setPreviewing] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // 귀속 대상 드롭다운은 전 거래처·셀러·캠페인 **이름 목록**이다 — operator 에게는 이
  // 작업이 막으려는 바로 그 데이터라, 미들웨어가 세 조회 API 를 차단하고 여기서는 조회
  // 자체를 하지 않는다(빈 드롭다운을 띄우면 "고를 게 없다"는 오해만 남는다).
  // 미매핑 업로드는 정상 경로이고, 귀속 지정은 오너가 「방 관리」탭에서 처리한다.
  const role = useUserRole();
  const isOperator = role === "operator";

  React.useEffect(() => {
    // 역할이 확정되기 전(null)에는 쏘지 않는다 — operator 의 첫 프레임이 차단된 API 3건을
    // 때리고 403 을 받는 것을 막는다(데이터는 안 새지만 매 로드마다 실패가 쌓인다).
    if (role !== "admin") return;
    fetch("/api/partners")
      .then((res) => res.json())
      .then((data) => setPartners(data.partners ?? []))
      .catch(() => setPartners([]));
    fetch("/api/sellers")
      .then((res) => res.json())
      .then((data) => setSellers(data.sellers ?? []))
      .catch(() => setSellers([]));
    fetch("/api/campaigns")
      .then((res) => res.json())
      .then((data) => setCampaigns(data.campaigns ?? []))
      .catch(() => setCampaigns([]));
  }, [role]);

  const mappingOptions = React.useMemo(
    () => buildMappingOptions(partners, sellers, campaigns),
    [partners, sellers, campaigns]
  );

  const addFiles = React.useCallback((fileList: FileList | File[]) => {
    const incoming = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith(ACCEPTED_EXTENSION));
    if (incoming.length === 0) {
      toast.error("txt 파일만 업로드할 수 있습니다.");
      return;
    }
    setFiles((prev) => [
      ...prev,
      ...incoming.map(
        (file): UploadFileState => ({
          id: genId(),
          file,
          status: "pending",
          mappingEntityType: null,
          mappingEntityId: null,
          mappingCampaignId: null,
        })
      ),
    ]);
  }, []);

  const runPreviews = React.useCallback(async () => {
    setPreviewing(true);
    try {
      const targets = files.filter((f) => f.status === "pending");
      await runWithConcurrencyLimit(targets, CONCURRENCY_LIMIT, async (target) => {
        setFiles((prev) =>
          prev.map((f) => (f.id === target.id ? { ...f, status: "previewing" } : f))
        );
        try {
          const preview = await previewFile(target.file);
          setFiles((prev) =>
            prev.map((f) =>
              f.id === target.id
                ? {
                    ...f,
                    status: "previewed",
                    preview,
                    mappingEntityType: preview.mapping?.entityType ?? null,
                    mappingEntityId: preview.mapping?.entityId ?? null,
                    mappingCampaignId: preview.mapping?.campaignId ?? null,
                  }
                : f
            )
          );
        } catch (error) {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === target.id
                ? {
                    ...f,
                    status: "preview-error",
                    error: error instanceof Error ? error.message : "알 수 없는 오류",
                  }
                : f
            )
          );
        }
      });
    } finally {
      setPreviewing(false);
    }
  }, [files]);

  const onDrop = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const updateMapping = React.useCallback(
    (id: string, patch: Partial<Pick<UploadFileState, "mappingEntityType" | "mappingEntityId" | "mappingCampaignId">>) => {
      setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
    },
    []
  );

  const commitAll = React.useCallback(async () => {
    setCommitting(true);
    try {
      const targets = files.filter((f) => f.status === "previewed");
      await runWithConcurrencyLimit(targets, CONCURRENCY_LIMIT, async (target) => {
        setFiles((prev) =>
          prev.map((f) => (f.id === target.id ? { ...f, status: "committing" } : f))
        );
        try {
          const commit = await commitFile(target.file, {
            entityType: target.mappingEntityType,
            entityId: target.mappingEntityId,
            campaignId: target.mappingCampaignId,
          });
          setFiles((prev) =>
            prev.map((f) => (f.id === target.id ? { ...f, status: "committed", commit } : f))
          );
        } catch (error) {
          setFiles((prev) =>
            prev.map((f) =>
              f.id === target.id
                ? {
                    ...f,
                    status: "commit-error",
                    error: error instanceof Error ? error.message : "알 수 없는 오류",
                  }
                : f
            )
          );
        }
      });
      toast.success("업로드 확정이 완료되었습니다.");
    } finally {
      setCommitting(false);
    }
  }, [files]);

  const hasPending = files.some((f) => f.status === "pending");
  const hasPreviewed = files.some((f) => f.status === "previewed");
  const hasBlockedByKatokAuto = files.some(
    (f) => f.status === "preview-error" && f.error?.includes("사장 Mac 자동 수집")
  );

  return (
    <div className="flex flex-col gap-6">
      <UploadGuideCard />

      <Card className="p-6">
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
            카톡 대화 내보내기 txt 파일을 드래그하거나 클릭해서 업로드
          </p>
          <p className="text-xs text-muted-foreground">여러 파일 선택 가능 · 파일당 최대 4MB</p>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_EXTENSION}
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {hasBlockedByKatokAuto && (
          <p className="mt-3 text-xs text-status-urgent-text">
            일부 방은 사장 Mac 자동 수집 담당이라 txt 업로드가 차단되었습니다.
          </p>
        )}
      </Card>

      {files.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">업로드 대기 목록 ({files.length}건)</h2>
            <div className="flex gap-2">
              {hasPending && (
                <Button size="sm" variant="outline" onClick={runPreviews} disabled={previewing}>
                  {previewing ? "미리보기 중..." : "미리보기 실행"}
                </Button>
              )}
              {hasPreviewed && (
                <Button size="sm" onClick={commitAll} disabled={committing}>
                  {committing ? "확정 중..." : "일괄 업로드 확정"}
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {files.map((f) => (
              <FileRow
                key={f.id}
                fileState={f}
                mappingOptions={mappingOptions}
                canAssignMapping={!isOperator}
                onMappingChange={(patch) => updateMapping(f.id, patch)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 비개발자 직원용 사용 안내 카드. 기본은 접힘 상태이되, 최초 방문 배려로 요약 1줄은 항상
 * 노출한다(Accordion trigger 바깥에 별도 배치). 사용자 요구사항(2026-07): 윈도우 카톡 내보내기
 * 단계, 다중 파일 업로드 가능, 4MB 초과 시 기간 분할, 재업로드해도 중복 저장 안 됨(안심 문구),
 * 자동 수집 방은 업로드 거부됨(정상 동작)을 쉬운 한국어로 안내한다.
 */
function UploadGuideCard() {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-2">
        <InfoIcon className="mt-0.5 size-4 shrink-0 text-status-info" />
        <p className="text-xs font-medium text-foreground">
          카카오톡 PC에서 내보낸 대화 txt 파일을 올리면 자동으로 정리됩니다. 같은 파일을 다시 올려도
          중복 저장되지 않으니 안심하고 여러 번 올려도 괜찮습니다.
        </p>
      </div>
      <Accordion type="single" collapsible className="mt-1">
        <AccordionItem value="guide" className="border-none">
          <AccordionTrigger className="py-1.5 text-xs text-muted-foreground hover:no-underline">
            사용 방법 자세히 보기
          </AccordionTrigger>
          <AccordionContent className="text-xs leading-relaxed text-muted-foreground">
            <div className="flex flex-col gap-3">
              <div>
                <p className="font-medium text-foreground">1. 카카오톡 PC에서 대화 내보내기</p>
                <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                  <li>내보낼 채팅방을 엽니다.</li>
                  <li>채팅방 우측 상단 메뉴(≡)를 누릅니다.</li>
                  <li>대화 내용 메뉴에서 <b>대화 내보내기</b>를 선택합니다.</li>
                  <li><b>텍스트만 저장</b>을 선택해 .txt 파일로 저장합니다.</li>
                </ol>
              </div>
              <div>
                <p className="font-medium text-foreground">2. 방 이름은 첫 업로드 전에 정리해두세요</p>
                <p className="mt-1">
                  업로드할 공구 채팅방은 첫 업로드 전에 카카오톡에서 방 이름에 <b>[공구]</b> 라벨을
                  붙여 주세요(구분이 쉬워집니다). 단, 한 번 업로드를 시작한 방은 이름을 바꾸지
                  마세요. 방 이름이 바뀌면 시스템이 새로운 방으로 인식해 기록이 나뉩니다.
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">3. 여러 방을 한꺼번에 업로드</p>
                <p className="mt-1">
                  여러 채팅방의 txt 파일을 한 번에 여러 개 선택하거나, 한꺼번에 드래그해서 올려도
                  됩니다.
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">4. 파일이 너무 크면</p>
                <p className="mt-1">
                  파일 하나가 4MB를 넘으면 업로드가 거부됩니다. 카카오톡에서 내보낼 때 기간을
                  나눠서(예: 한 달씩) 다시 내보내주세요.
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">5. 재업로드는 안심하고 하세요</p>
                <p className="mt-1">
                  이미 올린 기간이 겹치는 파일을 다시 올려도 문제 없습니다. 겹치는 부분은
                  자동으로 걸러지고 새로운 내용만 추가됩니다.
                </p>
              </div>
              <div>
                <p className="font-medium text-foreground">6. 업로드가 거부되는 방이 있어요</p>
                <p className="mt-1">
                  사장님 Mac에서 자동으로 수집 중인 방은 중복 수집을 막기 위해 txt 업로드가
                  거부됩니다. 오류가 아니라 정상적으로 작동하는 것이니 그대로 두시면 됩니다.
                </p>
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
}

const NONE_OPTION: MappingOption = {
  compositeValue: "__none__",
  kind: "PARTNER",
  entityId: "",
  label: "지정 안 함(미매핑 유지)",
  searchableText: "",
};

function FileRow({
  fileState,
  mappingOptions,
  canAssignMapping,
  onMappingChange,
}: {
  fileState: UploadFileState;
  mappingOptions: MappingOption[];
  /** false 면 귀속 대상 드롭다운 대신 안내만 보여준다(operator — 목록 자체가 비공개). */
  canAssignMapping: boolean;
  onMappingChange: (
    patch: Partial<Pick<UploadFileState, "mappingEntityType" | "mappingEntityId" | "mappingCampaignId">>
  ) => void;
}) {
  const { file, status, preview, commit, error } = fileState;
  const isKatokAutoBlocked =
    status === "preview-error" && Boolean(error?.includes("사장 Mac 자동 수집"));
  const needsMapping = status === "previewed" && !preview?.mapping;

  const optionsWithNone = React.useMemo(() => [NONE_OPTION, ...mappingOptions], [mappingOptions]);

  const selectedEntityValue = fileState.mappingEntityType && fileState.mappingEntityId
    ? `${fileState.mappingEntityType}:${fileState.mappingEntityId}`
    : "__none__";

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <FileTextIcon className="size-5 shrink-0 text-muted-foreground" />
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{file.name}</span>
          {preview && (
            <span className="text-xs text-muted-foreground">
              {preview.roomName} · {preview.roomType === "GROUP" ? "그룹방" : preview.roomType === "OPEN" ? "오픈채팅" : "1:1"} ·
              메시지 {preview.messageCount}건 · 청크 {preview.chunkCount}개 · {formatPeriod(preview)}
            </span>
          )}
        </div>
        <StatusBadge status={status} isKatokAutoBlocked={isKatokAutoBlocked} />
      </div>

      {isKatokAutoBlocked && (
        <div className="flex items-center gap-2 rounded-lg bg-status-urgent-bg px-3 py-2 text-xs text-status-urgent-text">
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          {error}
        </div>
      )}

      {status === "preview-error" && !isKatokAutoBlocked && (
        <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          {error}
        </div>
      )}

      {preview && preview.warnings.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg bg-status-caution-bg px-3 py-2 text-xs text-status-caution">
          {preview.warnings.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
      )}

      {needsMapping && !canAssignMapping && (
        <p className="text-xs text-muted-foreground">
          아직 등록되지 않은 방입니다. 그대로 업로드하시면 되고, 어디에 속한 방인지는
          관리자가 나중에 지정합니다.
        </p>
      )}

      {needsMapping && canAssignMapping && (
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs text-muted-foreground">미매핑 방 귀속 대상 지정(선택):</span>
          <div className="w-72">
            <SearchableDropdown
              items={optionsWithNone}
              value={selectedEntityValue}
              getSearchableText={(opt) => opt.searchableText}
              getLabel={(opt) => opt.label}
              getValue={(opt) => opt.compositeValue}
              placeholder="거래처/셀러/캠페인 검색"
              emptyMessage="검색 결과 없음"
              onValueChange={(value) => {
                if (value === "__none__") {
                  onMappingChange({ mappingEntityType: null, mappingEntityId: null, mappingCampaignId: null });
                  return;
                }
                const option = mappingOptions.find((opt) => opt.compositeValue === value);
                if (!option) return;
                if (option.kind === "CAMPAIGN") {
                  // 캠페인은 항상 특정 셀러에 속한다 — SELLER로 귀속하고 campaignId를 추가 태깅한다.
                  onMappingChange({
                    mappingEntityType: "SELLER",
                    mappingEntityId: option.campaignSellerId ?? null,
                    mappingCampaignId: option.entityId,
                  });
                  return;
                }
                onMappingChange({
                  mappingEntityType: option.kind,
                  mappingEntityId: option.entityId,
                  mappingCampaignId: null,
                });
              }}
            />
          </div>
        </div>
      )}

      {commit && (
        <div className="flex items-center gap-2 rounded-lg bg-status-success/10 px-3 py-2 text-xs text-status-success">
          <CheckCircle2Icon className="size-3.5 shrink-0" />
          신규 {commit.upserted}건 / 중복 스킵 {commit.skipped}건
          {commit.errors && commit.errors.length > 0 && (
            <span className="text-status-urgent-text"> · 실패 {commit.errors.length}건</span>
          )}
        </div>
      )}

      {status === "commit-error" && (
        <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          {error}
        </div>
      )}
    </Card>
  );
}

function StatusBadge({
  status,
  isKatokAutoBlocked,
}: {
  status: UploadFileState["status"];
  isKatokAutoBlocked: boolean;
}) {
  if (isKatokAutoBlocked) {
    return (
      <Badge variant="outline" className="border-transparent bg-status-urgent-bg text-status-urgent-text text-[11px]">
        자동 수집 방
      </Badge>
    );
  }
  switch (status) {
    case "pending":
      return (
        <Badge variant="outline" className="text-[11px] text-foreground">
          대기
        </Badge>
      );
    case "previewing":
      return (
        <Badge variant="status-info" className="text-[11px]">
          미리보기 중
        </Badge>
      );
    case "previewed":
      return (
        <Badge variant="status-info" className="text-[11px]">
          확정 대기
        </Badge>
      );
    case "committing":
      return (
        <Badge variant="status-caution" className="text-[11px]">
          업로드 중
        </Badge>
      );
    case "committed":
      return (
        <Badge variant="status-success" className="text-[11px]">
          완료
        </Badge>
      );
    case "preview-error":
    case "commit-error":
      return (
        <Badge variant="destructive" className="text-[11px]">
          오류
        </Badge>
      );
    default:
      return null;
  }
}
