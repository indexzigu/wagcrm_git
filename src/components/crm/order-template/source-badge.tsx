"use client";

import { Badge } from "@/components/ui/badge";

// 열 매핑 추천 출처 배지 — price-sheet status-badge와 동일한 status-* variant 체계 재사용.
// 휴리스틱=사전 정확일치라 확신도 표기 없음, LLM은 확신도 병기(배지 밖 보조 텍스트 —
// 배지 안에 넣으면 행 높이가 들쭉날쭉해진다).
export function SourceBadge({
  source,
  confidence,
}: {
  source: "heuristic" | "llm" | null;
  confidence: number;
}) {
  if (source === "heuristic") {
    return <Badge variant="status-active">자동 매칭</Badge>;
  }
  if (source === "llm") {
    const low = confidence < 0.7;
    return (
      <span className="inline-flex items-center gap-1">
        <Badge variant={low ? "status-pending" : "status-info"}>{low ? "AI 추천 (낮음)" : "AI 추천"}</Badge>
        <span className="text-[10px] tabular-nums text-muted-foreground">{Math.round(confidence * 100)}%</span>
      </span>
    );
  }
  return <Badge variant="outline">미매핑</Badge>;
}
