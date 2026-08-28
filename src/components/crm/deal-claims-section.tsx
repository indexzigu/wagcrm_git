"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, PlusIcon, SparklesIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * 딜 상세 "표현 관리" 섹션 (C1 M2b).
 *
 * 지원하는 판단: **"이 딜에서 무엇을 말해도 되고, 무엇은 말하면 안 되는가"**.
 * 여기 등록된 것이 표현 검사(`/claim-check`)와 이후 생성 파이프라인(M4)의
 * 게이트 입력이 된다.
 *
 * 핵심 규율: **승인은 운영자만 한다.** 신규 등록은 언제나 PROPOSED 에서
 * 출발하고, 근거 미확보(NEEDS_SOURCE)는 승인 자체가 막힌다 — 주장이 곧
 * 근거가 되는 경로를 만들지 않는 것이 이 레지스트리의 존재 이유다(C1 §2).
 */

const KIND_META = {
  APPROVED_CLAIM: {
    label: "승인 소구점",
    hint: "생성물이 이 표현을 쓰도록 허용",
  },
  BANNED_PHRASE: { label: "금지 표현", hint: "이 딜에 한정된 브랜드 제약" },
  REQUIRED_DISCLOSURE: {
    label: "필수 고지",
    hint: "본문에 반드시 포함되어야 함",
  },
} as const;

const EVIDENCE_META = {
  MEASURED: { label: "실측 근거", tone: "text-foreground" },
  USER_PROVIDED: { label: "브랜드 제공", tone: "text-foreground" },
  NEEDS_SOURCE: { label: "근거 미확보", tone: "text-status-caution-text" },
} as const;

/** 상태는 심각도가 아니라 생애주기다 — 승인/거절만 색을 받고 나머지는 무채색. */
const STATUS_META = {
  PROPOSED: { label: "검토 대기", chip: "bg-muted text-muted-foreground" },
  APPROVED: { label: "승인", chip: "bg-primary/10 text-primary" },
  REJECTED: { label: "거절", chip: "bg-muted text-muted-foreground" },
  EXPIRED: { label: "만료", chip: "bg-muted text-muted-foreground" },
} as const;

const CATEGORY_OPTIONS = [
  { value: "GENERAL", label: "미지정 (공통 규칙만)" },
  { value: "FOOD", label: "식품" },
  { value: "SUPPLEMENT", label: "건강기능식품" },
  { value: "COSMETIC", label: "화장품" },
] as const;

type ClaimKind = keyof typeof KIND_META;
type EvidenceType = keyof typeof EVIDENCE_META;
type ClaimStatus = keyof typeof STATUS_META;

type ClaimCandidate = {
  kind: ClaimKind;
  text: string;
  evidence: string | null;
  evidenceType: EvidenceType;
  quote: string | null;
};

type DealClaim = {
  id: string;
  kind: ClaimKind;
  text: string;
  evidence: string | null;
  evidenceType: EvidenceType;
  status: ClaimStatus;
  reviewBy: string | null;
  source: string | null;
};

