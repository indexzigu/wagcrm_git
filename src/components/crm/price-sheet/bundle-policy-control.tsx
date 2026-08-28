"use client";

/**
 * 「반영 방식」 컨트롤 — 이 시트의 신규 행들을 자동 규칙으로 반영할지, 한 딜의
 * 하위품목으로 묶을지 고른다(설계 §4).
 *
 * 초기값은 자동이다 — 기존 시트들의 동작을 보존하고, 묶어야 할 때만 오너가 명시적으로
 * 바꾼다. 대상 기본 탭이 "기존 딜"인 것은 통상 협의 단계에서 딜 기본정보가 먼저
 * 등록되고 딜 조건이 사후에 들어오는 운영 순서를 따른 것이다(오너 결정).
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BundlePolicy } from "@/lib/price-sheet/grouping";
import type { DealOption } from "./review-table";

export function BundlePolicyControl({
  value,
  onChange,
  deals,
  sheetPartnerId,
}: {
  value: BundlePolicy;
  onChange: (next: BundlePolicy) => void;
  deals: DealOption[];
  /** 시트 거래처 — 그 거래처의 딜을 목록 앞에 올려 검색 없이 고를 수 있게 한다. */
  sheetPartnerId: string | null;
}) {
  // 상위딜 후보 = 최상위 딜만(2단 중첩 금지). 시트 거래처 딜을 앞으로.
  const parentCandidates = React.useMemo(() => {
    const tops = deals.filter((d) => d.parentDealId === null);
    if (!sheetPartnerId) return tops;
    return [
      ...tops.filter((d) => d.partnerId === sheetPartnerId),
      ...tops.filter((d) => d.partnerId !== sheetPartnerId),
    ];
  }, [deals, sheetPartnerId]);

  const emptyExisting = {
    kind: "EXISTING" as const,
    dealId: "",
    parentDealName: "",
    parentBrandName: null,
    parentPartnerId: null,
  };

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold text-foreground">반영 방식</h3>
          <p className="text-xs text-muted-foreground">
            이 시트의 신규 행들을 어떤 구조로 딜에 넣을지 정합니다.
          </p>
        </div>

        {/* shadcn radio-group 은 이 프로젝트에 없다(실측). 체크박스와 같이 네이티브
            input 을 쓴다 — 컨트롤 2~3개에 새 의존성을 들이지 않는다. */}
        <div role="radiogroup" aria-label="반영 방식" className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <input
              type="radio"
              name="bundle-mode"
              id="bundle-auto"
              className="mt-1 size-4 accent-primary"
              checked={value.mode === "AUTO"}
              onChange={() => onChange({ mode: "AUTO" })}
            />
            {/* ⚠️ items-start 를 반드시 명시한다 — Label 기본 클래스에 `flex items-center`
                가 있어서 flex-col 만 덮어쓰면 items-center 가 살아남아 세로축에서 자식을
                **가로 중앙 정렬**한다. 짧은 라벨("자동")이 라디오에서 멀찍이 떨어져 보이던
                원인이 이것이다. */}
            <Label htmlFor="bundle-auto" className="flex flex-col items-start gap-0.5 font-normal">
              <span className="text-xs font-medium text-foreground">자동</span>
              <span className="text-xs text-muted-foreground">
                제품명과 옵션 구성이 같은 행끼리 알아서 묶습니다.
              </span>
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <input
              type="radio"
              name="bundle-mode"
              id="bundle-on"
              className="mt-1 size-4 accent-primary"
              checked={value.mode === "BUNDLE"}
              onChange={() =>
                onChange({ mode: "BUNDLE", target: emptyExisting, excludedRowIds: [] })
              }
            />
            <Label htmlFor="bundle-on" className="flex flex-col items-start gap-0.5 font-normal">
              <span className="text-xs font-medium text-foreground">한 딜의 하위품목으로 묶기</span>
              <span className="text-xs text-muted-foreground">
                제품이 서로 달라도 지정한 상위딜 아래로 전부 넣습니다.
              </span>
            </Label>
          </div>
        </div>

        {/* 좌측 들여쓰기 pl-6(24px) = 라디오(16px) + gap-2(8px) — 위 "묶기" 라벨 텍스트가
            시작하는 지점과 맞춘다. 구분선만으로는 형제 관계(자동/묶기)와 종속 관계(묶기를
            골랐을 때만 나오는 대상 선택)가 같은 강도로 읽힌다. 테두리 박스를 하나 더
            두면 카드 안에 카드가 중첩되므로 여백으로만 표현한다. */}
        {value.mode === "BUNDLE" && (
          <div className="flex flex-col gap-2 border-t border-border/40 pt-3 pl-6">
            <div role="radiogroup" aria-label="상위딜 대상" className="flex gap-4">
              <div className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="bundle-target"
                  id="target-existing"
                  className="size-4 accent-primary"
                  checked={value.target.kind === "EXISTING"}
                  onChange={() => onChange({ ...value, target: emptyExisting })}
                />
                <Label htmlFor="target-existing" className="text-xs font-normal">
                  기존 딜에 붙이기
                </Label>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="bundle-target"
                  id="target-new"
                  className="size-4 accent-primary"
                  checked={value.target.kind === "NEW"}
                  onChange={() =>
                    onChange({ ...value, target: { kind: "NEW", parentDealName: "" } })
                  }
                />
                <Label htmlFor="target-new" className="text-xs font-normal">
                  새 상위딜 만들기
                </Label>
              </div>
            </div>

            {value.target.kind === "EXISTING" ? (
              <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <span id="bundle-parent-label">상위딜</span>
                <Select
                  value={value.target.dealId}
                  onValueChange={(dealId) => {
                    const deal = parentCandidates.find((d) => d.id === dealId);
                    if (!deal) return;
                    onChange({
                      ...value,
                      target: {
                        kind: "EXISTING",
                        dealId: deal.id,
                        parentDealName: deal.dealName,
                        parentBrandName: deal.brandName,
                        parentPartnerId: deal.partnerId,
                      },
                    });
                  }}
                >
                  <SelectTrigger aria-labelledby="bundle-parent-label" className="h-8 w-72 text-xs">
                    <SelectValue placeholder="상위딜 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {parentCandidates.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.dealName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : (
              <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                상위딜 이름
                <Input
                  className="h-8 w-72 text-xs"
                  placeholder="새로 만들 상위딜 이름"
                  value={value.target.parentDealName}
                  onChange={(e) =>
                    onChange({ ...value, target: { kind: "NEW", parentDealName: e.target.value } })
                  }
                />
              </label>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
