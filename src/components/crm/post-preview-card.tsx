"use client";

import React, { useRef, useState, useEffect } from "react";
import { ImageOff, ShoppingBag, Megaphone, Video, Play } from "lucide-react";

export function PostPreviewCard({
  post,
  nowMs,
}: {
  post: {
    permalink?: string | null;
    thumb?: string | null;
    media_type?: string | null;
    video_url?: string | null;
    is_gongu?: boolean | null;
    is_ad?: boolean | null;
    likes: number;
    comments: number;
    video_views?: number | null;
    taken_at?: string | null;
  };
  nowMs: number;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (isHovered && videoRef.current) {
      videoRef.current.play().catch(() => {});
    } else if (!isHovered && videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  }, [isHovered]);

  const p = post;
  
  const relDaysStr = () => {
    if (!p.taken_at) return "날짜 미상";
    const d = new Date(p.taken_at).getTime();
    const diff = nowMs - d;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return "오늘";
    if (days < 30) return `${days}일 전`;
    return `${Math.floor(days / 30)}달 전`;
  };

  const isReelish = p.media_type === "reel" || p.media_type === "video";

  return (
    <a
      href={p.permalink ?? undefined}
      target={p.permalink ? "_blank" : undefined}
      rel={p.permalink ? "noopener noreferrer" : undefined}
      className={`group block rounded-lg overflow-hidden border border-slate-200 bg-white ${
        p.permalink ? "hover:border-slate-400 hover:shadow-soft-sm transition-[border-color,box-shadow]" : "cursor-default"
      }`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="relative aspect-square bg-slate-100 overflow-hidden">
        {p.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={p.thumb}
            alt=""
            referrerPolicy="no-referrer"
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 pointer-fine:group-hover:scale-105"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-slate-300">
            <ImageOff className="size-5" />
          </div>
        )}
        
        {p.video_url && (
          <video
            ref={videoRef}
            src={p.video_url}
            muted
            loop
            playsInline
            className={`absolute inset-0 size-full object-cover transition-opacity duration-300 ${
              isHovered ? "opacity-100" : "opacity-0"
            }`}
          />
        )}

        <div className="absolute top-1 left-1 flex gap-1 z-10">
          {p.is_gongu && (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-600/90 text-white backdrop-blur-sm">
              <ShoppingBag className="size-2.5" />
              공구
            </span>
          )}
          {p.is_ad && (
            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/90 text-white backdrop-blur-sm">
              <Megaphone className="size-2.5" />
              광고
            </span>
          )}
        </div>
        {isReelish && (
          <span className="absolute top-1 right-1 z-10 text-white drop-shadow">
            <Video className="size-3.5" />
          </span>
        )}
        {p.video_url && (
          <div className="absolute inset-0 z-10 m-auto flex size-8 items-center justify-center rounded-full bg-black/40 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
            <Play className="size-4 fill-current" />
          </div>
        )}
      </div>
      <div className="px-2 py-1.5 flex items-center gap-2 text-[10px] text-slate-500 bg-white relative z-20">
        <span className="tabular-nums">♥ {p.likes.toLocaleString()}</span>
        <span className="tabular-nums">💬 {p.comments.toLocaleString()}</span>
        {p.video_views !== null && p.video_views !== undefined && (
          <span className="tabular-nums">▶ {p.video_views.toLocaleString()}</span>
        )}
        <span className="ml-auto">{relDaysStr()}</span>
      </div>
    </a>
  );
}
