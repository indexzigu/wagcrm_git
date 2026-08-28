"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface OutreachMessageGeneratorProps {
  dealId: string;
  sellerId: string;
  onGenerated: (message: string) => void;
}

export function OutreachMessageGenerator({ dealId, sellerId, onGenerated }: OutreachMessageGeneratorProps) {
  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerate = async () => {
    if (!dealId || !sellerId) {
      toast.error("딜과 셀러를 먼저 선택해주세요.");
      return;
    }

    setIsGenerating(true);
    try {
      const res = await fetch("/api/outreach/generate-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId, sellerId }),
      });

      if (!res.ok) {
        throw new Error("생성 실패");
      }

      const data = await res.json();
      if (data.message) {
        onGenerated(data.message);
        toast.success("AI 제안 메시지 초안이 생성되었습니다.");
      } else if (data.error) {
        throw new Error(data.error);
      }
    } catch (error) {
      console.error(error);
      toast.error("AI 생성 중 오류가 발생했습니다.");
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 px-2.5 text-[11px] font-medium text-blue-600 border-blue-200 bg-blue-50/50 hover:bg-blue-50 hover:text-blue-700"
      onClick={handleGenerate}
      disabled={isGenerating || !dealId || !sellerId}
    >
      {isGenerating ? (
        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
      ) : (
        <Sparkles className="h-3 w-3 mr-1" />
      )}
      ✨ 제안 메시지 초안 생성
    </Button>
  );
}
