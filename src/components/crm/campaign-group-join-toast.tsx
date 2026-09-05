"use client";

import { Boxes } from "lucide-react";
import { toast } from "sonner";
import type { CampaignRow } from "@/lib/crm-types";
import {
  dismissSuggestion,
  fetchActiveSuggestions,
  formatGroupLabel,
  joinCampaignToGroup,
} from "@/lib/campaign-group-client";

/**
 * CG-1 표면 ⓑ(단건 생성 직후 컨텍스트) — 지속 sonner 토스트로 그룹 합류를 제안한다.
 *
 * 원본 화면(생성 시트)이 닫혀 비차단 채널이 토스트뿐이므로 `duration: Infinity`로
 * "결정 증발"을 막는다(액션 클릭·닫기로만 사라짐, nag 금지). 세션 억제된 후보는 제외.
 * 이미 그룹 소속이거나 후보가 없으면 아무것도 표시하지 않는다(조용).
 *
 * 다중 후보(드묾)는 대표 후보 1건으로 축약한다 — 다중 선택 UI는 사이드패널 인라인 배너가 담당.
 */
export async function maybeSuggestGroupJoin(
  campaign: CampaignRow,
  options?: {
    /**
     * 합류 후 **다시 읽어야 할 캠페인 id 전부**(합류한 캠페인 + 기존 멤버들).
     * ⛔ 합류한 캠페인 하나만 넘기지 말 것 — 합류는 기존 멤버들의 배지 숫자
     * (`groupMemberCount`)도 늘리므로, 그 행들을 안 읽으면 보드에 낡은 숫자가 남는다.
     */
    onJoined?: (campaignIds: string[]) => void;
  },
): Promise<void> {
  if (campaign.groupId) return; // 이미 그룹 소속 — 합류 제안 없음.

  let candidates;
  try {
    candidates = await fetchActiveSuggestions({
      sellerId: campaign.sellerId,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      excludeCampaignId: campaign.id,
    });
  } catch {
    // 비차단 — 제안 조회 실패는 조용히 무시(생성은 이미 성공).
    return;
  }

  if (!candidates || candidates.length === 0) return;

  const representative = candidates[0];
  const label = formatGroupLabel(representative);
  const toastId = `cg1-join-${campaign.id}`;

  toast(`'${label}' 그룹에 이 캠페인을 합류시킬까요?`, {
    id: toastId,
    duration: Infinity,
    icon: <Boxes className="size-4 text-primary" aria-hidden="true" />,
    action: {
      label: "합류",
      onClick: () => {
        void (async () => {
          try {
            const joined = await joinCampaignToGroup(representative.id, campaign.id);
            toast.success("그룹에 합류했습니다.");
            options?.onJoined?.([
              campaign.id,
              ...joined.members.map((m) => m.campaignId),
            ]);
          } catch {
            toast.error("합류하지 못했습니다. 다시 시도해 주세요.");
          }
        })();
      },
    },
    cancel: {
      label: "합류 안 함",
      onClick: () => {
        dismissSuggestion(campaign.id, representative.id);
      },
    },
  });
}
