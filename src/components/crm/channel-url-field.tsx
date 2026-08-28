"use client";

import { useCallback, useState } from "react";
import { Loader2, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { validateChannelUrl } from "@/lib/validations/partner-seller";
import { toast } from "sonner";
import { parseChannelUrl } from "@/lib/channel-url";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type ChannelInfoResponse = {
  snsType?: "INSTAGRAM" | "YOUTUBE" | "X";
  snsHandle?: string;
  name?: string;
  currentFollowers?: number;
  channelUrl?: string;
};

type ChannelUrlFieldProps = {
  initialUrl: string;
  sellerId: string;
  onInfoApplied: (info: ChannelInfoResponse) => void;
  disabled?: boolean;
  onSync?: () => Promise<void>;
  syncing?: boolean;
};

export function ChannelUrlField({
  initialUrl,
  sellerId,
  onInfoApplied,
  disabled = false,
  onSync,
  syncing = false,
}: ChannelUrlFieldProps) {
  const [url, setUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validation = url ? validateChannelUrl(url) : { valid: false, error: undefined };
  const isValid = url.length > 0 && validation.valid;
  const showValidationError = url.length > 0 && !validation.valid;

  const handleSave = useCallback(async () => {
    if (!isValid || loading) return;

    setLoading(true);
    setError(null);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      // Step 1: Parse and Save the channel URL to DB
      const parsedChannel = parseChannelUrl(url);
      const patchBody = {
        channelUrl: url,
        ...(parsedChannel && {
          snsType: parsedChannel.snsType,
          snsHandle: parsedChannel.snsHandle,
        }),
      };

      const patchRes = await fetch(`/api/sellers/${sellerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
        signal: controller.signal,
      });

      if (!patchRes.ok) {
        throw new Error("URL 저장에 실패했습니다.");
      }

      // Step 2: Fetch channel info
      const infoRes = await fetch(
        `/api/sellers/${sellerId}/channel-info?force=true&url=${encodeURIComponent(url)}`,
        { signal: controller.signal },
      );

      clearTimeout(timeoutId);

      if (!infoRes.ok) {
        const data = await infoRes.json().catch(() => ({}));
        throw new Error(data.error || "채널 정보를 가져올 수 없습니다.");
      }

      const data = await infoRes.json();

      // Apify 비동기 모드: pending=true이면 폴링 시작
      if (data.pending && data.runId) {
        toast.info("채널 정보를 수집 중입니다... (최대 1분 소요)");
        const { runId, platform } = data as { runId: string; platform: string };
        const pollUrl = `/api/sellers/${sellerId}/channel-info/poll?runId=${runId}&platform=${platform}`;
        const MAX_POLLS = 30; // 3초 × 30 = 90초

        let successData = null;
        for (let i = 0; i < MAX_POLLS; i++) {
          await new Promise((resolve) => setTimeout(resolve, 3000));
          const pollRes = await fetch(pollUrl);
          if (!pollRes.ok) {
            const errData = await pollRes.json().catch(() => ({}));
            throw new Error(errData.error || "폴링 중 오류가 발생했습니다.");
          }
          const pollData = await pollRes.json();
          if (!pollData.pending) {
            successData = pollData;
            break;
          }
        }

        if (!successData) {
          throw new Error("동기화 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.");
        }

        toast.success("채널 정보 동기화가 완료되었습니다.");
        onInfoApplied({
          snsType: successData.snsType,
          snsHandle: successData.snsHandle,
          name: successData.name,
          currentFollowers: successData.currentFollowers,
          channelUrl: url,
        });
      } else {
        toast.success("채널 정보 동기화가 완료되었습니다.");
        onInfoApplied({
          ...data,
          channelUrl: url,
        });
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error) {
        if (err.name === "AbortError") {
          setError("채널 정보 조회 시간이 초과되었습니다. (15초)");
        } else {
          setError(err.message);
        }
      } else {
        setError("채널 정보를 가져올 수 없습니다.");
      }
    } finally {
      setLoading(false);
    }
  }, [isValid, loading, sellerId, url, onInfoApplied]);

  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex items-center gap-3 w-full">
        <label className="text-xs font-medium text-muted-foreground shrink-0 w-16">
          채널 URL
        </label>
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            disabled={disabled || loading || syncing}
            className="flex-1 h-7.5 text-xs md:text-xs px-2.5 bg-white min-w-0"
          />
          {url && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-7.5 shrink-0"
              onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
              title="새 창으로 열기"
            >
              <ExternalLink className="size-3.5" />
            </Button>
          )}
          {onSync && url && (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-7.5 shrink-0"
                    onClick={onSync}
                    disabled={disabled || loading || syncing}
                  >
                    {syncing ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" align="center" className="text-[11px] max-w-[280px]">
                  채널의 최신 정보를 즉시 갱신하고 싶을 때 사용합니다.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <Button
            type="button"
            className="h-7.5 px-3 text-[11px] font-semibold shrink-0"
            onClick={handleSave}
            disabled={disabled || loading || !isValid || syncing}
          >
            {loading ? (
              <>
                <Loader2 className="mr-1 size-3 animate-spin" />
                조회 중
              </>
            ) : (
              "저장"
            )}
          </Button>
        </div>
      </div>
      {showValidationError && (
        <p className="text-[10px] text-destructive pl-[76px]">
          {validation.error}
        </p>
      )}
      {error && (
        <p className="text-[10px] text-destructive pl-[76px]">{error}</p>
      )}
    </div>
  );
}
