"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangleIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SearchableDropdown } from "@/components/crm/searchable-dropdown";
import { buildMappingOptions } from "./mapping-options";
import type { CampaignOption, CollectorType, ManageRoom, MappingOption, PartnerOption, SellerOption } from "./types";

const STALE_THRESHOLD_DAYS = 7;

function daysSince(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const diffMs = Date.now() - new Date(dateStr).getTime();
  return diffMs / (1000 * 60 * 60 * 24);
}

function roomTypeLabel(roomType: string | null): string {
  if (roomType === "GROUP") return "그룹";
  if (roomType === "OPEN") return "오픈채팅";
  if (roomType === "DIRECT") return "1:1";
  return "-";
}

function collectorTypeLabel(collectorType: CollectorType): { label: string; variant: "status-active" | "status-info" | "outline" } {
  switch (collectorType) {
    case "KATOK_AUTO":
      return { label: "자동(사장)", variant: "status-active" };
    case "TXT_UPLOAD":
      return { label: "txt 업로드(직원)", variant: "status-info" };
    case "EXCLUDED":
      return { label: "제외", variant: "outline" };
  }
}

const NONE_OPTION: MappingOption = {
  compositeValue: "__none__",
  kind: "PARTNER",
  entityId: "",
  label: "미매핑",
  searchableText: "",
};

