"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { buildNaverTrackingLink } from "@/lib/tracking";
import type { SellerSummary } from "@/lib/crm-types";

type NaverLinkPreviewProps = {
  baseNaverLink: string;
  seller: SellerSummary | null;
  campaignId?: string;
};

function isValidUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

export function NaverLinkPreview({
  baseNaverLink,
  seller,
  campaignId,
}: NaverLinkPreviewProps) {
  const [copied, setCopied] = useState(false);

  const generatedLink = useMemo(() => {
    if (!baseNaverLink || !isValidUrl(baseNaverLink) || !seller) {
      return null;
    }

    return buildNaverTrackingLink({
      baseUrl: baseNaverLink,
      snsType: seller.snsType,
      sellerId: seller.id,
      campaignId: campaignId ?? "{campaignId}",
    });
  }, [baseNaverLink, seller, campaignId]);

  const showWarning = !baseNaverLink || !isValidUrl(baseNaverLink);

  async function handleCopy() {
    if (!generatedLink) return;
    await navigator.clipboard.writeText(generatedLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">트래킹 링크 미리보기</p>

      {showWarning && (
        <p className="text-xs text-destructive">
          유효한 네이버 링크를 입력하세요
        </p>
      )}

      {!showWarning && !seller && (
        <p className="text-xs text-muted-foreground">
          셀러를 선택하면 트래킹 링크가 생성됩니다
        </p>
      )}

      {generatedLink && (
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded border bg-muted/40 px-3 py-2 text-xs font-mono break-all">
            {generatedLink}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
          >
            {copied ? "복사됨" : "복사"}
          </Button>
        </div>
      )}
    </div>
  );
}
