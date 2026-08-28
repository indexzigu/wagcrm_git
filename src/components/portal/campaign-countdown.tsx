"use client";

// 마감/오픈까지 라이브 카운트다운 배지(§B+D 혼합). 서버는 임박(≤3일)·당일에만 이 컴포넌트를
// 마운트하고, 그 전(4일+)은 정적 D-N 배지를 그대로 서버 렌더한다 — 포털 대부분 기간은 무JS 유지.
// 비용: 순수 브라우저 setInterval이라 틱마다 서버를 치지 않는다(서버비 증가 0).
// hydration: 초기 렌더는 서버가 준 initialLabel(D-N)로 서버·클라 동일 → mismatch 없음.
// mount 후 useEffect가 라이브 시:분:초로 "업그레이드"한다(잠깐의 전환뿐).
import { useEffect, useState } from "react";
import { Clock, Flame } from "lucide-react";

type Mode = "close" | "open";

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** targetMs까지 남은 시간을 사람이 읽는 라벨로. mode·당일(D-0) 여부로 문구가 달라진다. */
function formatRemaining(targetMs: number, mode: Mode): string {
  const rem = Math.max(0, Math.floor((targetMs - Date.now()) / 1000));
  const d = Math.floor(rem / 86400);
  const hms = `${two(Math.floor((rem % 86400) / 3600))}:${two(Math.floor((rem % 3600) / 60))}:${two(rem % 60)}`;
  if (d > 0) {
    return mode === "open" ? `오픈까지 ${d}일 ${hms}` : `${d}일 ${hms}`;
  }
  // 당일(남은 날 0) — 가장 긴박한 표기
  return mode === "open" ? `오픈까지 ${hms}` : `오늘 마감 ${hms}`;
}

export function CampaignCountdown({
  targetMs,
  initialLabel,
  className,
  icon,
  mode,
}: {
  targetMs: number;
  initialLabel: string; // 서버 정적 라벨(D-N 등) — 마운트 전까지 이 값으로 렌더(hydration 안전)
  className: string; // amber/blue 톤(서버가 근접도로 결정)
  icon: "clock" | "flame";
  mode: Mode;
}) {
  const [label, setLabel] = useState(initialLabel);

  useEffect(() => {
    setLabel(formatRemaining(targetMs, mode));
    const id = setInterval(() => setLabel(formatRemaining(targetMs, mode)), 1000);
    return () => clearInterval(id);
  }, [targetMs, mode]);

  const Icon = icon === "flame" ? Flame : Clock;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border tabular-nums ${className}`}
      aria-label={label}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}