export function DealClaimsSection({ dealId }: { dealId: string }) {
  const [claims, setClaims] = useState<DealClaim[]>([]);
  const [category, setCategory] = useState<string>("GENERAL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [draftKind, setDraftKind] = useState<ClaimKind>("APPROVED_CLAIM");
  const [draftText, setDraftText] = useState("");
  const [draftEvidence, setDraftEvidence] = useState("");
  const [draftEvidenceType, setDraftEvidenceType] =
    useState<EvidenceType>("NEEDS_SOURCE");
  const [creating, setCreating] = useState(false);

  // AI 추출(M3) — 후보를 화면에 먼저 보여주고, 운영자가 고른 것만 PROPOSED 로
  // 등록한다. 추출 API 자체는 DB 에 쓰지 않는다(C1 §2-3).
  const [extractOpen, setExtractOpen] = useState(false);
  const [extractSource, setExtractSource] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [candidates, setCandidates] = useState<ClaimCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [truncated, setTruncated] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/claims`);
      if (!res.ok) throw new Error("클레임을 불러오지 못했습니다");
      const data = await res.json();
      setClaims(data.claims ?? []);
      setCategory(data.category ?? "GENERAL");
    } catch (err) {
      setError(err instanceof Error ? err.message : "클레임 로드 실패");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCategoryChange(next: string) {
    const previous = category;
    setCategory(next);
    const res = await fetch(`/api/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: next === "GENERAL" ? null : next }),
    });
    if (!res.ok) {
      setCategory(previous); // 저장 실패는 표시로 되돌린다(무음 성공 위장 금지)
      setError("카테고리 저장에 실패했습니다");
    }
  }

  async function handleCreate() {
    if (!draftText.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/claims`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: draftKind,
          text: draftText.trim(),
          evidence: draftEvidence.trim() || null,
          evidenceType: draftEvidenceType,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "등록에 실패했습니다");
      }
      setDraftText("");
      setDraftEvidence("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "등록 실패");
    } finally {
      setCreating(false);
    }
  }

  async function handleExtract() {
    if (!extractSource.trim()) return;
    setExtracting(true);
    setError(null);
    setCandidates(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/claims/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: extractSource }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "추출에 실패했습니다");
      setCandidates(body.candidates ?? []);
      setTruncated(Boolean(body.truncated));
      // 기본은 전부 선택 해제 — 검토 없이 일괄 등록되는 흐름을 만들지 않는다.
      setPicked(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "추출 실패");
    } finally {
      setExtracting(false);
    }
  }

  async function handleRegisterPicked() {
    if (!candidates || picked.size === 0) return;
    setCreating(true);
    setError(null);
    // 성공분은 선택에서 즉시 빼둔다 — 중간에 실패한 뒤 다시 누르면 이미
    // 등록된 것까지 재전송돼 중복이 쌓인다(코드리뷰 MEDIUM, 2026-07-30).
    const remaining = new Set(picked);
    try {
      for (const index of picked) {
        const candidate = candidates[index];
        if (!candidate) {
          remaining.delete(index);
          continue;
        }
        const res = await fetch(`/api/deals/${dealId}/claims`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: candidate.kind,
            text: candidate.text,
            evidence: candidate.evidence,
            evidenceType: candidate.evidenceType,
            source: "AI 추출",
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? "등록에 실패했습니다");
        }
        remaining.delete(index);
      }
      setCandidates(null);
      setPicked(new Set());
      setExtractSource("");
      setExtractOpen(false);
      await load();
    } catch (err) {
      // 남은 것만 선택 상태로 두고 목록은 갱신한다 — 재시도해도 중복되지 않는다.
      setPicked(remaining);
      // ⚠️ load() 가 내부에서 setError(null) 을 하므로 **갱신 뒤에** 에러를 세운다.
      // 순서를 뒤집으면 실패가 조용히 사라진다(테스트가 이 순서를 고정한다).
      await load();
      setError(err instanceof Error ? err.message : "등록 실패");
    } finally {
      setCreating(false);
    }
  }

  async function patchClaim(claimId: string, body: Record<string, unknown>) {
    setBusyId(claimId);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/claims`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimId, ...body }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error ?? "변경에 실패했습니다");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "변경 실패");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(claimId: string) {
    setBusyId(claimId);
    try {
      const res = await fetch(
        `/api/deals/${dealId}/claims?claimId=${encodeURIComponent(claimId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("삭제에 실패했습니다");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 실패");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">표현 관리</h3>
          <p className="text-xs text-muted-foreground">
            이 딜에서 쓸 수 있는 표현과 금지 표현. 표현 검사와 자료 생성이
            여기를 기준으로 판정합니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">카테고리</span>
          <Select value={category} onValueChange={handleCategoryChange}>
            <SelectTrigger className="h-8 w-44" aria-label="상품 카테고리">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      {error ? (
        <p className="rounded-md bg-status-urgent-bg px-3 py-2 text-xs text-status-urgent-text">
          {error}
        </p>
      ) : null}

      <div className="space-y-2 rounded-lg border border-slate-100 p-3">
        {!extractOpen ? (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => setExtractOpen(true)}
          >
            <SparklesIcon className="size-3.5" aria-hidden />
            상품자료에서 후보 뽑기
          </Button>
        ) : (
          <div className="space-y-2">
            <Textarea
              value={extractSource}
              onChange={(event) => setExtractSource(event.target.value)}
              placeholder="상품소개서·상세페이지 문구를 붙여넣으세요. 자료에 실제로 있는 표현만 후보로 나옵니다."
              aria-label="상품자료"
              className="min-h-28 text-sm"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleExtract}
                disabled={extracting || !extractSource.trim()}
                className="flex-1"
              >
                {extracting ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <SparklesIcon className="size-3.5" aria-hidden />
                )}
                후보 뽑기
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setExtractOpen(false);
                  setCandidates(null);
                  setPicked(new Set());
                }}
              >
                닫기
              </Button>
            </div>

            {truncated ? (
              <p className="text-xs text-status-caution-text">
                자료가 길어 앞부분만 사용했습니다. 나머지는 나눠서 다시
                뽑으세요.
              </p>
            ) : null}

            {candidates ? (
              candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  자료에서 확인 가능한 후보가 없습니다. 없는 표현을 지어내지
                  않습니다.
                </p>
              ) : (
                <div className="space-y-2" aria-label="추출 후보 목록">
                  <p className="text-xs text-muted-foreground">
                    등록할 항목을 고르세요. 전부 <b>검토 대기</b>로 들어가며,
                    승인은 따로 합니다.
                  </p>
                  {candidates.map((candidate, index) => (
                    <label
                      key={`${candidate.kind}-${index}`}
                      className="flex cursor-pointer gap-2 rounded-lg border border-slate-100 p-2 text-xs"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={picked.has(index)}
                        onChange={(event) => {
                          const next = new Set(picked);
                          if (event.target.checked) next.add(index);
                          else next.delete(index);
                          setPicked(next);
                        }}
                        aria-label={`후보 선택: ${candidate.text}`}
                      />
                      <span className="min-w-0 space-y-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-muted-foreground">
                            {KIND_META[candidate.kind].label}
                          </span>
                          <span
                            className={
                              EVIDENCE_META[candidate.evidenceType].tone
                            }
                          >
                            {EVIDENCE_META[candidate.evidenceType].label}
                          </span>
                        </span>
                        <span className="block text-sm text-foreground">
                          {candidate.text}
                        </span>
                        {candidate.quote ? (
                          <span className="block text-muted-foreground">
                            원문: “{candidate.quote}”
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                  <Button
                    size="sm"
                    onClick={handleRegisterPicked}
                    disabled={creating || picked.size === 0}
                    className="w-full"
                  >
                    {creating ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <PlusIcon className="size-3.5" aria-hidden />
                    )}
                    선택 {picked.size}건 검토 대기로 등록
                  </Button>
                </div>
              )
            ) : null}
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-lg border border-slate-100 p-3">
        <div className="flex flex-wrap gap-2">
          <Select
            value={draftKind}
            onValueChange={(value) => setDraftKind(value as ClaimKind)}
          >
            <SelectTrigger className="h-8 w-36" aria-label="표현 종류">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(KIND_META).map(([value, meta]) => (
                <SelectItem key={value} value={value}>
                  {meta.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={draftEvidenceType}
            onValueChange={(value) =>
              setDraftEvidenceType(value as EvidenceType)
            }
          >
            <SelectTrigger className="h-8 w-36" aria-label="근거 유형">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(EVIDENCE_META).map(([value, meta]) => (
                <SelectItem key={value} value={value}>
                  {meta.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Input
          value={draftText}
          onChange={(event) => setDraftText(event.target.value)}
          placeholder={KIND_META[draftKind].hint}
          aria-label="표현"
          className="h-8"
        />
        <Input
          value={draftEvidence}
          onChange={(event) => setDraftEvidence(event.target.value)}
          placeholder="근거 (시험성적서 번호·인증번호·공문 일자 등)"
          aria-label="근거"
          className="h-8"
        />
        <Button
          size="sm"
          onClick={handleCreate}
          disabled={creating || !draftText.trim()}
          className="w-full"
        >
          {creating ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <PlusIcon className="size-3.5" aria-hidden />
          )}
          검토 대기로 등록
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : claims.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-muted-foreground">
          등록된 표현이 없습니다. 상품자료의 소구점과 브랜드가 금지한 표현을
          등록해 두면 검사와 자료 생성이 이를 기준으로 판정합니다.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="등록된 표현 목록">
          {claims.map((claim) => (
            <li
              key={claim.id}
              className="space-y-2 rounded-lg border border-slate-100 p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-xs font-medium",
                    STATUS_META[claim.status].chip,
                  )}
                >
                  {STATUS_META[claim.status].label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {KIND_META[claim.kind].label}
                </span>
                <span
                  className={cn(
                    "text-xs",
                    EVIDENCE_META[claim.evidenceType].tone,
                  )}
                >
                  {EVIDENCE_META[claim.evidenceType].label}
                </span>
              </div>
              <p className="text-sm text-foreground">{claim.text}</p>
              {claim.evidence ? (
                <p className="text-xs text-muted-foreground">
                  근거: {claim.evidence}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {claim.status !== "APPROVED" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === claim.id}
                    onClick={() => patchClaim(claim.id, { status: "APPROVED" })}
                  >
                    승인
                  </Button>
                ) : null}
                {claim.status !== "REJECTED" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === claim.id}
                    onClick={() => patchClaim(claim.id, { status: "REJECTED" })}
                  >
                    거절
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === claim.id}
                  onClick={() => handleDelete(claim.id)}
                  aria-label="표현 삭제"
                >
                  <TrashIcon className="size-3.5" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