export function KatalkManageTab() {
  const [rooms, setRooms] = React.useState<ManageRoom[]>([]);
  const [partners, setPartners] = React.useState<PartnerOption[]>([]);
  const [sellers, setSellers] = React.useState<SellerOption[]>([]);
  const [campaigns, setCampaigns] = React.useState<CampaignOption[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [savingRoomKey, setSavingRoomKey] = React.useState<string | null>(null);

  const loadRooms = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/chat-room-mappings/manage");
      const data = await res.json();
      setRooms(data.rooms ?? []);
    } catch {
      toast.error("방 목록을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadRooms();
    fetch("/api/partners")
      .then((res) => res.json())
      .then((data) => setPartners(data.partners ?? []))
      .catch(() => setPartners([]));
    fetch("/api/sellers")
      .then((res) => res.json())
      .then((data) => setSellers(data.sellers ?? []))
      .catch(() => setSellers([]));
    fetch("/api/campaigns")
      .then((res) => res.json())
      .then((data) => setCampaigns(data.campaigns ?? []))
      .catch(() => setCampaigns([]));
  }, [loadRooms]);

  const mappingOptions = React.useMemo(
    () => buildMappingOptions(partners, sellers, campaigns),
    [partners, sellers, campaigns]
  );
  const optionsWithNone = React.useMemo(() => [NONE_OPTION, ...mappingOptions], [mappingOptions]);

  const patchRoom = React.useCallback(
    async (room: ManageRoom, patch: Record<string, unknown>) => {
      setSavingRoomKey(room.roomKey);
      try {
        const res = await fetch("/api/chat-room-mappings/manage", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: room.source, roomKey: room.roomKey, ...patch }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error ?? "저장에 실패했습니다.");
          return;
        }
        toast.success("저장되었습니다.");
        await loadRooms();
      } catch {
        toast.error("저장 중 오류가 발생했습니다.");
      } finally {
        setSavingRoomKey(null);
      }
    },
    [loadRooms]
  );

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <ManageGuideNote />
        <p className="p-6 text-sm text-muted-foreground">불러오는 중...</p>
      </div>
    );
  }

  if (rooms.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <ManageGuideNote />
        <p className="p-6 text-sm text-muted-foreground">등록된 방이 없습니다.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ManageGuideNote />
      <div className="overflow-x-auto rounded-xl border border-border/60 bg-white">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>방 이름</TableHead>
            <TableHead>유형</TableHead>
            <TableHead>수집 담당</TableHead>
            <TableHead>매핑</TableHead>
            <TableHead>활동량</TableHead>
            <TableHead>마지막 업로드/동기화</TableHead>
            <TableHead>액션</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rooms.map((room) => {
            const stale =
              room.collectorType === "TXT_UPLOAD" &&
              (() => {
                const days = daysSince(room.lastSyncedAt);
                return days !== null && days > STALE_THRESHOLD_DAYS;
              })();
            const collector = collectorTypeLabel(room.collectorType);
            const isSaving = savingRoomKey === room.roomKey;

            const mappingValue =
              room.entityType && room.entityId ? `${room.entityType}:${room.entityId}` : "__none__";

            return (
              <TableRow key={`${room.source}:${room.roomKey}`} className={stale ? "bg-amber-50" : undefined}>
                <TableCell className="max-w-[220px] truncate font-medium text-foreground">
                  {room.roomName ?? room.roomKey}
                  {stale && (
                    <span className="ml-1 inline-flex items-center gap-1 text-[10px] text-amber-600">
                      <AlertTriangleIcon className="size-3" /> 7일 이상 미갱신
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[11px]">
                    {roomTypeLabel(room.roomType)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={collector.variant} className="text-[11px]">
                    {collector.label}
                  </Badge>
                </TableCell>
                <TableCell>
                  {room.mapped ? (
                    <div className="w-56">
                      <SearchableDropdown
                        items={optionsWithNone}
                        value={mappingValue}
                        disabled={isSaving}
                        getSearchableText={(opt) => opt.searchableText}
                        getLabel={(opt) => opt.label}
                        getValue={(opt) => opt.compositeValue}
                        placeholder="거래처/셀러/캠페인 검색"
                        emptyMessage="검색 결과 없음"
                        onValueChange={(value) => {
                          if (value === "__none__") {
                            patchRoom(room, { entityType: null, entityId: null, campaignId: null });
                            return;
                          }
                          const option = mappingOptions.find((opt) => opt.compositeValue === value);
                          if (!option) return;
                          if (option.kind === "CAMPAIGN") {
                            // 캠페인은 항상 특정 셀러에 속한다 — SELLER로 귀속 + campaignId 태깅.
                            patchRoom(room, {
                              entityType: "SELLER",
                              entityId: option.campaignSellerId ?? null,
                              campaignId: option.entityId,
                            });
                            return;
                          }
                          patchRoom(room, {
                            entityType: option.kind,
                            entityId: option.entityId,
                            campaignId: null,
                          });
                        }}
                      />
                    </div>
                  ) : (
                    <Badge variant="outline" className="text-[11px] text-muted-foreground">
                      미매핑(미등록)
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {room.messageCount !== null ? `${room.messageCount}건` : "-"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {room.lastSyncedAt ? new Date(room.lastSyncedAt).toLocaleString("ko-KR") : "-"}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={isSaving || !room.mapped}
                      onClick={() => {
                        const nextCollectorType =
                          room.collectorType === "KATOK_AUTO" ? "TXT_UPLOAD" : "KATOK_AUTO";
                        // m10 리뷰 반영: KATOK_AUTO로 전환하면 사장 Mac 러너가 이 방을 자동
                        // 수집하기 시작한다 — 직원이 계속 txt 업로드를 하면 이중 수집이 될 수
                        // 있으므로 전환 전 확인을 받는다.
                        const confirmMessage =
                          nextCollectorType === "KATOK_AUTO"
                            ? "자동 수집 담당(사장 Mac)으로 전환하시겠습니까? 전환 후 직원이 이 방을 txt로 계속 업로드하면 이중 수집이 발생할 수 있습니다."
                            : "txt 업로드 담당(직원)으로 전환하시겠습니까? 사장 Mac 자동 수집이 이 방에서 중단됩니다.";
                        if (!window.confirm(confirmMessage)) return;
                        patchRoom(room, { collectorType: nextCollectorType });
                      }}
                    >
                      담당 전환
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={isSaving || !room.mapped}
                      onClick={() => patchRoom(room, { excluded: !room.excluded })}
                    >
                      {room.excluded ? "제외 해제" : "제외"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}

/**
 * 비개발자 직원용 방 관리 안내 문구. 방을 거래처/셀러/캠페인에 연결(매핑)하면 대화 기록이
 * 자동으로 해당 업체 기록으로 정리된다는 것, 주황 강조는 "오래 업로드 안 된 방"임을 설명한다.
 */
function ManageGuideNote() {
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      방을 거래처·셀러·캠페인에 연결(매핑)하면 그 방의 대화 기록이 해당 업체 기록으로 자동
      정리됩니다.{" "}
      <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
        주황색 표시
      </span>
      는 7일 이상 업로드가 없었던 방이라는 뜻이니, 최근 대화가 있다면 다시 업로드해주세요.
    </p>
  );
}
