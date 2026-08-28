import { useState } from "react";
import { toast } from "sonner";
import {
  extractOptionLabel,
  formatOptionDealName,
  getDisplayDealName,
} from "@/lib/deal-display";
import {
  computeOptionCostFromSelling,
  computeSupplyPrice,
  buildOptionSupplementaryInfo,
  parseOptionSupplementaryInfo,
  type DealPanelData,
} from "@/utils/deal-panel-helpers";

export function useDealOptions({
  deal,
  fetchDealDetails,
}: {
  deal: DealPanelData | null;
  fetchDealDetails: () => Promise<void>;
}) {
  const [optionsExpanded, setOptionsExpanded] = useState(false);
  const [newOptionName, setNewOptionName] = useState("");
  const [newOptionUnitQuantity, setNewOptionUnitQuantity] = useState("");
  const [newOptionSupplementaryInfo, setNewOptionSupplementaryInfo] =
    useState("");
  const [newOptionModelName, setNewOptionModelName] = useState("");
  const [newOptionCost, setNewOptionCost] = useState("");
  const [newOptionSelling, setNewOptionSelling] = useState("");
  const [newOptionCommission, setNewOptionCommission] = useState("");
  const [addingOption, setAddingOption] = useState(false);
  const [editingOptionId, setEditingOptionId] = useState<string | null>(null);
  const [reorderingOptions, setReorderingOptions] = useState(false);

  const defaultOptionCommission =
    deal?.totalCommissionRate != null ? String(deal.totalCommissionRate) : "";

  const handleAddOption = async (e: React.FormEvent) => {
    e.preventDefault();
    const hasUnitConfig = !!deal?.unit;
    const isNameValid = hasUnitConfig
      ? newOptionUnitQuantity.trim()
      : newOptionName.trim();
    if (!deal || !isNameValid) return;
    setAddingOption(true);
    try {
      const finalDealName = hasUnitConfig
        ? getDisplayDealName({
            dealName: deal.dealName,
            unit: deal.unit,
            unitQuantity: Number(newOptionUnitQuantity),
            supplementaryInfo: newOptionSupplementaryInfo.trim() || null,
          })
        : formatOptionDealName(deal.dealName, newOptionName);

      const optionUnitQuantity = hasUnitConfig
        ? Number(newOptionUnitQuantity)
        : null;
      const optionSupplementaryInfo = buildOptionSupplementaryInfo(
        newOptionSupplementaryInfo,
        newOptionModelName,
      );

      const body = editingOptionId
        ? {
            dealName: finalDealName,
            unit: deal.unit,
            unitQuantity: optionUnitQuantity,
            supplementaryInfo: optionSupplementaryInfo,
            costPrice:
              computeSupplyPrice(
                Number(newOptionSelling) || 0,
                newOptionCommission
                  ? Number(newOptionCommission)
                  : (deal.totalCommissionRate ?? null),
              ) ?? 0,
            sellingPrice: Number(newOptionSelling) || 0,
            totalCommissionRate: newOptionCommission
              ? Number(newOptionCommission)
              : (deal.totalCommissionRate ?? null),
          }
        : {
            dealName: finalDealName,
            unit: deal.unit,
            unitQuantity: optionUnitQuantity,
            supplementaryInfo: optionSupplementaryInfo,
            partnerId: deal.partnerId,
            costPrice:
              computeSupplyPrice(
                Number(newOptionSelling) || 0,
                newOptionCommission
                  ? Number(newOptionCommission)
                  : (deal.totalCommissionRate ?? null),
              ) ?? 0,
            sellingPrice: Number(newOptionSelling) || 0,
            totalCommissionRate: newOptionCommission
              ? Number(newOptionCommission)
              : (deal.totalCommissionRate ?? null),
            baseMarginPolicy: deal.baseMarginPolicy,
            dealType: "OPTION",
            parentDealId: deal.id,
          };
      const res = await fetch(
        editingOptionId ? `/api/deals/${editingOptionId}` : "/api/deals",
        {
          method: editingOptionId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (res.ok) {
        toast.success(
          editingOptionId
            ? "옵션 상품이 수정되었습니다."
            : "옵션 상품이 추가되었습니다.",
        );
        resetOptionForm();
        await fetchDealDetails();
      } else {
        const data = await res.json().catch(() => null);
        toast.error(
          data?.error?.message ??
            (editingOptionId
              ? "옵션 상품 수정에 실패했습니다."
              : "옵션 상품 추가에 실패했습니다."),
        );
      }
    } catch {
      toast.error(
        editingOptionId
          ? "옵션 상품 수정에 실패했습니다."
          : "옵션 상품 추가에 실패했습니다.",
      );
    } finally {
      setAddingOption(false);
    }
  };

  function handleOptionSellingChange(value: string) {
    setNewOptionSelling(value);
    const nextCost = computeOptionCostFromSelling(
      value,
      newOptionCommission || defaultOptionCommission,
    );
    if (nextCost !== "") {
      setNewOptionCost(nextCost);
    }
  }

  function handleOptionCommissionChange(value: string) {
    setNewOptionCommission(value);
    const nextCost = computeOptionCostFromSelling(
      newOptionSelling,
      value || defaultOptionCommission,
    );
    if (nextCost !== "") {
      setNewOptionCost(nextCost);
    }
  }

  function startOptionEdit(
    option: NonNullable<DealPanelData["options"]>[number],
  ) {
    setEditingOptionId(option.id);
    const {
      supplementaryInfo: parsedSupplementaryInfo,
      modelName: parsedModelName,
    } = parseOptionSupplementaryInfo(option.supplementaryInfo);
    if (deal?.unit && option.unitQuantity != null) {
      setNewOptionUnitQuantity(String(option.unitQuantity));
      setNewOptionSupplementaryInfo(parsedSupplementaryInfo);
      setNewOptionName("");
    } else {
      setNewOptionName(
        extractOptionLabel(deal?.dealName ?? "", option.dealName),
      );
      setNewOptionUnitQuantity("");
      setNewOptionSupplementaryInfo(parsedSupplementaryInfo);
    }
    setNewOptionModelName(parsedModelName);
    setNewOptionCost(String(option.costPrice ?? ""));
    setNewOptionSelling(String(option.sellingPrice ?? ""));
    setNewOptionCommission(
      option.totalCommissionRate != null
        ? String(option.totalCommissionRate)
        : defaultOptionCommission,
    );
    setOptionsExpanded(true);
  }

  function resetOptionForm() {
    setEditingOptionId(null);
    setNewOptionName("");
    setNewOptionUnitQuantity("");
    setNewOptionSupplementaryInfo("");
    setNewOptionModelName("");
    setNewOptionCost("");
    setNewOptionSelling("");
    setNewOptionCommission("");
  }

  const handleMoveOption = async (
    optionId: string,
    direction: "up" | "down",
  ) => {
    if (!deal?.options || deal.options.length < 2) return;

    const currentIndex = deal.options.findIndex(
      (option) => option.id === optionId,
    );
    if (currentIndex < 0) return;

    const targetIndex =
      direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= deal.options.length) return;

    const reordered = [...deal.options];
    const [movedOption] = reordered.splice(currentIndex, 1);
    reordered.splice(targetIndex, 0, movedOption);

    setReorderingOptions(true);
    try {
      const responses = await Promise.all(
        reordered.map((option, index) =>
          fetch(`/api/deals/${option.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ optionSortOrder: index }),
          }),
        ),
      );

      if (responses.some((response) => !response.ok)) {
        toast.error("옵션 순서 변경에 실패했습니다.");
        return;
      }

      toast.success("옵션 순서가 변경되었습니다.");
      await fetchDealDetails();
    } catch {
      toast.error("옵션 순서 변경에 실패했습니다.");
    } finally {
      setReorderingOptions(false);
    }
  };

  const handleRemoveOption = async (optionId: string) => {
    try {
      const res = await fetch(`/api/deals/${optionId}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("옵션 상품이 삭제되었습니다.");
        await fetchDealDetails();
      } else {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? "옵션 상품 삭제에 실패했습니다.");
      }
    } catch {
      toast.error("옵션 상품 삭제에 실패했습니다.");
    }
  };

  return {
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
    newOptionCost,
    setNewOptionCost,
    newOptionSelling,
    setNewOptionSelling,
    newOptionCommission,
    setNewOptionCommission,
    addingOption,
    editingOptionId,
    reorderingOptions,
    setReorderingOptions,
    defaultOptionCommission,
    handleAddOption,
    handleOptionSellingChange,
    handleOptionCommissionChange,
    startOptionEdit,
    resetOptionForm,
    handleMoveOption,
    handleRemoveOption,
  };
}
