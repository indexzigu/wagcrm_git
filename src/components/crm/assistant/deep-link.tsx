import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import type { AssistantToolCallView } from "./types";

/**
 * 도구 이름 + evidence.query를 근거로 CRM 화면 딥링크를 쿼리파라미터 방식으로 만든다
 * (청사진: 사이드패널 아님, 전용 페이지 + 쿼리파라미터 — 예: /settlement?month=).
 */
function buildDeepLink(toolCall: AssistantToolCallView): { href: string; label: string } | null {
  const query = toolCall.evidence?.query ?? {};

  switch (toolCall.toolName) {
    case "get_settlement_report": {
      const params = new URLSearchParams();
      if (typeof query.month === "string") params.set("month", query.month);
      const qs = params.toString();
      return { href: qs ? `/settlement?${qs}` : "/settlement", label: "정산 화면에서 보기" };
    }
    case "search_deals": {
      const params = new URLSearchParams();
      if (typeof query.keyword === "string" && query.keyword) params.set("q", query.keyword);
      if (typeof query.status === "string" && query.status) params.set("status", query.status);
      const qs = params.toString();
      return { href: qs ? `/deals?${qs}` : "/deals", label: "딜 목록에서 보기" };
    }
    case "get_pipeline_status":
      return { href: "/pipeline", label: "파이프라인 화면에서 보기" };
    case "get_campaign_financials": {
      const campaignId = typeof query.campaignId === "string" ? query.campaignId : null;
      const params = new URLSearchParams();
      if (campaignId) params.set("campaignId", campaignId);
      const qs = params.toString();
      return { href: qs ? `/pipeline?${qs}` : "/pipeline", label: "캠페인 화면에서 보기" };
    }
    case "get_order_snapshot":
      return { href: "/order-converter", label: "주문 관리 화면에서 보기" };
    default:
      return null;
  }
}

export function DeepLink({ toolCall }: { toolCall: AssistantToolCallView }) {
  const link = buildDeepLink(toolCall);
  if (!link) return null;

  return (
    <Link
      href={link.href}
      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
    >
      {link.label}
      <ExternalLinkIcon className="size-3" />
    </Link>
  );
}
