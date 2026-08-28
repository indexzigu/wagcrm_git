"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { CrmShell } from "@/components/crm/crm-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PriceSheetStatusBadge } from "./status-badge";
import {
  ReviewTable,
  ReviewTableSkeleton,
  type DealOption,
  type PriceSheetRowData,
} from "./review-table";
import { DealGroupPreview } from "./deal-group-preview";
import { ApplyResultCard } from "./apply-result-card";
import type { ApplySummary } from "@/lib/price-sheet/apply-summary";
import { ApplyDiffModal } from "./apply-diff-modal";
import { BundlePolicyControl } from "./bundle-policy-control";
import { toast } from "sonner";
import {
  computeDealGroups,
  matchPartnerByBrand,
  type ApplyRowInput,
  type BundlePolicy,
  type DealGroupOverride,
  type PartnerOption,
} from "@/lib/price-sheet/grouping";

export type PriceSheetData = {
  id: string;
  partnerId: string | null;
  partner?: { id: string; name: string } | null;
  sourceFormat: string;
  extractPath: string;
  status: string;
  detectedTables: number;
  policyText: string | null;
  reviewNote: string | null;
  createdAt: string;
  rows: PriceSheetRowData[];
};

export function PriceSheetDetail({ priceSheetId }: { priceSheetId: string }) {
  const [sheet, setSheet] = React.useState<PriceSheetData | null>(null);
  const [lastApply, setLastApply] = React.useState<ApplySummary | null>(null);
  const [deals, setDeals] = React.useState<DealOption[]>([]);
  const [partners, setPartners] = React.useState<PartnerOption[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [applyModalOpen, setApplyModalOpen] = React.useState(false);
  // 검수자가 직접 수정한 그룹별 브랜드·거래처(수정 전 그룹은 아래 effectiveOverrides가
  // 기본값 규칙으로 채운다). 키 = grouping.ts의 groupKey.
  const [editedOverrides, setEditedOverrides] = React.useState<
    Record<string, DealGroupOverride>
  >({});
  // 시트 단위 반영 방식. 초기값은 자동 — 기존 시트 동작을 보존한다(설계 §4).
  const [bundle, setBundle] = React.useState<BundlePolicy>({ mode: "AUTO" });
  // 자동 추출은 시트당 1회만 — EXTRACT_FAILED에서 자동 재시도 루프가 돌면 안 된다(수동 재추출만).
  // sheetId를 기록해 같은 컴포넌트 인스턴스가 다른 시트로 재사용돼도 새 시트는 다시 시도한다.
  const autoExtractedSheetIdRef = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await fetch(`/api/price-sheets/${priceSheetId}`);
    const data = await res.json();
    setSheet(data.priceSheet ?? null);
    // 마지막 반영 시도 — 실패해도 시트 상태는 되돌아가므로 이 기록만이 실패의 흔적이다.
    setLastApply(data.lastApply ?? null);
    setLoading(false);
  }, [priceSheetId]);

  React.useEffect(() => {
    load();
  }, [load]);

  // 매핑 후보 딜 목록 — 검수표(Select)와 반영 미리보기(딜명 표시)가 공유한다.
  React.useEffect(() => {
    fetch("/api/deals")
      .then((res) => res.json())
      .then((data) =>
        setDeals(
          (data.deals ?? []).map(
            (d: {
              id: string;
              dealName: string;
              parentDealId: string | null;
              brandName: string | null;
              partnerId: string | null;
            }) => ({
              id: d.id,
              dealName: d.dealName,
              parentDealId: d.parentDealId ?? null,
              brandName: d.brandName ?? null,
              partnerId: d.partnerId ?? null,
            })
          )
        )
      )
      .catch(() => setDeals([]));
  }, []);

  // 거래처 연결 후보 — 신규 딜의 브랜드명 기반 자동 매칭·수동 선택에 쓴다.
  React.useEffect(() => {
    fetch("/api/partners")
      .then((res) => res.json())
      .then((data) =>
        setPartners(
          (data.partners ?? []).map((p: { id: string; name: string }) => ({
            id: p.id,
            name: p.name,
          }))
        )
      )
      .catch(() => setPartners([]));
  }, []);

  // 그룹별 유효 브랜드·거래처 = 검수자 수정값 > 기본값(브랜드: 제품명 추출 제안,
  // 거래처: 시트 거래처 > 브랜드명 자동 매칭). 미리보기 표시값과 반영 시 전송값이
  // 항상 같은 이 객체 하나에서 나온다 — 화면 따로 서버 따로 계산하면 미리보기가 거짓말한다.
  const effectiveOverrides = React.useMemo(() => {
    if (!sheet) return {};
    const base = computeDealGroups(sheet.rows as ApplyRowInput[], sheet.partnerId, undefined, bundle);
    const out: Record<string, DealGroupOverride> = {};
    for (const group of base.groups) {
      const edited = editedOverrides[group.groupKey];
      const brandName =
        edited?.brandName !== undefined ? edited.brandName : group.suggestedBrandName;
      const partnerIdValue =
        edited?.partnerId !== undefined
          ? edited.partnerId
          : (sheet.partnerId ?? matchPartnerByBrand(partners, brandName)?.id ?? null);
      out[group.groupKey] = { brandName, partnerId: partnerIdValue };
    }
    return out;
  }, [sheet, editedOverrides, partners, bundle]);

  const handleOverrideChange = React.useCallback(
    (groupKey: string, patch: DealGroupOverride) => {
      setEditedOverrides((prev) => ({
        ...prev,
        [groupKey]: { ...prev[groupKey], ...patch },
      }));
    },
    []
  );

  // 반영 확인 모달용 신규 딜 그룹 요약 — 미리보기와 같은 effectiveOverrides에서 계산해
  // 두 화면(미리보기·최종 확인)이 항상 같은 브랜드·거래처를 말하게 한다.
  const newDealGroupSummaries = React.useMemo(() => {
    if (!sheet) return [];
    const partnerNameById = new Map(partners.map((p) => [p.id, p.name]));
    const { groups } = computeDealGroups(
      sheet.rows as ApplyRowInput[],
      sheet.partnerId,
      effectiveOverrides,
      bundle
    );
    return groups.map((group) => ({
      key: group.groupKey,
      dealName: group.parentDealName,
      optionCount: group.options?.length ?? 0,
      brandName: group.parent.brandName ?? null,
      partnerName: group.parent.partnerId
        ? (partnerNameById.get(group.parent.partnerId) ?? "선택한 거래처")
        : null,
      // "existing"은 기존 상위딜에 하위품목만 붙이는 그룹이라 상위딜 자체를 새로 만들지
      // 않는다 — 모달이 이를 "생성"이 아니라 "추가"로 구분해 표시해야 한다.
      attachToExisting: group.parentPriceSource === "existing",
    }));
  }, [sheet, partners, effectiveOverrides, bundle]);

  const runExtract = React.useCallback(async () => {
    setBusy("extract");
    try {
      const res = await fetch(`/api/price-sheets/${priceSheetId}/extract`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "추출에 실패했습니다.");
        await load();
        return;
      }
      // 추출 성공 → 딜 매핑 제안까지 이어서 실행한다(별도 버튼 클릭 불요). 매핑까지
      // 끝나야 행이 SUGGESTED/NEW_DEAL로 도착해 미리보기·반영 버튼이 곧바로 살아난다.
      // 매핑 실패는 추출 결과를 잃지 않도록 안내만 하고 수동 버튼에 맡긴다.
      const mapRes = await fetch(`/api/price-sheets/${priceSheetId}/map`, { method: "POST" });
      if (mapRes.ok) {
        toast.success(`${data.rowCount}개 행을 추출하고 딜 매핑을 제안했습니다.`);
      } else {
        toast.success(
          `${data.rowCount}개 행을 추출했습니다. 매핑 제안은 실패했습니다. "딜 매핑 제안"으로 다시 시도하세요.`
        );
      }
      await load();
    } finally {
      setBusy(null);
    }
  }, [priceSheetId, load]);

  // 업로드 직후(UPLOADED) 진입하면 버튼 없이 자동으로 추출을 시작한다.
  // EXTRACT_FAILED는 자동 재시도하지 않는다 — 수동 "재추출"만.
  React.useEffect(() => {
    if (!sheet || sheet.status !== "UPLOADED") return;
    if (autoExtractedSheetIdRef.current === priceSheetId) return;
    autoExtractedSheetIdRef.current = priceSheetId;
    void runExtract();
  }, [sheet, runExtract, priceSheetId]);

  const runMapping = async () => {
    setBusy("map");
    try {
      const res = await fetch(`/api/price-sheets/${priceSheetId}/map`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "매핑 제안에 실패했습니다.");
        return;
      }
      toast.success(`${data.mappingCount}개 행의 매핑을 제안했습니다.`);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const runApply = async () => {
    setBusy("apply");
    try {
      const res = await fetch(`/api/price-sheets/${priceSheetId}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 미리보기에 표시된 그룹별 브랜드·거래처를 그대로 전송 — 화면과 반영 결과 일치 보장.
        body: JSON.stringify({ groupOverrides: effectiveOverrides, bundle }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "반영에 실패했습니다.");
        return;
      }
      // 반영 품목 수(rowCount, 검수 모달과 동일)를 우선 표기하고, 그룹핑으로 실제 생성/수정된
      // 딜 수가 다를 때만 괄호로 병기한다("3개 품목 → 딜 4개"류 혼동 방지).
      const rowCount = data.rowCount ?? data.results?.length ?? 0;
      const dealCount = data.results?.length ?? rowCount;
      toast.success(
        dealCount === rowCount
          ? `${rowCount}건을 딜에 반영했습니다.`
          : `${rowCount}개 품목을 반영했습니다 (딜 ${dealCount}개 생성·수정).`
      );
      setApplyModalOpen(false);
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <CrmShell title="가격표 상세">
        <p className="p-8 text-sm text-muted-foreground">불러오는 중...</p>
      </CrmShell>
    );
  }

  if (!sheet) {
    return (
      <CrmShell title="가격표 상세">
        <p className="p-8 text-sm text-muted-foreground">가격표를 찾을 수 없습니다.</p>
      </CrmShell>
    );
  }

  const confirmedRows = sheet.rows.filter((r) => r.mappingStatus === "MAPPED" || r.mappingStatus === "NEW_DEAL");
  const sheetLabel = `${sheet.partner?.name ?? "거래처 미지정"} · ${sheet.sourceFormat}`;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/40 bg-white/50 px-6 pt-3 backdrop-blur-sm md:px-8">
        <Link
          href="/assets/price-sheets"
          className="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" />
          가격표 목록
        </Link>
        <div className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
          <span>가격표 인제스트</span>
          <ChevronRightIcon className="size-3" />
          <span className="text-foreground">{sheetLabel}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <CrmShell
          title={`${sheet.partner?.name ?? "거래처 미지정"} 가격표`}
          description={`${sheet.sourceFormat} · 경로 ${sheet.extractPath} · 표 ${sheet.detectedTables}개`}
          actions={
            <div className="flex items-center gap-2">
              <PriceSheetStatusBadge status={sheet.status} />
              {/* UPLOADED는 자동 추출이 담당하므로 버튼을 노출하지 않는다(추출 중 표시는
                  스켈레톤이 전담). 실패·완료 상태에서만 수동 재추출을 제공한다. */}
              {sheet.status !== "UPLOADED" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={runExtract}
                >
                  {busy === "extract"
                    ? "추출 중..."
                    : sheet.status === "EXTRACT_FAILED"
                      ? "추출 실행"
                      : "재추출"}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null || sheet.rows.length === 0}
                onClick={runMapping}
              >
                딜 매핑 제안
              </Button>
              {/* 확정 0건일 때 disabled로 두면 "눌렀는데 아무 일도 없다"가 된다(실보고) —
                  클릭은 받되 왜 안 되는지 안내한다. busy/APPLIED만 물리적으로 잠근다. */}
              <Button
                size="sm"
                disabled={busy !== null || sheet.status === "APPLIED"}
                onClick={() => {
                  if (confirmedRows.length === 0) {
                    toast.error(
                      "확정된 행이 없습니다. 검수표의 매핑에서 \"신규 딜로 생성\" 또는 기존 딜을 선택해 행을 확정하세요."
                    );
                    return;
                  }
                  if (bundle.mode === "BUNDLE") {
                    const target = bundle.target;
                    const missing =
                      target.kind === "EXISTING" ? !target.dealId : !target.parentDealName.trim();
                    if (missing) {
                      toast.error(
                        target.kind === "EXISTING"
                          ? "묶음 상위딜을 선택하세요."
                          : "새 상위딜 이름을 입력하세요."
                      );
                      return;
                    }
                  }
                  setApplyModalOpen(true);
                }}
              >
                검수 승인 및 반영
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-6 p-6 md:p-8">
            {/* 결과 카드가 맨 위다 — "지난번 반영이 어떻게 됐나"는 화면 진입 즉시 갖는
                질문이고, 실패 사유를 검수표 아래까지 스크롤해 찾게 하면 안 된다. 하단의
                "딜 반영 미리보기"(앞으로 일어날 일)와 양 끝에 놓여 시제가 위치로 갈린다. */}
            <ApplyResultCard summary={lastApply} />

            {/* 상태 hue 는 StatusBadge 스킴(--status-urgent)으로 통일한다 — 같은 "실패"를
                뜻하는 상태 배지가 그 토큰을 쓰는데 이 배너만 shadcn destructive 를 써서
                토큰이 이원화돼 있었다(라이트 모드는 값이 우연히 같지만 다크에서 갈린다). */}
            {sheet.status === "EXTRACT_FAILED" && sheet.reviewNote && (
              <Card className="bg-status-urgent-bg p-4">
                <p className="text-sm text-status-urgent-text">추출 실패: {sheet.reviewNote}</p>
              </Card>
            )}

            {sheet.policyText && (
              <Card className="p-4">
                <h3 className="mb-2 text-sm font-semibold text-foreground">정책 텍스트 (knowledge 후보)</h3>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{sheet.policyText}</p>
              </Card>
            )}

            {busy === "extract" ? (
              <ReviewTableSkeleton />
            ) : (
              <>
                <BundlePolicyControl
                  value={bundle}
                  onChange={setBundle}
                  deals={deals}
                  sheetPartnerId={sheet.partnerId}
                />
                <ReviewTable
                  priceSheetId={priceSheetId}
                  rows={sheet.rows}
                  deals={deals}
                  onRowUpdated={load}
                  bundleMode={bundle.mode === "BUNDLE"}
                  excludedRowIds={bundle.mode === "BUNDLE" ? bundle.excludedRowIds : []}
                  onToggleExclude={(rowId) =>
                    setBundle((prev) =>
                      prev.mode !== "BUNDLE"
                        ? prev
                        : {
                            ...prev,
                            excludedRowIds: prev.excludedRowIds.includes(rowId)
                              ? prev.excludedRowIds.filter((id) => id !== rowId)
                              : [...prev.excludedRowIds, rowId],
                          }
                    )
                  }
                />
                {/* 검수(추출값 검증→매핑 확정) 다음, 반영 직전의 마지막 체크포인트 —
                    반영 시 생성/갱신될 딜 구조를 서버와 같은 그룹핑 SSOT로 미리 보여준다. */}
                <DealGroupPreview
                  rows={sheet.rows}
                  partnerId={sheet.partnerId}
                  deals={deals}
                  partners={partners}
                  overrides={effectiveOverrides}
                  onOverrideChange={handleOverrideChange}
                  bundle={bundle}
                />
              </>
            )}
          </div>

          <ApplyDiffModal
            open={applyModalOpen}
            onOpenChange={setApplyModalOpen}
            rows={confirmedRows}
            newDealGroups={newDealGroupSummaries}
            busy={busy === "apply"}
            onConfirm={runApply}
          />
        </CrmShell>
      </div>
    </div>
  );
}
