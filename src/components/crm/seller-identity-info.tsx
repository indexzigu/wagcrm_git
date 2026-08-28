import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Globe } from "lucide-react";

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17z" />
      <polygon points="10 15 15 12 10 9" />
    </svg>
  );
}

const renderSnsIcon = (snsType?: string | null, className?: string) => {
  if (!snsType) return null;
  const type = snsType.toUpperCase();
  if (type === "INSTAGRAM") {
    return <InstagramIcon className={cn("text-pink-500/80 shrink-0", className)} />;
  }
  if (type === "YOUTUBE") {
    return <YoutubeIcon className={cn("text-red-500/80 shrink-0", className)} />;
  }
  return <Globe className={cn("text-slate-400/80 shrink-0", className)} />;
};

export type SellerIdentityInfoProps = {
  sellerName: string | null;
  snsType?: string | null;
  snsHandle: string | null;
  followers?: number | null;
  fitLevel?: string | null; // 적합성 정보
  variant?: "default" | "compact" | "heading";
  /**
   * SNS 표시(플랫폼 아이콘 + @계정명) 전체를 숨긴다 — 이름만 남긴다.
   *
   * **계약 버그 수정 2026-07-16**: 이 프롭은 도입(`34b1475`, 2026-06-19)부터 "소셜 아이콘 및
   * 계정명 제거"를 선언했는데, 구현은 @계정명에만 가드가 걸려 **아이콘은 무조건 렌더**됐다.
   * 즉 색 정책이 만든 게 아니라 처음부터 구현이 선언을 못 지킨 것이고, 고치면서 P8("범주는
   * 색을 받지 않는다") 위반이 **결과적으로 같이 닫혔다** — 유일한 `true` 호출부인 모바일 영업
   * 화면(`mobile-outreach-view.tsx`)에 플랫폼 hue(`:46` pink·`:49` red)가 새던 구멍이었다.
   *
   * 나머지 9개 호출부는 전부 `false`(기본값)라 영향 없다. 아이콘이 정당하게 뜨는 그 데스크톱
   * 표면들의 hue 회수는 별건(D2)이다 — `:46,49` 를 여기서 건드리지 말 것.
   *
   * 리스트 행에서 SNS 를 숨겨도 정보는 안 사라진다: 모바일 카드 탭 → 상세 시트가 같은 셀러를
   * `hideSns={false}` 로 다시 렌더한다(`outreach/page.tsx:1468-1474`). 밀도를 위한 생략이지
   * 정보 제거가 아니다.
   */
  hideSns?: boolean;
};

export function SellerIdentityInfo({
  sellerName,
  snsHandle,
  fitLevel,
  variant = "default",
  hideSns = false,
  snsType,
}: SellerIdentityInfoProps) {
  const isCompact = variant === "compact";
  const isHeading = variant === "heading";

  const badgeColors: Record<string, string> = {
    추천: "text-emerald-700 border-emerald-200 bg-emerald-50",
    보류: "text-amber-700 border-amber-200 bg-amber-50",
    비추천: "text-rose-700 border-rose-200 bg-rose-50",
    미진행: "text-slate-500 border-slate-200 bg-slate-100",
  };

  const nameSize = isHeading ? "text-sm font-semibold" : isCompact ? "text-[11px] font-semibold" : "text-sm font-medium";
  const handleSize = isHeading ? "text-xs" : "text-[11px]";
  const iconSize = isHeading ? "size-3.5" : isCompact ? "size-3" : "size-3.5";

  return (
    <div className="flex items-center gap-2 min-w-0 w-full">
      <div className="flex items-center gap-1.5 min-w-0">
        <div className="flex flex-col min-w-0 gap-0.5">
          <div className="flex items-center gap-1 min-w-0">
            {!hideSns && renderSnsIcon(snsType, iconSize)}
            <span className={`truncate text-foreground ${nameSize}`}>
              {sellerName ?? "-"}
            </span>
            {!hideSns && snsHandle && (
              <span className={`text-slate-500 font-mono leading-none truncate ${handleSize}`}>
                @{snsHandle}
              </span>
            )}
          </div>
        </div>
      </div>
      
      {fitLevel != null && (
        <div className="shrink-0 ml-auto pl-2 flex items-center">
          <Badge
            variant="outline"
            className={cn(
              "rounded-md font-medium whitespace-nowrap",
              badgeColors[fitLevel] || "text-slate-500 border-slate-200 bg-slate-100",
              isCompact ? "h-4 px-1.5 text-[9px]" : "h-5 px-2 text-[10px]"
            )}
          >
            {fitLevel}
          </Badge>
        </div>
      )}
    </div>
  );
}
