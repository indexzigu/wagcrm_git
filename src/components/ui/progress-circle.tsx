import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * ProgressCircle — Tremor식 도넛 게이지.
 *
 * 비율 하나(달성률·이익률·완료율)를 원형 그래픽 KPI로 승격한다. 중앙에 큰 값 +
 * 작은 캡션. 페이로드(값)는 즉시 렌더 — 채워지는 애니메이션 없음(미니멀·판독 우선).
 *
 * 색은 승인 팔레트에서 전달(기본: 골드=달성/이익축).
 */
export function ProgressCircle({
  value,
  max = 1,
  size = 116,
  strokeWidth = 12,
  color = "var(--accent-gold)",
  trackColor = "var(--border)",
  label,
  caption,
  className,
}: {
  value: number;
  /** 분모(기본 1 — value를 0~1 비율로 전달할 때). */
  max?: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  trackColor?: string;
  /** 중앙 큰 텍스트(예: "28%"). */
  label?: ReactNode;
  /** 중앙 작은 텍스트(예: "순이익률"). */
  caption?: ReactNode;
  className?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  const dashOffset = circumference * (1 - fraction);
  const center = size / 2;

  return (
    <div
      className={cn("relative inline-flex items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={trackColor}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      {(label || caption) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
          {label ? (
            <div className="text-2xl font-bold tabular-nums tracking-tight text-foreground">
              {label}
            </div>
          ) : null}
          {caption ? (
            <div className="text-[10px] text-muted-foreground">{caption}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
