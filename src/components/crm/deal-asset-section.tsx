"use client";

import { useId } from "react";
import { Archive, ExternalLink, FileText, Upload, Loader2, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type AssetSection, assetSectionLabels } from "@/lib/crm-types";
import { formatBytes, formatRelativeSavedAt } from "@/lib/format";
import { ContentGuideView } from "./content-guide-view";
import { ContentGuideReferences } from "./content-guide-references";
import { GUIDE_KINDS, GUIDE_KIND_LABEL } from "@/lib/content-guide";
import { OfferDiagnosticHint } from "./offer-diagnostic-hint";
import { useDealAssets, DEAL_ASSET_SECTIONS } from "@/hooks/useDealAssets";

export function DealAssetSection({ dealId }: { dealId: string }) {
  const guideTabId = useId();
  const {
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
  } = useDealAssets({ dealId });

  return (
    <section className="rounded-[24px] border border-border/70 bg-white/90 p-4 shadow-soft-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground">첨부 자료</h3>
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[10px] px-2 border-primary/20 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
          onClick={() => void handleGenerateGuide()}
          disabled={guideBusy}
        >
          {guideBusy ? (
            <span className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> 생성 중
            </span>
          ) : (
            `${GUIDE_KIND_LABEL[guideKind]} 가이드`
          )}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        딜 소개자료, 가격표, 제안자료 등 관련 파일을 첨부합니다.
      </p>
      <OfferDiagnosticHint dealId={dealId} />
      {guideError ? (
        <p className="mt-1.5 text-xs text-destructive">{guideError}</p>
      ) : null}

      <div className="mt-3 flex gap-2">
        <div className="flex-1">
          <select
            value={section}
            onChange={(e) => setSection(e.target.value as AssetSection)}
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-ring"
          >
            {DEAL_ASSET_SECTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
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
      {errorMsg ? (
        <p className="mt-1.5 text-xs text-destructive">{errorMsg}</p>
      ) : null}

      <div className="mt-2 flex gap-2">
        <input
          type="url"
          value={linkUrl}
          onChange={(e) => {
            setLinkUrl(e.target.value);
          }}
          placeholder="인스타 릴스/게시물 URL 붙여넣기"
          aria-label="레퍼런스 URL"
          disabled={linkBusy}
          className="h-8 min-w-0 flex-[2] rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-ring disabled:opacity-50"
        />
        <input
          type="text"
          value={linkName}
          onChange={(e) => setLinkName(e.target.value)}
          placeholder="표시 이름(선택)"
          aria-label="표시 이름"
          maxLength={120}
          disabled={linkBusy}
          className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-focus-ring disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void handleAddLink()}
          disabled={linkBusy || !linkUrl.trim()}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-input px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary disabled:pointer-events-none disabled:opacity-50"
        >
          <Link2 className="size-3.5" />
          {linkBusy ? "추가 중..." : "링크 추가"}
        </button>
      </div>
      {linkError ? (
        <p className="mt-1.5 text-xs text-destructive">{linkError}</p>
      ) : null}

      {visibleAssets.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {visibleAssets.map((asset) => (
            <li
              key={asset.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-white/80 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                {asset.thumbnailUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={asset.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="h-8 w-8 shrink-0 rounded object-cover"
                  />
                ) : (
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">
                    {asset.fileName}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {assetSectionLabels[asset.section as AssetSection]}
                    {asset.provider === "EXTERNAL_LINK"
                      ? ""
                      : ` · ${formatBytes(asset.sizeBytes)}`}
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
        <div className="mt-3 rounded-md border border-dashed border-border/50 bg-slate-50/60 py-4 text-center text-xs text-muted-foreground">
          첨부된 파일이 없습니다.
        </div>
      )}

      {/* ── 콘텐츠 가이드 카드 ──────────────────────────────────────────────
          유형 탭(셀러형 / 브랜드형)이 카드 **상단**에 온다(오너 결정 2026-08-02).
          두 초안은 `@@unique([dealId, kind])` 로 동시에 존재하므로, 카드가 하나뿐이면
          "지금 보고 있는 게 어느 유형인가"와 "다른 유형은 만들어져 있나"가 화면에서
          사라진다 — 탭이 그 정보 구조를 그대로 드러낸다(P2 정보 위계 우선).

          ⚠️ **카드는 초안이 없어도 렌더한다.** 종전처럼 `guide !== null` 로 카드를
          통째로 감추면 탭도 함께 사라져 **브랜드형으로 전환할 방법 자체가 없다.**

          ⚠️ **탭에 색을 쓰지 않는다.** 유형은 좋고 나쁨이 없는 **범주**라 hue 축을
          타지 않고(P8 §4), 이 카드가 이미 `bg-primary/5` 틴트라 그 위에 네이비 틴트를
          얹으면 틴트-온-틴트가 된다(`deals-panel-ai-affordance-color.test.ts` 가
          카드 안 `bg-primary/10` 을 금한다). 그래서 활성 탭은 **표면**으로 가른다 —
          이 카드가 복원 안내·자유 생성 안내·근거 카드에서 이미 쓰는 무채색 인셋과
          같은 언어다.

          ⛔ 이 주석을 지우거나 옮기지 말 것 — 위 색 계약이 이 마커를 앵커로 잡아
          카드 범위를 자른다(딜 패널 분할 때 실제로 지워져 계약 2건이 깨졌다). */}
      <div className="mt-3 rounded-md border border-primary/20 bg-primary/5 p-3">
        <div
          role="tablist"
          aria-label="콘텐츠 가이드 유형"
          className="flex gap-1 border-b border-slate-200/60 pb-2"
        >
          {GUIDE_KINDS.map((kindOption) => {
            const active = kindOption === guideKind;
            return (
              <button
                key={kindOption}
                type="button"
                role="tab"
                id={`${guideTabId}-tab-${kindOption}`}
                aria-selected={active}
                aria-controls={`${guideTabId}-panel`}
                onClick={() => setGuideKind(kindOption)}
                className={`flex h-6 items-center gap-1 rounded-md px-2 text-[10px] font-medium transition-colors ${
                  active
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                }`}
              >
                {GUIDE_KIND_LABEL[kindOption]}
                {guideAvailableKinds.includes(kindOption) ? (
                  <span className="font-normal text-muted-foreground">
                    · 초안 있음
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div
          role="tabpanel"
          id={`${guideTabId}-panel`}
          aria-labelledby={`${guideTabId}-tab-${guideKind}`}
        >
        {guide !== null ? (
        <>
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[10px] font-medium text-primary">
              콘텐츠 가이드 초안 · 참고 레퍼런스 {guideRefCount}건
              {guideVocCount > 0 ? ` · 소비자 후기 ${guideVocCount}건` : ""}{" "}
              반영
              {/* 통과는 판단이 필요 없는 정보라 색·별도 블록 없이 메타 줄에 흡수한다
                  (P2 Decision-Value Priority). `claim-checker-panel` 이 PASS 를 더 크게
                  다루는 것과 **다른 것이 맞다** — 그 화면은 판정이 곧 주 산출물이고
                  여기서는 초안 본문의 메타데이터다. 불일치로 보고 통일하지 말 것. */}
              {guideGate?.verdict === "PASS" &&
              guideGate.missingDisclosures.length === 0 ? (
                <span className="font-normal text-muted-foreground">
                  {" · 표현 검사 통과"}
                </span>
              ) : null}
              {sketchBusy ? (
                <span className="font-normal text-muted-foreground">
                  {" · 컷 시안 그리는 중"}
                </span>
              ) : null}
              {!sketchBusy &&
              (sketchRequestError !== null || sketchFailures.length > 0) ? (
                <span className="font-normal text-muted-foreground">
                  {sketchRequestError === "UNAVAILABLE"
                    ? " · 컷 시안 미생성(저장소 미설정)"
                    : " · 컷 시안 일부 실패"}
                </span>
              ) : null}
            </p>
            <div className="flex shrink-0 gap-1">
              {!sketchBusy &&
              sketchRequestError !== "UNAVAILABLE" &&
              (sketchRequestError === "FAILED" || sketchFailures.length > 0) ? (
                <button
                  type="button"
                  onClick={() => void drawSketches(dealId, guideKind)}
                  className="flex h-6 items-center rounded-md border border-input px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
                >
                  시안 다시 그리기
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void handleCopyGuide()}
                className="flex h-6 items-center rounded-md border border-input px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
              >
                {guideCopied ? "복사됨" : "복사"}
              </button>
              {guideSentAt !== null ? (
                <span className="flex h-6 items-center rounded-md bg-status-success-bg px-2 text-[10px] font-medium text-foreground">
                  보냄 표시됨
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleMarkGuideSent()}
                  disabled={guideSaving}
                  className="flex h-6 items-center rounded-md border border-input px-2 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary disabled:opacity-50"
                >
                  {guideSaving
                    ? "저장 중"
                    : guideKind === "CONTENT_GUIDE"
                      ? "셀러에게 보냄 표시"
                      : "브랜드에 보냄 표시"}
                </button>
              )}
              {/* ⛔ "닫기" 버튼을 다시 넣지 말 것 — 카드가 항상 렌더되면서 그 버튼이
                  거짓말을 하게 됐다. 초안은 서버에 있어 닫아도 사라지는 건 표시뿐인데,
                  자리에 남는 빈 상태 문구는 "아직 생성되지 않았습니다"라고 말한다.
                  정말 지우는 기능이 필요하면 삭제 라우트를 두는 것이 맞다. */}
            </div>
          </div>
          {guideRestored ? (
            <p className="mt-2 rounded-md border border-input bg-background px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              {formatRelativeSavedAt(guideRestored.savedAt)}에 저장된 초안입니다.
              {guideRestored.dealChangedAfter
                ? " 그 뒤 딜 정보가 바뀌었습니다. 다시 생성해야 지금 값이 반영됩니다."
                : " 다시 생성하지 않아도 그대로 쓸 수 있습니다."}
            </p>
          ) : null}

          <ContentGuideReferences references={guideRefs} />

          {guideFreeGeneration ? (
            <p className="mt-2 rounded-md border border-input bg-background px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              승인된 소구점이 등록되지 않아 모델이 자유 생성했습니다. 생성 후
              표현 검사만 적용됐습니다. 딜 표현 관리에서 소구점을 승인하면 다음
              생성부터 그 표현을 근거로 씁니다.
            </p>
          ) : null}

          {guideProofCardAbsence === "NO_EVIDENCE" ? (
            <p className="mt-2 rounded-md border border-input bg-background px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              승인된 소구점에 근거가 없어 근거 카드를 만들지 못했습니다. 딜 표현
              관리에서 근거(시험성적서·인증번호 등)와 근거 구분을 채우면 다음
              생성부터 붙습니다. 셀러가 인용할 재료가 없으면 그 공백을 과장으로
              메우게 됩니다.
            </p>
          ) : null}

          {guideGate &&
          (guideGate.violations.length > 0 ||
            guideGate.missingDisclosures.length > 0) ? (
            <div className="mt-2 rounded-md bg-status-caution-bg px-2 py-1.5">
              <p className="text-[10px] font-medium text-status-caution-text">
                표현 검사 {guideViolationGroups.length}건
                {guideGate.missingDisclosures.length > 0
                  ? ` · 필수 고지 누락 ${guideGate.missingDisclosures.length}건`
                  : ""}
              </p>
              <ul className="mt-1 space-y-1">
                {guideViolationGroups.map((violation) => (
                  <li
                    key={`${violation.sourceId}-${violation.matched}`}
                    className="text-[10px] leading-relaxed text-muted-foreground"
                  >
                    <span className="mr-1 rounded-md bg-status-caution-text/10 px-1 py-0.5 font-medium text-status-caution-text">
                      {violation.matched}
                    </span>
                    {violation.occurrences > 1
                      ? `${violation.occurrences}곳 · `
                      : ""}
                    {violation.legalBasis}
                    {violation.note ? ` · ${violation.note}` : ""}
                  </li>
                ))}
                {guideGate.missingDisclosures.map((disclosure) => (
                  <li
                    key={disclosure.id}
                    className="text-[10px] leading-relaxed text-muted-foreground"
                  >
                    <span className="mr-1 rounded-md bg-status-caution-text/10 px-1 py-0.5 font-medium text-status-caution-text">
                      고지 누락
                    </span>
                    {disclosure.text}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[10px] text-muted-foreground">
                셀러에게 보내기 전에 해당 표현을 손보세요. 판정은 참고용 안내이며
                법률 자문이 아닙니다.
              </p>
            </div>
          ) : null}

          <ContentGuideView
            guide={guide}
            kind={guideKind}
            sketches={guideSketches}
            sketchProgress={{
              loading: sketchBusy,
              failures: sketchFailures,
              skippedKeys: sketchSkippedKeys,
              requestError: sketchRequestError,
            }}
          />
        </>
        ) : (
          <p className="mt-2 rounded-md border border-input bg-background px-2 py-2 text-[10px] leading-relaxed text-muted-foreground">
            {guideKind === "CONTENT_GUIDE"
              ? "셀러가 자기 채널에 올릴 콘텐츠의 기획 골격입니다. 훅·촬영 컷·자막·해시태그. 가격·구성·할인율은 넣지 않습니다(브랜드용이 정본)."
              : "브랜드(벤더)가 전달할 상품 정보 자료입니다. 가격·구성·할인율의 정본이고, 카드뉴스 장 구성과 시안까지 함께 만듭니다."}{" "}
            위 「{GUIDE_KIND_LABEL[guideKind]} 가이드」 버튼으로 생성합니다.
          </p>
        )}
        </div>
      </div>
    </section>
  );
}
