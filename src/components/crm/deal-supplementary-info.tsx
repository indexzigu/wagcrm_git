import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineEditField } from "./inline-edit-field";

export function SupplementaryInfoFields({
  supplementaryInfoStr,
  onSave,
  onForceSave,
  dealName,
  brandName,
}: {
  supplementaryInfoStr: string;
  onSave: (val: string) => Promise<void>;
  onForceSave?: () => Promise<void>;
  dealName: string;
  brandName: string;
}) {
  const [isExtracting, setIsExtracting] = useState(false);

  let parsed: {
    searchKeyword: string;
    modelName?: string;
    referenceUrl: string;
    supplementaryInfo: string;
  } = {
    searchKeyword: "",
    modelName: "",
    referenceUrl: "",
    supplementaryInfo: "",
  };
  try {
    parsed = JSON.parse(supplementaryInfoStr || "{}");
    if (typeof parsed !== "object" || parsed === null) throw new Error();
  } catch {
    parsed = {
      searchKeyword: "",
      modelName: "",
      referenceUrl: "",
      supplementaryInfo: supplementaryInfoStr || "",
    };
  }

  const handleUpdate = async (key: string, value: string) => {
    const newData = { ...parsed, [key]: value };
    await onSave(JSON.stringify(newData));
  };

  const handleExtractKeyword = async (urlOverride?: string) => {
    const targetUrl = urlOverride ?? parsed.referenceUrl;
    if (!targetUrl) {
      toast.error("먼저 공식 스토어 링크를 입력하고 저장해주세요.");
      return;
    }
    if (isExtracting) return;
    setIsExtracting(true);
    try {
      const res = await fetch("/api/deals/extract-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: targetUrl,
          brandName: brandName || "",
          dealName: dealName || "",
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (data.crawl?.attempted && !data.crawl?.ok) {
          const reason =
            data.crawl.reason ||
            (data.crawl.httpStatus
              ? `HTTP ${data.crawl.httpStatus}`
              : "알 수 없는 오류");
          toast.warning(
            `스토어 페이지 접근 실패(${reason}): CRM 데이터만으로 추출했습니다`,
          );
        }
        const newData = {
          ...parsed,
          searchKeyword: data.searchKeyword,
          modelName: data.modelName ?? "",
        };
        await onSave(JSON.stringify(newData));
        if (onForceSave) await onForceSave();
        toast.success("키워드가 추출되어 자동 저장되었습니다!");
      } else {
        toast.error(data.error || "키워드 추출에 실패했습니다.");
      }
    } catch {
      toast.error("추출 요청 중 오류가 발생했습니다.");
    } finally {
      setIsExtracting(false);
    }
  };

  return (
    <>
      <InlineEditField
        label="보조 정보"
        description="추가 설명이 필요할 때 입력하세요 (예: 1개월분)"
        descriptionAsTooltip
        fieldType="text"
        value={parsed.supplementaryInfo ?? ""}
        onSave={async (val) => handleUpdate("supplementaryInfo", String(val))}
      />
      <InlineEditField
        label="공식 스토어 링크"
        description="최저가 비교 키워드 추출용 기준 링크"
        descriptionAsTooltip
        fieldType="text"
        value={parsed.referenceUrl ?? ""}
        onSave={async (val) => {
          const newUrl = String(val).trim();
          const previousUrl = (parsed.referenceUrl ?? "").trim();
          const keywordIsEmpty =
            !parsed.searchKeyword || !parsed.searchKeyword.trim();
          const isValidUrl = /^https?:\/\//i.test(newUrl);

          await handleUpdate("referenceUrl", String(val));

          if (
            isValidUrl &&
            newUrl !== previousUrl &&
            keywordIsEmpty &&
            !isExtracting
          ) {
            toast.info("키워드 자동 추출 중…");
            await handleExtractKeyword(newUrl);
          }
        }}
      />
      <div className="relative group rounded-md">
        <InlineEditField
          label="검색 키워드 (AI)"
          description="최저가 비교 모니터링 시 사용될 로우데이터 키워드"
          descriptionAsTooltip
          fieldType="text"
          value={parsed.searchKeyword ?? ""}
          onSave={async (val) => handleUpdate("searchKeyword", String(val))}
        />
        <div className="absolute right-0 top-0 h-full flex items-center pr-2 opacity-0 group-hover:opacity-100 transition-opacity z-10">
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2 border-primary/20 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary"
            onClick={() => void handleExtractKeyword()}
            disabled={isExtracting}
          >
            {isExtracting ? (
              <span className="flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> 추출 중
              </span>
            ) : (
              "✨ 키워드 추출"
            )}
          </Button>
        </div>
      </div>
      <InlineEditField
        label="모델명"
        description="제품 모델명/모델코드(있는 경우): 최저가 비교 시 매치 가중치로 사용됩니다"
        descriptionAsTooltip
        fieldType="text"
        value={parsed.modelName ?? ""}
        onSave={async (val) => handleUpdate("modelName", String(val))}
      />
    </>
  );
}
