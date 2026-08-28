import { useState, useRef, useEffect, useMemo } from "react";
import { type AssetSection, assetSectionLabels } from "@/lib/crm-types";
import { normalizeReferenceUrl, deriveLinkName } from "@/lib/reference-url";
import type { GuideSketch, SketchFailure } from "@/lib/guide-sketch";
import { DEFAULT_GUIDE_KIND, type GuideKind } from "@/lib/content-guide";
import { groupViolations } from "@/lib/claims/claim-gate";
import type { GuideReferenceCard } from "@/components/crm/content-guide-references";

export const DEAL_ASSET_SECTIONS: { value: AssetSection; label: string }[] = [
  { value: "PRODUCT_INTRO", label: assetSectionLabels["PRODUCT_INTRO"] },
  { value: "PRICE_TABLE", label: assetSectionLabels["PRICE_TABLE"] },
  {
    value: "CONTRACT_SETTLEMENT",
    label: assetSectionLabels["CONTRACT_SETTLEMENT"],
  },
  { value: "SNS_CREATIVE", label: assetSectionLabels["SNS_CREATIVE"] },
  { value: "ETC", label: assetSectionLabels["ETC"] },
];

export type AssetItem = {
  id: string;
  fileName: string;
  section: string;
  provider?: string;
  sizeBytes: number;
  externalUrl?: string | null;
  archivedAt?: string | null;
  thumbnailUrl?: string | null;
};

/**
 * 콘텐츠 가이드 생성물의 클레임 게이트 판정 (C3 M1).
 * 라우트가 `checkText` 결과를 그대로 실어 보낸다 — 판정 로직을 화면에서 다시
 * 만들지 않는다(`claim-gate.ts` 가 유일 정본).
 *
 * ⚠️ `sourceId`·`span` 까지 받는다 — 라우트는 원래 `Violation` 전문을 싣고 있었고
 * 화면 타입만 좁아서 **접기(`groupViolations`)에 필요한 필드가 버려지고 있었다.**
 * 같은 표현이 본문 두 곳에 걸리면 글자까지 똑같은 두 줄이 되던 것이 그 결과다.
 */
export type GuideGateViolation = {
  sourceId: string;
  origin: "GLOBAL_RULE" | "DEAL_CLAIM";
  severity: "BLOCK" | "WARN";
  matched: string;
  span: [number, number];
  legalBasis: string;
  note?: string | null;
};

export type GuideGate = {
  verdict: "PASS" | "WARN" | "BLOCK";
  violations: GuideGateViolation[];
  missingDisclosures: { id: string; text: string }[];
};

export type RestoredGuideDraft = {
  body: string;
  gate: GuideGate;
  gateVerdict: string;
  claimIds: string[];
  proofCardIncluded: boolean;
  model: string | null;
  referenceCount: number;
  vocCount: number;
  sketches: GuideSketch[];
  savedAt: string;
  dealChangedAfter: boolean;
};

