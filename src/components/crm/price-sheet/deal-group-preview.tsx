"use client";

/**
 * 딜 반영 미리보기 — 검수 중인 행들이 "검수 승인 및 반영" 시 어떤 딜 구조로 입력되는지
 * 상위딜(MAIN)·하위품목딜(OPTION) 단위로 보여준다. 매핑 선택을 바꾸면 즉시 갱신된다.
 *
 * 그룹핑 계산은 서버 반영 실행기와 같은 SSOT(src/lib/price-sheet/grouping.ts)를 쓴다 —
 * 여기 보이는 구조와 실제 반영 결과가 달라지면 안 되므로 별도 재구현 금지.
 * 위계 표현은 deals-panel의 "하위 옵션 상품" 어휘(중첩 컨테이너 + bg-muted/20 행 +
 * secondary 알약 배지)를 재사용한다 — MAIN/OPTION은 범주라 색을 받지 않는다(P8 §4).
 */
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/format";
import {
  computeDealGroups,
  type ApplyRowInput,
  type BundlePolicy,
  type DealCreatePayload,
  type DealGroupOverride,
  type PartnerOption,
} from "@/lib/price-sheet/grouping";
import type { DealOption, PriceSheetRowData } from "./review-table";

// ⚠️ 인자는 **딜 페이로드의 값**이라 이미 퍼센트 수치다(50 = 50%) — 가격표 행의 0~1
// 소수가 아니다(grouping.ts `rateToDealPercent`). 여기서 다시 *100 하면 5000% 가 된다.
// 행 값을 그리는 `apply-diff-modal.tsx` 의 `fmtRate` 와 단위가 다르니 합치지 말 것.
function ratePercentLabel(ratePercent: number | null | undefined): string | null {
  if (ratePercent === null || ratePercent === undefined) return null;
  return `${Math.round(ratePercent * 100) / 100}%`;
}

/** 판매가/공급가/수수료 알약 — deals-panel 옵션 행과 동일 어휘. */
function PricePills({ payload }: { payload: DealCreatePayload }) {
  const commission = ratePercentLabel(payload.totalCommissionRate);
  return (
    <div className="flex flex-wrap gap-1">
      <Badge variant="secondary" className="h-5 rounded-2xl px-1.5 text-[10px] font-medium">
        판매가 {formatCurrency(payload.sellingPrice)}
      </Badge>
      {payload.supplyPrice != null && (
        <Badge variant="secondary" className="h-5 rounded-2xl px-1.5 text-[10px] font-medium">
          공급가 {formatCurrency(payload.supplyPrice)}
        </Badge>
      )}
      {commission && (
        <Badge variant="secondary" className="h-5 rounded-2xl px-1.5 text-[10px] font-medium">
          수수료 {commission}
        </Badge>
      )}
    </div>
  );
}

