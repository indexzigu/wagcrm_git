import { useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Campaign } from '@/types/campaign';
import { queryKeys } from '@/lib/query-keys';

export interface NaverSyncMeta {
  lastSync: string | null;
  syncing: boolean;
  syncType: string | null;
}

type CampaignsPayload = {
  campaigns: Campaign[];
  syncMeta: NaverSyncMeta;
};

async function fetchCampaignsPayload(): Promise<CampaignsPayload> {
  const res = await fetch(`/order-converter/api/dashboard-stats?t=${new Date().getTime()}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('Failed to fetch campaigns');
  }
  const data = await res.json();
  return {
    campaigns: data,
    syncMeta: {
      lastSync: res.headers.get('X-Naver-Last-Sync') || null,
      syncing: res.headers.get('X-Naver-Syncing') === '1',
      syncType: res.headers.get('X-Naver-Sync-Type') || null,
    },
  };
}

const EMPTY_SYNC_META: NaverSyncMeta = { lastSync: null, syncing: false, syncType: null };

export function useCampaigns() {
  const queryClient = useQueryClient();

  // 서버는 stale한 스냅샷을 즉시 반환하면서 백그라운드 CHANGED 동기화를 건다(헤더 X-Naver-Syncing:1).
  // 그 동기화는 보통 1~3초 안에 DB 스냅샷을 갱신하지만, 클라이언트가 다시 읽지 않으면 화면은
  // 옛 스냅샷 + '갱신 중' 라벨에 머문다(= 페이지를 열어도 최신화가 안 되는 것처럼 보이던 원인).
  // syncing인 동안 3초 간격으로 조용히 재조회해 서버 SWR 루프를 클라이언트에서 닫는다. 동기화가
  // 끝나면 서버의 isSnapshotStale이 false로 떨어져 syncing:false가 되고 폴링이 자동으로 멈춘다.
  // 추가 재조회는 DB 읽기뿐이라(runSync는 45초 쿨다운·in-flight dedup) 네이버 API·ISR 쿼터에
  // 영향이 없다. 오류로 stale이 안 풀릴 때 무한 폴링을 막기 위해 최초 감지 후 30초까지만 폴링한다.
  const syncPollDeadlineRef = useRef<number | null>(null);

  const query = useQuery({
    queryKey: queryKeys.campaigns(),
    queryFn: fetchCampaignsPayload,
    staleTime: 60 * 1000, // hot 근접(60s) — B1-2 헤더 기반 동기화 메타와 정렬
    refetchInterval: (q) => {
      const syncing = q.state.data?.syncMeta.syncing ?? false;
      if (!syncing) {
        syncPollDeadlineRef.current = null;
        return false;
      }
      const now = Date.now();
      if (syncPollDeadlineRef.current === null) {
        syncPollDeadlineRef.current = now + 30 * 1000;
      } else if (now >= syncPollDeadlineRef.current) {
        return false; // 30초 상한 초과 — 폴링 중단(이후엔 수동 새로고침으로 회수)
      }
      return 3000;
    },
    // 탭이 백그라운드일 땐 폴링하지 않는다(기본값) — 운영자가 화면을 볼 때만 갱신.
  });

  const campaigns = query.data?.campaigns ?? [];
  const syncMeta = query.data?.syncMeta ?? EMPTY_SYNC_META;
  const isLoading = query.isLoading;

  // 기존 fetchCampaigns(silent) 시그니처 보존: silent=false면 화면에 로딩 스피너를 보이고,
  // silent=true면 백그라운드에서 조용히 갱신한다. React Query에서는 invalidate + refetch로 표현하고,
  // "보이는 로딩"은 캐시가 아예 없을 때만 발생하는 query.isLoading으로 자연히 대체된다.
  const fetchCampaigns = useCallback(async (_silent: boolean = false) => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.campaigns() });
  }, [queryClient]);

  // 수동 새로고침: POST /order-converter/api/naver/sync를 await한 뒤 캠페인 데이터를 재조회한다.
  // 버튼 잠금은 mutation의 isPending(=refreshing)으로만 제어한다(서버 syncing 헤더와 분리).
  const refreshNowMutation = useMutation({
    mutationFn: async () => {
      try {
        await fetch('/order-converter/api/naver/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'CHANGED' }),
        });
      } catch (e) {
        console.error(e);
      } finally {
        await queryClient.invalidateQueries({ queryKey: queryKeys.campaigns() });
      }
    },
  });

  const refreshNow = useCallback(async () => {
    await refreshNowMutation.mutateAsync();
  }, [refreshNowMutation]);

  const createCampaign = async (campaignData: Partial<Campaign>) => {
    try {
      const res = await fetch('/order-converter/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(campaignData),
      });
      if (res.ok) {
        await fetchCampaigns(true);
        return { success: true };
      }
      return { success: false, error: '생성에 실패했습니다.' };
    } catch (e) {
      console.error(e);
      return { success: false, error: '오류가 발생했습니다.' };
    }
  };

  const updateCampaign = async (id: string, campaignData: Partial<Campaign>) => {
    try {
      const res = await fetch(`/order-converter/api/campaigns/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(campaignData),
      });
      if (res.ok) {
        await fetchCampaigns(true);
        return { success: true };
      }
      return { success: false, error: '수정에 실패했습니다.' };
    } catch (e) {
      console.error(e);
      return { success: false, error: '오류가 발생했습니다.' };
    }
  };

  const deleteCampaign = async (id: string) => {
    try {
      const res = await fetch(`/order-converter/api/campaigns/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchCampaigns(true);
        return { success: true };
      }
      return { success: false, error: '삭제에 실패했습니다.' };
    } catch (e) {
      console.error(e);
      return { success: false, error: '오류가 발생했습니다.' };
    }
  };

  const toggleCampaignStatus = async (id: string, currentStatus: boolean) => {
    try {
      const res = await fetch(`/order-converter/api/campaigns/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !currentStatus }),
      });
      if (res.ok) {
        await fetchCampaigns(true);
        return { success: true };
      }
      return { success: false, error: '상태 변경에 실패했습니다.' };
    } catch (e) {
      console.error(e);
      return { success: false, error: '오류가 발생했습니다.' };
    }
  };

  return {
    campaigns,
    isLoading,
    fetchCampaigns,
    createCampaign,
    updateCampaign,
    deleteCampaign,
    toggleCampaignStatus,
    syncMeta,
    refreshNow,
    refreshing: refreshNowMutation.isPending,
  };
}
