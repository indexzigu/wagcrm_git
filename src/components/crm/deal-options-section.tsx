import React from "react";
import { ChevronDown, ArrowUp, ArrowDown, Pencil, Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/utils/deal-panel-helpers";
import { formatOptionDealName } from "@/lib/deal-display";
import { useDealOptions } from "@/hooks/useDealOptions";
import type { DealPanelData } from "@/utils/deal-panel-helpers";

interface DealOptionsSectionProps {
  deal: DealPanelData;
  fetchDealDetails: () => Promise<void>;
}

export function DealOptionsSection({ deal, fetchDealDetails }: DealOptionsSectionProps) {
  const {
    optionsExpanded,
    setOptionsExpanded,
    newOptionName,
    setNewOptionName,
    newOptionUnitQuantity,
    setNewOptionUnitQuantity,
    newOptionSupplementaryInfo,
    setNewOptionSupplementaryInfo,
    newOptionModelName,
    setNewOptionModelName,
    // 판매가·수수료율·원가는 setter 를 직접 쓰지 않는다 — 셋이 서로를 다시 계산하므로
    // `handleOptionSellingChange`·`handleOptionCommissionChange` 로만 바꾼다.
    newOptionCost,
    newOptionSelling,
    newOptionCommission,
    addingOption,
    editingOptionId,
    reorderingOptions,
    defaultOptionCommission,
    startOptionEdit,
    resetOptionForm,
    handleAddOption,
    handleRemoveOption,
    handleMoveOption,
    handleOptionSellingChange,
    handleOptionCommissionChange,
  } = useDealOptions({ deal, fetchDealDetails });

  return (
    <div className="rounded-lg border border-border/70 bg-card p-4">
      <button
        type="button"
        className="flex w-full items-center justify-between text-xs font-semibold"
        onClick={() => setOptionsExpanded(!optionsExpanded)}
      >
        <span>하위 옵션 상품 ({deal.options?.length ?? 0}개)</span>
        <ChevronDown
          className={cn(
            "size-4 transition-transform duration-200",
            optionsExpanded && "rotate-180"
          )}
        />
      </button>

      {optionsExpanded && (
        <div className="mt-4 space-y-4 animate-fade-in">
          {/* 옵션 목록 */}
          {!deal.options || deal.options.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              등록된 하위 옵션 상품이 없습니다.
            </p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {deal.options.map((opt, index) => (
                <div
                  key={opt.id}
                  className="flex items-center justify-between rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-foreground">
                      {opt.dealName}
                    </span>
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      <Badge
                        variant="secondary"
                        className="h-5 rounded-2xl px-1.5 text-[10px] font-medium"
                      >
                        판매가 {formatCurrency(opt.sellingPrice)}
                      </Badge>
                      <Badge
                        variant="secondary"
                        className="h-5 rounded-2xl px-1.5 text-[10px] font-medium"
                      >
                        공급가 {formatCurrency(opt.costPrice)}
                      </Badge>
                      {opt.totalCommissionRate != null ? (
                        <Badge
                          variant="secondary"
                          className="h-5 rounded-2xl px-1.5 text-[10px] font-medium"
                        >
                          수수료 {opt.totalCommissionRate}%
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 hover:bg-slate-100"
                      aria-label={`${formatOptionDealName(deal.dealName, opt.dealName)} 위로 이동`}
                      disabled={reorderingOptions || index === 0}
                      onClick={() => void handleMoveOption(opt.id, "up")}
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 hover:bg-slate-100"
                      aria-label={`${formatOptionDealName(deal.dealName, opt.dealName)} 아래로 이동`}
                      disabled={
                        reorderingOptions ||
                        index === (deal.options?.length ?? 0) - 1
                      }
                      onClick={() => void handleMoveOption(opt.id, "down")}
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                    <div className="mx-1 h-3 w-px bg-border/50" />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 hover:bg-slate-100"
                      aria-label={`${formatOptionDealName(deal.dealName, opt.dealName)} 수정`}
                      onClick={() => startOptionEdit(opt)}
                    >
                      <Pencil className="size-3.5 text-muted-foreground" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 hover:bg-red-50 hover:text-red-500"
                      aria-label={`${formatOptionDealName(deal.dealName, opt.dealName)} 삭제`}
                      onClick={() => void handleRemoveOption(opt.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 옵션 등록 폼 */}
          <form
            onSubmit={(e) => void handleAddOption(e)}
            className="space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              {/* 폼 소제목 — 카드 제목(text-xs semibold foreground)과 같은 크기, 색으로 한 단계 아래.
                  이 파일 유일의 uppercase+tracking 룩은 폼 타이포 위계 정리로 회수(2026-07-23). */}
              <h4 className="text-xs font-semibold text-muted-foreground">
                {editingOptionId ? "옵션 수정" : "새 옵션 등록"}
              </h4>
              {editingOptionId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-7 text-[11px]"
                  onClick={resetOptionForm}
                >
                  취소
                </Button>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {deal.unit ? (
                <>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-foreground">
                      수량 (단위: {deal.unit})
                    </span>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        placeholder="예: 1"
                        value={newOptionUnitQuantity}
                        onChange={(e) =>
                          setNewOptionUnitQuantity(e.target.value)
                        }
                        className="h-8 border-slate-200 bg-slate-50 text-xs"
                        required
                      />
                      <span className="text-xs font-medium shrink-0">
                        {deal.unit}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-foreground">
                      보조 정보 (선택)
                    </span>
                    <Input
                      placeholder="예: 1개월분"
                      value={newOptionSupplementaryInfo}
                      onChange={(e) =>
                        setNewOptionSupplementaryInfo(e.target.value)
                      }
                      className="h-8 border-slate-200 bg-slate-50 text-xs"
                    />
                  </div>
                </>
              ) : (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-foreground">
                    옵션명
                  </span>
                  <Input
                    placeholder="예: 1통"
                    value={newOptionName}
                    onChange={(e) => setNewOptionName(e.target.value)}
                    className="h-8 border-slate-200 bg-slate-50 text-xs"
                    required
                  />
                </div>
              )}
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">
                  모델명 (선택)
                </span>
                <Input
                  placeholder="예: PB-10000X"
                  value={newOptionModelName}
                  onChange={(e) => setNewOptionModelName(e.target.value)}
                  className="h-8 border-slate-200 bg-slate-50 text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">
                  수수료율 (%)
                </span>
                <Input
                  type="number"
                  step="any"
                  placeholder={defaultOptionCommission || "기본값 사용"}
                  value={newOptionCommission || defaultOptionCommission}
                  onChange={(e) =>
                    handleOptionCommissionChange(e.target.value)
                  }
                  className="h-8 border-slate-200 bg-slate-50 text-xs"
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">
                  공구 판매가 (원)
                </span>
                <Input
                  type="number"
                  placeholder="0"
                  value={newOptionSelling}
                  onChange={(e) =>
                    handleOptionSellingChange(e.target.value)
                  }
                  className="h-8 border-slate-200 bg-slate-50 text-xs"
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-foreground">
                  공급가 (원)
                </span>
                <div className="flex h-8 items-center rounded-md border border-slate-200 bg-slate-100 px-3 text-xs font-semibold text-slate-700">
                  {newOptionCost
                    ? formatCurrency(Number(newOptionCost))
                    : "-"}
                </div>
              </div>
            </div>
            <Button
              type="submit"
              size="sm"
              className="h-8 w-full text-xs"
              disabled={addingOption}
            >
              <Plus className="mr-1 size-3.5" />
              {editingOptionId ? "옵션 수정하기" : "옵션 추가하기"}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