export function useDealAssets({ dealId }: { dealId: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<AssetSection>("PRODUCT_INTRO");
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkName, setLinkName] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [guideBusy, setGuideBusy] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  const [guideRefCount, setGuideRefCount] = useState(0);
  const [guideRefs, setGuideRefs] = useState<GuideReferenceCard[]>([]);
  const [guideKind, setGuideKind] = useState<GuideKind>(DEFAULT_GUIDE_KIND);
  const [guideAvailableKinds, setGuideAvailableKinds] = useState<GuideKind[]>([]);
  const [guideSketches, setGuideSketches] = useState<GuideSketch[]>([]);
  const [sketchBusy, setSketchBusy] = useState(false);
  const [sketchFailures, setSketchFailures] = useState<SketchFailure[]>([]);
  const [sketchSkippedKeys, setSketchSkippedKeys] = useState<string[]>([]);
  const [sketchRequestError, setSketchRequestError] = useState<null | "UNAVAILABLE" | "FAILED">(null);
  const [guideRestored, setGuideRestored] = useState<{
    savedAt: string;
    dealChangedAfter: boolean;
  } | null>(null);
  const [guideVocCount, setGuideVocCount] = useState(0);
  const [guideCopied, setGuideCopied] = useState(false);
  const [guideMeta, setGuideMeta] = useState<{
    gateVerdict: string;
    proofCardIncluded: boolean;
    claimIds: string[];
    model: string | null;
  } | null>(null);
  const [guideSentAt, setGuideSentAt] = useState<string | null>(null);
  const [guideSaving, setGuideSaving] = useState(false);
  const [guideGate, setGuideGate] = useState<GuideGate | null>(null);
  const [guideFreeGeneration, setGuideFreeGeneration] = useState(false);
  const [guideProofCardAbsence, setGuideProofCardAbsence] = useState<"NO_APPROVED_CLAIMS" | "NO_EVIDENCE" | null>(null);

  const guideViolationGroups = useMemo(
    () => groupViolations(guideGate?.violations ?? []),
    [guideGate],
  );

  useEffect(() => {
    setGuideKind(DEFAULT_GUIDE_KIND);
    setGuideAvailableKinds([]);
  }, [dealId]);

  useEffect(() => {
    setGuide(null);
    setGuideRefCount(0);
    setGuideRefs([]);
    setGuideSketches([]);
    setSketchBusy(false);
    setSketchFailures([]);
    setSketchSkippedKeys([]);
    setSketchRequestError(null);
    setGuideError(null);
    setGuideCopied(false);
    setGuideMeta(null);
    setGuideSentAt(null);
    setGuideGate(null);
    setGuideFreeGeneration(false);
    setGuideProofCardAbsence(null);
    setGuideRestored(null);

    let cancelled = false;
    fetch(`/api/deals/${encodeURIComponent(dealId)}/content-guide?kind=${guideKind}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (data: {
          draft?: RestoredGuideDraft | null;
          availableKinds?: GuideKind[];
        } | null) => {
          if (cancelled) return;
          setGuideAvailableKinds(data?.availableKinds ?? []);
          if (!data?.draft) return;
          const d = data.draft;
          setGuide(d.body);
          setGuideRefCount(d.referenceCount);
          setGuideVocCount(d.vocCount);
          setGuideGate(d.gate ?? null);
          setGuideMeta({
            gateVerdict: d.gateVerdict,
            proofCardIncluded: d.proofCardIncluded,
            claimIds: d.claimIds,
            model: d.model,
          });
          setGuideSketches(d.sketches ?? []);
          setGuideRestored({
            savedAt: d.savedAt,
            dealChangedAfter: d.dealChangedAfter,
          });
        },
      )
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [dealId, guideKind]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/assets?entityType=DEAL&entityId=${encodeURIComponent(dealId)}`)
      .then((r) => r.json())
      .then((data: { assets?: AssetItem[] }) => {
        if (!cancelled && data.assets) setAssets(data.assets);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  async function handleUpload(file: File) {
    setBusy(true);
    setErrorMsg(null);
    const formData = new FormData();
    formData.set("entityType", "DEAL");
    formData.set("entityId", dealId);
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

  async function handleAddLink() {
    const normalized = normalizeReferenceUrl(linkUrl);
    if (!normalized) {
      setLinkError("올바른 URL이 아닙니다. http(s):// 주소를 입력하세요.");
      return;
    }
    if (assets.some((a) => a.externalUrl === normalized)) {
      setLinkError("이미 등록(또는 보관)된 링크입니다.");
      return;
    }
    setLinkBusy(true);
    setLinkError(null);
    const formData = new FormData();
    formData.set("entityType", "DEAL");
    formData.set("entityId", dealId);
    formData.set("section", section);
    formData.set("externalUrl", normalized);
    formData.set("fileName", linkName.trim() || deriveLinkName(normalized));
    const res = await fetch("/api/assets", { method: "POST", body: formData });
    const data = await res.json();
    setLinkBusy(false);
    if (!res.ok) {
      const serverError = (data as { error?: unknown }).error;
      setLinkError(
        typeof serverError === "string"
          ? serverError
          : `링크 추가 실패 (HTTP ${res.status})`,
      );
      return;
    }
    const typed = data as { asset?: AssetItem };
    if (typed.asset) setAssets((prev) => [typed.asset!, ...prev]);
    setLinkUrl("");
    setLinkName("");
  }

  async function drawSketches(dealIdForDraw: string, kindForDraw: GuideKind) {
    setSketchBusy(true);
    setSketchRequestError(null);
    try {
      const res = await fetch(
        `/api/deals/${encodeURIComponent(dealIdForDraw)}/content-guide/sketches?kind=${kindForDraw}`,
        { method: "POST" },
      );
      if (dealIdForDraw !== dealId || kindForDraw !== guideKind) return;
      if (!res.ok) {
        setSketchRequestError(res.status === 503 ? "UNAVAILABLE" : "FAILED");
        return;
      }
      const data = (await res.json()) as {
        sketches?: GuideSketch[];
        failures?: SketchFailure[];
        skippedKeys?: string[];
      };
      if (dealIdForDraw !== dealId || kindForDraw !== guideKind) return;
      setGuideSketches(data.sketches ?? []);
      setSketchFailures(data.failures ?? []);
      setSketchSkippedKeys(data.skippedKeys ?? []);
    } catch {
      if (dealIdForDraw === dealId && kindForDraw === guideKind) {
        setSketchRequestError("FAILED");
      }
    } finally {
      setSketchBusy(false);
    }
  }

  async function handleGenerateGuide() {
    if (guideBusy) return;
    setGuideBusy(true);
    setGuideError(null);
    try {
      const res = await fetch(
        `/api/deals/${dealId}/content-guide?kind=${guideKind}`,
        { method: "POST" },
      );
      const data = (await res.json()) as {
        guide?: string;
        referenceCount?: number;
        references?: GuideReferenceCard[];
        vocCount?: number;
        gate?: GuideGate;
        claimGuided?: boolean;
        proofCardIncluded?: boolean;
        proofCardAbsenceReason?: "NO_APPROVED_CLAIMS" | "NO_EVIDENCE" | null;
        claimIds?: string[];
        model?: string;
        error?: string;
      };
      if (!res.ok || !data.guide) {
        setGuideError(data.error ?? `가이드 생성 실패 (HTTP ${res.status})`);
        return;
      }
      setGuide(data.guide);
      setGuideRefCount(data.referenceCount ?? 0);
      setGuideRefs(data.references ?? []);
      setGuideSketches([]);
      setGuideRestored(null);
      setGuideVocCount(data.vocCount ?? 0);
      setGuideCopied(false);
      setGuideMeta({
        gateVerdict: data.gate?.verdict ?? "PASS",
        proofCardIncluded: data.proofCardIncluded ?? false,
        claimIds: data.claimIds ?? [],
        model: data.model ?? null,
      });
      setGuideGate(data.gate ?? null);
      setGuideFreeGeneration(data.claimGuided === false);
      setGuideProofCardAbsence(data.proofCardAbsenceReason ?? null);
      void drawSketches(dealId, guideKind);
      setGuideAvailableKinds((prev) =>
        prev.includes(guideKind) ? prev : [...prev, guideKind],
      );
      setGuideSentAt(null);
    } catch {
      setGuideError("가이드 생성 요청 중 오류가 발생했습니다.");
    } finally {
      setGuideBusy(false);
    }
  }

  /**
   * 셀러에게 보냈다고 **표시** → 채택분 저장 (C3 M4, 오너 결정 §9-Q2).
   *
   * ⛔ 발송하지 않는다. 실제 전달은 운영자가 카톡으로 하고 여기서는 기록만 남긴다
   * (P0: 외부 부수효과 자동 실행 금지). 버튼 문구가 "보냄 표시"인 이유가 이것이다.
   */
  async function handleMarkGuideSent() {
    if (guide === null || guideMeta === null) return;
    setGuideSaving(true);
    try {
      const res = await fetch(`/api/deals/${dealId}/asset-drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: guide,
          kind: guideKind,
          gateVerdict: guideMeta.gateVerdict,
          proofCardIncluded: guideMeta.proofCardIncluded,
          claimIds: guideMeta.claimIds,
          model: guideMeta.model,
        }),
      });
      const data = (await res.json()) as {
        draft?: { sentAt?: string };
        error?: string;
      };
      if (!res.ok) {
        setGuideError(data.error ?? `저장 실패 (HTTP ${res.status})`);
        return;
      }
      setGuideSentAt(data.draft?.sentAt ?? new Date().toISOString());
      setGuideError(null);
    } catch {
      setGuideError("보냄 표시 저장 중 오류가 발생했습니다.");
    } finally {
      setGuideSaving(false);
    }
  }

  async function handleCopyGuide() {
    if (!guide) return;
    try {
      await navigator.clipboard.writeText(guide);
      setGuideCopied(true);
      setTimeout(() => setGuideCopied(false), 1500);
    } catch {
      setGuideError("클립보드 복사에 실패했습니다.");
    }
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

  return {
    fileInputRef,
    section,
    setSection,
    busy,
    errorMsg,
    linkUrl,
    setLinkUrl,
    linkName,
    setLinkName,
    linkBusy,
    linkError,
    guideBusy,
    guideError,
    guide,
    guideRefCount,
    guideRefs,
    guideKind,
    setGuideKind,
    guideAvailableKinds,
    guideSketches,
    sketchBusy,
    sketchFailures,
    sketchSkippedKeys,
    sketchRequestError,
    guideRestored,
    guideVocCount,
    guideCopied,
    guideSentAt,
    guideSaving,
    guideGate,
    guideFreeGeneration,
    guideProofCardAbsence,
    guideViolationGroups,
    handleUpload,
    handleAddLink,
    handleGenerateGuide,
    drawSketches,
    handleMarkGuideSent,
    handleCopyGuide,
    handleArchive,
    handleOpen,
    visibleAssets,
  };
}