export function DealGroupPreview({
  rows,
  partnerId,
  deals,
  partners,
  overrides,
  onOverrideChange,
  bundle,
}: {
  rows: PriceSheetRowData[];
  partnerId: string | null;
  deals: DealOption[];
  /** 거래처 연결 후보 목록(상세 화면이 1회 조회). */
  partners: PartnerOption[];
  /** 그룹별 유효 브랜드·거래처(상세 화면이 기본값 규칙까지 채워 내려준다 = 반영 시 전송값). */
  overrides: Record<string, DealGroupOverride>;
  onOverrideChange: (groupKey: string, patch: DealGroupOverride) => void;
  /** 시트 단위 반영 방식. 미전달 시 AUTO. */
  bundle?: BundlePolicy;
}) {
  const dealNameById = React.useMemo(
    () => new Map(deals.map((d) => [d.id, d.dealName])),
    [deals]
  );

  // 미리보기 = 반영 시 실제 전송될 오버라이드를 그대로 반영한 결과(SSOT 공유).
  const { groups, skippedRowIds } = React.useMemo(
    () => computeDealGroups(rows as ApplyRowInput[], partnerId, overrides, bundle),
    [rows, partnerId, overrides, bundle]
  );

  // "existing" 그룹은 상위딜을 새로 만들지 않고 기존 딜에 하위품목만 붙인다 — "신규 생성"
  // 헤더와 "기존 딜에 추가" 헤더를 분리해 두 섹션이 서로 모순되지 않게 한다.
  const createdGroups = React.useMemo(
    () => groups.filter((g) => g.parentPriceSource !== "existing"),
    [groups]
  );
  const attachGroups = React.useMemo(
    () => groups.filter((g) => g.parentPriceSource === "existing"),
    [groups]
  );

  const updates = React.useMemo(
    () => rows.filter((r) => r.mappingStatus === "MAPPED" && r.mappedDealId),
    [rows]
  );
  const unconfirmed = React.useMemo(
    () => rows.filter((r) => r.mappingStatus === "SUGGESTED" || r.mappingStatus === "UNMAPPED"),
    [rows]
  );

  if (rows.length === 0) return null;

  const hasAnyConfirmed = groups.length > 0 || updates.length > 0;

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold text-foreground">딜 반영 미리보기</h3>
          <p className="text-xs text-muted-foreground">
            검수 승인 시 아래 구조 그대로 딜에 입력됩니다. 매핑을 바꾸면 즉시 갱신됩니다.
          </p>
        </div>

        {!hasAnyConfirmed ? (
          <p className="text-sm text-muted-foreground">
            아직 확정된 행이 없습니다. 검수표에서 매핑을 확정(신규 딜/기존 딜)하면 반영될 딜
            구조가 여기 표시됩니다.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {createdGroups.length > 0 && (
              <div className="flex flex-col gap-2">
                {/* "existing" 그룹은 상위딜을 새로 만들지 않고 기존 딜에 하위품목만 붙이므로
                    신규 생성 개수에서 뺀다 — 아래 카드 본문의 "기존 딜에 추가" 문구와
                    헤더가 서로 모순되지 않게 한다. */}
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  신규 생성 ({createdGroups.length}개 딜)
                </span>
                {createdGroups.map((group) => (
                  <div
                    key={group.groupKey}
                    className="rounded-lg border border-border/70 bg-card p-3"
                  >
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {group.parentPriceSource === "existing"
                            ? "기존 딜에 추가"
                            : group.options
                              ? "상위딜"
                              : "단일 딜"}
                        </span>
                        <span className="text-sm font-medium text-foreground">
                          {group.parentDealName}
                        </span>
                      </div>

                      {/* 신규 딜에 함께 저장될 브랜드·거래처 — 브랜드는 제품명에서 추출한
                          제안값이 기본이고, 거래처는 브랜드명으로 자동 매칭된다. 여기서
                          수정한 값이 반영 시 그대로 전송된다. 기존 딜에 붙는 그룹은 부모
                          값을 그대로 상속하므로(편집 대상 아님) 이 블록을 숨긴다. */}
                      {group.parentPriceSource !== "existing" && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                            브랜드
                            <Input
                              className="h-7 w-32 text-xs"
                              placeholder="브랜드명 입력"
                              value={overrides[group.groupKey]?.brandName ?? ""}
                              onChange={(e) =>
                                onOverrideChange(group.groupKey, {
                                  brandName: e.target.value || null,
                                })
                              }
                            />
                          </label>
                          <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                            거래처
                            <Select
                              value={overrides[group.groupKey]?.partnerId ?? "__none__"}
                              onValueChange={(value) =>
                                onOverrideChange(group.groupKey, {
                                  partnerId: value === "__none__" ? null : value,
                                })
                              }
                            >
                              <SelectTrigger className="h-7 w-40 text-xs">
                                <SelectValue placeholder="거래처 선택" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">연결 안 함</SelectItem>
                                {partners.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {p.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </label>
                          {/* 정보성 안내 — 시트 자체가 거래처 미지정이면 모든 카드에 뜨는 정상
                              케이스라 caution 색을 쓰지 않는다(P8: 색은 소수의 주의 행에만). */}
                          {!overrides[group.groupKey]?.partnerId && (
                            <span className="text-[11px] text-muted-foreground">
                              거래처 미연결 상태로 생성됩니다
                            </span>
                          )}
                        </div>
                      )}

                      {group.parentPriceSource === "existing" ? (
                        <p className="text-xs text-muted-foreground">
                          기존 상위딜 아래에 하위품목으로 추가됩니다. 상위딜의 가격·브랜드·거래처는
                          변경되지 않습니다.
                        </p>
                      ) : group.parentPriceSource === "empty" ? (
                        <p className="flex items-center gap-1.5 text-xs font-medium text-status-caution-text">
                          <span
                            aria-hidden
                            className="size-1.5 shrink-0 rounded-full bg-status-caution"
                          />
                          상위딜 가격 없음(0원). 단위 1(1개/1통/1팩) 옵션이 없어 빈
                          컨테이너로 생성됩니다.
                        </p>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <PricePills payload={group.parent} />
                          {group.parentPriceSource === "base-option" && (
                            <span className="text-[11px] text-muted-foreground">
                              단위 1 옵션에서 상속
                            </span>
                          )}
                        </div>
                      )}

                      {group.options && (
                        <div className="mt-1 flex flex-col gap-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            하위 옵션 {group.options.length}개
                          </span>
                          <div className="flex max-h-60 flex-col gap-1 overflow-y-auto pr-1">
                            {/* key는 행 id — 옵션명까지 동일한 중복 추출 행(이 화면에서 눈으로
                                걸러내야 할 바로 그 케이스)에서 dealName key가 충돌하기 때문.
                                rowIds는 options와 같은 validRows 순회에서 나와 순서가 평행하다. */}
                            {group.options.map((option, optionIndex) => (
                              <div
                                key={group.rowIds[optionIndex] ?? option.dealName}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2"
                              >
                                <span className="text-xs font-medium text-foreground">
                                  {option.dealName}
                                </span>
                                <PricePills payload={option} />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 기존 딜에 붙는 묶음은 "신규 생성"과 별개 섹션으로 보여준다 — 헤더가 상위딜을
                새로 만드는 것처럼 세지 않도록. 브랜드·거래처는 부모 값을 그대로 상속하므로
                편집 UI를 두지 않는다(위 신규 생성 카드와 달리). */}
            {attachGroups.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  기존 딜에 추가 ({attachGroups.length}개 딜)
                </span>
                {attachGroups.map((group) => (
                  <div
                    key={group.groupKey}
                    className="rounded-lg border border-border/70 bg-card p-3"
                  >
                    <div className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          기존 딜에 추가
                        </span>
                        <span className="text-sm font-medium text-foreground">
                          {group.parentDealName}
                        </span>
                      </div>

                      <p className="text-xs text-muted-foreground">
                        기존 상위딜 아래에 하위품목으로 추가됩니다. 상위딜의 가격·브랜드·거래처는
                        변경되지 않습니다.
                      </p>

                      {group.options && (
                        <div className="mt-1 flex flex-col gap-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            하위 옵션 {group.options.length}개
                          </span>
                          <div className="flex max-h-60 flex-col gap-1 overflow-y-auto pr-1">
                            {group.options.map((option, optionIndex) => (
                              <div
                                key={group.rowIds[optionIndex] ?? option.dealName}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2"
                              >
                                <span className="text-xs font-medium text-foreground">
                                  {option.dealName}
                                </span>
                                <PricePills payload={option} />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {updates.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  기존 딜 업데이트 ({updates.length}건)
                </span>
                <div className="flex flex-col gap-1">
                  {updates.map((row) => (
                    <div
                      key={row.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs"
                    >
                      <span className="text-muted-foreground">
                        {row.optionName ?? row.productName ?? "(이름 없음)"}
                      </span>
                      <span aria-hidden className="text-muted-foreground">
                        →
                      </span>
                      <span className="font-medium text-foreground">
                        {dealNameById.get(row.mappedDealId!) ?? "선택한 딜"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {(unconfirmed.length > 0 || skippedRowIds.length > 0) && (
          <div className="flex flex-col gap-0.5 border-t border-border/40 pt-2">
            {unconfirmed.length > 0 && (
              <p className="text-xs text-muted-foreground">
                미확정 {unconfirmed.length}건은 반영에서 제외됩니다 (제안 승인 또는 딜 선택
                필요).
              </p>
            )}
            {skippedRowIds.length > 0 && (
              <p className="text-xs font-medium text-status-caution-text">
                신규 딜로 확정했지만 필수값(제품명·판매가) 누락으로 제외되는 행이{" "}
                {skippedRowIds.length}건 있습니다.
              </p>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
